import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const mode = process.argv[2];
const directory = resolve(process.env.RUNNER_TEMP || '/tmp', 'nix-ci-live-gha');

if (mode === 'serve') {
  const { startCollector } = await import('./server.mjs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const collector = await startCollector({
    databasePath: join(directory, 'events.sqlite'), httpPort: 0, grpcPort: 0,
    auth: { mode: 'oidc', audience: 'nix-ci-build', repositories: [process.env.GITHUB_REPOSITORY] },
  });
  const connection = { endpoint: `http://${collector.grpcAddress}`, reportUrl: collector.httpAddress };
  await appendFile(process.env.GITHUB_OUTPUT, `endpoint=${connection.endpoint}\nreport-url=${connection.reportUrl}\n`);
  await writeFile(join(directory, 'connection.json'), JSON.stringify(connection));
  console.log('Collector is ready for the GitHub OIDC transport proof.');
  await new Promise(resolvePromise => {
    process.once('SIGINT', resolvePromise);
    process.once('SIGTERM', resolvePromise);
  });
  await collector.close();
} else if (mode === 'wait') {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const { reportUrl } = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8'));
      ready = (await fetch(`${reportUrl}/api/runs`)).ok;
    } catch { /* Background service is starting. */ }
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, 'collector started within 20 seconds');
} else if (mode === 'build') {
  // A transport fixture, clearly separate from the real Nix fixture in
  // real-smoke.mjs. It exercises the bundled action with actual GitHub OIDC.
  const at = process.argv.indexOf('--report-dir');
  assert.ok(at > 0, 'action supplied the builder report directory');
  const report = resolve(process.argv[at + 1]);
  await mkdir(report, { recursive: true });
  const events = join(report, 'events.jsonl');
  const drvPath = '/nix/store/00000000000000000000000000000000-transport-fixture.drv';
  const event = (type, fields = {}) => appendFile(events, `${JSON.stringify({ time: Date.now() / 1000, type, drvPath, name: 'Transport fixture', ...fields })}\n`);
  await event('activity-start', { state: 'building', active: 1 });
  await delay(300);
  await event('phase', { phase: 'transportCheck' });
  await delay(300);
  await event('activity-stop', { state: 'finished', active: 0, seconds: .6 });
  await event('job', { state: 'built', attrs: ['fixture'] });
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, 'Transport fixture succeeded.\n');
} else if (mode === 'verify') {
  const { reportUrl } = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8'));
  const list = await fetch(`${reportUrl}/api/runs`).then(response => response.json());
  assert.equal(list.runs.length, 1);
  const run = list.runs[0];
  assert.equal(run.repository, process.env.GITHUB_REPOSITORY.toLowerCase());
  const detail = await fetch(`${reportUrl}/api/runs/${encodeURIComponent(run.id)}`).then(response => response.json());
  const jobs = detail.jobs.filter(job => job.invocationId);
  assert.equal(jobs.length, 1, 'authenticated action registered exactly once');
  assert.equal(jobs[0].status, 'success');
  assert.ok(detail.activities.length > 0, 'typed build events reached the read API');
  await writeFile(join(directory, 'evidence.json'), JSON.stringify({ run, jobs, activities: detail.activities }, null, 2));
  console.log('Verified the bundled action → GitHub OIDC → gRPC → SQLite → read API path.');
} else {
  throw new Error('Expected serve, wait, build, or verify');
}
