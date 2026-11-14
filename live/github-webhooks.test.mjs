import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, runKey } from './store.mjs';
import { ingestGithubWebhook } from './github-webhooks.mjs';
import { normalizeGithub } from './github-reconcile.mjs';
import { projectRun, projectRuns } from './project.mjs';

const repository = { id: 1, full_name: 'nix-ocaml/nix-ci-build' };
const now = Date.parse('2026-11-13T00:00:20Z');
const run = {
  id: 123, run_attempt: 1, name: 'Build packages', display_title: 'Update OCaml',
  status: 'queued', conclusion: null, head_branch: 'compiler-update', head_sha: 'a'.repeat(40),
  event: 'pull_request', pull_requests: [{ number: 14 }], actor: { login: 'anmonteiro' },
  html_url: 'https://github.com/nix-ocaml/nix-ci-build/actions/runs/123',
  created_at: '2026-11-13T00:00:00Z', updated_at: '2026-11-13T00:00:00Z', repository,
};
const job = {
  id: 456, run_id: 123, run_attempt: 1, name: 'Build (native)', workflow_name: run.name,
  status: 'queued', head_sha: run.head_sha, head_branch: run.head_branch,
  html_url: 'https://github.com/nix-ocaml/nix-ci-build/actions/runs/123/job/456',
  check_run_url: 'https://api.github.com/repos/nix-ocaml/nix-ci-build/check-runs/789',
};
const registration = {
  invocationId: 'worker-1',
  run: { repository: repository.full_name, repositoryId: '1', runId: '123', runAttempt: 1 },
  job: { jobId: 'build', checkRunId: '789', githubJobUrl: job.html_url },
};
const runDelivery = (deliveryId, action = 'requested', changes = {}, repo = repository) => ({
  event: 'workflow_run', deliveryId,
  payload: { action, repository: repo, workflow_run: { ...run, ...changes, repository: repo } },
});
const jobDelivery = (deliveryId, action = 'queued', changes = {}) => ({
  event: 'workflow_job', deliveryId, payload: { action, repository, workflow_job: { ...job, status: action, ...changes } },
});

test('a workflow is discoverable before the reporter and an early setup failure stays visible', () => {
  const store = new EventStore(':memory:', { now: () => now });
  try {
    const created = ingestGithubWebhook(store, runDelivery('queued'));
    const listed = projectRuns(store, { now });
    assert.equal(listed.runs.length, 1);
    assert.equal(listed.runs[0].status, 'queued');
    assert.equal(listed.runs[0].reportedStatus, 'unknown');
    assert.equal(listed.runs[0].telemetryStatus, 'waiting');
    assert.equal(listed.runs[0].repositoryId, '1');
    assert.equal(listed.runs[0].pullRequest, 14);
    assert.equal(listed.runs[0].commitSha, run.head_sha);
    ingestGithubWebhook(store, jobDelivery('job-failed', 'completed', {
      conclusion: 'failure', started_at: '2026-11-13T00:00:02Z', completed_at: '2026-11-13T00:00:15Z',
      steps: [{ number: 2, name: 'Install Nix', status: 'completed', conclusion: 'failure' }],
    }));
    ingestGithubWebhook(store, runDelivery('failed', 'completed', { status: 'completed', conclusion: 'failure', updated_at: '2026-11-13T00:00:16Z' }));
    const report = projectRun(store, created.runId, { now });
    assert.equal(report.run.status, 'failed');
    assert.equal(report.run.telemetryStatus, 'not_reported');
    assert.equal(report.run.invocationCount, 0);
    assert.equal(report.jobs.length, 0);
    assert.equal(report.activities.length, 0);
    assert.equal(report.githubJobs[0].steps[0].name, 'Install Nix');
    assert.equal(store.github(created.runId).needsReconcile, true);
  } finally { store.close(); }
});

test('job-before-run delivery and later telemetry merge using exact job identity', () => {
  const store = new EventStore(':memory:', { now: () => now });
  try {
    const created = ingestGithubWebhook(store, jobDelivery('first-job', 'in_progress'));
    ingestGithubWebhook(store, jobDelivery('same-name-job', 'in_progress', { id: 457, check_run_url: job.check_run_url.replace('789', '790') }));
    assert.equal(projectRun(store, created.runId, { now }).run.status, 'running');
    ingestGithubWebhook(store, runDelivery('run-started', 'in_progress', { status: 'in_progress' }));
    assert.equal(store.register(registration).runKey, created.runId);
    store.append({ invocationId: registration.invocationId, streamId: 'reporter', events: [
      { sequence: 1, occurredAtMs: now, kind: 'invocation_start' },
    ] });
    const report = projectRun(store, created.runId, { now });
    assert.equal(store.runIds().length, 1);
    assert.equal(report.jobs.length, 1);
    assert.equal(report.run.invocationCount, 1);
    assert.equal(report.run.telemetryStatus, 'receiving');
    assert.equal(report.jobs[0].github.id, '456');
    assert.equal(report.githubJobs.length, 2);
    assert.equal(report.run.pullRequest, 14);
  } finally { store.close(); }
});

test('delivery acknowledgement and deduplication survive restart; invalid delivery rolls back atomically', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nix-live-hooks-'));
  const path = join(directory, 'events.sqlite');
  let store;
  try {
    store = new EventStore(path, { now: () => now });
    const delivery = runDelivery('unique-delivery');
    const first = ingestGithubWebhook(store, delivery);
    store.close();
    store = new EventStore(path);
    const duplicate = ingestGithubWebhook(store, delivery);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.revision, first.revision);
    assert.equal(duplicate.changed, false);
    assert.throws(() => ingestGithubWebhook(store, runDelivery('unique-delivery', 'completed')), { code: 'ALREADY_EXISTS' });
    assert.throws(() => ingestGithubWebhook(store, runDelivery('bad', 'requested', { run_attempt: 0 })), { code: 'INVALID_ARGUMENT' });
    assert.equal(ingestGithubWebhook(store, runDelivery('bad')).duplicate, false);
    const tooLarge = runDelivery('oversize', 'requested', { display_title: 'x'.repeat(2049) });
    assert.throws(() => ingestGithubWebhook(store, tooLarge));
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM github_deliveries').get().count, 2);
    assert.equal(store.runIds().length, 1);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('late queued/running events cannot undo terminal workflow, job, or step outcomes', () => {
  const store = new EventStore(':memory:', { now: () => now });
  try {
    const completedRun = { ...run, status: 'completed', conclusion: 'failure', updated_at: '2026-11-13T00:00:16Z' };
    const completedJob = { ...job, status: 'completed', conclusion: 'failure', started_at: '2026-11-13T00:00:02Z', completed_at: '2026-11-13T00:00:15Z', steps: [
      { number: 1, name: 'Checkout', status: 'completed', conclusion: 'success' },
      { number: 2, name: 'Install Nix', status: 'completed', conclusion: 'failure' },
    ] };
    const key = runKey(registration.run);
    store.updateGithub(key, normalizeGithub(completedRun, [completedJob], { now }));
    assert.equal(store.github(key).needsReconcile, false);
    ingestGithubWebhook(store, runDelivery('late-run-start', 'in_progress', { status: 'in_progress', updated_at: '2026-11-13T00:00:02Z' }));
    ingestGithubWebhook(store, jobDelivery('late-job-start', 'in_progress', { steps: [{ number: 2, name: 'Install Nix', status: 'in_progress' }] }));
    ingestGithubWebhook(store, jobDelivery('late-job-queue'));
    const snapshot = store.github(key);
    assert.equal(snapshot.run.status, 'completed');
    assert.equal(snapshot.run.conclusion, 'failure');
    assert.equal(snapshot.jobs[0].status, 'completed');
    assert.equal(snapshot.jobs[0].conclusion, 'failure');
    assert.equal(snapshot.jobs[0].steps.length, 2);
    assert.equal(snapshot.jobs[0].steps[1].conclusion, 'failure');
    assert.equal(snapshot.jobs[0].completedAt, Date.parse(completedJob.completed_at));
  } finally { store.close(); }
});

test('reruns stay independent even when their webhooks arrive in reverse order', () => {
  const store = new EventStore(':memory:', { now: () => now });
  try {
    const second = ingestGithubWebhook(store, jobDelivery('attempt-two', 'in_progress', { id: 900, run_attempt: 2 }));
    const first = ingestGithubWebhook(store, runDelivery('attempt-one', 'completed', { status: 'completed', conclusion: 'cancelled' }));
    assert.notEqual(first.runId, second.runId);
    const runs = projectRuns(store, { now }).runs;
    assert.equal(runs.length, 2);
    assert.equal(runs.find(run => run.runAttempt === 1).status, 'cancelled');
    assert.equal(runs.find(run => run.runAttempt === 2).status, 'running');
    assert.equal(store.github(first.runId).jobs.length, 0);
    assert.equal(store.github(second.runId).jobs[0].id, '900');
    assert.throws(() => ingestGithubWebhook(store, jobDelivery('missing-attempt', 'queued', { run_attempt: undefined })), /attempt/);
  } finally { store.close(); }
});

test('repository renames preserve old links, stable authorization identity, and a single invocation history', () => {
  const store = new EventStore(':memory:', { now: () => now });
  try {
    const original = ingestGithubWebhook(store, runDelivery('before-rename'));
    const renamed = { ...repository, full_name: 'nix-ocaml/build-service' };
    const updated = ingestGithubWebhook(store, runDelivery('after-rename', 'in_progress', { status: 'in_progress' }, renamed));
    assert.equal(updated.runId, original.runId);
    const alias = runKey({ ...registration.run, repository: renamed.full_name });
    assert.equal(store.resolveRunId(alias), original.runId);
    assert.equal(store.run(alias).repository, renamed.full_name);
    store.register(registration); // A reporter started before the rename.
    assert.equal(store.run(alias).repository, renamed.full_name);
    assert.equal(store.invocations(alias).length, 1);
    assert.equal(projectRun(store, alias, { now }).run.repositoryId, '1');
    assert.equal(store.runIds().length, 1);
    assert.throws(() => ingestGithubWebhook(store, runDelivery('imposter', 'requested', {}, { ...repository, id: 2 })), { code: 'ALREADY_EXISTS' });
    assert.equal(store.runIds().length, 1);
  } finally { store.close(); }
});

test('upgrading an invocation-only database backfills runs without changing acknowledged streams', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nix-live-upgrade-'));
  const path = join(directory, 'events.sqlite');
  let store;
  try {
    store = new EventStore(path, { now: () => now });
    const key = store.register(registration).runKey;
    const batch = { invocationId: registration.invocationId, streamId: 'reporter', events: [{ sequence: 1, occurredAtMs: now, kind: 'heartbeat' }] };
    store.append(batch);
    store.updateGithub(key, { run: { status: 'in_progress' }, jobs: [] });
    const revision = store.revision;
    store.db.exec('DROP TABLE github_deliveries; DROP TABLE run_aliases; DROP TABLE runs;');
    store.close();
    store = new EventStore(path);
    assert.equal(store.runIds().length, 1);
    assert.equal(store.run(key).repositoryId, '1');
    assert.equal(store.github(key).run.status, 'in_progress');
    assert.equal(store.append(batch).lastSequence, 1);
    assert.equal(store.revision, revision);
    assert.equal(store.register(registration).changed, false);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});
