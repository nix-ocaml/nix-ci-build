import { readFileSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_JWKS = new URL(`${GITHUB_ISSUER}/.well-known/jwks`);

export class AuthenticationError extends Error {
  constructor(message = 'Reporter authentication failed') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends Error {
  constructor(message = 'Reporter is not authorized for this run') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

function repositoryName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
    ? value.toLowerCase() : null;
}

function identifier(value) {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : null;
}

export function authConfigFromEnv(env = process.env) {
  return {
    mode: env.NIX_CI_LIVE_AUTH_MODE || 'oidc',
    audience: env.NIX_CI_LIVE_OIDC_AUDIENCE,
    repositories: (env.NIX_CI_LIVE_REPOSITORIES || '').split(',').map(value => value.trim()).filter(Boolean),
    tokenFile: env.NIX_CI_LIVE_DEV_TOKEN_FILE,
  };
}

/** Verify credentials once per RPC. No token or unverified claim is persisted. */
export function createAuthenticator(config, { keySet, now = () => Date.now(), authorizeRepository } = {}) {
  const repositories = new Set((config.repositories || []).map(repositoryName));
  const installedRepositories = typeof authorizeRepository === 'function' && config.mode === 'oidc';
  if ((!repositories.size && !installedRepositories) || repositories.has(null)) {
    throw new Error('NIX_CI_LIVE_REPOSITORIES must contain an explicit owner/repository allowlist');
  }
  if (!['oidc', 'dev'].includes(config.mode)) throw new Error('Unknown live reporter authentication mode');

  let devToken;
  let keys;
  if (config.mode === 'dev') {
    if (!config.tokenFile) throw new Error('Dev authentication requires NIX_CI_LIVE_DEV_TOKEN_FILE');
    const info = statSync(config.tokenFile);
    if (!info.isFile() || (info.mode & 0o077) !== 0) {
      throw new Error('The dev token must be a private regular file (mode 0600)');
    }
    devToken = Buffer.from(readFileSync(config.tokenFile, 'utf8').trim());
    if (devToken.length < 32 || devToken.length > 4096) {
      throw new Error('The dev token must contain 32–4096 bytes');
    }
  } else {
    if (config.tokenFile) throw new Error('A dev token file requires explicit NIX_CI_LIVE_AUTH_MODE=dev');
    if (typeof config.audience !== 'string' || !config.audience.trim()) {
      throw new Error('NIX_CI_LIVE_OIDC_AUDIENCE is required');
    }
    keys = keySet || createRemoteJWKSet(GITHUB_JWKS, { timeoutDuration: 5000 });
  }

  return {
    mode: config.mode,
    async authenticate(authorization) {
      if (typeof authorization !== 'string' || authorization.length > 16384) throw new AuthenticationError();
      const match = /^Bearer ([^\s]+)$/i.exec(authorization);
      if (!match) throw new AuthenticationError();
      if (config.mode === 'dev') {
        const supplied = Buffer.from(match[1]);
        if (supplied.length !== devToken.length || !timingSafeEqual(supplied, devToken)) {
          throw new AuthenticationError();
        }
        return { mode: 'dev', repositories };
      }
      let payload;
      try {
        ({ payload } = await jwtVerify(match[1], keys, {
          algorithms: ['RS256'],
          issuer: GITHUB_ISSUER,
          audience: config.audience,
          requiredClaims: ['exp', 'iat', 'sub', 'repository', 'repository_id', 'run_id', 'run_attempt', 'check_run_id'],
          clockTolerance: 5,
          currentDate: new Date(now()),
        }));
      } catch {
        throw new AuthenticationError();
      }
      const repository = repositoryName(payload.repository);
      const githubRunId = identifier(payload.run_id);
      const runAttempt = identifier(payload.run_attempt);
      const repositoryId = identifier(payload.repository_id);
      const checkRunId = identifier(payload.check_run_id);
      if (!repository || (repositories.size && !repositories.has(repository))) throw new AuthorizationError('Repository is not allowed');
      if (!githubRunId || !runAttempt || !repositoryId || !checkRunId || typeof payload.sub !== 'string' || !payload.sub) {
        throw new AuthenticationError();
      }
      // In service mode the verified repository ID must belong to an active
      // installation. An optional explicit allowlist can narrow that scope.
      if (installedRepositories && !await authorizeRepository({ repository, repositoryId })) {
        throw new AuthorizationError('Repository is not connected');
      }
      return {
        mode: 'oidc', repository, repositoryId, githubRunId, runAttempt, checkRunId,
        subject: payload.sub,
        workflowRef: typeof payload.workflow_ref === 'string' ? payload.workflow_ref : null,
        commitSha: typeof payload.sha === 'string' ? payload.sha : null,
        ref: typeof payload.ref === 'string' ? payload.ref : null,
      };
    },
    authorizeRun(principal, run) {
      const repository = repositoryName(run.repository);
      if (!repository || (repositories.size && !repositories.has(repository))) throw new AuthorizationError('Repository is not allowed');
      if (principal.mode === 'dev') return;
      if (repository !== principal.repository || String(run.repositoryId) !== principal.repositoryId || String(run.githubRunId ?? run.runId) !== principal.githubRunId || String(run.runAttempt) !== principal.runAttempt) {
        throw new AuthorizationError();
      }
    },
    authorizeInvocation(principal, registration) {
      this.authorizeRun(principal, registration.run);
      if (principal.mode !== 'dev' && String(registration.job.checkRunId) !== principal.checkRunId) {
        throw new AuthorizationError('Reporter cannot publish another job’s invocation');
      }
    },
  };
}
