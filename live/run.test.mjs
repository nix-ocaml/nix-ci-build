import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runWrapped, makeRegistration } from './run.mjs';
import { DurableSpool } from './uploader.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = { PATH: process.env.PATH, HOME: process.env.HOME };

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'nix-ci-wrapper-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the wrapped process');
    await delay(15);
  }
}

async function alive(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (process.platform === 'linux') {
    try { if (/^\d+ \(.*\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'))) return false; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return true;
}

test('collector outage does not change the builder exit code and retains a truthful terminal event', async t => {
  const path = await directory(t);
  const started = Date.now();
  const result = await runWrapped({ command: process.execPath, args: ['-e', 'process.exit(17)'], cwd: path, env,
    endpoint: 'http://127.0.0.1:1', reportUrl: 'http://127.0.0.1:4000', finalFlushMs: 100,
    stdio: 'ignore', logger() {}, warning() {},
  });
  assert.equal(result.exitCode, 17);
  assert.equal(result.status, 'failed');
  assert.ok(Date.now() - started < 2000);
  assert.ok(result.pending >= 2);
  const spool = await DurableSpool.open(result.spoolDirectory);
  const events = (await spool.readBatch()).events;
  assert.equal(events[0].kind, 'invocation_start');
  assert.equal(events.at(-1).kind, 'invocation_finish');
  assert.equal(events.at(-1).status, 'failed');
  assert.equal(events.at(-1).result, '17');
});

test('disabled telemetry is transparent and GitHub planner outputs still reach the action', async t => {
  const path = await directory(t);
  const output = join(path, 'outputs');
  const result = await runWrapped({ command: process.execPath, args: ['-e',
    `require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT, 'shared={"include":[]}\\nhas-shared=false\\n');`],
    cwd: path, env: { ...env, GITHUB_OUTPUT: output }, stdio: 'ignore',
  });
  assert.equal(result.exitCode, 0);
  const values = await readFile(output, 'utf8');
  assert.ok(values.includes('shared={"include":[]}\n'));
  assert.ok(values.includes('has-shared=false\n'));
  assert.ok(values.includes('disabled'));
  assert.equal(result.spoolDirectory, undefined);
});

test('the final GitHub summary retains the report URL after the builder replaces its summary', async t => {
  const path = await directory(t);
  const summary = join(path, 'summary.md');
  await runWrapped({ command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(process.env.GITHUB_STEP_SUMMARY, 'Builder summary\\n');`],
    cwd: path, env: { ...env, GITHUB_STEP_SUMMARY: summary }, endpoint: 'http://127.0.0.1:1', reportUrl: 'http://localhost:4000',
    finalFlushMs: 0, stdio: 'ignore', logger() {}, warning() {},
  });
  const text = await readFile(summary, 'utf8');
  assert.ok(text.startsWith('Builder summary\n'));
  assert.match(text, /Open the live build report/);
  assert.match(text, /Live reporting: incomplete/);
});

test('SIGTERM preserves cancellation and removes descendants even if the direct child exits first', { skip: process.platform === 'win32' }, async t => {
  const path = await directory(t);
  const script = join(path, 'builder.cjs');
  const marker = join(path, 'pids.json');
  await writeFile(script, `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid]));
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100));
    setInterval(() => {}, 1000);
  `);
  const wrapper = spawn(process.execPath, [join(root, 'live/run.mjs'), '--endpoint', 'http://127.0.0.1:1', '--report-dir', join(path, 'report'),
    '--final-flush-ms', '100', '--cancel-grace-ms', '1000', '--', process.execPath, script], { cwd: path, env, stdio: 'ignore' });
  const exited = new Promise(resolve => wrapper.once('exit', (code, signal) => resolve({ code, signal })));
  let pids = [];
  t.after(() => {
    wrapper.kill('SIGKILL');
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });
  await until(async () => {
    try { pids = JSON.parse(await readFile(marker, 'utf8')); return true; } catch { return false; }
  });
  wrapper.kill('SIGTERM');
  const outcome = await Promise.race([exited, delay(3000).then(() => { throw new Error('Cancellation did not finish'); })]);
  assert.equal(outcome.code, 143);
  assert.equal(outcome.signal, null);
  await until(async () => (await Promise.all(pids.map(alive))).every(value => !value));
  const names = await readdir(join(path, 'report/telemetry'));
  const spool = await DurableSpool.open(join(path, 'report/telemetry', names[0]));
  const finish = (await spool.readBatch()).events.find(event => event.kind === 'invocation_finish');
  assert.equal(finish.status, 'cancelled');
});

test('an abruptly lost wrapper leaves an unfinished invocation, never a manufactured success', { skip: process.platform === 'win32' }, async t => {
  const path = await directory(t);
  const script = join(path, 'builder.cjs');
  const marker = join(path, 'pid');
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => process.exit(0), 5000);`);
  const wrapper = spawn(process.execPath, [join(root, 'live/run.mjs'), '--endpoint', 'http://127.0.0.1:1', '--report-dir', join(path, 'report'), '--', process.execPath, script], { cwd: path, env, stdio: 'ignore' });
  const exited = new Promise(resolve => wrapper.once('exit', (code, signal) => resolve({ code, signal })));
  let builder;
  t.after(() => { wrapper.kill('SIGKILL'); if (builder) { try { process.kill(-builder, 'SIGKILL'); } catch {} } });
  await until(async () => { try { builder = Number(await readFile(marker, 'utf8')); return true; } catch { return false; } });
  wrapper.kill('SIGKILL');
  assert.equal((await exited).signal, 'SIGKILL');
  const names = await readdir(join(path, 'report/telemetry'));
  const spool = await DurableSpool.open(join(path, 'report/telemetry', names[0]));
  const records = (await spool.readBatch()).events;
  assert.ok(records.some(event => event.kind === 'invocation_start'));
  assert.ok(!records.some(event => event.kind === 'invocation_finish'));
});

test('shared-plan registration attaches the selected dependency group', async t => {
  const path = await directory(t);
  const manifest = { version: 1, graph: {}, plan: { groups: [{ id: 'package-x', system: 'aarch64-linux', kind: 'package', needs: ['compiler'], consumers: ['arm'] }] } };
  await writeFile(join(path, 'execution-plan.json'), JSON.stringify(manifest));
  const registration = await makeRegistration({ env, cwd: path, args: ['--execute-plan', '.', '--group', 'package-x'], invocationId: 'invocation', repository: 'local/nix-ci-build', runId: 'smoke' });
  assert.equal(registration.job.groupId, 'package-x');
  assert.equal(registration.job.system, 'aarch64-linux');
  assert.deepEqual(registration.job.dependencies, ['compiler']);
  assert.equal(registration.run.repository, 'local/nix-ci-build');
  assert.equal(registration.run.runId, 'smoke');
  assert.equal(registration.run.runUrl, '');
});
