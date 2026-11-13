import test from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from './store.mjs';
import { projectRun, projectRuns } from './project.mjs';

function fixture() {
  let clock = 10_000;
  const store = new EventStore(':memory:', { now: () => clock });
  const run = { repository: 'nix-ocaml/nix-ci-build', repositoryId: '1', runId: '123', runAttempt: 1, workflow: 'Demo', headSha: 'abc', sha: 'merge' };
  const sequences = new Map();
  let id;
  function register(invocationId = 'one', job = {}, runChanges = {}) {
    id = store.register({ invocationId, run: { ...run, ...runChanges }, job: { jobId: invocationId, checkRunId: invocationId, ...job } }).runKey;
    return id;
  }
  function append(events, invocationId = 'one') {
    store.append({ invocationId, streamId: 'reporter', events: events.map(value => {
      const sequence = (sequences.get(invocationId) || 0) + 1;
      sequences.set(invocationId, sequence);
      return { sequence, occurredAtMs: clock, ...value };
    }) });
  }
  return { store, register, append, advance: value => { clock = value; }, report: options => projectRun(store, id, { now: clock, ...options }) };
}

test('only an explicit wrapper terminal event can finish an invocation', () => {
  const f = fixture();
  try {
    f.register();
    f.append([
      { kind: 'invocation_start', occurredAtMs: 1000 },
      { kind: 'phase_start', entityId: 'publish', phase: 'publish', occurredAtMs: 2000 },
      { kind: 'phase_finish', entityId: 'publish', phase: 'publish', status: 'success', terminal: true, occurredAtMs: 3000 },
      { kind: 'attempt_finish', entityId: 'group:one', status: 'success', terminal: true },
    ]);
    let report = f.report();
    assert.equal(report.run.status, 'running');
    assert.equal(report.jobs[0].finishedAt, null);
    assert.equal(report.jobs[0].phases[0].durationSeconds, 1);
    f.append([{ kind: 'invocation_finish', terminal: true, status: 'cancelled', durationSeconds: 9 }]);
    report = f.report();
    assert.equal(report.run.status, 'cancelled');
    assert.equal(report.jobs[0].terminal, true);
    assert.equal(report.jobs[0].durationSeconds, 9);
  } finally { f.store.close(); }
});

test('stale reporters remain uncertain, with observed timestamps unchanged', () => {
  const f = fixture();
  try {
    f.register();
    f.append([{ kind: 'invocation_start' }, { kind: 'heartbeat' }]);
    f.advance(110_001);
    const report = f.report();
    assert.equal(report.run.status, 'stale');
    assert.equal(report.jobs[0].reportedStatus, 'running');
    assert.equal(report.jobs[0].terminal, false);
    assert.equal(report.jobs[0].finishedAt, null);
    assert.equal(report.run.updatedAt, 10);
    assert.equal(report.run.heartbeatAt, 10);
    f.append([{ kind: 'invocation_finish', terminal: true, status: 'interrupted' }]);
    assert.equal(f.report().run.status, 'incomplete');
  } finally { f.store.close(); }
});

test('stopped Nix activity is not success; late result snapshots recover original bounds', () => {
  const f = fixture();
  const drvPath = '/nix/store/abc-package.drv';
  try {
    f.register();
    f.append([
      { kind: 'invocation_start', occurredAtMs: 1000 },
      { kind: 'activity_start', entityId: drvPath, drvPath, activityType: 'build', occurredAtMs: 2000 },
      { kind: 'activity_stop', entityId: drvPath, drvPath, activityType: 'build', status: 'finished', occurredAtMs: 5000 },
    ]);
    let report = f.report();
    assert.equal(report.activities[0].status, 'unknown');
    assert.equal(report.jobs[0].metrics.built, null);
    f.advance(120_000);
    f.append([{ kind: 'activity_snapshot', entityId: drvPath, drvPath, activityType: 'build', status: 'built', startedAtMs: 2000, finishedAtMs: 5000, durationSeconds: 3 }]);
    report = f.report();
    assert.equal(report.activities.length, 1);
    assert.equal(report.activities[0].status, 'success');
    assert.equal(report.activities[0].startedAt, 2);
    assert.equal(report.activities[0].finishedAt, 5);
    assert.equal(report.activities[0].durationSeconds, 3);
    assert.equal(report.jobs[0].metrics.built, null);
    assert.equal(report.jobs[0].metrics.actualBuilds, 1);
  } finally { f.store.close(); }
});

test('snapshots without source timestamps do not fabricate build timing', () => {
  const f = fixture();
  try {
    f.register();
    f.append([{ kind: 'activity_snapshot', drvPath: '/nix/store/a.drv', status: 'built', durationSeconds: 3 }]);
    const row = f.report().activities[0];
    assert.equal(row.status, 'success');
    assert.equal(row.startedAt, null);
    assert.equal(row.finishedAt, null);
    assert.equal(row.durationSeconds, 3);
  } finally { f.store.close(); }
});

test('matrix dependencies are visible before workers start and missing workers never succeed', () => {
  const f = fixture();
  try {
    f.register('planner', { kind: 'plan' });
    f.append([
      { kind: 'matrix_plan', matrixJobs: [
        { id: 'shared', name: 'Shared libraries', kind: 'shared', stage: 0 },
        { id: 'cross', name: 'Cross packages', dependencies: ['shared'], stage: 1, system: 'aarch64-linux' },
      ] },
      { kind: 'invocation_finish', terminal: true, status: 'success' },
    ], 'planner');
    let report = f.report();
    assert.equal(report.run.status, 'planned');
    assert.deepEqual(report.jobs.find(job => job.id === 'cross').needs, ['shared']);
    assert.equal(report.jobs.find(job => job.id === 'cross').stage, 1);
    const runId = f.register('shared-invocation', { groupId: 'shared' });
    f.append([{ kind: 'invocation_start' }, { kind: 'invocation_finish', terminal: true, status: 'success' }], 'shared-invocation');
    report = f.report();
    assert.equal(report.jobs.filter(job => job.id === 'shared').length, 1);
    assert.equal(report.jobs.find(job => job.id === 'cross').status, 'planned');
    f.store.updateGithub(runId, { run: { status: 'completed', conclusion: 'failure' }, jobs: [] });
    report = f.report();
    assert.equal(report.jobs.find(job => job.id === 'cross').status, 'incomplete');
    assert.equal(report.run.status, 'incomplete');
    assert.equal(report.run.workflowStatus, 'failed');
  } finally { f.store.close(); }
});

test('a successful command stays separate from a subsequently failed GitHub job', () => {
  const f = fixture();
  try {
    const id = f.register('one', { checkRunId: '88' });
    f.append([{ kind: 'invocation_start' }, { kind: 'invocation_finish', terminal: true, status: 'success' }]);
    f.store.updateGithub(id, { run: { status: 'completed', conclusion: 'failure' }, jobs: [
      { id: '1', checkRunId: '88', status: 'completed', conclusion: 'failure', steps: [{ name: 'Upload artifact', status: 'completed', conclusion: 'failure' }] },
      { id: '2', checkRunId: '89', status: 'queued' },
    ] });
    const report = f.report();
    assert.equal(report.run.status, 'success');
    assert.equal(report.run.workflowStatus, 'failed');
    assert.equal(report.jobs[0].status, 'success');
    assert.equal(report.jobs[0].githubStatus, 'failed');
    assert.equal(report.jobs[0].github.steps[0].name, 'Upload artifact');
    assert.equal(report.githubJobs.length, 2);
  } finally { f.store.close(); }
});

test('workflow reruns and nested worker attempts cannot overwrite each other', () => {
  const f = fixture();
  try {
    const first = f.register('one');
    f.append([
      { kind: 'invocation_start' },
      { kind: 'activity_start', drvPath: '/nix/store/a.drv', labels: { groupId: 'one', attemptId: 'first' } },
      { kind: 'activity_start', drvPath: '/nix/store/a.drv', labels: { groupId: 'two', attemptId: 'second' } },
      { kind: 'activity_snapshot', drvPath: '/nix/store/a.drv', status: 'built', labels: { groupId: 'one', attemptId: 'first' } },
      { kind: 'invocation_finish', status: 'cancelled', terminal: true },
    ]);
    let report = f.report();
    assert.equal(report.activities[0].status, 'success');
    assert.equal(report.activities[1].status, 'incomplete');
    const second = f.register('two', {}, { runAttempt: 2 });
    f.append([{ kind: 'invocation_finish', status: 'success', terminal: true }], 'two');
    assert.notEqual(first, second);
    report = projectRuns(f.store, { now: 10_000 });
    assert.equal(report.runs.length, 2);
    assert.equal(report.runs.find(run => run.runAttempt === 1).status, 'cancelled');
    assert.equal(report.runs.find(run => run.runAttempt === 2).status, 'success');
  } finally { f.store.close(); }
});

test('conflicting terminal outcomes remain incomplete', () => {
  const f = fixture();
  try {
    f.register();
    f.append([{ kind: 'invocation_finish', status: 'failed', terminal: true }, { kind: 'invocation_finish', status: 'success', terminal: true }]);
    assert.equal(f.report().run.status, 'incomplete');
    assert.match(f.report().diagnostics[0], /Conflicting/);
  } finally { f.store.close(); }
});

test('cumulative metrics replace their own source snapshot and sum separate workers', () => {
  const f = fixture();
  try {
    f.register();
    f.append([
      { kind: 'snapshot', labels: { sourceStream: 'a/results.json', built: '1', cached: '2', imports: '0' } },
      { kind: 'snapshot', labels: { sourceStream: 'b/results.json', built: '3', cached: '1', imports: '2' } },
      { kind: 'snapshot', labels: { sourceStream: 'a/results.json', built: '2', cached: '2', imports: '0' } },
    ]);
    const metrics = f.report().jobs[0].metrics;
    assert.equal(metrics.built, 5);
    assert.equal(metrics.cached, 3);
    assert.equal(metrics.imports, 2);
    assert.equal(metrics.uploads, null);
  } finally { f.store.close(); }
});

test('an early results snapshot and late event tail describe one build activity', () => {
  const f = fixture();
  const drvPath = '/nix/store/cross-consumer.drv';
  const results = { groupId: 'cross', attemptId: 'first', sourceStream: 'results.json' };
  const events = { ...results, sourceStream: 'events.jsonl' };
  try {
    f.register();
    f.append([
      { kind: 'invocation_start', occurredAtMs: 1000 },
      { kind: 'activity_snapshot', drvPath, activityType: 'build', status: 'finished', startedAtMs: 3000, finishedAtMs: 4000, durationSeconds: 1, labels: results },
      { kind: 'activity_start', drvPath, activityType: 'build', status: 'building', occurredAtMs: 3000, labels: events },
      { kind: 'activity_stop', drvPath, status: 'finished', occurredAtMs: 4000, durationSeconds: 1, labels: events },
      { kind: 'job', drvPath, status: 'built', startedAtMs: 2000, finishedAtMs: 5000, durationSeconds: 3, labels: results },
      { kind: 'activity_snapshot', drvPath, activityType: 'build', status: 'built', startedAtMs: 3000, finishedAtMs: 4000, durationSeconds: 1, labels: results },
      { kind: 'snapshot', labels: { ...results, built: '1', actualBuilds: '1' } },
      { kind: 'invocation_finish', status: 'success', terminal: true },
    ]);
    const report = f.report();
    assert.equal(report.activities.length, 1);
    assert.equal(report.activities[0].status, 'success');
    assert.equal(report.activities[0].open, false);
    assert.deepEqual([report.activities[0].startedAt, report.activities[0].finishedAt, report.activities[0].durationSeconds], [3, 4, 1]);
    assert.equal(report.jobs[0].metrics.built, 1);
    assert.equal(report.jobs[0].metrics.actualBuilds, 1);
  } finally { f.store.close(); }
});

test('a completed snapshot does not regress when its start and stop events arrive later', () => {
  const f = fixture();
  const drvPath = '/nix/store/dependency.drv';
  try {
    f.register();
    f.append([
      { kind: 'activity_snapshot', drvPath, activityType: 'build', status: 'built', startedAtMs: 3000, finishedAtMs: 4000, labels: { sourceStream: 'results' } },
      { kind: 'activity_start', drvPath, activityType: 'build', occurredAtMs: 3000, labels: { sourceStream: 'events' } },
      { kind: 'activity_stop', drvPath, status: 'finished', occurredAtMs: 4000, labels: { sourceStream: 'events' } },
      { kind: 'invocation_finish', status: 'success', terminal: true },
    ]);
    const report = f.report();
    assert.equal(report.activities.length, 1);
    assert.equal(report.activities[0].status, 'success');
    assert.equal(report.activities[0].open, false);
    assert.equal(report.jobs[0].metrics.actualBuilds, 1);
  } finally { f.store.close(); }
});
