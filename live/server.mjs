import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { grpc, ReportingService } from './protocol.mjs';
import { AuthenticationError, AuthorizationError, authConfigFromEnv, createAuthenticator } from './auth.mjs';
import { EventStore, normalizeRegistration, StoreError } from './store.mjs';
import { projectRun, projectRuns } from './project.mjs';
import { startGithubReconciler } from './github-reconcile.mjs';
import { createGitHubApp, githubAppConfigFromEnv } from './github-app.mjs';
import { createService, HttpError, json } from './service.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };

function port(value, fallback) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 0 || result > 65535) throw new Error('Collector ports must be integers between 0 and 65535');
  return result;
}

export function collectorConfigFromEnv(env = process.env) {
  return {
    databasePath: env.NIX_CI_LIVE_DB || resolve(HERE, 'data/events.sqlite'),
    httpPort: port(env.NIX_CI_LIVE_HTTP_PORT, 8799),
    grpcPort: port(env.NIX_CI_LIVE_GRPC_PORT, 50051),
    auth: authConfigFromEnv(env),
    githubToken: env.NIX_CI_LIVE_GITHUB_TOKEN,
    githubApp: githubAppConfigFromEnv(env),
    staticDirectory: resolve(HERE, 'dist'),
  };
}

function rpcError(error) {
  if (error instanceof AuthenticationError) return { code: grpc.status.UNAUTHENTICATED, details: error.message };
  if (error instanceof AuthorizationError) return { code: grpc.status.PERMISSION_DENIED, details: error.message };
  if (error instanceof StoreError) {
    const metadata = new grpc.Metadata();
    if (error.lastSequence !== undefined) metadata.set('last-sequence', String(error.lastSequence));
    return { code: grpc.status[error.code] ?? grpc.status.INVALID_ARGUMENT, details: error.message, metadata };
  }
  return { code: grpc.status.INTERNAL, details: 'Collector could not persist the request' };
}

/** Listeners stay on loopback. Service mode can expose the authenticated HTTP
 * app through its configured TLS origin; gRPC needs HTTP/2 forwarding. */
export async function startCollector(config = collectorConfigFromEnv()) {
  const now = config.now || (() => Date.now());
  const store = new EventStore(config.databasePath || resolve(HERE, 'data/events.sqlite'), { now });
  let app;
  let authenticate;
  try {
    const mode = config.githubApp?.mode || 'local';
    if (!['local', 'github'].includes(mode)) throw new Error('Unknown dashboard access mode');
    if (mode === 'github') {
      if (config.auth?.mode !== 'oidc') throw new Error('GitHub service mode requires OIDC reporter authentication');
      app = await createGitHubApp(config.githubApp, { db: store.db, now, ...config.githubAppOptions });
    }
    authenticate = createAuthenticator(config.auth, { ...config.authOptions, now,
      ...(app ? { authorizeRepository: identity => app.isRepositoryConnected(identity) } : {}),
    });
  } catch (error) { store.close(); throw error; }
  const staticDirectory = resolve(config.staticDirectory || resolve(HERE, 'dist'));
  const staleAfterMs = config.staleAfterMs ?? 90_000;
  const clients = new Set();
  const pendingHttp = new Set();
  const pendingRpc = new Set();
  let httpAddress;
  let grpcAddress;
  let stopping;
  let stopReconciler = async () => {};
  let timer;
  let refreshingAccess;
  let accessNotification = false;
  let closing = false;

  function send(client, event, payload) {
    const response = client.response;
    if (response.destroyed || response.writableLength > 1024 * 1024) {
      clients.delete(client); response.destroy(); return;
    }
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  function onChange(change) {
    if (!change.changed) return;
    const payload = { revision: change.revision, runId: change.runId || change.runKey || null };
    const run = payload.runId ? store.run(payload.runId) : null;
    for (const client of clients) {
      if (app) {
        const session = app.session(client.viewer.cookie);
        if (!session) {
          send(client, 'auth', {}); clients.delete(client); client.response.end(); continue;
        }
        // Recheck committed permission changes before every notification,
        // even between periodic GitHub permission refreshes.
        const cached = app.cachedRepositoryIds(session);
        if (!cached) continue;
        client.viewer.repositoryIds = cached;
      }
      if (client.viewer.repositoryIds && (!run || !client.viewer.repositoryIds.has(String(run.repositoryId)))) continue;
      send(client, 'invalidate', payload);
    }
  }

  function refreshClients(notify = false) {
    if (!app || closing) return Promise.resolve();
    accessNotification ||= notify;
    if (refreshingAccess) return refreshingAccess;
    refreshingAccess = (async () => {
      for (const client of clients) {
        try {
          client.viewer = await service.viewer({ headers: { cookie: client.viewer.cookie } });
        } catch (error) {
          if (error.status === 401) {
            send(client, 'auth', {});
            clients.delete(client);
            client.response.end();
          } else {
            // A GitHub outage is not a logout. Stop delivering data until
            // access can be verified again, and let the viewer retry.
            client.viewer.repositoryIds = new Set();
            send(client, 'access', {});
          }
        }
      }
      if (accessNotification) {
        accessNotification = false;
        for (const client of clients) send(client, 'access', {});
      }
    })().finally(() => {
      refreshingAccess = null;
      if (accessNotification && !closing) void refreshClients();
    });
    return refreshingAccess;
  }

  const service = createService({ app, config: config.githubApp, store, onChange, onAccessChange: () => { void refreshClients(true); } });
  const http = createServer((request, response) => {
    const task = handleHttp(request, response);
    pendingHttp.add(task);
    void task.finally(() => pendingHttp.delete(task));
  });
  async function handleHttp(request, response) {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (closing) { json(response, 503, { error: 'The collector is restarting' }); return; }
      // A loopback bind alone does not prevent a hostile website from issuing
      // requests through DNS rebinding or cross-origin browser requests.
      const actualPort = http.address()?.port;
      const hosts = new Set([`${HOST}:${actualPort}`, `localhost:${actualPort}`]);
      const origins = new Set([...hosts].map(host => `http://${host}`));
      if (app) {
        const publicUrl = new URL(config.githubApp.publicUrl);
        hosts.add(publicUrl.host); origins.add(publicUrl.origin);
      }
      if (!request.url || request.url.length > 8192) { json(response, 414, { error: 'Request path is too long' }); return; }
      const url = new URL(request.url, httpAddress);
      const navigation = app && request.method === 'GET' && !url.pathname.startsWith('/api/') && url.pathname !== '/auth/logout';
      if (!hosts.has(request.headers.host) || (request.headers.origin && !origins.has(request.headers.origin)) || (request.headers['sec-fetch-site'] === 'cross-site' && !navigation)) {
        json(response, 403, { error: 'Use the configured dashboard origin' }); return;
      }
      if (await service.route(request, response, url)) return;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('allow', 'GET, HEAD'); json(response, 405, { error: 'Read-only endpoint' }); return;
      }
      if (url.pathname === '/healthz') { json(response, 200, { status: 'ok' }); return; }
      if (url.pathname === '/api/events') {
        const viewer = await service.viewer(request);
        if (request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
        if (clients.size >= 32) { json(response, 503, { error: 'Too many live viewers' }); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
        response.flushHeaders();
        const client = { response, viewer };
        clients.add(client);
        send(client, 'ready', { revision: store.revision, runId: null });
        response.on('close', () => clients.delete(client));
        return;
      }
      if (url.pathname === '/api/runs') {
        const viewer = await service.viewer(request);
        // Filter before projecting: unauthorized runs must not be rendered or
        // returned, even if the caller knows their names or numeric run IDs.
        const allowedStore = viewer.repositoryIds ? Object.assign(Object.create(store), {
          listRuns: () => store.listRuns().filter(run => viewer.repositoryIds.has(String(run.repositoryId))),
        }) : store;
        json(response, 200, projectRuns(allowedStore, { now: now(), staleAfterMs })); return;
      }
      if (url.pathname.startsWith('/api/runs/')) {
        let runId;
        try { runId = decodeURIComponent(url.pathname.slice('/api/runs/'.length)); }
        catch { json(response, 400, { error: 'Invalid run ID' }); return; }
        const viewer = await service.viewer(request);
        const run = store.run(runId);
        const allowed = !viewer.repositoryIds || (run && viewer.repositoryIds.has(String(run.repositoryId)));
        const report = allowed ? projectRun(store, runId, { now: now(), staleAfterMs }) : null;
        json(response, report ? 200 : 404, report || { error: 'Run not found' }); return;
      }
      if (url.pathname.startsWith('/api/')) { json(response, 404, { error: 'Endpoint not found' }); return; }
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { json(response, 400, { error: 'Invalid path' }); return; }
      const fallback = pathname === '/' || pathname === '/connections' || pathname.startsWith('/runs/');
      const file = fallback ? resolve(staticDirectory, 'index.html') : resolve(staticDirectory, `.${pathname}`);
      if (file !== staticDirectory && !file.startsWith(`${staticDirectory}${sep}`)) { json(response, 404, { error: 'File not found' }); return; }
      let info;
      try { info = await stat(file); } catch { json(response, 404, { error: 'Report assets are not built; run npm run build in live/' }); return; }
      if (!info.isFile() || !MIME[extname(file)] || info.size > 32 * 1024 * 1024) { json(response, 404, { error: 'File not found' }); return; }
      response.writeHead(200, { 'content-type': MIME[extname(file)], 'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=60' });
      response.end(request.method === 'HEAD' ? undefined : await readFile(file));
    } catch (error) {
      const code = error instanceof HttpError ? error.status : error instanceof StoreError ? (error.code === 'ALREADY_EXISTS' ? 409 : 400) : [401, 403, 503].includes(error.status) ? error.status : 500;
      if (response.destroyed) return;
      if (!response.headersSent) json(response, code, { error: error instanceof HttpError ? error.message : code === 401 ? 'Sign in with GitHub to view these builds' : 'The request could not be completed' });
      else response.destroy();
    }
  }
  http.requestTimeout = 30_000;
  http.headersTimeout = 15_000;

  const rpc = new grpc.Server({
    'grpc.max_receive_message_length': 5 * 1024 * 1024,
    'grpc.max_send_message_length': 1024 * 1024,
    'grpc.max_concurrent_streams': 64,
  });

  async function principal(call) {
    if (closing) throw new StoreError('Collector is restarting', 'UNAVAILABLE');
    const authorization = call.metadata.get('authorization');
    if (authorization.length !== 1 || typeof authorization[0] !== 'string') throw new AuthenticationError();
    return authenticate.authenticate(authorization[0]);
  }

  rpc.addService(ReportingService, {
    registerInvocation(call, callback) {
      const task = (async () => {
        const identity = await principal(call);
        const registration = normalizeRegistration(call.request);
        authenticate.authorizeInvocation(identity, registration);
        const result = store.register(registration);
        onChange(result);
        callback(null, { invocationId: result.invocationId, runKey: result.runKey, reportUrl: `${app ? config.githubApp.publicUrl : httpAddress}/runs/${encodeURIComponent(result.runKey)}` });
      })().catch(error => callback(rpcError(error)));
      pendingRpc.add(task);
      void task.finally(() => pendingRpc.delete(task));
    },
    publish(call, callback) {
      const task = (async () => {
        const identity = await principal(call);
        const registration = store.invocation(call.request.invocationId);
        if (!registration) throw new StoreError('Register invocation before publishing', 'NOT_FOUND');
        authenticate.authorizeInvocation(identity, registration);
        const result = store.append(call.request);
        onChange(result);
        callback(null, { lastSequence: result.lastSequence });
      })().catch(error => callback(rpcError(error)));
      pendingRpc.add(task);
      void task.finally(() => pendingRpc.delete(task));
    },
  });

  async function close() {
    if (stopping) return stopping;
    closing = true;
    stopping = (async () => {
      clearInterval(timer);
      const stopReading = stopReconciler();
      for (const client of clients) client.response.end();
      clients.clear();
      await Promise.all([
        stopReading,
        new Promise(resolveClose => { http.close(resolveClose); http.closeAllConnections(); }),
        new Promise(resolveClose => {
          const timeout = setTimeout(() => { rpc.forceShutdown(); resolveClose(); }, 5000);
          timeout.unref();
          rpc.tryShutdown(() => { clearTimeout(timeout); resolveClose(); });
        }),
      ]);
      await Promise.allSettled([...pendingHttp, ...pendingRpc]);
      await refreshingAccess;
      store.close();
    })();
    return stopping;
  }

  try {
    await new Promise((resolveListen, reject) => {
      http.once('error', reject);
      http.listen(port(config.httpPort, 8799), HOST, () => { http.off('error', reject); resolveListen(); });
    });
    httpAddress = `http://${HOST}:${http.address().port}`;
    const boundPort = await new Promise((resolveBind, reject) => rpc.bindAsync(`${HOST}:${port(config.grpcPort, 50051)}`, grpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolveBind(port)));
    grpcAddress = `${HOST}:${boundPort}`;
    timer = setInterval(() => {
      void refreshClients().then(() => {
        for (const client of clients) send(client, 'invalidate', { revision: store.revision, runId: null, reason: 'liveness' });
      });
    }, config.livenessIntervalMs ?? 15_000);
    timer.unref();
    stopReconciler = startGithubReconciler({ store, onChange, token: app ? undefined : config.githubToken,
      ...(app ? { tokenProvider: identity => app.installationToken(identity), isRepositoryConnected: identity => app.isRepositoryConnected(identity), listRepositories: () => app.connectedRepositories() } : {}),
      intervalMs: config.githubIntervalMs, onWarning: config.onWarning, fetchImpl: config.githubFetch,
    });
    return { httpAddress, grpcAddress, store, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const collector = await startCollector();
    console.log(`Live report: ${collector.httpAddress}`);
    console.log(`Authenticated reporter ingress: ${collector.grpcAddress} (forward this port with HTTP/2 TLS)`);
    const stop = () => collector.close().then(() => { process.exitCode = 0; });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error(`Collector startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
