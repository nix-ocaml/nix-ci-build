import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { grpc, ReportingService } from './protocol.mjs';
import { AuthenticationError, AuthorizationError, authConfigFromEnv, createAuthenticator } from './auth.mjs';
import { EventStore, normalizeRegistration, StoreError } from './store.mjs';
import { projectRun, projectRuns } from './project.mjs';
import { startGithubReconciler } from './github-reconcile.mjs';

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

/** Both listeners deliberately stay on loopback; only the authenticated gRPC
 * port is intended to be forwarded by an HTTP/2 TLS tunnel. */
export async function startCollector(config = collectorConfigFromEnv()) {
  const now = config.now || (() => Date.now());
  const authenticate = createAuthenticator(config.auth, { ...config.authOptions, now });
  const store = new EventStore(config.databasePath || resolve(HERE, 'data/events.sqlite'), { now });
  const staticDirectory = resolve(config.staticDirectory || resolve(HERE, 'dist'));
  const staleAfterMs = config.staleAfterMs ?? 90_000;
  const clients = new Set();
  let httpAddress;
  let grpcAddress;
  let stopping;
  let stopReconciler = async () => {};
  let timer;

  function send(client, event, payload) {
    if (client.destroyed || client.writableLength > 1024 * 1024) {
      clients.delete(client); client.destroy(); return;
    }
    client.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  function onChange(change) {
    if (!change.changed) return;
    const payload = { revision: change.revision, runId: change.runId || change.runKey || null };
    for (const client of clients) send(client, 'invalidate', payload);
  }

  function json(response, code, data) {
    response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(data));
  }

  const http = createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      // A loopback bind alone does not prevent a hostile website from issuing
      // requests through DNS rebinding or cross-origin browser requests.
      const actualPort = http.address()?.port;
      const hosts = new Set([`${HOST}:${actualPort}`, `localhost:${actualPort}`]);
      const origins = new Set([...hosts].map(host => `http://${host}`));
      if (!hosts.has(request.headers.host) || (request.headers.origin && !origins.has(request.headers.origin)) || request.headers['sec-fetch-site'] === 'cross-site') {
        json(response, 403, { error: 'The report is available only from its local origin' }); return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('allow', 'GET, HEAD'); json(response, 405, { error: 'Read-only endpoint' }); return;
      }
      if (!request.url || request.url.length > 8192) { json(response, 414, { error: 'Request path is too long' }); return; }
      const url = new URL(request.url, httpAddress);
      if (url.pathname === '/healthz') { json(response, 200, { status: 'ok' }); return; }
      if (url.pathname === '/api/events') {
        if (request.method === 'HEAD') { response.writeHead(200); response.end(); return; }
        if (clients.size >= 32) { json(response, 503, { error: 'Too many live viewers' }); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
        response.flushHeaders();
        clients.add(response);
        send(response, 'ready', { revision: store.revision, runId: null });
        response.on('close', () => clients.delete(response));
        return;
      }
      if (url.pathname === '/api/runs') { json(response, 200, projectRuns(store, { now: now(), staleAfterMs })); return; }
      if (url.pathname.startsWith('/api/runs/')) {
        let runId;
        try { runId = decodeURIComponent(url.pathname.slice('/api/runs/'.length)); }
        catch { json(response, 400, { error: 'Invalid run ID' }); return; }
        const report = projectRun(store, runId, { now: now(), staleAfterMs });
        json(response, report ? 200 : 404, report || { error: 'Run not found' }); return;
      }
      if (url.pathname.startsWith('/api/')) { json(response, 404, { error: 'Endpoint not found' }); return; }
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { json(response, 400, { error: 'Invalid path' }); return; }
      const fallback = pathname === '/' || pathname.startsWith('/runs/');
      const file = fallback ? resolve(staticDirectory, 'index.html') : resolve(staticDirectory, `.${pathname}`);
      if (file !== staticDirectory && !file.startsWith(`${staticDirectory}${sep}`)) { json(response, 404, { error: 'File not found' }); return; }
      let info;
      try { info = await stat(file); } catch { json(response, 404, { error: 'Report assets are not built; run npm run build in live/' }); return; }
      if (!info.isFile() || !MIME[extname(file)] || info.size > 32 * 1024 * 1024) { json(response, 404, { error: 'File not found' }); return; }
      response.writeHead(200, { 'content-type': MIME[extname(file)], 'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=60' });
      response.end(request.method === 'HEAD' ? undefined : await readFile(file));
    } catch {
      if (!response.headersSent) json(response, 500, { error: 'The report could not be read' });
      else response.destroy();
    }
  });
  http.requestTimeout = 30_000;
  http.headersTimeout = 15_000;

  const rpc = new grpc.Server({
    'grpc.max_receive_message_length': 5 * 1024 * 1024,
    'grpc.max_send_message_length': 1024 * 1024,
    'grpc.max_concurrent_streams': 64,
  });

  async function principal(call) {
    const authorization = call.metadata.get('authorization');
    if (authorization.length !== 1 || typeof authorization[0] !== 'string') throw new AuthenticationError();
    return authenticate.authenticate(authorization[0]);
  }

  rpc.addService(ReportingService, {
    registerInvocation(call, callback) {
      (async () => {
        const identity = await principal(call);
        const registration = normalizeRegistration(call.request);
        authenticate.authorizeInvocation(identity, registration);
        const result = store.register(registration);
        onChange(result);
        callback(null, { invocationId: result.invocationId, runKey: result.runKey, reportUrl: `${httpAddress}/runs/${encodeURIComponent(result.runKey)}` });
      })().catch(error => callback(rpcError(error)));
    },
    publish(call, callback) {
      (async () => {
        const identity = await principal(call);
        const registration = store.invocation(call.request.invocationId);
        if (!registration) throw new StoreError('Register invocation before publishing', 'NOT_FOUND');
        authenticate.authorizeInvocation(identity, registration);
        const result = store.append(call.request);
        onChange(result);
        callback(null, { lastSequence: result.lastSequence });
      })().catch(error => callback(rpcError(error)));
    },
  });

  async function close() {
    if (stopping) return stopping;
    stopping = (async () => {
      clearInterval(timer);
      await stopReconciler();
      for (const client of clients) client.end();
      clients.clear();
      await Promise.all([
        new Promise(resolveClose => { http.close(resolveClose); http.closeAllConnections(); }),
        new Promise(resolveClose => {
          const timeout = setTimeout(() => { rpc.forceShutdown(); resolveClose(); }, 5000);
          timeout.unref();
          rpc.tryShutdown(() => { clearTimeout(timeout); resolveClose(); });
        }),
      ]);
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
      for (const client of clients) send(client, 'invalidate', { revision: store.revision, runId: null, reason: 'liveness' });
    }, config.livenessIntervalMs ?? 15_000);
    timer.unref();
    stopReconciler = startGithubReconciler({ store, onChange, token: config.githubToken, intervalMs: config.githubIntervalMs, onWarning: config.onWarning });
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
