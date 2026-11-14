import test from 'node:test';
import assert from 'node:assert/strict';
import { githubIdentity, oidcTokenSource, parseMatrix, requestOidcToken, safeDiagnostic } from './github.mjs';

const env = {
  GITHUB_REPOSITORY: 'example/packages', GITHUB_REPOSITORY_ID: '42',
  GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'build',
  GITHUB_SHA: 'merge-sha', GITHUB_REF: 'refs/pull/99/merge',
};

test('PR identity distinguishes the actual head commit from the tested merge commit', () => {
  const identity = githubIdentity({ env, invocationId: 'invoke-1', event: {
    number: 99, pull_request: { number: 99, head: { sha: 'head-sha', ref: 'fix' }, base: { ref: 'master' } },
  } });
  assert.equal(identity.headSha, 'head-sha');
  assert.equal(identity.checkoutSha, 'merge-sha');
  assert.equal(identity.pullRequestNumber, 99);
  assert.equal(identity.runId, 'github:example/packages:1234');
  assert.equal(identity.runAttempt, 2);
  assert.match(identity.runUrl, /\/attempts\/2$/);
});

test('matrix order is canonical, distinct jobs and reruns retain separate identities', () => {
  const first = githubIdentity({ env, matrix: { ocaml: '5.5', target: 'musl' }, invocationId: 'one' });
  const ordered = githubIdentity({ env, matrix: { target: 'musl', ocaml: '5.5' }, invocationId: 'two' });
  const native = githubIdentity({ env, matrix: { ocaml: '5.5', target: 'native' }, invocationId: 'three' });
  assert.equal(first.jobKey, ordered.jobKey);
  assert.notEqual(first.attemptId, ordered.attemptId);
  assert.notEqual(first.jobKey, native.jobKey);
  assert.throws(() => parseMatrix('[]'), /JSON object/);
});

test('OIDC check run identity is used directly without guessing a matrix job by display name', () => {
  const identity = githubIdentity({ env, claims: { check_run_id: '5678' } });
  assert.equal(identity.checkRunId, '5678');
  assert.equal(identity.jobUrl, 'https://github.com/example/packages/runs/5678');
  assert.equal(githubIdentity({ env }).checkRunId, '');
});

test('OIDC token request uses the requested audience and avoids leaking transport exceptions', async () => {
  const oidcEnv = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token?x=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret' };
  await assert.rejects(requestOidcToken({ env: {} }), /id-token: write/);
  const token = await requestOidcToken({ env: oidcEnv, audience: 'collector', fetchImpl: async (url, options) => {
    assert.equal(url.searchParams.get('audience'), 'collector');
    assert.equal(options.headers.authorization, 'Bearer secret');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ value: 'oidc-jwt' }) };
  } });
  assert.equal(token, 'oidc-jwt');
  await assert.rejects(requestOidcToken({ env: oidcEnv, audience: 'collector', fetchImpl: async () => {
    throw new Error('secret token leaked from transport');
  } }), error => !error.message.includes('secret') && /could not complete/.test(error.message));
  assert.equal(safeDiagnostic({ code: 16, message: 'secret' }), 'transport code 16');
});

test('concurrent OIDC requests share a refresh and refresh before expiration', async () => {
  let requests = 0;
  const source = oidcTokenSource({
    env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret' },
    audience: 'collector',
    fetchImpl: async () => {
      requests++;
      const body = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
      return { ok: true, json: async () => ({ value: `header.${body}.signature-${requests}` }) };
    },
  });
  const [one, two] = await Promise.all([source(), source()]);
  assert.equal(one, two);
  assert.equal(requests, 1);
  assert.equal(await source(), one);
  assert.notEqual(await source({ refresh: true }), one);
  assert.equal(requests, 2);
});
