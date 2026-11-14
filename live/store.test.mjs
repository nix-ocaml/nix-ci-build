import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, normalizeEvent, runKey } from './store.mjs';

const registration = {
  invocationId: 'worker-1',
  run: { repository: 'nix-ocaml/nix-ci-build', repositoryId: '1', runId: '123', runAttempt: 1 },
  job: { jobId: 'build-a', groupId: 'a', checkRunId: '5' },
};
const event = (sequence, kind = 'heartbeat') => ({ sequence, occurredAtMs: 1000 + sequence, kind });
const batch = (...events) => ({ invocationId: registration.invocationId, streamId: 'one', events });

test('acknowledged events and idempotent registration survive collector restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nix-live-store-'));
  const path = join(directory, 'events.sqlite');
  let store;
  try {
    store = new EventStore(path, { now: () => 2000 });
    assert.equal(store.register(registration).changed, true);
    assert.equal(store.append(batch(event(1), event(2))).lastSequence, 2);
    const revision = store.revision;
    store.close();
    store = new EventStore(path);
    assert.equal(store.register(registration).changed, false);
    const duplicate = store.append(batch(event(1), event(2)));
    assert.deepEqual([duplicate.lastSequence, duplicate.changed, duplicate.revision], [2, false, revision]);
    assert.equal(store.events(runKey(registration.run)).length, 2);
    assert.equal(store.append(batch(event(3))).lastSequence, 3);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('gaps and conflicting duplicates roll back every event in the batch', () => {
  const store = new EventStore(':memory:');
  try {
    store.register(registration);
    store.append(batch(event(1)));
    const revision = store.revision;
    assert.throws(() => store.append(batch(event(2), event(4))), error => error.code === 'FAILED_PRECONDITION' && error.lastSequence === 1);
    assert.equal(store.events(runKey(registration.run)).length, 1);
    assert.equal(store.revision, revision);
    assert.throws(() => store.append(batch(event(2), event(1, 'invocation_finish'))), error => error.code === 'ALREADY_EXISTS' && error.lastSequence === 1);
    assert.equal(store.append(batch()).lastSequence, 1);
    assert.equal(store.append(batch(event(2))).lastSequence, 2);
    assert.equal(store.append({ ...batch(event(1)), streamId: 'two' }).lastSequence, 1);
  } finally { store.close(); }
});

test('invocation identity cannot be reassigned to another job, attempt, or run', () => {
  const store = new EventStore(':memory:');
  try {
    store.register(registration);
    for (const changed of [
      { ...registration, job: { ...registration.job, checkRunId: '6' } },
      { ...registration, run: { ...registration.run, runAttempt: 2 } },
      { ...registration, run: { ...registration.run, runId: '124' } },
    ]) assert.throws(() => store.register(changed), { code: 'ALREADY_EXISTS' });
    assert.equal(store.invocation(registration.invocationId).job.checkRunId, '5');
  } finally { store.close(); }
});

test('normalization preserves typed evidence and drops arbitrary payload fields', () => {
  const normalized = normalizeEvent({ ...event(1), startedAtMs: 500, finishedAtMs: 900, durationSeconds: 0.4, _durationSeconds: 'durationSeconds', rawLog: 'token or log text' });
  assert.equal(normalized.startedAtMs, 500);
  assert.equal(normalized.finishedAtMs, 900);
  assert.equal(normalized.durationSeconds, 0.4);
  assert.equal(Object.hasOwn(normalized, 'rawLog'), false);
  assert.equal(Object.hasOwn(normalized, '_durationSeconds'), false);
  assert.throws(() => normalizeEvent({ ...event(1), sequence: 0 }));
  assert.throws(() => normalizeEvent({ ...event(1), durationSeconds: NaN }));
  assert.throws(() => normalizeEvent({ ...event(1), labels: { value: 'x'.repeat(2049) } }));
});

test('GitHub reconciliation remains durable separately from worker events', () => {
  const store = new EventStore(':memory:');
  try {
    const { runKey: id } = store.register(registration);
    const snapshot = { run: { status: 'completed', conclusion: 'failure' }, jobs: [] };
    assert.equal(store.updateGithub(id, snapshot).changed, true);
    assert.equal(store.updateGithub(id, snapshot).changed, false);
    assert.equal(store.github(id).run.conclusion, 'failure');
    assert.equal(store.listRuns()[0].runId, '123');
    assert.equal(store.events(id).length, 0);
  } finally { store.close(); }
});
