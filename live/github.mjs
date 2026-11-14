import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function parseMatrix(value = '{}') {
  const matrix = typeof value === 'string' ? JSON.parse(value || '{}') : value;
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
    throw new Error('matrix must be a JSON object');
  }
  return canonical(matrix);
}

// Token claims are hints here. The collector verifies the signature and binds
// the submitted identity to those claims before accepting an event.
export function tokenClaims(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : {};
  } catch {
    return {};
  }
}

export async function readGitHubEvent(env = process.env) {
  if (!env.GITHUB_EVENT_PATH) return {};
  try {
    return JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    throw new Error('Cannot read the GitHub event payload');
  }
}

export function githubIdentity({ env = process.env, event = {}, claims = {}, matrix = {}, invocationId = randomUUID() } = {}) {
  const coordinates = JSON.stringify(parseMatrix(matrix));
  const matrixId = createHash('sha256').update(coordinates).digest('hex').slice(0, 16);
  const repository = env.GITHUB_REPOSITORY || claims.repository || '';
  const repositoryId = String(env.GITHUB_REPOSITORY_ID || claims.repository_id || event.repository?.id || '');
  const workflowRunId = String(env.GITHUB_RUN_ID || claims.run_id || '');
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT || claims.run_attempt || 1);
  const jobId = env.GITHUB_JOB || 'build';
  const github = Boolean(workflowRunId && repository);
  const pullRequest = event.pull_request;
  const headSha = pullRequest?.head?.sha || event.workflow_run?.head_sha || env.GITHUB_SHA || claims.sha || '';
  const serverUrl = env.GITHUB_SERVER_URL || 'https://github.com';
  return {
    provider: github ? 'github' : 'local',
    runId: github ? `github:${repository}:${workflowRunId}` : `local:${invocationId}`,
    attemptId: invocationId,
    invocationId,
    repository,
    repositoryId,
    workflowRunId,
    runAttempt,
    workflow: env.GITHUB_WORKFLOW || claims.workflow || '',
    jobId,
    jobKey: `${jobId}:${matrixId}`,
    checkRunId: String(claims.check_run_id || ''),
    matrixJson: coordinates,
    headSha,
    checkoutSha: env.GITHUB_SHA || claims.sha || '',
    ref: env.GITHUB_REF || claims.ref || '',
    headRef: pullRequest?.head?.ref || env.GITHUB_HEAD_REF || '',
    baseRef: pullRequest?.base?.ref || env.GITHUB_BASE_REF || '',
    pullRequestNumber: Number(pullRequest?.number || event.number || 0),
    runUrl: github ? `${serverUrl}/${repository}/actions/runs/${workflowRunId}/attempts/${runAttempt}` : '',
    jobUrl: claims.check_run_id ? `${serverUrl}/${repository}/runs/${claims.check_run_id}` : '',
    runnerName: env.RUNNER_NAME || '',
    runnerOs: env.RUNNER_OS || process.platform,
    runnerArch: env.RUNNER_ARCH || process.arch,
  };
}

export async function requestOidcToken({ audience, env = process.env, fetchImpl = fetch, timeoutMs = 5000, signal } = {}) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw Object.assign(new Error('GitHub OIDC is unavailable; give this job permissions: id-token: write'), { hint: 'missing-oidc-permission' });
  }
  let url;
  try {
    url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (url.protocol !== 'https:') throw new Error();
    url.searchParams.set('audience', audience);
  } catch {
    throw new Error('Invalid GitHub OIDC request URL');
  }
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch {
    // Fetch exceptions can include URLs or headers; never expose credentials.
    throw new Error('GitHub OIDC request could not complete');
  }
  if (!response.ok) throw new Error(`GitHub OIDC request failed (HTTP ${response.status})`);
  let token;
  try {
    token = (await response.json()).value;
  } catch {
    throw new Error('GitHub OIDC returned an invalid response');
  }
  if (typeof token !== 'string' || !token) throw new Error('GitHub OIDC returned no token');
  return token;
}

export function oidcTokenSource(options = {}) {
  let cached;
  let pending;
  return async ({ refresh = false, signal } = {}) => {
    if (!refresh && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    if (!pending) {
      pending = requestOidcToken({ ...options, signal }).then(token => {
        const exp = Number(tokenClaims(token).exp);
        cached = { token, expiresAt: Number.isFinite(exp) ? exp * 1000 : Date.now() + 60_000 };
        return token;
      }).finally(() => { pending = undefined; });
    }
    return pending;
  };
}

export function safeDiagnostic(error) {
  // Service errors may echo rejected metadata, including bearer tokens. Only
  // transport codes belong in the action's log; details stay off the console.
  if (error?.hint === 'missing-oidc-permission') return 'GitHub OIDC is unavailable; give this job permissions: id-token: write';
  return Number.isInteger(error?.code) ? `transport code ${error.code}` : 'connection unavailable';
}
