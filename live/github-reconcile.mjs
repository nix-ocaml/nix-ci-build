const API = 'https://api.github.com';
const timestamp = value => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const text = value => typeof value === 'string' ? value : '';

export function normalizeGithub(run, jobs, { now = Date.now(), truncated = false } = {}) {
  return {
    fetchedAt: now,
    jobsTruncated: truncated,
    run: {
      id: String(run.id),
      attempt: Number(run.run_attempt),
      status: text(run.status),
      conclusion: text(run.conclusion),
      url: text(run.html_url),
      startedAt: timestamp(run.run_started_at),
      updatedAt: timestamp(run.updated_at),
      headSha: text(run.head_sha),
      headBranch: text(run.head_branch),
      event: text(run.event),
    },
    jobs: jobs.map(job => ({
      id: String(job.id),
      checkRunId: /\/check-runs\/(\d+)$/.exec(text(job.check_run_url))?.[1] || '',
      name: text(job.name),
      status: text(job.status),
      conclusion: text(job.conclusion),
      url: text(job.html_url),
      runnerName: text(job.runner_name),
      runnerGroupName: text(job.runner_group_name),
      labels: (job.labels || []).filter(label => typeof label === 'string'),
      startedAt: timestamp(job.started_at),
      completedAt: timestamp(job.completed_at),
      steps: (job.steps || []).map(step => ({
        number: Number(step.number),
        name: text(step.name),
        status: text(step.status),
        conclusion: text(step.conclusion),
        startedAt: timestamp(step.started_at),
        completedAt: timestamp(step.completed_at),
      })),
    })),
  };
}

// The token stays in the collector. This read-only client never receives a
// runner's GITHUB_TOKEN and never follows an endpoint from uploaded metadata.
export function createGithubReader({ token, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!token) throw new Error('GitHub reconciliation requires a read-only Actions token');
  const cache = new Map();

  async function get(path, signal) {
    const cached = cache.get(path);
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
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
    cache.set(path, { etag: response.headers.get('etag'), body });
    // Bound cache use even on a long-lived collector with many historical runs.
    if (cache.size > 2048) cache.delete(cache.keys().next().value);
    return body;
  }

  return async function read(identity, { signal } = {}) {
    const { repository, runId, runAttempt } = identity;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^\d+$/.test(String(runId)) || !Number.isInteger(runAttempt) || runAttempt < 1) {
      throw new Error('Invalid GitHub run identity');
    }
    const path = `/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}`;
    const [run, page] = await Promise.all([
      get(path, signal),
      get(`${path}/jobs?per_page=100&page=1`, signal),
    ]);
    if (String(run.id) !== String(runId) || Number(run.run_attempt) !== runAttempt) {
      throw new Error('GitHub returned a different workflow attempt');
    }
    const jobs = [...(page.jobs || [])];
    const total = Math.max(jobs.length, Number(page.total_count) || 0);
    for (let pageNumber = 2; jobs.length < total && pageNumber <= 10; pageNumber++) {
      const next = await get(`${path}/jobs?per_page=100&page=${pageNumber}`, signal);
      if (!next.jobs?.length) break;
      jobs.push(...next.jobs);
    }
    // An attempt endpoint must not silently mix jobs from a subsequent retry.
    if (jobs.some(job => job.run_attempt != null && Number(job.run_attempt) !== runAttempt)) {
      throw new Error('GitHub returned jobs from a different workflow attempt');
    }
    return normalizeGithub(run, jobs, { truncated: jobs.length < total });
  };
}

export function startGithubReconciler({
  store, onChange = () => {}, token, intervalMs = 30000,
  onWarning = message => console.warn(message),
  fetchImpl = fetch,
} = {}) {
  if (!token) return async () => {};
  const read = createGithubReader({ token, fetchImpl });
  const controller = new AbortController();
  const failures = new Map();
  let stopped = false;
  let timer;
  let cursor = 0;
  let pending;
  let globallyPausedUntil = 0;

  async function tick() {
    const runs = store.listRuns().filter(run => {
      if (!/^\d+$/.test(String(run.runId))) return false;
      const previous = store.github(run.id);
      return !(previous?.run?.status === 'completed' && !previous.jobsTruncated && previous.jobs.every(job => job.status === 'completed'));
    });
    if (!runs.length || globallyPausedUntil > Date.now()) return;
    // Round-robin, at most five runs per tick. Requests are sequential across
    // runs so a busy collector cannot burst through GitHub's API quota.
    for (let count = 0; count < Math.min(5, runs.length) && !stopped; count++) {
      const run = runs[(cursor + count) % runs.length];
      const failure = failures.get(run.id);
      if (failure?.retryAt > Date.now()) continue;
      try {
        const snapshot = await read(run, { signal: controller.signal });
        const result = store.updateGithub(run.id, snapshot);
        failures.delete(run.id);
        if (result.changed) onChange(result);
      } catch (error) {
        if (stopped) break;
        const count = (failure?.count || 0) + 1;
        const backoff = Math.max(error.retryAfterMs || 0, Math.min(300000, intervalMs * 2 ** Math.min(count, 4)));
        failures.set(run.id, { count, retryAt: Date.now() + backoff });
        if ([401, 403, 429].includes(error.status)) globallyPausedUntil = Date.now() + backoff;
        // Do not include response bodies, headers, credentials, or untrusted
        // server messages in diagnostics. Existing snapshots stay available.
        if (count === 1) onWarning(`GitHub status refresh unavailable for ${run.repository} run ${run.runId}; retrying.`);
        if (globallyPausedUntil > Date.now()) break;
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
