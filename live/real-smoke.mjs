import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startCollector } from './server.mjs';

// Opt-in proof with actual Nix derivations and a shared binary cache. This
// deliberately uses the integration fixture's host shell/sandbox=false.
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const builder = option('--builder');
if (!builder) throw new Error('Usage: node live/real-smoke.mjs --builder /absolute/path/to/nix-ci-build [--directory DIR] [--keep-running]');
const directory = resolve(option('--directory') || `/tmp/nix-ci-live-${randomUUID()}`);
const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
await mkdir(directory, { recursive: true, mode: 0o755 });
await chmod(directory, 0o755);
const tokenFile = join(directory, 'dev-token');
await writeFile(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
const fixture = join(directory, 'fixture');
await mkdir(fixture, { recursive: true });
await copyFile(join(repo, 'test/shared-plan-fixture/flake.nix'), join(fixture, 'flake.nix'));
const system = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'darwin' : 'linux'}`;
const ledger = join(directory, 'builders.log');
await writeFile(ledger, '', { mode: 0o666 });
await chmod(ledger, 0o666);
await writeFile(join(fixture, 'settings.nix'), `{ system = ${JSON.stringify(system)}; ledger = ${JSON.stringify(ledger)}; }\n`);
const setsFile = join(directory, 'sets.json');
await writeFile(setsFile, JSON.stringify({
  sets: ['native', 'cross'].map(id => ({ id, flake: `path:${fixture}#${id}` })),
  runners: { [system]: process.platform },
}));
const cache = join(directory, 'cache');
await mkdir(cache, { recursive: true });
await writeFile(join(cache, 'nix-cache-info'), 'StoreDir: /nix/store\nWantMassQuery: 1\n');
const collector = await startCollector({
  databasePath: join(directory, 'events.sqlite'),
  grpcPort: 0,
  httpPort: Number(option('--http-port') || 0),
  auth: { mode: 'dev', repositories: ['local/nix-ci-build'], tokenFile },
});
const endpoint = `http://${collector.grpcAddress}`;
const reportUrl = collector.httpAddress;
const runId = `local-proof-${randomUUID()}`;
const plan = join(directory, 'plan');
const env = {
  ...process.env,
  NIX_CONFIG: 'experimental-features = nix-command flakes\nsandbox = false\nsubstituters =\nextra-substituters =\nrequire-sigs = false\n',
};

function invoke(job, cli, reportDir) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(here, 'run.mjs'),
      '--endpoint', endpoint, '--report-url', reportUrl,
      '--repository', 'local/nix-ci-build', '--run-id', runId, '--job-id', job,
      '--report-dir', reportDir, '--token-file', tokenFile, '--', resolve(builder), ...cli,
    ], { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolvePromise() : reject(new Error(`${job} exited ${code ?? signal}`)));
  });
}

try {
  console.log(`Live proof: ${reportUrl}`);
  await invoke('plan', ['--plan-sets', setsFile, '--report-dir', plan], plan);
  const manifest = JSON.parse(await readFile(join(plan, 'execution-plan.json'), 'utf8'));
  const finished = new Set();
  const pending = new Map(manifest.plan.groups.map(group => [group.id, group]));
  while (pending.size) {
    const ready = [...pending.values()].filter(group => (group.needs || []).every(id => finished.has(id)));
    assert.ok(ready.length, 'shared plan contains no ready group');
    await Promise.all(ready.map(async group => {
      const reportDir = join(directory, 'reports', group.id);
      await invoke(group.id, ['--execute-plan', plan, '--group', group.id,
        '--copy-from', pathToFileURL(cache).href, '--copy-to', pathToFileURL(cache).href,
        '--report-dir', reportDir], reportDir);
      pending.delete(group.id);
      finished.add(group.id);
    }));
  }
  const built = (await readFile(ledger, 'utf8')).trim().split('\n');
  assert.equal(built.filter(name => name === 'opaque-shared-tool').length, 1, 'shared tool must build once');
  assert.equal(built.length, 5, 'exactly five owned derivations must build');
  const list = await fetch(`${reportUrl}/api/runs`).then(response => response.json());
  const run = list.runs.find(run => run.repository === 'local/nix-ci-build');
  assert.ok(run, 'collector received the local run');
  const detail = await fetch(`${reportUrl}/api/runs/${encodeURIComponent(run.id)}`).then(response => response.json());
  const observed = detail.jobs.filter(job => job.invocationId);
  assert.equal(observed.length, 4, 'planner plus three matrix workers');
  assert.ok(detail.activities.length >= 5, 'real Nix activities reached the read API');
  assert.ok(observed.every(job => job.status === 'success'), 'all commands succeeded');
  const result = { directory, reportUrl: `${reportUrl}/runs/${encodeURIComponent(run.id)}`, runId: run.id,
    builders: built, invocations: observed.length, activities: detail.activities.length,
    database: join(directory, 'events.sqlite') };
  await writeFile(join(directory, 'evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (args.includes('--keep-running')) {
    console.log('Collector remains available until this process receives SIGINT or SIGTERM.');
    await new Promise(resolvePromise => {
      process.once('SIGINT', resolvePromise);
      process.once('SIGTERM', resolvePromise);
    });
  }
} finally {
  await collector.close();
}
