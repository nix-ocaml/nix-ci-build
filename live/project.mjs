const TERMINAL = new Set(['success', 'failed', 'cancelled', 'blocked', 'incomplete']);
const seconds = value => typeof value === 'number' && Number.isFinite(value) ? value / 1000 : null;
const max = values => values.filter(value => value !== null && value !== undefined).reduce((a, b) => Math.max(a, b), 0) || null;
const min = values => {
  const present = values.filter(value => value !== null && value !== undefined);
  return present.length ? Math.min(...present) : null;
};
const duration = (start, finish) => start !== null && finish !== null && finish >= start ? finish - start : null;

export function status(value) {
  switch (value) {
    case 'success': case 'succeeded': case 'built': case 'cached': case 'downloaded': case 'uploaded': case 'imported': return 'success';
    case 'failed': case 'failure': case 'timed_out': case 'action_required': return 'failed';
    case 'cancelled': case 'canceled': return 'cancelled';
    case 'interrupted': case 'incomplete': return 'incomplete';
    case 'blocked': return 'blocked';
    case 'planned': return 'planned';
    case 'queued': case 'pending': case 'waiting': case 'requested': return 'queued';
    case 'running': case 'active': case 'in_progress': case 'building': case 'downloading': case 'uploading': return 'running';
    default: return 'unknown';
  }
}

function githubStatus(value) {
  if (!value) return null;
  if (value.status === 'completed') {
    if (value.conclusion === 'skipped') return 'skipped';
    if (value.conclusion === 'neutral') return 'neutral';
    return status(value.conclusion);
  }
  return status(value.status);
}

function evidenceStatus(jobs) {
  const values = jobs.map(job => job.status);
  if (!values.length) return 'unknown';
  if (values.includes('failed')) return 'failed';
  if (values.includes('cancelled')) return 'cancelled';
  if (values.includes('running')) return 'running';
  if (values.includes('stale')) return 'stale';
  if (values.includes('incomplete') || values.includes('unknown')) return 'incomplete';
  if (values.includes('queued')) return 'queued';
  if (values.includes('planned')) return 'planned';
  if (values.includes('blocked')) return 'blocked';
  return values.every(value => value === 'success') ? 'success' : 'unknown';
}

function activityType(event) {
  const type = event.activityType || event.labels?.kind || '';
  if (/download|substitut|fetch/.test(type)) return 'download';
  if (/upload|publish/.test(type)) return 'upload';
  if (/cache.*import|cache_reuse/.test(type)) return 'import';
  if (/wait/.test(type)) return 'wait';
  if (/request/.test(type)) return 'request';
  if (/build|derivation/.test(type) || event.drvPath) return 'build';
  return type || 'activity';
}

function scope(event) {
  return [event.streamId, event.labels?.sourceStream, event.labels?.groupId, event.labels?.attemptId].filter(Boolean).join(':');
}

function newJob(invocation) {
  const metadata = invocation.job;
  return {
    id: metadata.groupId || metadata.jobId,
    key: invocation.invocationId,
    invocationId: invocation.invocationId,
    attemptId: String(metadata.jobAttempt || 1),
    name: metadata.name || metadata.logicalJob || metadata.groupId || metadata.jobId,
    logicalJob: metadata.logicalJob || metadata.jobId,
    groupId: metadata.groupId || null,
    kind: metadata.kind || 'job',
    system: metadata.system || null,
    matrix: metadata.matrix || {},
    needs: metadata.dependencies || [],
    planId: metadata.planId || null,
    status: 'unknown', reportedStatus: 'unknown', statusReason: 'No invocation start or terminal event received',
    stale: false, terminal: false,
    plannedAt: null, queuedAt: null,
    startedAt: seconds(metadata.startedAtMs), finishedAt: null,
    lastEventAt: null, heartbeatAt: null, durationSeconds: null,
    registeredAt: seconds(invocation.registeredAtMs),
    phases: [], metrics: { built: null, cached: null, actualBuilds: null, actualDownloads: null, downloads: null, imports: null, uploads: null },
    progress: null,
    url: metadata.githubJobUrl || null,
    checkRunId: metadata.checkRunId || null,
    github: null, githubStatus: null,
  };
}

/** Rebuild projections from committed facts. Clock-based liveness is never a terminal outcome. */
export function projectRun(store, runId, { now = Date.now(), staleAfterMs = 90_000 } = {}) {
  const metadata = store.run(runId);
  if (!metadata) return null;
  runId = metadata.id;
  const invocations = store.invocations(runId);
  const events = store.events(runId);
  const github = store.github(runId);
  const diagnostics = [];
  const jobs = new Map(invocations.map(invocation => [invocation.invocationId, newJob(invocation)]));
  const activityRows = [];
  const active = new Map();
  const latest = new Map();
  const plans = new Map();
  const derivations = new Map();
  const states = new Map();
  const snapshots = new Map();
  const lastReceived = new Map();
  const recovered = new Set();

  function sameActivity(row, event, kind) {
    const job = jobs.get(event.invocationId);
    return row.jobKey === job.key && row.drvPath === event.drvPath && row.streamId === event.streamId
      && row.groupId === (event.labels?.groupId || job.groupId)
      && row.sourceAttemptId === (event.labels?.attemptId || null)
      && (!kind || row.kind === kind);
  }

  function entityKey(event, kind) {
    return `${event.invocationId}:${scope(event)}:${kind}:${event.entityId || event.drvPath || event.outputPath || event.phase || event.name || kind}`;
  }

  function activity(event, kind, start) {
    const job = jobs.get(event.invocationId);
    const base = entityKey(event, kind);
    let row = active.get(base);
    if (start && event.drvPath) {
      // Polling results and tailing events are independent. The snapshot can
      // arrive first; an exact source start time identifies that same activity.
      const startedAt = seconds(event.startedAtMs ?? event.occurredAtMs);
      const recovery = activityRows.find(candidate => recovered.has(candidate) && sameActivity(candidate, event, kind) && candidate.startedAt === startedAt);
      if (recovery) { row = recovery; recovered.delete(row); }
      else row = null;
    } else if (start) row = null;
    if (!row) {
      row = {
        id: `${base}:${event.sequence}`,
        jobId: job.id, jobKey: job.key, attemptId: job.attemptId,
        groupId: event.labels?.groupId || job.groupId,
        sourceAttemptId: event.labels?.attemptId || null,
        kind,
        name: event.name || event.phase || derivations.get(event.drvPath)?.name || event.drvPath?.split('/').at(-1) || kind,
        phase: event.phase || null, status: 'unknown', reportedStatus: event.status || null,
        startedAt: seconds(event.startedAtMs) ?? (start ? seconds(event.occurredAtMs) : null),
        finishedAt: null, durationSeconds: null,
        drvPath: event.drvPath || null, outputPath: event.outputPath || null,
        progress: null, parentId: event.parentId || null, open: true,
        streamId: event.streamId,
      };
      activityRows.push(row);
      latest.set(base, row);
      if (kind === 'phase') job.phases.push(row);
    }
    if (start) active.set(base, row);
    return { row, base };
  }

  function stop(event, kind, authoritative = false) {
    const base = entityKey(event, kind);
    const found = active.get(base) || latest.get(base);
    const row = found || activity(event, kind, false).row;
    row.startedAt = seconds(event.startedAtMs) ?? row.startedAt;
    row.finishedAt = seconds(event.finishedAtMs) ?? seconds(event.occurredAtMs);
    row.durationSeconds = event.durationSeconds ?? duration(row.startedAt, row.finishedAt);
    const next = status(event.status || event.result);
    // Nix activity_stop only means inactivity. A later snapshot supplies the result.
    if (authoritative || next !== 'unknown' || row.status === 'running') {
      row.reportedStatus = event.status || event.result || row.reportedStatus;
      row.status = next;
    }
    row.open = false;
    active.delete(base);
    latest.set(base, row);
    return row;
  }

  for (const event of events) {
    const job = jobs.get(event.invocationId);
    if (!job) continue;
    job.lastEventAt = max([job.lastEventAt, seconds(event.occurredAtMs)]);
    lastReceived.set(job.key, Math.max(lastReceived.get(job.key) || 0, event.receivedAtMs));
    for (const drv of event.derivations || []) derivations.set(drv.drvPath, drv);
    for (const planned of event.matrixJobs || []) {
      const previous = plans.get(planned.id);
      plans.set(planned.id, { ...previous, ...planned, plannedAt: previous?.plannedAt ?? seconds(event.occurredAtMs), lastReceivedAt: seconds(event.receivedAtMs) });
    }
    switch (event.kind) {
      case 'invocation_start':
        if (!job.terminal) {
          job.reportedStatus = 'running'; job.statusReason = null;
          job.startedAt = seconds(event.occurredAtMs);
        }
        break;
      case 'heartbeat':
        job.heartbeatAt = max([job.heartbeatAt, seconds(Math.min(event.occurredAtMs, event.receivedAtMs))]);
        break;
      case 'invocation_finish':
        if (event.terminal === true) {
          const next = status(event.status || event.result);
          if (!TERMINAL.has(next)) {
            diagnostics.push('An invocation terminal event did not include a recognized outcome');
            break;
          }
          if (job.terminal && job.reportedStatus !== (event.status || event.result)) {
            job.reportedStatus = 'incomplete';
            job.statusReason = 'Conflicting invocation terminal events';
            diagnostics.push('Conflicting invocation terminal events');
          } else {
            job.reportedStatus = event.status || event.result;
            job.statusReason = next === 'incomplete' ? 'Reporter ended without a confirmed command outcome' : null;
          }
          job.terminal = true;
          job.finishedAt = seconds(event.occurredAtMs);
          job.durationSeconds = event.durationSeconds ?? duration(job.startedAt, job.finishedAt);
        }
        break;
      case 'phase_start': {
        const { row } = activity(event, 'phase', true); row.status = 'running';
        break;
      }
      case 'phase_finish': stop(event, 'phase', true); break;
      case 'attempt_start': {
        const { row } = activity(event, 'attempt', true); row.status = 'running';
        break;
      }
      case 'attempt_finish': stop(event, 'attempt', true); break;
      case 'activity_start': {
        const { row } = activity(event, activityType(event), true);
        if (!TERMINAL.has(row.status) && row.finishedAt === null) row.status = 'running';
        break;
      }
      case 'activity_stop': stop(event, activityType(event)); break;
      case 'upload_start': {
        const { row } = activity(event, 'upload', true); row.status = 'running';
        break;
      }
      case 'upload_finish': stop(event, 'upload', true); break;
      case 'phase': {
        for (const row of activityRows) if (row.jobKey === job.key && row.drvPath === event.drvPath && row.open) row.phase = event.phase || event.name || null;
        break;
      }
      case 'job':
      case 'activity_snapshot': {
        const drv = event.drvPath || event.entityId;
        if (drv) {
          if (event.kind === 'job') states.set(`${job.key}:${scope(event)}:${drv}`, { jobKey: job.key, state: event.status, drvPath: drv });
          const matching = activityRows.filter(row => sameActivity(row, { ...event, drvPath: drv }) && ['build', 'download'].includes(row.kind)
            && (event.kind !== 'activity_snapshot' || event.startedAtMs === undefined || row.startedAt === null || row.startedAt === seconds(event.startedAtMs)));
          if (matching.length) {
            const row = matching.at(-1);
            const next = status(event.status);
            if (!TERMINAL.has(row.status) || TERMINAL.has(next)) {
              row.reportedStatus = event.status || row.reportedStatus;
              row.status = next;
            }
            if (event.kind === 'activity_snapshot') {
              row.startedAt = seconds(event.startedAtMs) ?? row.startedAt;
              row.finishedAt = seconds(event.finishedAtMs) ?? row.finishedAt;
              if (event.durationSeconds !== undefined) row.durationSeconds = event.durationSeconds;
              else row.durationSeconds ??= duration(row.startedAt, row.finishedAt);
            }
            if (TERMINAL.has(row.status) || row.finishedAt !== null || event.status === 'finished') {
              row.open = false;
            }
          } else if (event.kind === 'activity_snapshot') {
            const row = activity(event, activityType(event), false).row;
            recovered.add(row);
            row.status = status(event.status);
            row.finishedAt = seconds(event.finishedAtMs);
            row.open = !TERMINAL.has(row.status) && row.finishedAt === null && event.status !== 'finished';
            row.durationSeconds = event.durationSeconds ?? null;
          }
        }
        break;
      }
      case 'snapshot': {
        // Each source file publishes cumulative totals. Keep its latest totals
        // independently so a nested worker cannot erase another worker's work.
        const key = `${job.key}:${scope(event)}`;
        const snapshot = snapshots.get(key) || { jobKey: job.key, metrics: {} };
        for (const [key, value] of Object.entries(event.labels || {})) if (/^(built|downloads|cached|actualBuilds|actualDownloads|imports|uploads)$/.test(key) && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) snapshot.metrics[key] = Number(value);
        snapshots.set(key, snapshot);
        if (event.current !== undefined || event.total !== undefined) job.progress = { done: event.current ?? null, expected: event.total ?? null };
        break;
      }
      case 'cache_reuse': {
        const kind = 'import';
        if (status(event.status) === 'running') activity(event, kind, true).row.status = 'running';
        else stop(event, kind, true);
        break;
      }
      case 'warning': case 'failure':
        if (event.message && diagnostics.length < 100) diagnostics.push(event.message);
        break;
      case 'queued': case 'dispatched': case 'completed': case 'blocked': {
        const id = event.labels?.groupId || event.entityId;
        const planned = plans.get(id);
        if (planned) {
          planned.schedulerStatus = event.kind === 'dispatched' ? 'running' : event.kind === 'queued' ? 'queued' : event.status || event.kind;
          if (event.kind === 'queued') planned.queuedAt = seconds(event.occurredAtMs);
        }
        break;
      }
    }
  }

  for (const job of jobs.values()) {
    const planned = plans.get(job.id);
    if (planned) {
      job.plannedAt = planned.plannedAt;
      job.queuedAt = planned.queuedAt || null;
      if (!job.needs.length) job.needs = planned.dependencies || [];
      if (!job.system) job.system = planned.system || null;
      if (!job.planId) job.planId = planned.planId || null;
      job.stage = planned.stage ?? null;
      job.runner = planned.runner || null;
      job.consumers = planned.consumers || [];
    }
    const liveness = job.heartbeatAt ?? seconds(lastReceived.get(job.key)) ?? job.registeredAt;
    job.stale = !job.terminal && liveness !== null && now / 1000 - liveness > staleAfterMs / 1000;
    job.status = job.stale ? 'stale' : status(job.reportedStatus);
    if (job.stale) job.statusReason = 'Heartbeat is stale; no terminal outcome has been received';
    const finalStates = [...states.values()].filter(state => state.jobKey === job.key);
    const activity = activityRows.filter(row => row.jobKey === job.key);
    if (finalStates.length) {
      job.metrics.built = new Set(finalStates.filter(state => state.state === 'built').map(state => state.drvPath)).size;
      job.metrics.cached = new Set(finalStates.filter(state => state.state === 'cached').map(state => state.drvPath)).size;
    }
    const builds = activity.filter(row => row.kind === 'build' && TERMINAL.has(row.status));
    if (builds.length) job.metrics.actualBuilds = builds.filter(row => row.status === 'success' && row.reportedStatus === 'built').length;
    for (const [metric, kind] of [['downloads', 'download'], ['uploads', 'upload'], ['imports', 'import']]) {
      const rows = activity.filter(row => row.kind === kind);
      if (rows.length) job.metrics[metric] = rows.filter(row => row.status === 'success').length;
    }
    job.metrics.actualDownloads = job.metrics.downloads;
    const reported = [...snapshots.values()].filter(snapshot => snapshot.jobKey === job.key);
    for (const metric of Object.keys(job.metrics)) {
      const values = reported.map(snapshot => snapshot.metrics[metric]).filter(value => value !== undefined);
      if (values.length) job.metrics[metric] = values.reduce((a, b) => a + b, 0);
    }
    if (github) {
      job.github = (github.jobs || []).find(candidate => (job.checkRunId && candidate.checkRunId === job.checkRunId) || (job.url && candidate.url === job.url)) || null;
      job.githubStatus = githubStatus(job.github);
    }
    for (const row of activity) {
      if (row.open && job.terminal) row.status = 'incomplete';
      else if (row.open && job.stale) row.status = 'stale';
    }
  }

  const rows = [...jobs.values()];
  for (const [id, planned] of plans) {
    if (rows.some(job => job.id === id)) continue;
    const workflowFinished = github?.run?.status === 'completed';
    rows.push({
      id, key: `planned:${id}`, invocationId: null, attemptId: null,
      name: planned.name || id, logicalJob: id, groupId: id,
      kind: planned.kind || 'job', system: planned.system || null,
      matrix: planned.matrix || {}, needs: planned.dependencies || [], planId: planned.planId || null,
      stage: planned.stage ?? null, runner: planned.runner || null, consumers: planned.consumers || [],
      status: workflowFinished ? 'incomplete' : status(planned.schedulerStatus || 'planned'),
      reportedStatus: planned.schedulerStatus || 'planned', stale: false, terminal: false,
      statusReason: workflowFinished ? 'Workflow ended without a matching invocation report' : 'Announced by the plan; no invocation has reported yet',
      plannedAt: planned.plannedAt, queuedAt: planned.queuedAt || null,
      startedAt: null, finishedAt: null, lastEventAt: null, heartbeatAt: null, durationSeconds: null,
      phases: [], metrics: { built: null, cached: null, actualBuilds: null, actualDownloads: null, downloads: null, imports: null, uploads: null }, progress: null,
      url: null, checkRunId: null, github: null, githubStatus: null,
    });
  }

  const counts = { total: rows.length, planned: 0, queued: 0, running: 0, success: 0, failed: 0, cancelled: 0, blocked: 0, unknown: 0, incomplete: 0, stale: 0 };
  for (const job of rows) counts[job.status] = (counts[job.status] || 0) + 1;
  const runStatus = evidenceStatus(rows);
  const workflowStatus = githubStatus(github?.run);
  const workflowStartedAt = seconds(github?.run?.startedAt);
  const workflowFinishedAt = github?.run?.status === 'completed' ? seconds(github.run.updatedAt) : null;
  const startedAt = invocations.length ? min(rows.map(job => job.startedAt)) : workflowStartedAt;
  const finishedAt = invocations.length ? (rows.length && rows.every(job => job.terminal) ? max(rows.map(job => job.finishedAt)) : null) : workflowFinishedAt;
  const run = {
    id: runId, provider: 'github',
    repository: metadata.repository, repositoryId: metadata.repositoryId || null,
    workflow: metadata.workflow || null, branch: metadata.branch || null,
    commitSha: metadata.headSha || metadata.sha || null, checkoutSha: metadata.sha || null,
    pullRequest: metadata.pullRequestNumber || null, title: metadata.title || null,
    commitMessage: metadata.commitMessage || null, actor: metadata.actor || null,
    url: metadata.runUrl || null, githubRunId: metadata.runId, runAttempt: metadata.runAttempt,
    status: invocations.length ? runStatus : workflowStatus || 'queued', reportedStatus: runStatus, stale: rows.some(job => job.stale),
    invocationCount: invocations.length,
    telemetryStatus: !invocations.length ? (github?.run?.status === 'completed' ? 'not_reported' : 'waiting')
      : rows.every(job => job.terminal) ? 'complete' : rows.some(job => job.stale) ? 'incomplete' : 'receiving',
    workflowStatus, github: github ? { ...github.run, observedAtMs: github.observedAtMs } : null,
    discoveredAt: seconds(metadata.registeredAtMs),
    workflowStartedAt, workflowFinishedAt, workflowDurationSeconds: duration(workflowStartedAt, workflowFinishedAt),
    startedAt, finishedAt,
    updatedAt: max([seconds(metadata.updatedAtMs), ...invocations.map(value => seconds(value.registeredAtMs)), seconds(github?.observedAtMs), ...events.map(event => seconds(event.receivedAtMs))]),
    heartbeatAt: max(rows.map(job => job.heartbeatAt)),
    durationSeconds: duration(startedAt, finishedAt),
    counts, planId: rows.find(job => job.planId)?.planId || null,
  };
  return { schemaVersion: 1, revision: store.revision, now: now / 1000, run, jobs: rows, activities: activityRows, derivations: [...derivations.values()], githubJobs: github?.jobs || [], diagnostics: [...new Set(diagnostics)] };
}

export function projectRuns(store, options = {}) {
  const now = options.now ?? Date.now();
  const runs = store.runIds().map(id => projectRun(store, id, { ...options, now }).run);
  return { schemaVersion: 1, revision: store.revision, now: now / 1000, runs };
}
