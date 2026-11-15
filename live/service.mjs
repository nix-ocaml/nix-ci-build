import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { validateCsrf } from './github-app.mjs';
import { ingestGithubWebhook } from './github-webhooks.mjs';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function redirect(response, location, cookies) {
  if (cookies) response.setHeader('set-cookie', cookies);
  response.writeHead(303, { location, 'cache-control': 'no-store' });
  response.end();
}

function requireMethod(request, expected) {
  if (request.method !== expected) throw new HttpError(405, `Use ${expected} for this endpoint`);
}

function readBody(request, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const clean = () => {
      request.off('data', data); request.off('end', end); request.off('error', error); request.off('aborted', aborted);
    };
    const error = () => { clean(); reject(new HttpError(400, 'Incomplete webhook delivery')); };
    const aborted = error;
    const end = () => { clean(); resolve(Buffer.concat(chunks)); };
    const data = chunk => {
      size += chunk.length;
      if (size > limit) {
        clean(); request.resume(); reject(new HttpError(413, 'Webhook delivery exceeds 4 MiB'));
      } else chunks.push(chunk);
    };
    request.on('data', data); request.once('end', end); request.once('error', error); request.once('aborted', aborted);
  });
}

export function verifyWebhook(body, signature, secret) {
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

/** HTTP account lifecycle is separate from the OIDC-authenticated reporter. */
export function createService({ app, config, store, onChange, onAccessChange = () => {} }) {
  const mode = app ? 'github' : 'local';
  if (app) store.db.exec(`CREATE TABLE IF NOT EXISTS service_webhook_deliveries (
    id TEXT PRIMARY KEY, digest TEXT NOT NULL, received_at INTEGER NOT NULL
  ) STRICT`);

  function session(request) {
    const value = app?.session(request.headers.cookie);
    if (app && !value) throw new HttpError(401, 'Sign in with GitHub to view these builds');
    return value || null;
  }

  async function viewer(request) {
    const account = session(request);
    const repositoryIds = account ? await app.repositoryIds(account) : null;
    return { session: account, repositoryIds, cookie: request.headers.cookie };
  }

  async function sessionPayload(request, { refresh = false } = {}) {
    const account = app?.session(request.headers.cookie);
    const base = { mode, user: null, connections: [], signInUrl: app ? '/auth/github' : null, installUrl: null };
    if (!account) return base;
    const connection = await app.connections(account, { refresh });
    return { ...base, ...connection, user: account.user, csrfToken: account.csrfToken, installUrl: await app.installUrl() };
  }

  function mutation(request) {
    requireMethod(request, 'POST');
    const account = session(request);
    if (!account || !validateCsrf(account, request.headers['x-csrf-token'])) throw new HttpError(403, 'Refresh the page before trying again');
    return account;
  }

  async function webhook(request, response) {
    requireMethod(request, 'POST');
    if (!app) throw new HttpError(404, 'Endpoint not found');
    if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'Unsupported webhook encoding');
    const body = await readBody(request);
    if (!verifyWebhook(body, request.headers['x-hub-signature-256'], config.webhookSecret)) throw new HttpError(401, 'Invalid webhook signature');
    const event = request.headers['x-github-event'];
    const deliveryId = request.headers['x-github-delivery'];
    if (typeof event !== 'string' || !/^[a-z_]{1,64}$/.test(event) || typeof deliveryId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(deliveryId)) throw new HttpError(400, 'Invalid webhook identity');
    let payload;
    try { payload = JSON.parse(body); } catch { throw new HttpError(400, 'Invalid webhook JSON'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'Invalid webhook payload');
    if (event === 'workflow_run' || event === 'workflow_job') {
      const change = ingestGithubWebhook(store, { event, deliveryId, payload });
      onChange(change);
      json(response, 200, { ok: true, duplicate: !!change.duplicate });
    } else if (['installation', 'installation_repositories', 'github_app_authorization'].includes(event)) {
      const digest = createHash('sha256').update(event).update(body).digest('hex');
      const previous = store.db.prepare('SELECT digest FROM service_webhook_deliveries WHERE id = ?').get(deliveryId);
      if (previous && previous.digest !== digest) throw new HttpError(409, 'Conflicting webhook delivery');
      if (!previous) {
        // Lifecycle mutations are themselves transactional and idempotent; a
        // crash before recording the delivery safely repeats the invalidation.
        app.handleInstallationEvent(event, payload);
        store.db.prepare('INSERT INTO service_webhook_deliveries (id, digest, received_at) VALUES (?, ?, ?)').run(deliveryId, digest, Date.now());
        onAccessChange();
      }
      json(response, 200, { ok: true, duplicate: !!previous });
    } else json(response, 200, { ok: true, ignored: true });
  }

  async function route(request, response, url) {
    switch (url.pathname) {
      case '/api/session':
        requireMethod(request, 'GET');
        json(response, 200, await sessionPayload(request));
        return true;
      case '/webhooks/github':
        await webhook(request, response); return true;
      case '/auth/github': {
        requireMethod(request, 'GET');
        if (!app) throw new HttpError(404, 'GitHub sign-in is not enabled');
        const next = await app.beginOAuth(url.searchParams.get('returnTo') || '/');
        redirect(response, next.url, next.cookie); return true;
      }
      case '/auth/github/callback': {
        requireMethod(request, 'GET');
        if (!app) throw new HttpError(404, 'GitHub sign-in is not enabled');
        try {
          const result = await app.finishOAuth({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), cookie: request.headers.cookie });
          redirect(response, result.returnTo, result.cookies);
        } catch {
          // Never render the code, token, or upstream error response.
          redirect(response, '/?auth_error=github');
        }
        return true;
      }
      case '/auth/github/installed': {
        requireMethod(request, 'GET');
        if (!app) throw new HttpError(404, 'GitHub sign-in is not enabled');
        const account = app.session(request.headers.cookie);
        if (!account) {
          const next = await app.beginOAuth('/connections');
          redirect(response, next.url, next.cookie);
        } else {
          // The query's installation_id is untrusted; enumerate what this
          // signed-in user can actually access using their GitHub token.
          await app.connections(account, { refresh: true });
          onAccessChange();
          redirect(response, '/connections');
        }
        return true;
      }
      case '/api/connections/refresh':
        mutation(request);
        json(response, 200, await sessionPayload(request, { refresh: true }));
        onAccessChange(); return true;
      case '/auth/logout':
        mutation(request);
        response.setHeader('set-cookie', await app.logout(request.headers.cookie));
        json(response, 200, { ok: true });
        onAccessChange(); return true;
      default: return false;
    }
  }

  return { route, viewer, mode };
}
