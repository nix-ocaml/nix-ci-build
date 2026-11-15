import { githubRunMetadata, normalizeGithub, normalizeGithubJob } from './github-reconcile.mjs';
import { StoreError } from './store.mjs';

const actions = {
  workflow_run: new Set(['requested', 'in_progress', 'completed']),
  workflow_job: new Set(['queued', 'waiting', 'in_progress', 'completed']),
};

function id(value, name) {
  if (!/^[1-9]\d*$/.test(String(value)) || (typeof value === 'number' && !Number.isSafeInteger(value))) {
    throw new StoreError(`Invalid GitHub ${name}`);
  }
  return String(value);
}

function attempt(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new StoreError('Invalid GitHub run attempt');
  return result;
}

/** Ingest only after signature validation and installation/repository authorization. */
export function ingestGithubWebhook(store, delivery) {
  const { event, payload } = delivery;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new StoreError('Invalid GitHub webhook payload');
  if (!actions[event]?.has(payload.action)) {
    return { ...store.ingestGithub(delivery), ignored: true };
  }
  const repository = payload.repository;
  const repositoryId = id(repository?.id, 'repository ID');
  if (typeof repository.full_name !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository.full_name)) {
    throw new StoreError('Invalid GitHub repository');
  }
  if (event === 'workflow_run') {
    const run = payload.workflow_run;
    id(run?.id, 'run ID');
    attempt(run?.run_attempt);
    if (run.repository?.id != null && String(run.repository.id) !== repositoryId) throw new StoreError('Webhook contains conflicting repository identities');
    const normalized = { ...run, status: run.status || payload.action, repository };
    const snapshot = { ...normalizeGithub(normalized, [], { now: store.now() }), source: 'webhook', jobsTruncated: true };
    return store.ingestGithub(delivery, githubRunMetadata(normalized, repository), snapshot);
  }
  const job = payload.workflow_job;
  id(job?.id, 'job ID');
  const runId = id(job?.run_id, 'run ID');
  const runAttempt = attempt(job?.run_attempt);
  // A completed job does not establish the workflow's outcome: other matrix
  // jobs may still run, and the final report/upload job may fail afterwards.
  const run = {
    id: runId, run_attempt: runAttempt, repository,
    name: job.workflow_name, head_sha: job.head_sha, head_branch: job.head_branch,
    html_url: `https://github.com/${repository.full_name}/actions/runs/${runId}`,
    status: ['queued', 'waiting'].includes(payload.action) ? 'queued' : 'in_progress',
  };
  const snapshot = {
    ...normalizeGithub(run, [], { now: store.now() }), source: 'webhook', jobsTruncated: true,
    jobs: [normalizeGithubJob({ ...job, status: job.status || payload.action })],
  };
  return store.ingestGithub(delivery, githubRunMetadata(run, repository), snapshot);
}
