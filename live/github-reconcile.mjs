import { normalizeRun, runKey } from './store.mjs';

const API = 'https://api.github.com';
const timestamp = value => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const text = value => typeof value === 'string' ? value : '';
const present = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== ''));

export function githubRunMetadata(run, repository = run.repository) {
  if (!repository?.full_name) return undefined;
  return present({
    repository: repository.full_name.toLowerCase(), repositoryId: String(repository.id),
    runId: String(run.id), runAttempt: Number(run.run_attempt),
    workflow: text(run.name), branch: text(run.head_branch), headSha: text(run.head_sha),
    title: text(run.display_title), actor: text(run.actor?.login),
    runUrl: text(run.html_url), commitMessage: text(run.head_commit?.message),
    eventName: text(run.event), startedAtMs: timestamp(run.run_started_at),
    pullRequestNumber: run.pull_requests?.[0]?.number,
  });
}

export function normalizeGithubJob(job) {
  return {
    id: String(job.id),
    checkRunId: /\/check-runs\/(\d+)$/.exec(text(job.check_run_url))?.[1] || '',
    name: text(job.name), status: text(job.status), conclusion: text(job.conclusion), url: text(job.html_url),
    runnerName: text(job.runner_name), runnerGroupName: text(job.runner_group_name),
    labels: (job.labels || []).filter(label => typeof label === 'string'),
    createdAt: timestamp(job.created_at), startedAt: timestamp(job.started_at), completedAt: timestamp(job.completed_at),
    steps: (job.steps || []).map(step => ({
      number: Number(step.number), name: text(step.name), status: text(step.status), conclusion: text(step.conclusion),
      startedAt: timestamp(step.started_at), completedAt: timestamp(step.completed_at),
    })),
  };
}

export function normalizeGithub(run, jobs, { now = Date.now(), truncated = false } = {}) {
  return {
    source: 'api',
    metadata: githubRunMetadata(run),
    fetchedAt: now,
    jobsTruncated: truncated,
    run: {
      id: String(run.id),
      attempt: Number(run.run_attempt),
      status: text(run.status),
      conclusion: text(run.conclusion),
      url: text(run.html_url),
      createdAt: timestamp(run.created_at),
      startedAt: timestamp(run.run_started_at),
      updatedAt: timestamp(run.updated_at),
      headSha: text(run.head_sha),
      headBranch: text(run.head_branch),
      event: text(run.event),
    },
    jobs: jobs.map(normalizeGithubJob),
  };
}

// The token stays in the collector. This read-only client never receives a
// runner's GITHUB_TOKEN and never follows an endpoint from uploaded metadata.
export function createGithubReader({ token, tokenProvider, isRepositoryConnected = () => true, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!token && !tokenProvider) throw new Error('GitHub reconciliation requires a read-only Actions token');
  const cache = new Map();

  async function get(path, signal, bearer, identity) {
    const cacheKey = `${identity.repositoryId || identity.repository}:${path}`;
    const cached = cache.get(cacheKey);
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${bearer}`,
      'user-agent': 'nix-ci-build-live',
      'x-github-api-version': '2022-11-28',
    };
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    const response = await fetchImpl(`${API}${path}`, {
      headers,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 304 && cached) return cached.body;
    if (!response.ok) {
      const error = new Error(`GitHub reconciliation HTTP ${response.status}`);
      error.status = response.status;
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const retry = Number(response.headers.get('retry-after')) * 1000;
      error.retryAfterMs = Math.max(0, Math.min(3600000, retry || (reset - Date.now()) || 0));
      throw error;
    }
    const body = await response.json();
    cache.set(cacheKey, { etag: response.headers.get('etag'), body });
    // Bound cache use even on a long-lived collector with many historical runs.
    if (cache.size > 2048) cache.delete(cache.keys().next().value);
    return body;
  }

  async function access(identity) {
    if (!await isRepositoryConnected(identity)) return null;
    return tokenProvider ? await tokenProvider(identity) : token;
  }

  async function read(identity, { signal } = {}) {
    const { repository, runId, runAttempt } = identity;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^\d+$/.test(String(runId)) || !Number.isInteger(runAttempt) || runAttempt < 1) {
      throw new Error('Invalid GitHub run identity');
    }
    // Check before token acquisition, including cached installation tokens.
    const bearer = await access(identity);
    if (!bearer) return null;
    const path = `/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}`;
    const [run, page] = await Promise.all([
      get(path, signal, bearer, identity),
      get(`${path}/jobs?per_page=100&page=1`, signal, bearer, identity),
    ]);
    if (String(run.id) !== String(runId) || Number(run.run_attempt) !== runAttempt) {
      throw new Error('GitHub returned a different workflow attempt');
    }
    if (identity.repositoryId && String(run.repository?.id) !== identity.repositoryId) throw new Error('GitHub returned a different repository');
    const jobs = [...(page.jobs || [])];
    const total = Math.max(jobs.length, Number(page.total_count) || 0);
    for (let pageNumber = 2; jobs.length < total && pageNumber <= 10; pageNumber++) {
      const next = await get(`${path}/jobs?per_page=100&page=${pageNumber}`, signal, bearer, identity);
      if (!next.jobs?.length) break;
      jobs.push(...next.jobs);
    }
    // An attempt endpoint must not silently mix jobs from a subsequent retry.
    if (jobs.some(job => job.run_attempt != null && Number(job.run_attempt) !== runAttempt)) {
      throw new Error('GitHub returned jobs from a different workflow attempt');
    }
    return normalizeGithub(run, jobs, { truncated: jobs.length < total });
  }

  read.discover = async function discover(identity, { signal } = {}) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(identity.repository) || !/^[1-9]\d*$/.test(identity.repositoryId)) throw new Error('Invalid GitHub repository identity');
    const bearer = await access(identity);
    if (!bearer) return [];
    const page = await get(`/repos/${identity.repository}/actions/runs?per_page=30`, signal, bearer, identity);
    if (!Array.isArray(page.workflow_runs)) throw new Error('GitHub returned an invalid workflow list');
    return page.workflow_runs.slice(0, 30).map(run => {
      if (String(run.repository?.id) !== identity.repositoryId) throw new Error('GitHub returned a different repository');
      if (!/^[1-9]\d*$/.test(String(run.id)) || (typeof run.id === 'number' && !Number.isSafeInteger(run.id))
        || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error('GitHub returned an invalid workflow identity');
      const snapshot = { ...normalizeGithub(run, [], { truncated: true }), source: 'discovery' };
      snapshot.metadata = normalizeRun(snapshot.metadata);
      return snapshot;
    });
  };
  return read;
}

export function startGithubReconciler({
  store, onChange = () => {}, token, tokenProvider, isRepositoryConnected = () => true, intervalMs = 30000,
  listRepositories, discoveryIntervalMs = 60000, now = () => Date.now(),
  onWarning = message => console.warn(message),
  fetchImpl = fetch,
} = {}) {
  if (!token && !tokenProvider) return async () => {};
  const read = createGithubReader({ token, tokenProvider, isRepositoryConnected, fetchImpl });
  const controller = new AbortController();
  const failures = new Map();
  const discovery = new Map();
  let stopped = false;
  let timer;
  let cursor = 0;
  let repositoryCursor = 0;
  let pending;
  let globallyPausedUntil = 0;

  async function discover() {
    if (!listRepositories || stopped) return;
    const repositories = await listRepositories();
    if (!repositories.length || stopped) return;
    let identity;
    for (let offset = 0; offset < repositories.length; offset++) {
      const index = (repositoryCursor + offset) % repositories.length;
      const candidate = repositories[index];
      if ((discovery.get(candidate.repositoryId)?.retryAt || 0) <= now()) {
        identity = candidate;
        repositoryCursor = (index + 1) % repositories.length;
        break;
      }
    }
    if (!identity) return;
    const previous = discovery.get(identity.repositoryId);
    discovery.set(identity.repositoryId, { count: previous?.count || 0, retryAt: now() + discoveryIntervalMs });
    try {
      const snapshots = await read.discover(identity, { signal: controller.signal });
      if (stopped) return;
      // The endpoint returns only the latest attempt of the last 30 runs. This
      // bounded repair path fills discovery gaps; detailed reads own known runs.
      const known = new Set(store.listRuns().map(run => `${run.repositoryId}:${run.runId}:${run.runAttempt}`));
      for (const snapshot of snapshots) {
        const metadata = snapshot.metadata;
        const key = `${metadata.repositoryId}:${metadata.runId}:${metadata.runAttempt}`;
        if (known.has(key)) continue;
        const result = store.updateGithub(runKey(metadata), snapshot);
        known.add(key);
        if (result.changed) onChange(result);
      }
      discovery.set(identity.repositoryId, { count: 0, retryAt: now() + discoveryIntervalMs });
    } catch (error) {
      if (stopped) return;
      const count = (previous?.count || 0) + 1;
      const backoff = Math.max(discoveryIntervalMs, error.retryAfterMs || 0, Math.min(300000, intervalMs * 2 ** Math.min(count, 4)));
      discovery.set(identity.repositoryId, { count, retryAt: now() + backoff });
      if (count === 1) onWarning(`GitHub run discovery unavailable for ${identity.repository}; retrying.`);
    }
  }

  async function tick() {
    if (globallyPausedUntil > now()) return;
    try { await discover(); } catch { if (!stopped) onWarning('GitHub repository discovery unavailable; retrying.'); }
    if (stopped) return;
    const runs = store.listRuns().filter(run => {
      if (!/^\d+$/.test(String(run.runId))) return false;
      const previous = store.github(run.id);
      return !(previous?.run?.status === 'completed' && !previous.needsReconcile && !previous.jobsTruncated && previous.jobs.every(job => job.status === 'completed'));
    });
    if (!runs.length) return;
    // Round-robin, at most five runs per tick. Requests are sequential across
    // runs so a busy collector cannot burst through GitHub's API quota.
    for (let count = 0; count < Math.min(5, runs.length) && !stopped; count++) {
      const run = runs[(cursor + count) % runs.length];
      const failure = failures.get(run.id);
      if (failure?.retryAt > now()) continue;
      try {
        const snapshot = await read(run, { signal: controller.signal });
        if (!snapshot) continue;
        const result = store.updateGithub(run.id, snapshot);
        failures.delete(run.id);
        if (result.changed) onChange(result);
      } catch (error) {
        if (stopped) break;
        const count = (failure?.count || 0) + 1;
        const backoff = Math.max(error.retryAfterMs || 0, Math.min(300000, intervalMs * 2 ** Math.min(count, 4)));
        failures.set(run.id, { count, retryAt: now() + backoff });
        // One installation losing access must not stall unrelated teams. A
        // shared PAT retains the original global authentication backoff.
        if (!tokenProvider && [401, 403, 429].includes(error.status)) globallyPausedUntil = now() + backoff;
        // Do not include response bodies, headers, credentials, or untrusted
        // server messages in diagnostics. Existing snapshots stay available.
        if (count === 1) onWarning(`GitHub status refresh unavailable for ${run.repository} run ${run.runId}; retrying.`);
        if (globallyPausedUntil > now()) break;
      }
    }
    cursor = (cursor + Math.min(5, runs.length)) % runs.length;
  }

  function schedule() {
    if (stopped) return;
    pending = tick().catch(() => onWarning('GitHub status refresh unavailable; retrying.')).finally(() => {
      if (!stopped) {
        timer = setTimeout(schedule, Math.max(1000, intervalMs));
        timer.unref();
      }
    });
  }
  schedule();
  return async function stop() {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
    await pending;
  };
}
