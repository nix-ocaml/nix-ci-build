import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { startCollector } from './server.mjs';
import { GITHUB_ISSUER } from './auth.mjs';
import { grpc, ReportingClient } from './protocol.mjs';

const installation = { id: 100, app_id: 11, account: { id: 10, login: 'team', type: 'Organization' }, html_url: 'https://github.com/organizations/team/settings/installations/100' };
const repositories = [{ id: 1, full_name: 'team/alpha', private: true }, { id: 2, full_name: 'team/beta', private: true }];

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nix-live-service-'));
  let collector;
  t.after(async () => { await collector?.close(); rmSync(directory, { recursive: true, force: true }); });
  const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const oidc = await generateKeyPair('RS256');
  const publicJwk = { ...await exportJWK(oidc.publicKey), kid: 'test', alg: 'RS256' };
  const state = { installed: true, aliceRepos: [repositories[0]], bobRepos: [repositories[1]], calls: [] };
  const githubFetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const body = options.body && JSON.parse(options.body);
    const user = options.headers?.authorization?.split(' ').at(-1);
    state.calls.push({ path, body });
    const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/login/oauth/access_token') return response({ access_token: body.code, expires_in: 28800, refresh_token: `refresh-${body.code}`, refresh_token_expires_in: 15_552_000 });
    if (path === '/user') return response({ id: user === 'alice' ? 7 : 8, login: user, name: user === 'alice' ? 'Alice' : 'Bob' });
    if (path === '/app') return response({ slug: 'nix-ci-build-test' });
    if (path === '/user/installations') {
      await state.beforeUserList?.();
      return response({ installations: state.installed ? [installation] : [] });
    }
    if (path === '/user/installations/100/repositories') return response({ repositories: user === 'alice' ? state.aliceRepos : state.bobRepos });
    if (path === '/app/installations/100/access_tokens') return response({ token: `installation-${body.repository_ids[0]}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    const repo = repositories.find(repo => path === `/repos/${repo.full_name}` || path === `/repos/${repo.full_name}/installation`);
    if (repo && state.installed) return response(path.endsWith('/installation') ? installation : repo);
    return response({}, 404);
  };
  const config = {
    databasePath: join(directory, 'events.sqlite'), httpPort: 0, grpcPort: 0,
    auth: { mode: 'oidc', repositories: [], audience: 'nix-ci-build' },
    authOptions: { keySet: createLocalJWKSet({ keys: [publicJwk] }) },
    githubApp: { mode: 'github', publicUrl: 'https://dashboard.example.test', appId: '11', clientId: 'client-id', clientSecret: 'test-secret', privateKey: appKey, webhookSecret: 'w'.repeat(64), sessionSecret: 's'.repeat(64) },
    githubAppOptions: { fetch: githubFetch }, githubFetch, githubIntervalMs: 60_000,
    onWarning: () => {},
  };
  collector = await startCollector(config);
  async function request(path, options = {}) { return fetch(`${collector.httpAddress}${path}`, { redirect: 'manual', ...options }); }
  async function login(user, returnTo = '/connections') {
    const begin = await request(`/auth/github?returnTo=${encodeURIComponent(returnTo)}`);
    assert.equal(begin.status, 303);
    const authorize = new URL(begin.headers.get('location'));
    assert.equal(authorize.origin, 'https://github.com');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    const oauthCookie = begin.headers.getSetCookie()[0];
    assert.match(oauthCookie, /HttpOnly/); assert.match(oauthCookie, /Secure/);
    const response = await request(`/auth/github/callback?code=${user}&state=${authorize.searchParams.get('state')}`, {
      headers: { cookie: oauthCookie.split(';')[0], 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), returnTo);
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-nix_ci_live_session=')).split(';')[0];
    const session = await (await request('/api/session', { headers: { cookie } })).json();
    assert.equal(session.user.login, user);
    return { cookie, session };
  }
  async function webhook(event, payload, delivery = `delivery-${Math.random().toString(36).slice(2)}`, override = {}) {
    const body = JSON.stringify(payload);
    return request('/webhooks/github', { method: 'POST', body, headers: {
      'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery,
      'x-hub-signature-256': `sha256=${createHmac('sha256', config.githubApp.webhookSecret).update(body).digest('hex')}`, ...override,
    } });
  }
  async function reporterToken(repo = repositories[0], runId = '22') {
    return new SignJWT({ repository: repo.full_name, repository_id: String(repo.id), run_id: runId, run_attempt: '1', check_run_id: '33' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(GITHUB_ISSUER).setAudience('nix-ci-build')
      .setSubject(`repo:${repo.full_name}:ref:refs/heads/main`).setIssuedAt().setExpirationTime('5m').sign(oidc.privateKey);
  }
  return { config, state, request, login, webhook, reporterToken, get collector() { return collector; }, async restart() { await collector.close(); collector = await startCollector(config); } };
}

function workflow(repository = repositories[0], id = 22, status = 'queued', conclusion = null) {
  return { action: status === 'queued' ? 'requested' : status, installation: { id: installation.id }, repository,
    workflow_run: { id, run_attempt: 1, name: 'Nix packages', display_title: 'Build the package set', status, conclusion, event: 'push',
      head_sha: 'a'.repeat(40), head_branch: 'main', created_at: '2026-11-13T10:00:00Z', updated_at: '2026-11-13T10:01:00Z',
      html_url: `https://github.com/${repository.full_name}/actions/runs/${id}` },
  };
}

function invoke(client, method, body, token) {
  const metadata = new grpc.Metadata(); metadata.set('authorization', `Bearer ${token}`);
  return new Promise((resolve, reject) => client[method](body, metadata, { deadline: Date.now() + 5000 }, (error, value) => error ? reject(error) : resolve(value)));
}

test('GitHub service discovers durable runs before telemetry and isolates two users in the same team', async t => {
  const f = await fixture(t);
  const anonymous = await (await f.request('/api/session')).json();
  assert.equal(anonymous.mode, 'github'); assert.equal(anonymous.user, null);
  assert.equal((await f.request('/api/runs')).status, 401);
  assert.equal((await f.request('/api/events')).status, 401);
  assert.equal((await f.request('/api/session', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.webhook('workflow_run', workflow(), 'bad-signature', { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) })).status, 401);
  assert.equal(f.collector.store.listRuns().length, 0);
  assert.equal((await f.webhook('workflow_run', workflow(), 'alpha-queued')).status, 200);
  assert.equal((await f.webhook('workflow_run', workflow(repositories[1], 23), 'beta-queued')).status, 200);
  const duplicate = await (await f.webhook('workflow_run', workflow(), 'alpha-queued')).json();
  assert.equal(duplicate.duplicate, true);
  assert.equal((await f.webhook('workflow_run', workflow(repositories[1], 23), 'alpha-queued')).status, 409);
  const alice = await f.login('alice'), bob = await f.login('bob');
  const alphaId = 'github:team/alpha:22:1', betaId = 'github:team/beta:23:1';
  for (const [viewer, allowed, denied] of [[alice, alphaId, betaId], [bob, betaId, alphaId]]) {
    const headers = { cookie: viewer.cookie };
    const list = await (await f.request('/api/runs', { headers })).json();
    assert.deepEqual(list.runs.map(run => run.id), [allowed]);
    assert.equal(list.runs[0].invocationCount, 0);
    assert.equal(list.runs[0].status, 'queued');
    assert.equal((await f.request(`/api/runs/${encodeURIComponent(denied)}`, { headers })).status, 404);
    assert.equal((await f.request(`/api/runs/${encodeURIComponent(allowed)}`, { headers })).status, 200);
  }
  const controller = new AbortController(); t.after(() => controller.abort());
  const events = await f.request('/api/events', { headers: { cookie: alice.cookie }, signal: controller.signal });
  const reader = events.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
  await f.webhook('workflow_run', workflow(repositories[1], 23, 'in_progress'));
  await f.webhook('workflow_run', workflow(repositories[0], 22, 'in_progress'));
  const delta = new TextDecoder().decode((await reader.read()).value);
  assert.match(delta, /team\/alpha/); assert.doesNotMatch(delta, /team\/beta/);
  controller.abort();

  const client = new ReportingClient(f.collector.grpcAddress, grpc.credentials.createInsecure());
  t.after(() => client.close());
  const token = await f.reporterToken();
  const registered = await invoke(client, 'registerInvocation', { invocationId: 'alpha-builder', run: {
    repository: 'team/alpha', repositoryId: '1', runId: '22', runAttempt: 1,
  }, job: { jobId: 'build', checkRunId: '33' } }, token);
  assert.equal(registered.runKey, alphaId);
  assert.match(registered.reportUrl, /^https:\/\/dashboard\.example\.test\/runs\//);
  assert.equal(f.collector.store.listRuns().length, 2);
  const detail = await (await f.request(`/api/runs/${encodeURIComponent(alphaId)}`, { headers: { cookie: alice.cookie } })).json();
  assert.equal(detail.run.invocationCount, 1); assert.equal(detail.run.workflowStatus, 'running');
  assert.equal(detail.jobs.length, 1);
  const unknown = { id: 999, full_name: 'other/private' };
  await assert.rejects(invoke(client, 'registerInvocation', { invocationId: 'other-builder', run: {
    repository: unknown.full_name, repositoryId: '999', runId: '22', runAttempt: 1,
  }, job: { jobId: 'build', checkRunId: '33' } }, await f.reporterToken(unknown)), error => error.code === grpc.status.PERMISSION_DENIED);
  client.close();
  await f.restart();
  assert.deepEqual((await (await f.request('/api/runs', { headers: { cookie: alice.cookie } })).json()).runs.map(run => run.id), [alphaId]);
  assert.equal((await (await f.webhook('workflow_run', workflow(), 'alpha-queued')).json()).duplicate, true);
});

test('connection refresh, uninstall, OAuth replay and logout revoke access without exposing credentials', async t => {
  const f = await fixture(t);
  const alice = await f.login('alice');
  assert.doesNotMatch(JSON.stringify(alice.session), /accessToken|refreshToken|privateKey|clientSecret/);
  assert.deepEqual(alice.session.connections[0].repositories.map(repo => repo.id), ['1']);
  await f.webhook('workflow_run', workflow());
  assert.equal((await f.request('/api/connections/refresh', { method: 'POST', headers: { cookie: alice.cookie } })).status, 403);
  const headers = { cookie: alice.cookie, 'x-csrf-token': alice.session.csrfToken };
  assert.equal((await f.request('/auth/logout', { method: 'GET', headers })).status, 405);
  f.state.aliceRepos = [];
  assert.equal((await f.request('/api/connections/refresh', { method: 'POST', headers })).status, 200);
  assert.equal((await (await f.request('/api/runs', { headers })).json()).runs.length, 0);
  f.state.aliceRepos = [repositories[0]];
  await f.request('/api/connections/refresh', { method: 'POST', headers });
  assert.equal((await (await f.request('/api/runs', { headers })).json()).runs.length, 1);
  f.state.installed = false;
  const removed = { action: 'deleted', installation };
  assert.equal((await f.webhook('installation', removed, 'uninstalled')).status, 200);
  assert.equal((await (await f.webhook('installation', removed, 'uninstalled')).json()).duplicate, true);
  assert.equal((await (await f.request('/api/runs', { headers })).json()).runs.length, 0);
  assert.equal((await f.request('/auth/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await f.request('/api/runs', { headers })).status, 401);
  assert.equal((await (await f.request('/api/session', { headers })).json()).user, null);
  const failed = await f.request('/auth/github/callback?code=secret-code&state=invalid', { headers: { cookie: alice.cookie } });
  assert.equal(failed.headers.get('location'), '/?auth_error=github');
  assert.doesNotMatch(await failed.text(), /secret-code/);
});

test('shutdown drains an in-flight permission refresh before closing its database', async t => {
  const f = await fixture(t);
  const alice = await f.login('alice');
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  f.state.beforeUserList = async () => { started.resolve(); await release.promise; };
  const refresh = f.request('/api/connections/refresh', { method: 'POST', headers: { cookie: alice.cookie, 'x-csrf-token': alice.session.csrfToken } }).catch(() => null);
  await started.promise;
  let closed = false;
  const stopping = f.collector.close().then(() => { closed = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(closed, false, 'the unfinished handler still needs SQLite');
    assert.equal(f.collector.store.db.prepare('SELECT count(*) AS count FROM connection_users').get().count, 1);
  } finally { release.resolve(); }
  await stopping;
  await refresh;
  assert.equal(closed, true);
});
