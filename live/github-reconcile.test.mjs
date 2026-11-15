import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithubReader, normalizeGithub, startGithubReconciler } from './github-reconcile.mjs';
import { EventStore } from './store.mjs';
import { ingestGithubWebhook } from './github-webhooks.mjs';

const identity = { repository: 'nix-ocaml/nix-ci-build', runId: '123', runAttempt: 2 };
const run = { id: 123, run_attempt: 2, status: 'completed', conclusion: 'failure', head_sha: 'a'.repeat(40) };
const job = {
  id: 456, run_attempt: 2, name: 'Build / native', check_run_url: 'https://api.github.com/repos/nix-ocaml/nix-ci-build/check-runs/789',
  status: 'completed', conclusion: 'failure', started_at: '2026-11-13T00:00:00Z',
  steps: [{ number: 3, name: 'Upload artifact', status: 'completed', conclusion: 'failure' }],
};
const json = (value, headers) => new Response(JSON.stringify(value), { headers });

test('GitHub conclusion and failed steps remain separate from builder success', () => {
  const snapshot = normalizeGithub(run, [job], { now: 42 });
  assert.equal(snapshot.run.conclusion, 'failure');
  assert.equal(snapshot.jobs[0].checkRunId, '789');
  assert.equal(snapshot.jobs[0].steps[0].conclusion, 'failure');
  assert.equal(snapshot.jobs[0].startedAt, 1794528000000);
  assert.equal(snapshot.fetchedAt, 42);
});

test('attempt-specific API paginates jobs and uses conditional requests', async () => {
  const calls = [];
  let cached = false;
  const read = createGithubReader({ token: 'test-token', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    assert.ok(url.startsWith('https://api.github.com/repos/nix-ocaml/nix-ci-build/actions/runs/123/attempts/2'));
    if (cached) {
      assert.equal(options.headers['if-none-match'], 'v1');
      return new Response(null, { status: 304 });
    }
    return json(url.includes('/jobs') ? { total_count: 2, jobs: [url.endsWith('page=1') ? job : { ...job, id: 457 }] } : run, { etag: 'v1' });
  } });
  const first = await read(identity);
  assert.deepEqual(first.jobs.map(job => job.id), ['456', '457']);
  cached = true;
  const second = await read(identity);
  assert.deepEqual(second.jobs, first.jobs);
  assert.equal(calls.length, 6);
});

test('invalid identities and cross-attempt responses fail without accepting snapshots', async () => {
  let calls = 0;
  const read = createGithubReader({ token: 'token', fetchImpl: async url => {
    calls++;
    return json(url.includes('/jobs') ? { jobs: [] } : { ...run, run_attempt: 3 });
  } });
  await assert.rejects(read({ ...identity, repository: '../another/host' }), /Invalid/);
  assert.equal(calls, 0);
  await assert.rejects(read(identity), /different workflow attempt/);
});

test('HTTP errors never reflect response bodies or the bearer token', async () => {
  const read = createGithubReader({ token: 'do-not-expose', fetchImpl: async () => new Response('secret response', { status: 401 }) });
  await assert.rejects(read(identity), error => {
    assert.equal(error.message, 'GitHub reconciliation HTTP 401');
    assert.equal(error.status, 401);
    return true;
  });
});

test('disabled reconciliation makes no network calls', async () => {
  const stop = startGithubReconciler({ fetchImpl: () => assert.fail('unexpected request') });
  await stop();
});

test('disconnected repositories cannot acquire installation tokens or make API requests', async () => {
  let connected = false;
  let tokenRequests = 0;
  let apiRequests = 0;
  const read = createGithubReader({
    isRepositoryConnected: candidate => { assert.equal(candidate.repositoryId, '10'); return connected; },
    tokenProvider: candidate => { tokenRequests++; assert.equal(candidate.repositoryId, '10'); return 'installation-token'; },
    fetchImpl: async (url, options) => {
      apiRequests++;
      assert.equal(options.headers.authorization, 'Bearer installation-token');
      return json(url.includes('/jobs') ? { jobs: [job] } : { ...run, repository: { id: 10, full_name: identity.repository } });
    },
  });
  const stableIdentity = { ...identity, repositoryId: '10' };
  assert.equal(await read(stableIdentity), null);
  assert.equal(tokenRequests, 0);
  assert.equal(apiRequests, 0);
  connected = true;
  assert.equal((await read(stableIdentity)).run.id, '123');
  assert.equal(tokenRequests, 1);
  assert.equal(apiRequests, 2);
  connected = false;
  assert.equal(await read(stableIdentity), null);
  assert.equal(tokenRequests, 1);
  assert.equal(apiRequests, 2);
});

test('installation reconciliation verifies the immutable repository ID', async () => {
  const read = createGithubReader({ tokenProvider: () => 'installation-token', fetchImpl: async url =>
    json(url.includes('/jobs') ? { jobs: [job] } : { ...run, repository: { id: 11, full_name: identity.repository } }),
  });
  await assert.rejects(read({ ...identity, repositoryId: '10' }), /different repository/);
});

test('completed webhook-only runs still reconcile the complete job list and failed steps', async () => {
  const store = new EventStore(':memory:');
  let stop;
  try {
    const repository = { id: 10, full_name: identity.repository };
    const created = ingestGithubWebhook(store, {
      event: 'workflow_run', deliveryId: 'complete-before-api',
      payload: { action: 'completed', repository, workflow_run: { ...run, repository } },
    });
    let resolveChange;
    const changed = new Promise(resolve => { resolveChange = resolve; });
    stop = startGithubReconciler({
      store, isRepositoryConnected: () => true, tokenProvider: () => 'installation-token',
      onChange: resolveChange,
      fetchImpl: async url => json(url.includes('/jobs') ? { jobs: [job] } : { ...run, repository }),
    });
    const result = await changed;
    assert.equal(result.runId, created.runId);
    const snapshot = store.github(created.runId);
    assert.equal(snapshot.jobs[0].steps[0].name, 'Upload artifact');
    assert.equal(snapshot.needsReconcile, false);
    assert.equal(snapshot.jobsTruncated, false);
  } finally { await stop?.(); store.close(); }
});

test('a revoked installation does not pause reconciliation for another team', async () => {
  const store = new EventStore(':memory:');
  let stop;
  try {
    store.upsertRun({ ...identity, repository: 'aaa/private', repositoryId: '10' });
    const second = store.upsertRun({ ...identity, repository: 'bbb/private', repositoryId: '20' });
    let resolveChange;
    const changed = new Promise(resolve => { resolveChange = resolve; });
    stop = startGithubReconciler({
      store, isRepositoryConnected: () => true,
      tokenProvider: identity => identity.repositoryId === '10' ? 'revoked-token' : 'connected-token',
      onChange: resolveChange, onWarning: () => {},
      fetchImpl: async (url, options) => options.headers.authorization === 'Bearer revoked-token'
        ? new Response(null, { status: 401 })
        : json(url.includes('/jobs') ? { jobs: [job] } : { ...run, repository: { id: 20, full_name: 'bbb/private' } }),
    });
    assert.equal((await changed).runId, second.runId);
    assert.equal(store.github(second.runId).run.conclusion, 'failure');
  } finally { await stop?.(); store.close(); }
});

test('first connection discovers a run without a webhook and later telemetry joins that run', async () => {
  const store = new EventStore(':memory:');
  let stop;
  try {
    const repository = { id: 10, full_name: identity.repository };
    let resolveChange;
    const changed = new Promise(resolve => { resolveChange = resolve; });
    const paths = [];
    stop = startGithubReconciler({
      store, listRepositories: async () => [{ repository: identity.repository, repositoryId: '10' }],
      isRepositoryConnected: () => true, tokenProvider: () => 'installation-token',
      onChange: resolveChange,
      fetchImpl: async (url, options) => {
        paths.push(url);
        assert.equal(options.headers.authorization, 'Bearer installation-token');
        return json(url.endsWith('/actions/runs?per_page=30') ? { workflow_runs: [{ ...run, repository }] }
          : url.includes('/jobs') ? { jobs: [job] } : { ...run, repository });
      },
    });
    const discovered = await changed;
    await stop();
    assert.equal(paths[0], `https://api.github.com/repos/${identity.repository}/actions/runs?per_page=30`);
    assert.equal(store.invocations(discovered.runId).length, 0);
    assert.equal(store.run(discovered.runId).repositoryId, '10');
    assert.equal(store.github(discovered.runId).run.conclusion, 'failure');
    const registered = store.register({ invocationId: 'discovered-worker',
      run: { ...identity, repositoryId: '10' }, job: { jobId: 'build', checkRunId: '789' },
    });
    assert.equal(registered.runKey, discovered.runId);
    assert.equal(store.runIds().length, 1);
    assert.equal(store.invocations(discovered.runId).length, 1);
  } finally { await stop?.(); store.close(); }
});

test('discovery rejects foreign repositories and invalid run identities before accepting a page', async () => {
  const repository = { id: 10, full_name: identity.repository };
  const candidate = { ...identity, repositoryId: '10' };
  for (const invalid of [
    { ...run, repository: { ...repository, id: 11 } },
    { ...run, repository, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...run, repository, run_attempt: 0 },
  ]) {
    const read = createGithubReader({ tokenProvider: () => 'installation-token',
      fetchImpl: async () => json({ workflow_runs: [{ ...run, repository }, invalid] }),
    });
    await assert.rejects(read.discover(candidate), /different repository|invalid workflow identity/);
  }
});

test('discovery reads at most thirty recent runs and skips disconnected repositories', async () => {
  let connected = true;
  let calls = 0;
  let tokens = 0;
  const read = createGithubReader({
    isRepositoryConnected: () => connected,
    tokenProvider: () => { tokens++; return 'installation-token'; },
    fetchImpl: async url => {
      calls++;
      assert.match(url, /\/actions\/runs\?per_page=30$/);
      return json({ total_count: 1000, workflow_runs: Array.from({ length: 35 }, (_, index) => ({ ...run, id: 1000 + index,
        repository: { id: 10, full_name: identity.repository },
      })) });
    },
  });
  const repositories = { repository: identity.repository, repositoryId: '10' };
  const snapshots = await read.discover(repositories);
  assert.equal(snapshots.length, 30);
  assert.ok(snapshots.every(snapshot => snapshot.source === 'discovery' && snapshot.jobsTruncated));
  assert.equal(calls, 1);
  connected = false;
  assert.deepEqual(await read.discover(repositories), []);
  assert.equal(calls, 1);
  assert.equal(tokens, 1);
});

test('discovery preserves established job details and backs off a rate-limited repository independently', async () => {
  const store = new EventStore(':memory:');
  let stop;
  try {
    const repository = { id: 20, full_name: 'bbb/private' };
    const existing = store.updateGithub('github:bbb/private:123:2', normalizeGithub({ ...run, repository }, [job]));
    const before = store.github(existing.runId);
    const calls = [];
    let ticks = 0;
    let resolveThirdTick;
    const thirdTick = new Promise(resolve => { resolveThirdTick = resolve; });
    stop = startGithubReconciler({
      store, intervalMs: 1000, discoveryIntervalMs: 0, tokenProvider: () => 'installation-token', isRepositoryConnected: () => true,
      listRepositories: () => {
        if (++ticks === 3) resolveThirdTick();
        return [{ repository: 'aaa/private', repositoryId: '10' }, { repository: repository.full_name, repositoryId: '20' }];
      },
      onWarning: () => {},
      fetchImpl: async url => {
        calls.push(url);
        assert.match(url, /\/actions\/runs\?per_page=30$/);
        if (url.includes('/aaa/')) return new Response(null, { status: 429, headers: { 'retry-after': '60' } });
        // A stale discovery response must not erase fetched terminal steps.
        return json({ workflow_runs: [{ ...run, repository, status: 'queued', conclusion: null }] });
      },
    });
    await thirdTick;
    await stop();
    assert.equal(calls.filter(url => url.includes('/aaa/')).length, 1);
    assert.ok(calls.some(url => url.includes('/bbb/')));
    assert.deepEqual(store.github(existing.runId), before);
  } finally { await stop?.(); store.close(); }
});
