import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AuthenticationError, AuthorizationError, GITHUB_ISSUER, createAuthenticator } from './auth.mjs';

const now = 1_800_000_000;
const audience = 'https://collector.example.test';
const repositories = ['nix-ocaml/nix-ci-build'];
const claims = { repository: repositories[0], repository_id: '456', run_id: '1234', run_attempt: '2', check_run_id: '789', sub: 'repo:nix-ocaml/nix-ci-build:pull_request' };

async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
  const auth = createAuthenticator({ mode: 'oidc', audience, repositories }, {
    keySet: createLocalJWKSet({ keys: [jwk] }), now: () => now * 1000,
  });
  const token = (payload = {}, options = {}) => new SignJWT({ ...claims, ...payload })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(options.issuer ?? GITHUB_ISSUER)
    .setAudience(options.audience ?? audience)
    .setIssuedAt(now - 10)
    .setExpirationTime(options.expiry ?? now + 300)
    .sign(privateKey);
  return { auth, token };
}

test('OIDC binds a verified repository, workflow run, and retry to reports', async () => {
  const { auth, token } = await fixture();
  const principal = await auth.authenticate(`Bearer ${await token()}`);
  assert.equal(principal.repository, repositories[0]);
  const run = { repository: repositories[0], repositoryId: '456', runId: '1234', runAttempt: 2 };
  auth.authorizeRun(principal, run);
  auth.authorizeInvocation(principal, { run, job: { checkRunId: '789' } });
  assert.throws(() => auth.authorizeInvocation(principal, { run, job: { checkRunId: '790' } }), AuthorizationError);
  assert.throws(() => auth.authorizeInvocation(principal, { run, job: {} }), AuthorizationError);
  assert.throws(() => auth.authorizeRun(principal, { ...run, repositoryId: '457' }), AuthorizationError);
  for (const run of [
    { repository: 'another/project', githubRunId: '1234', runAttempt: 2 },
    { repository: repositories[0], githubRunId: '1235', runAttempt: 2 },
    { repository: repositories[0], githubRunId: '1234', runAttempt: 1 },
  ]) assert.throws(() => auth.authorizeRun(principal, run), AuthorizationError);
});

test('OIDC rejects invalid signatures, audience, issuer, expiration, and repository', async () => {
  const { auth, token } = await fixture();
  for (const options of [
    { audience: 'https://another.example.test' },
    { issuer: 'https://attacker.example.test' },
    { expiry: now - 30 },
  ]) await assert.rejects(auth.authenticate(`Bearer ${await token({}, options)}`), AuthenticationError);
  await assert.rejects(auth.authenticate(`Bearer ${await token({ repository: 'another/project' })}`), AuthorizationError);
  await assert.rejects(auth.authenticate(`Bearer ${await token({ run_id: '' })}`), AuthenticationError);
  const attacker = await fixture();
  await assert.rejects(auth.authenticate(`Bearer ${await attacker.token()}`), AuthenticationError);
  await assert.rejects(auth.authenticate('Bearer unsigned'), AuthenticationError);
  await assert.rejects(auth.authenticate(''), AuthenticationError);
});

test('collector authentication fails closed when trust configuration is missing', () => {
  assert.throws(() => createAuthenticator({ mode: 'oidc', audience, repositories: [] }), /allowlist/);
  assert.throws(() => createAuthenticator({ mode: 'oidc', repositories }), /AUDIENCE/);
  assert.throws(() => createAuthenticator({ mode: 'none', repositories }), /Unknown/);
  assert.throws(() => createAuthenticator({ mode: 'oidc', audience, repositories, tokenFile: '/tmp/token' }), /explicit/);
});

test('dev authentication requires an explicitly configured private token file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nix-ci-live-auth-'));
  try {
    const path = join(directory, 'token');
    const token = 'test-only-token-that-is-longer-than-thirty-two-bytes';
    writeFileSync(path, token, { mode: 0o600 });
    const auth = createAuthenticator({ mode: 'dev', repositories, tokenFile: path });
    const principal = await auth.authenticate(`Bearer ${token}`);
    auth.authorizeRun(principal, { repository: repositories[0] });
    assert.throws(() => auth.authorizeRun(principal, { repository: 'another/project' }), AuthorizationError);
    await assert.rejects(auth.authenticate(`Bearer ${token}wrong`), AuthenticationError);
    assert.throws(() => createAuthenticator({ mode: 'dev', repositories }), /TOKEN_FILE/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
