import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { startCollector } from './server.mjs';
import { GITHUB_ISSUER } from './auth.mjs';
import { grpc, ReportingClient } from './protocol.mjs';

const repository = 'nix-ocaml/nix-ci-build';
const registration = {
  invocationId: 'invocation-a',
  run: { repository, repositoryId: '1', runId: '22', runAttempt: 1, title: '<script>untrusted</script>' },
  job: { jobId: 'a', checkRunId: '33' },
};
const start = { sequence: 1, occurredAtMs: 1000, kind: 'invocation_start' };
const finish = { sequence: 2, occurredAtMs: 2000, kind: 'invocation_finish', terminal: true, status: 'success', durationSeconds: 1 };
const batch = events => ({ invocationId: registration.invocationId, streamId: 'source', events });

function invoke(client, method, request, token) {
  const metadata = new grpc.Metadata();
  if (token) metadata.set('authorization', `Bearer ${token}`);
  return new Promise((resolve, reject) => client[method](request, metadata, { deadline: Date.now() + 5000 }, (error, result) => error ? reject(error) : resolve(result)));
}

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'nix-live-server-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('gRPC ACKs are durable across restart and REST/SSE expose committed projections', async t => {
  const path = directory(t);
  const token = 'test-only-' + 'a'.repeat(48);
  const tokenFile = join(path, 'token');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const config = { databasePath: join(path, 'events.sqlite'), httpPort: 0, grpcPort: 0, auth: { mode: 'dev', repositories: [repository], tokenFile }, now: () => 2000 };
  let collector = await startCollector(config);
  let client = new ReportingClient(collector.grpcAddress, grpc.credentials.createInsecure());
  const controller = new AbortController();
  t.after(async () => { controller.abort(); client.close(); await collector.close(); });
  await assert.rejects(invoke(client, 'registerInvocation', registration), error => error.code === grpc.status.UNAUTHENTICATED);
  const response = await fetch(`${collector.httpAddress}/api/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
  const registered = await invoke(client, 'registerInvocation', registration, token);
  assert.equal(registered.runKey, 'github:nix-ocaml/nix-ci-build:22:1');
  assert.equal(registered.reportUrl, `${collector.httpAddress}/runs/${encodeURIComponent(registered.runKey)}`);
  const invalidation = new TextDecoder().decode((await reader.read()).value);
  assert.match(invalidation, /event: invalidate/);
  assert.match(invalidation, /github:nix-ocaml\/nix-ci-build:22:1/);
  assert.deepEqual(await invoke(client, 'publish', batch([start, finish]), token), { lastSequence: 2 });
  const detail = await (await fetch(`${collector.httpAddress}/api/runs/${encodeURIComponent(registered.runKey)}`)).json();
  assert.equal(detail.run.status, 'success');
  assert.equal(detail.run.title, '<script>untrusted</script>');
  assert.equal(detail.jobs[0].durationSeconds, 1);
  assert.equal(detail.run.workflowStatus, null);
  assert.equal((await fetch(`${collector.httpAddress}/api/runs`, { headers: { origin: 'https://hostile.example' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => get(`${collector.httpAddress}/api/runs`, { headers: { host: 'hostile.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject));
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${collector.httpAddress}/api/runs`, { method: 'POST' })).status, 405);
  controller.abort();
  client.close();
  const oldPort = Number(collector.grpcAddress.split(':').at(-1));
  await collector.close();
  collector = await startCollector({ ...config, grpcPort: oldPort });
  client = new ReportingClient(collector.grpcAddress, grpc.credentials.createInsecure());
  const before = collector.store.revision;
  await invoke(client, 'registerInvocation', registration, token);
  assert.equal((await invoke(client, 'publish', batch([start, finish]), token)).lastSequence, 2);
  assert.equal(collector.store.revision, before);
  await assert.rejects(invoke(client, 'publish', batch([{ ...finish, sequence: 4 }]), token), error => error.code === grpc.status.FAILED_PRECONDITION && error.metadata.get('last-sequence')[0] === '2');
  assert.equal((await (await fetch(`${collector.httpAddress}/api/runs`)).json()).runs.length, 1);
});

test('OIDC publisher is bound to the original verified repository, run, and check run', async t => {
  const path = directory(t);
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = await exportJWK(publicKey);
  key.kid = 'test';
  const collector = await startCollector({
    databasePath: ':memory:', httpPort: 0, grpcPort: 0,
    auth: { mode: 'oidc', repositories: [repository], audience: 'nix-ci-build' },
    authOptions: { keySet: createLocalJWKSet({ keys: [key] }) },
    staticDirectory: path,
  });
  const client = new ReportingClient(collector.grpcAddress, grpc.credentials.createInsecure());
  t.after(async () => { client.close(); await collector.close(); });
  async function token(claims = {}) {
    return new SignJWT({ repository, repository_id: '1', run_id: '22', run_attempt: '1', check_run_id: '33', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(GITHUB_ISSUER).setAudience('nix-ci-build')
      .setSubject('repo:nix-ocaml/nix-ci-build:ref:refs/heads/main').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  }
  const valid = await token();
  await invoke(client, 'registerInvocation', registration, valid);
  assert.equal((await invoke(client, 'publish', batch([start]), valid)).lastSequence, 1);
  for (const claims of [{ check_run_id: '34' }, { repository_id: '2' }, { run_id: '23' }, { run_attempt: '2' }]) {
    const other = await token(claims);
    await assert.rejects(invoke(client, 'publish', batch([finish]), other), error => error.code === grpc.status.PERMISSION_DENIED);
    await assert.rejects(invoke(client, 'registerInvocation', { ...registration, invocationId: 'forged' }, other), error => error.code === grpc.status.PERMISSION_DENIED);
  }
  const otherJob = await token({ check_run_id: '34' });
  await assert.rejects(invoke(client, 'registerInvocation', { ...registration, job: { ...registration.job, checkRunId: '34' } }, otherJob), error => error.code === grpc.status.ALREADY_EXISTS);
  assert.equal(collector.store.events('github:nix-ocaml/nix-ci-build:22:1').length, 1);
  assert.equal((await invoke(client, 'publish', batch([finish]), valid)).lastSequence, 2);
});

test('startup without an explicit authentication trust configuration fails closed', async () => {
  await assert.rejects(startCollector({ databasePath: ':memory:', httpPort: 0, grpcPort: 0, auth: { mode: 'oidc', repositories: [repository] } }), /AUDIENCE/);
  await assert.rejects(startCollector({ databasePath: ':memory:', httpPort: 0, grpcPort: 0, auth: { mode: 'oidc', audience: 'nix-ci-build', repositories: [] } }), /allowlist/);
});
