import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import * as sqlite from 'node:sqlite';
import { GitHubApp, GitHubAccessError, githubAppConfigFromEnv, validateCsrf } from './github-app.mjs';

const Database = sqlite.Database || sqlite.DatabaseSync;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const installation = { id: 10, app_id: 12, account: { id: 500, login: 'our-team', type: 'Organization' } };
const repo = { id: 101, full_name: 'our-team/project', private: true };
const config = { mode: 'github', appId: '12', clientId: 'client-id', clientSecret: 'client-secret', privateKey,
  publicUrl: 'https://builds.example.test', sessionSecret: 'session-secret-only-for-unit-tests-123456', webhookSecret: 'webhook-secret-only-for-unit-tests-123456' };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const cookieHeader = value => (Array.isArray(value) ? value : [value]).map(cookie => cookie.split(';')[0]).join('; ');

function fixture(t, overrides = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const clock = { now: 1_800_000_000_000 };
  const data = {
    user: { id: 1, login: 'alice', name: 'Alice' }, installations: [installation], repositories: { 10: [repo] },
    credentials: { access_token: 'user-secret', expires_in: 28_800, refresh_token: 'refresh-secret', refresh_token_expires_in: 15_811_200 },
    inventory: [repo], calls: [], ...overrides,
  };
  const app = new GitHubApp(config, { db, now: () => clock.now, fetch: async (url, options) => {
    const parsed = new URL(url), body = options.body ? JSON.parse(options.body) : undefined;
    const call = { url: parsed, options, body }; data.calls.push(call);
    const custom = await data.onFetch?.(call);
    if (custom) return custom;
    if (parsed.pathname === '/login/oauth/access_token') return response(data.credentials);
    if (parsed.pathname === '/user') return response(data.user);
    const page = Number(parsed.searchParams.get('page') || 1), pageItems = values => values.slice((page - 1) * 100, page * 100);
    if (parsed.pathname === '/user/installations') return response({ installations: pageItems(data.installations) });
    const repositories = parsed.pathname.match(/^\/user\/installations\/(\d+)\/repositories$/);
    if (repositories) return response({ repositories: pageItems(data.repositories[repositories[1]] || []) });
    if (parsed.pathname === '/app') return response({ slug: 'nix-ci-build' });
    if (parsed.pathname.endsWith('/installation')) return data.installations.length ? response(data.installations[0]) : response({}, 404);
    if (parsed.pathname === '/app/installations/10/access_tokens') {
      if (!data.inventory.some(repository => body.repository_ids.includes(repository.id))) return response({}, 422);
      return response({ token: 'installation-secret', expires_at: new Date(clock.now + 3600_000).toISOString() });
    }
    const found = data.inventory.find(repository => parsed.pathname === `/repos/${repository.full_name}`);
    if (found) return response(found);
    throw new Error(`Unexpected test route ${parsed.pathname}`);
  } });
  return { app, db, clock, data };
}

async function login(app, returnTo = '/') {
  const start = app.beginOAuth(returnTo);
  const result = await app.finishOAuth({ code: 'authorization-code', state: new URL(start.url).searchParams.get('state'), cookie: cookieHeader(start.cookie) });
  return { ...result, start, cookie: cookieHeader(result.cookies) };
}

test('GitHub mode is explicit and fails closed without usable configuration', () => {
  assert.deepEqual(githubAppConfigFromEnv({}), { mode: 'local' });
  assert.throws(() => githubAppConfigFromEnv({ NIX_CI_LIVE_ACCESS_MODE: 'anonymous' }), /local or github/);
  assert.throws(() => githubAppConfigFromEnv({ NIX_CI_LIVE_ACCESS_MODE: 'github' }), /PUBLIC_URL/);
  const env = { NIX_CI_LIVE_ACCESS_MODE: 'github', NIX_CI_LIVE_PUBLIC_URL: config.publicUrl,
    NIX_CI_LIVE_GITHUB_APP_ID: '12', NIX_CI_LIVE_GITHUB_CLIENT_ID: 'id', NIX_CI_LIVE_GITHUB_CLIENT_SECRET: 'secret',
    NIX_CI_LIVE_GITHUB_PRIVATE_KEY_FILE: '/private.pem', NIX_CI_LIVE_GITHUB_WEBHOOK_SECRET: config.webhookSecret, NIX_CI_LIVE_SESSION_SECRET: config.sessionSecret };
  assert.equal(githubAppConfigFromEnv(env).mode, 'github');
  for (const url of ['http://builds.example.test', 'https://user:password@example.test', 'https://builds.example.test/a', 'https://builds.example.test/?query=yes']) {
    assert.throws(() => githubAppConfigFromEnv({ ...env, NIX_CI_LIVE_PUBLIC_URL: url }), /origin/);
  }
  assert.equal(githubAppConfigFromEnv({ ...env, NIX_CI_LIVE_PUBLIC_URL: 'http://localhost:8799' }).publicUrl, 'http://localhost:8799');
  assert.throws(() => githubAppConfigFromEnv({ ...env, NIX_CI_LIVE_SESSION_SECRET: 'short' }), /32 bytes/);
});

test('OAuth binds state to the initiating browser, uses PKCE, and issues a private expiring session', async t => {
  const { app, data, clock } = fixture(t);
  const first = app.beginOAuth('/runs/123?job=1'), other = app.beginOAuth('/');
  const url = new URL(first.url), state = url.searchParams.get('state');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(app.finishOAuth({ code: 'code', state, cookie: cookieHeader(other.cookie) }), GitHubAccessError);
  assert.equal(data.calls.length, 0);
  const result = await app.finishOAuth({ code: 'code', state, cookie: cookieHeader(first.cookie) });
  const exchange = data.calls.find(call => call.url.pathname === '/login/oauth/access_token');
  assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(exchange.body.redirect_uri, `${config.publicUrl}/auth/github/callback`);
  assert.equal(result.returnTo, '/runs/123?job=1');
  assert.match(result.cookies[0], /__Host-nix_ci_live_session=.*; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure/);
  assert.ok(!JSON.stringify(result).includes('user-secret'));
  const session = app.session(cookieHeader(result.cookies));
  assert.equal(session.user.login, 'alice');
  assert.ok(validateCsrf(session, session.csrfToken));
  assert.ok(!validateCsrf(session, 'wrong'));
  await assert.rejects(app.finishOAuth({ code: 'code', state, cookie: cookieHeader(first.cookie) }), GitHubAccessError);
  clock.now += 7 * 24 * 3600_000;
  assert.equal(app.session(cookieHeader(result.cookies)), null);
  await assert.rejects(app.repositoryIds(session), /Sign in/);
});

test('login return paths cannot redirect to another site and logout invalidates the session', async t => {
  const { app } = fixture(t);
  for (const value of ['https://attacker.test', '//attacker.test', '/\\attacker.test', '/\nredirect']) {
    const result = await login(app, value);
    assert.equal(result.returnTo, '/');
    assert.ok(app.session(result.cookie));
    assert.match(app.logout(result.cookie), /Max-Age=0/);
    assert.equal(app.session(result.cookie), null);
  }
});

test('OAuth lists every installation and only repositories the signed-in user can access, with pagination', async t => {
  const installs = Array.from({ length: 101 }, (_, index) => ({ ...installation, id: index + 10, account: { ...installation.account, id: index + 500, login: `team-${index}` } }));
  const visible = Array.from({ length: 101 }, (_, index) => ({ id: index + 101, full_name: `team-0/project-${index}`, private: true }));
  const { app, data } = fixture(t, { installations: installs, repositories: { 10: visible }, inventory: [...visible, { id: 999, full_name: 'team-0/secret', private: true }] });
  const { session } = await login(app);
  const { connections } = await app.connections(session);
  assert.equal(connections.length, 101);
  const ids = await app.repositoryIds(session);
  assert.equal(ids.size, 101);
  assert.ok(!ids.has('999'));
  assert.ok(data.calls.some(call => call.url.pathname === '/user/installations' && call.url.searchParams.get('page') === '2'));
  assert.ok(data.calls.some(call => call.url.pathname === '/user/installations/10/repositories' && call.url.searchParams.get('page') === '2'));
  assert.ok(!data.calls.some(call => call.url.pathname === '/installation/repositories'));
});

test('different members of the same organization never inherit one another’s private repo visibility', async t => {
  const { app, data } = fixture(t);
  const alice = await login(app);
  data.user = { id: 2, login: 'bob' };
  data.repositories[10] = [{ id: 102, full_name: 'our-team/bobs-project', private: true }];
  const bob = await login(app);
  assert.deepEqual([...await app.repositoryIds(alice.session)], ['101']);
  assert.deepEqual([...await app.repositoryIds(bob.session)], ['102']);
  assert.equal((await app.connections(alice.session)).connections[0].repositories.length, 1);
});

test('permission refresh removes departed users and fails closed when GitHub cannot verify stale access', async t => {
  const { app, data, clock } = fixture(t);
  const { session } = await login(app);
  assert.deepEqual([...app.cachedRepositoryIds(session)], ['101']);
  clock.now += 300_001;
  assert.equal(app.cachedRepositoryIds(session), null);
  data.onFetch = ({ url }) => url.pathname === '/user/installations' ? response({ message: 'internal sensitive context' }, 500) : null;
  await assert.rejects(app.repositoryIds(session), error => error.status === 503 && !error.message.includes('sensitive'));
  assert.equal(app.cachedRepositoryIds(session), null);
  data.onFetch = null;
  data.installations = [];
  assert.equal((await app.repositoryIds(session)).size, 0);
  assert.equal((await app.connections(session)).connections.length, 0);
  assert.equal(app.cachedRepositoryIds(session).size, 0);
});

test('expired user credentials rotate once across concurrent refreshes and revoked credentials remove sessions', async t => {
  const { app, data, clock } = fixture(t);
  const { session, cookie } = await login(app);
  clock.now += 28_800_000;
  data.credentials = { access_token: 'renewed-user-secret', expires_in: 28_800, refresh_token: 'rotated-refresh', refresh_token_expires_in: 100_000 };
  await Promise.all([app.connections(session, { refresh: true }), app.repositoryIds(session), app.connections(session, { refresh: true })]);
  const refreshes = data.calls.filter(call => call.body?.grant_type === 'refresh_token');
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].body.refresh_token, 'refresh-secret');
  assert.equal(app.store.credentials('1').refreshToken, 'rotated-refresh');
  data.onFetch = ({ url }) => url.pathname === '/user/installations' ? response({}, 401) : null;
  await assert.rejects(app.connections(session, { refresh: true }), error => error.status === 401);
  assert.equal(app.session(cookie), null);
  assert.equal(app.store.repositoryIds('1').size, 0);
});

test('signed lifecycle events revoke access immediately and delayed created events cannot restore it', async t => {
  const { app } = fixture(t);
  const { session } = await login(app);
  app.handleInstallationEvent('installation_repositories', { action: 'removed', installation, repositories_removed: [repo] });
  assert.equal((await app.repositoryIds(session, { refresh: false })).size, 0);
  assert.equal(app.cachedRepositoryIds(session), null);
  await app.connections(session, { refresh: true });
  app.handleInstallationEvent('installation', { action: 'deleted', installation });
  assert.equal((await app.repositoryIds(session, { refresh: false })).size, 0);
  app.handleInstallationEvent('installation', { action: 'created', installation, repositories: [repo] });
  assert.equal(app.store.installation('10').status, 'deleted');
  assert.equal((await app.repositoryIds(session, { refresh: false })).size, 0);
});

test('an in-flight membership response cannot resurrect an installation revoked by webhook', async t => {
  const { app, data } = fixture(t);
  const { session } = await login(app);
  data.onFetch = ({ url }) => {
    if (url.pathname.endsWith('/repositories')) app.handleInstallationEvent('installation', { action: 'suspend', installation });
    return null;
  };
  await assert.rejects(app.connections(session, { refresh: true }), /permissions changed/);
  assert.equal((await app.repositoryIds(session, { refresh: false })).size, 0);
  assert.equal(app.store.installation('10').status, 'suspended');
});

test('unknown reporter repositories are verified with a repo-scoped installation token and signed app JWT', async t => {
  const { app, data } = fixture(t);
  const identity = { repositoryId: '101', repository: 'our-team/project' };
  assert.equal(await app.isRepositoryConnected(identity), true);
  assert.equal(await app.installationToken(identity), 'installation-secret');
  const request = data.calls.find(call => call.url.pathname.endsWith('/access_tokens'));
  assert.deepEqual(request.body, { repository_ids: [101], permissions: { actions: 'read', metadata: 'read' } });
  const jwt = request.options.headers.authorization.slice('Bearer '.length), [header, claims, signature] = jwt.split('.');
  assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), keys.publicKey, Buffer.from(signature, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, '12');
  assert.equal(await app.isRepositoryConnected({ ...identity, repositoryId: '999' }), false);
  assert.equal(await app.isRepositoryConnected({ ...identity, installationId: '999' }), false);
  assert.equal(await app.isRepositoryConnected({ ...identity, repositoryId: undefined }), false);
  assert.equal(data.calls.filter(call => call.url.pathname.endsWith('/access_tokens') && call.body.repository_ids.includes(101)).length, 1);
});

test('webhook installation inventory works before the first login but never grants user visibility', async t => {
  const { app, data } = fixture(t);
  assert.equal(app.handleInstallationEvent('installation', { action: 'created', installation, repositories: [repo] }), true);
  assert.equal(await app.isRepositoryConnected({ repositoryId: '101', repository: repo.full_name }), true);
  assert.equal(data.calls.length, 0);
  assert.equal(app.store.repositoryIds('1').size, 0);
  assert.deepEqual(app.connectedRepositories(), [{ repositoryId: '101', repository: repo.full_name }]);
  assert.equal(await app.installUrl(), 'https://github.com/apps/nix-ci-build/installations/new');
  assert.equal(await app.installUrl(), 'https://github.com/apps/nix-ci-build/installations/new');
  assert.equal(data.calls.length, 1);
  app.handleInstallationEvent('installation', { action: 'suspend', installation });
  assert.deepEqual(app.connectedRepositories(), []);
});

test('installation token creation cannot repopulate its cache after a revocation', async t => {
  const { app, data } = fixture(t);
  app.handleInstallationEvent('installation', { action: 'created', installation, repositories: [repo] });
  data.onFetch = ({ url }) => {
    if (url.pathname.endsWith('/access_tokens')) app.handleInstallationEvent('installation', { action: 'deleted', installation });
    return null;
  };
  await assert.rejects(app.installationToken({ repositoryId: '101', repository: repo.full_name }), /permissions changed/);
  assert.equal(app.installationTokens.size, 0);
  assert.equal(app.store.installation('10').status, 'deleted');
});

test('GitHub App user authorization revocation removes all browser sessions and cached grants', async t => {
  const { app } = fixture(t);
  const first = await login(app), second = await login(app);
  app.handleInstallationEvent('github_app_authorization', { action: 'revoked', sender: { id: 1 } });
  assert.equal(app.session(first.cookie), null);
  assert.equal(app.session(second.cookie), null);
  assert.equal(app.store.repositoryIds('1').size, 0);
  assert.throws(() => app.cachedRepositoryIds(first.session), /Sign in/);
  await assert.rejects(app.repositoryIds(first.session), /Sign in/);
});
