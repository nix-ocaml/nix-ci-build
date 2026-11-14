import { createHash, createPrivateKey, sign, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConnectionStore } from './connections.mjs';

const SESSION_SECONDS = 7 * 24 * 3600;
const ACCESS_TTL_MS = 5 * 60_000;
const validId = value => /^(?:[1-9][0-9]*)$/.test(String(value)) && Number.isSafeInteger(Number(value));
const validRepository = value => typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
const safeReturn = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\u0000-\u0020]/.test(value) && value.length <= 2048 ? value : '/';

export class GitHubAccessError extends Error {
  constructor(message, status = 401) { super(message); this.name = 'GitHubAccessError'; this.status = status; }
}

export function githubAppConfigFromEnv(env = process.env) {
  const mode = env.NIX_CI_LIVE_ACCESS_MODE || 'local';
  if (!['local', 'github'].includes(mode)) throw new Error('NIX_CI_LIVE_ACCESS_MODE must be local or github');
  if (mode === 'local') return { mode };
  const fields = {
    publicUrl: 'NIX_CI_LIVE_PUBLIC_URL', appId: 'NIX_CI_LIVE_GITHUB_APP_ID', clientId: 'NIX_CI_LIVE_GITHUB_CLIENT_ID',
    clientSecret: 'NIX_CI_LIVE_GITHUB_CLIENT_SECRET', privateKeyFile: 'NIX_CI_LIVE_GITHUB_PRIVATE_KEY_FILE',
    webhookSecret: 'NIX_CI_LIVE_GITHUB_WEBHOOK_SECRET', sessionSecret: 'NIX_CI_LIVE_SESSION_SECRET',
  };
  const config = { mode };
  for (const [field, variable] of Object.entries(fields)) {
    if (!env[variable]?.trim()) throw new Error(`${variable} is required in GitHub access mode`);
    config[field] = env[variable];
  }
  let url;
  try { url = new URL(config.publicUrl); } catch { throw new Error('NIX_CI_LIVE_PUBLIC_URL must be an absolute origin'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('NIX_CI_LIVE_PUBLIC_URL must be an HTTPS origin (HTTP is allowed only on loopback)');
  }
  if (!validId(config.appId)) throw new Error('NIX_CI_LIVE_GITHUB_APP_ID must be a positive integer');
  if (Buffer.byteLength(config.sessionSecret) < 32) throw new Error('NIX_CI_LIVE_SESSION_SECRET must contain at least 32 bytes');
  if (Buffer.byteLength(config.webhookSecret) < 32) throw new Error('NIX_CI_LIVE_GITHUB_WEBHOOK_SECRET must contain at least 32 bytes');
  config.publicUrl = url.origin;
  return config;
}

export function validateCsrf(session, value) {
  if (typeof value !== 'string' || !session?.csrfToken) return false;
  const expected = Buffer.from(session.csrfToken), provided = Buffer.from(value);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function cookieValue(header, name) {
  if (typeof header !== 'string' || header.length > 16_384) return null;
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}

function validInstallation(value) {
  return value && validId(value.id) && validId(value.account?.id) && typeof value.account.login === 'string' && ['User', 'Organization'].includes(value.account.type);
}

function validRepo(value) { return value && validId(value.id) && validRepository(value.full_name); }

/** HTTP-independent GitHub integration. Request handlers own cookies, redirects,
 * CSRF checks and webhook signature verification; no credentials reach the UI. */
export class GitHubApp {
  constructor(config, { db, now = () => Date.now(), fetch: fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.now = now;
    this.fetch = fetchImpl;
    this.store = new ConnectionStore(db, { secret: config.sessionSecret, now });
    try {
      this.privateKey = createPrivateKey(config.privateKey || readFileSync(config.privateKeyFile));
      if (this.privateKey.asymmetricKeyType !== 'rsa') throw new Error('Expected RSA key');
    } catch { throw new Error('GitHub App private key must be a readable RSA PEM private key'); }
    this.secure = new URL(config.publicUrl).protocol === 'https:';
    this.sessionCookieName = `${this.secure ? '__Host-' : ''}nix_ci_live_session`;
    this.oauthCookieName = `${this.secure ? '__Host-' : ''}nix_ci_live_oauth`;
    this.pendingRefresh = new Map();
    this.pendingCredentials = new Map();
    this.installationTokens = new Map();
    this.pendingRepository = new Map();
    this.installationGeneration = new Map();
    this.accessGeneration = 0;
  }

  cookie(name, value, maxAge) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`;
  }

  beginOAuth(returnTo = '/') {
    const authorization = this.store.beginOAuth(safeReturn(returnTo));
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: `${this.config.publicUrl}/auth/github/callback`,
      state: authorization.state, code_challenge: createHash('sha256').update(authorization.verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return { url: url.href, cookie: this.cookie(this.oauthCookieName, authorization.browser, 600) };
  }

  async finishOAuth({ code, state, cookie }) {
    const authorization = this.store.consumeOAuth(state, cookieValue(cookie, this.oauthCookieName));
    if (!authorization || typeof code !== 'string' || !code || code.length > 2048) throw new GitHubAccessError('GitHub sign-in expired or could not be verified. Please sign in again.', 400);
    const credentials = await this.exchange({ code, code_verifier: authorization.verifier, redirect_uri: `${this.config.publicUrl}/auth/github/callback` });
    const user = await this.request('/user', credentials.accessToken);
    if (!validId(user.id) || typeof user.login !== 'string') throw new GitHubAccessError('GitHub returned an invalid user profile', 502);
    const profile = this.store.saveUser(user, credentials);
    await this.refreshUser(profile.id);
    this.logout(cookie);
    const session = this.store.createSession(profile.id, SESSION_SECONDS * 1000);
    const { token, ...view } = session;
    return { session: view, cookies: [this.cookie(this.sessionCookieName, token, SESSION_SECONDS), this.cookie(this.oauthCookieName, '', 0)], returnTo: authorization.returnTo };
  }

  session(cookie) { return this.store.session(cookieValue(cookie, this.sessionCookieName)); }
  logout(cookie) { this.store.logout(cookieValue(cookie, this.sessionCookieName)); return this.cookie(this.sessionCookieName, '', 0); }

  requireSession(session) {
    const row = session?.id && this.store.db.prepare('SELECT user_id, expires_at FROM connection_sessions WHERE token_hash=?').get(session.id);
    if (!row || row.user_id !== session.user?.id || row.expires_at <= this.now()) throw new GitHubAccessError('Sign in with GitHub to view these builds');
  }

  async connections(session, { refresh = false } = {}) {
    this.requireSession(session);
    const existing = this.store.connections(session.user.id);
    if (refresh || !existing.refreshedAtMs || this.now() - existing.refreshedAtMs >= ACCESS_TTL_MS) await this.refreshUser(session.user.id);
    this.requireSession(session);
    return this.store.connections(session.user.id);
  }

  async repositoryIds(session, { refresh = true } = {}) {
    this.requireSession(session);
    if (refresh) await this.connections(session);
    return this.store.repositoryIds(session.user.id);
  }

  /** SSE invalidations must stop while stale permissions await a GitHub refresh.
   * A transient GitHub outage is not grounds to sign the user out, but old
   * grants must not authorize further events after their cache lifetime. */
  cachedRepositoryIds(session) {
    this.requireSession(session);
    const refreshedAtMs = this.store.refreshedAt(session.user.id);
    if (!refreshedAtMs || this.now() - refreshedAtMs >= ACCESS_TTL_MS) return null;
    return this.store.repositoryIds(session.user.id);
  }

  connectedRepositories() { return this.store.connectedRepositories(); }

  appJwt() {
    const seconds = Math.floor(this.now() / 1000);
    const payload = [JSON.stringify({ alg: 'RS256', typ: 'JWT' }), JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: this.config.appId })]
      .map(value => Buffer.from(value).toString('base64url')).join('.');
    return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), this.privateKey).toString('base64url')}`;
  }

  async request(path, token, { method = 'GET', body, oauth = false } = {}) {
    const url = oauth ? 'https://github.com/login/oauth/access_token' : `https://api.github.com${path}`;
    let response;
    try {
      response = await this.fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { accept: oauth ? 'application/json' : 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'nix-ci-build-live',
          ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new GitHubAccessError('GitHub is temporarily unavailable. Please try again.', 503); }
    if (!response.ok) {
      // GitHub error bodies can contain supplied secrets or repository details.
      // Neither is needed in a browser error or service log.
      const error = new GitHubAccessError(response.status === 401 ? 'GitHub authorization expired. Please sign in again.' : 'GitHub access could not be verified. Please try again.', response.status === 401 ? 401 : 503);
      error.githubStatus = response.status;
      throw error;
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new GitHubAccessError('GitHub response exceeded its size limit', 502);
    try { return JSON.parse(raw); } catch { throw new GitHubAccessError('GitHub returned an invalid response', 502); }
  }

  async exchange(parameters) {
    const result = await this.request('', null, { oauth: true, method: 'POST', body: {
      client_id: this.config.clientId, client_secret: this.config.clientSecret, ...parameters,
    } });
    if (typeof result.access_token !== 'string' || !result.access_token || result.error) throw new GitHubAccessError('GitHub authorization expired. Please sign in again.');
    const expiry = value => Number.isSafeInteger(value) && value > 0 ? this.now() + value * 1000 : null;
    return { accessToken: result.access_token, expiresAtMs: expiry(result.expires_in), refreshToken: result.refresh_token || null, refreshExpiresAtMs: expiry(result.refresh_token_expires_in) };
  }

  async userToken(userId) {
    if (this.pendingCredentials.has(userId)) return this.pendingCredentials.get(userId);
    const task = (async () => {
      const credentials = this.store.credentials(userId);
      if (!credentials?.accessToken) throw new GitHubAccessError('GitHub authorization expired. Please sign in again.');
      if (!credentials.expiresAtMs || credentials.expiresAtMs > this.now() + 60_000) return credentials.accessToken;
      if (!credentials.refreshToken || (credentials.refreshExpiresAtMs && credentials.refreshExpiresAtMs <= this.now())) {
        this.store.revokeUser(userId);
        throw new GitHubAccessError('GitHub authorization expired. Please sign in again.');
      }
      try {
        const renewed = await this.exchange({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken });
        this.store.saveCredentials(userId, renewed);
        return renewed.accessToken;
      } catch (error) { if (error.status === 401) this.store.revokeUser(userId); throw error; }
    })();
    this.pendingCredentials.set(userId, task);
    try { return await task; } finally { this.pendingCredentials.delete(userId); }
  }

  async pages(path, token, field) {
    const rows = [];
    for (let page = 1; page <= 1000; page++) {
      const response = await this.request(`${path}?per_page=100&page=${page}`, token);
      const values = response[field];
      if (!Array.isArray(values)) throw new GitHubAccessError('GitHub returned an invalid repository list', 502);
      rows.push(...values);
      if (values.length < 100) return rows;
    }
    throw new GitHubAccessError('GitHub returned too many repository pages', 502);
  }

  async refreshUser(userId) {
    if (this.pendingRefresh.has(userId)) return this.pendingRefresh.get(userId);
    const task = (async () => {
      try {
        const generation = this.accessGeneration;
        const token = await this.userToken(userId);
        const installations = await this.pages('/user/installations', token, 'installations');
        const connections = [];
        for (const installation of installations) {
          if (!validInstallation(installation) || (installation.app_id && String(installation.app_id) !== String(this.config.appId))) continue;
          const repositories = installation.suspended_at ? [] : await this.pages(`/user/installations/${installation.id}/repositories`, token, 'repositories');
          if (!repositories.every(validRepo)) throw new GitHubAccessError('GitHub returned an invalid repository list', 502);
          connections.push({ installation, repositories });
        }
        if (generation !== this.accessGeneration) throw new GitHubAccessError('GitHub permissions changed while refreshing. Please try again.', 503);
        this.store.saveConnections(userId, connections);
      } catch (error) {
        if (error.status === 401) this.store.revokeUser(userId);
        throw error;
      }
    })();
    this.pendingRefresh.set(userId, task);
    try { return await task; } finally { this.pendingRefresh.delete(userId); }
  }

  async installUrl() {
    if (!this.appSlug) {
      const app = await this.request('/app', this.appJwt());
      if (typeof app.slug !== 'string' || !/^[A-Za-z0-9-]+$/.test(app.slug)) throw new GitHubAccessError('GitHub returned an invalid app name', 502);
      this.appSlug = app.slug;
    }
    return `https://github.com/apps/${this.appSlug}/installations/new`;
  }

  async scopedToken(installationId, repositoryId) {
    const key = `${installationId}:${repositoryId}`;
    const cached = this.installationTokens.get(key);
    if (cached && cached.expiresAtMs > this.now() + 60_000) return cached.token;
    const generation = this.installationGeneration.get(installationId) || 0;
    const response = await this.request(`/app/installations/${installationId}/access_tokens`, this.appJwt(), {
      method: 'POST', body: { repository_ids: [Number(repositoryId)], permissions: { actions: 'read', metadata: 'read' } },
    });
    const expiresAtMs = Date.parse(response.expires_at);
    if (typeof response.token !== 'string' || !Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) throw new GitHubAccessError('GitHub returned an invalid installation token', 502);
    if ((this.installationGeneration.get(installationId) || 0) !== generation) throw new GitHubAccessError('GitHub permissions changed while obtaining access. Please try again.', 503);
    this.installationTokens.set(key, { token: response.token, expiresAtMs });
    return response.token;
  }

  async isRepositoryConnected({ repositoryId, repository, installationId } = {}) {
    if (!validId(repositoryId) || !validRepository(repository)) return false;
    const id = String(repositoryId);
    const existing = this.store.repository(id);
    if (existing && existing.status === 'active' && (!installationId || existing.installationId === String(installationId)) && this.now() - existing.verifiedAtMs < ACCESS_TTL_MS) return true;
    const pendingKey = `${id}:${installationId || ''}`;
    if (this.pendingRepository.has(pendingKey)) return this.pendingRepository.get(pendingKey);
    const task = (async () => {
      try {
        const generation = this.accessGeneration;
        const installation = await this.request(`/repos/${repository}/installation`, this.appJwt());
        if (!validInstallation(installation) || installation.suspended_at || (installationId && String(installation.id) !== String(installationId))) return false;
        const token = await this.scopedToken(String(installation.id), id);
        const confirmed = await this.request(`/repos/${repository}`, token);
        if (!validRepo(confirmed) || String(confirmed.id) !== id || this.accessGeneration !== generation) return false;
        this.store.upsertInstallation(installation);
        this.store.upsertRepository(installation.id, confirmed);
        return true;
      } catch (error) {
        if ([401, 403, 404, 422].includes(error.githubStatus)) return false;
        throw error;
      }
    })();
    this.pendingRepository.set(pendingKey, task);
    try { return await task; } finally { this.pendingRepository.delete(pendingKey); }
  }

  async installationToken(identity) {
    if (!(await this.isRepositoryConnected(identity))) return null;
    const repository = this.store.repository(identity.repositoryId);
    if (!repository || repository.status !== 'active') return null;
    return this.scopedToken(repository.installationId, repository.id);
  }

  /** Call only after authenticating the webhook body, outside EventStore's
   * transaction. Deletion and suspension immediately remove user visibility. */
  handleInstallationEvent(event, payload) {
    if (event === 'github_app_authorization' && payload.action === 'revoked' && validId(payload.sender?.id)) {
      this.accessGeneration++;
      this.store.revokeUser(String(payload.sender.id));
      return true;
    }
    if (!['installation', 'installation_repositories'].includes(event) || !validInstallation(payload.installation)) return false;
    const installation = payload.installation, id = String(installation.id);
    if (installation.app_id && String(installation.app_id) !== String(this.config.appId)) return false;
    this.accessGeneration++;
    this.installationGeneration.set(id, (this.installationGeneration.get(id) || 0) + 1);
    for (const key of this.installationTokens.keys()) if (key.startsWith(`${id}:`)) this.installationTokens.delete(key);
    return this.store.transaction(() => {
      const previous = this.store.installation(id);
      this.store.upsertInstallation(installation);
      if (event === 'installation' && ['deleted', 'suspend'].includes(payload.action)) {
        this.store.invalidateInstallation(id, { status: payload.action === 'deleted' ? 'deleted' : 'suspended', transaction: false });
      } else {
        // A delayed created/added delivery cannot undo a newer revocation.
        // A fresh GitHub API read may reactivate a suspended installation.
        this.store.invalidateInstallation(id, { status: previous?.status !== 'active' ? previous?.status : undefined, transaction: false,
          removedRepositoryIds: (payload.repositories_removed || []).filter(validRepo).map(repository => repository.id) });
        if (!previous || previous.status === 'active') for (const repository of (payload.repositories_added || payload.repositories || []).filter(validRepo)) this.store.upsertRepository(id, repository);
      }
      return true;
    });
  }
}

export function createGitHubApp(config, options) { return new GitHubApp(config, options); }
