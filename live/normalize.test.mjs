import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, appendFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeEvent, normalizeManifest, normalizeSnapshot, ReportWatcher, sharedPlanId } from './normalize.mjs';

test('independent engine and orchestration sequences retain separate source identities', () => {
  const raw = { type: 'phase_start', phase: 'build', sequence: 1, time: 10, groupId: 'shared-a', attemptId: 'try-one' };
  const orchestration = normalizeEvent(raw, { source: 'worker/execution-events.jsonl' })[0];
  const engine = normalizeEvent({ type: 'activity-start', state: 'building', drvPath: '/nix/store/a.drv' }, { source: 'worker/events.jsonl', sequence: 1 })[0];
  assert.notEqual(orchestration.labels.sourceStream, engine.labels.sourceStream);
  assert.equal(orchestration.labels.sourceSequence, engine.labels.sourceSequence);
  assert.equal(orchestration.entityId, 'shared-a:try-one:build');
  assert.notEqual(normalizeEvent({ ...raw, attemptId: 'try-two' })[0].entityId, orchestration.entityId);
});

test('stopped activity is never invented as a successfully built derivation', () => {
  const stopped = normalizeEvent({ type: 'activity-stop', drvPath: '/nix/store/a.drv', state: 'finished', seconds: 3 })[0];
  assert.equal(stopped.status, 'finished');
  assert.equal(stopped.terminal, undefined);
  const finished = normalizeEvent({ type: 'finished', status: 'success' })[0];
  assert.equal(finished.terminal, false);
  const records = normalizeSnapshot({ status: 'success', jobs: [], derivations: [{ drvPath: '/nix/store/a.drv', state: 'built', kind: 'derivation', startedAt: 10, finishedAt: 13, buildSeconds: 3, seconds: 3 }] }, { now: 100000 });
  const activity = records.find(item => item.kind === 'activity_snapshot');
  assert.equal(activity.status, 'built');
  assert.equal(activity.startedAtMs, 10000);
  assert.equal(activity.finishedAtMs, 13000);
  assert.equal(activity.durationSeconds, 3);
});

test('normalization sends typed metadata, not raw command output or credentials in failures', () => {
  const records = normalizeEvent({ type: 'root-failure', failure: { drvPath: '/nix/store/a.drv', name: 'package', message: 'token=secret', excerpt: ['private'] } });
  assert.equal(records[0].status, 'failed');
  assert.ok(!JSON.stringify(records).includes('secret'));
  assert.ok(!JSON.stringify(records).includes('private'));
});

test('shared graph stages follow dependencies and canonical plan identity ignores key ordering', () => {
  const groups = [
    { id: 'tool', kind: 'shared', system: 'x86_64-linux', needs: [], roots: [], consumers: ['a', 'b'] },
    { id: 'lib', kind: 'shared', system: 'x86_64-linux', needs: ['tool'], roots: [], consumers: ['a', 'b'] },
    { id: 'package', kind: 'package', system: 'x86_64-linux', needs: ['lib'], roots: [], consumers: ['a'] },
  ];
  const manifest = { version: 1, graph: { '/nix/store/tool.drv': { name: 'compiler', inputDrvs: {}, outputs: { out: '/nix/store/tool' } } }, plan: { groups }, runners: { 'x86_64-linux': 'ubuntu-latest' } };
  const jobs = normalizeManifest(manifest).flatMap(event => event.matrixJobs || []);
  assert.deepEqual(jobs.map(job => job.stage), [0, 1, 2]);
  assert.ok(jobs.every(job => job.runner === 'ubuntu-latest'));
  assert.equal(sharedPlanId(manifest), sharedPlanId({ plan: manifest.plan, runners: manifest.runners, graph: manifest.graph, version: 1 }));
});

test('tailer skips old attempts, follows partial UTF-8 lines and discovers nested workers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nix-ci-normalize-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.jsonl');
  await writeFile(path, `${JSON.stringify({ type: 'finished', status: 'success', time: 1 })}\n`);
  const received = [];
  const watcher = new ReportWatcher({ directories: [directory], emit: event => received.push(event) });
  await watcher.initialize();
  const bytes = Buffer.from(`${JSON.stringify({ type: 'evaluated', attr: 'café', drvPath: '/nix/store/a.drv', time: 2 })}\n`);
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  await appendFile(path, bytes.subarray(0, split));
  await watcher.poll();
  assert.equal(received.length, 0);
  await appendFile(path, bytes.subarray(split));
  await mkdir(join(directory, 'worker'));
  await writeFile(join(directory, 'worker/execution-events.jsonl'), `${JSON.stringify({ type: 'attempt_start', groupId: 'group', attemptId: 'attempt', sequence: 1, time: 3 })}\n`);
  await watcher.poll();
  assert.equal(received.length, 2);
  assert.deepEqual(received.find(event => event.kind === 'evaluated').attributes, ['café']);
  assert.ok(received.some(event => event.kind === 'attempt_start'));
  assert.ok(!received.some(event => event.kind === 'finished'));
  await watcher.poll();
  assert.equal(received.length, 2);
});

test('same-inode truncation and rapid regrowth cannot hide the next ordinary build attempt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nix-ci-truncated-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.jsonl');
  await writeFile(path, `${JSON.stringify({ type: 'finished', status: 'success', time: 1 })}\n`);
  const received = [];
  const watcher = new ReportWatcher({ directories: [directory], emit: event => received.push(event) });
  await watcher.initialize();
  await writeFile(path, [
    { type: 'evaluated', drvPath: '/nix/store/new-package.drv', attr: 'new', time: 2 },
    { type: 'job', drvPath: '/nix/store/new-package.drv', state: 'failed', time: 3 },
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  await watcher.poll();
  assert.deepEqual(received.map(event => event.kind), ['evaluated', 'job']);
  assert.equal(received[1].status, 'failed');
});
