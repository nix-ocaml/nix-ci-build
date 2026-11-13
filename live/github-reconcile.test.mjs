import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithubReader, normalizeGithub, startGithubReconciler } from './github-reconcile.mjs';

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
