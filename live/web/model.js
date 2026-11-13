import Query from "./query.cjs";
export { Query };

export const TERMINAL = new Set([
  "success",
  "failed",
  "cancelled",
  "blocked",
  "skipped",
]);
export const STATUS_ORDER = [
  "running",
  "failed",
  "stale",
  "incomplete",
  "blocked",
  "queued",
  "planned",
  "unknown",
  "cancelled",
  "success",
];
export const KINDS = {
  build: "Build",
  download: "Download",
  evaluation: "Evaluation",
  planning: "Planning",
  upload: "Publication",
  import: "Import",
  request: "Request",
  wait: "Wait",
};
const PHASE_LABELS = {
  import_plan: "Import plan",
  refresh_cache: "Refresh cache",
  import_prerequisites: "Import prerequisites",
  build: "Build requests",
  publish: "Publish outputs",
  attempt: "Worker execution",
  bootstrap: "Prepare worker",
};
const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
export const timestamp = finite;
export const number = (value) =>
  finite(value) === null ? "—" : value.toLocaleString("en-US");
export const shortName = (value) =>
  String(value || "")
    .split("/")
    .pop()
    .replace(/^[a-z0-9]{32}-/, "")
    .replace(/\.drv$/, "");
export function duration(value) {
  if (finite(value) === null || value < 0) return "—";
  if (value < 1) return `${Math.round(value * 1000)}ms`;
  if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)}s`;
  if (value < 3600)
    return `${Math.floor(value / 60)}m ${Math.floor(value % 60)}s`;
  return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
}
export function ago(value, now = Date.now() / 1000) {
  if (timestamp(value) === null) return "No observation yet";
  const seconds = Math.max(0, now - value);
  return seconds < 3 ? "just now" : `${duration(seconds)} ago`;
}
export function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
export function normalizedStatus(value) {
  const aliases = {
    completed: "success",
    built: "success",
    cached: "success",
    finished: "success",
    building: "running",
    downloading: "running",
    evaluating: "running",
    uploading: "running",
    importing: "running",
    submitted: "running",
    active: "running",
    in_progress: "running",
    error: "failed",
    failure: "failed",
    timed_out: "failed",
    startup_failure: "failed",
    action_required: "failed",
    canceled: "cancelled",
    pending: "queued",
    waiting: "queued",
  };
  const key = String(value || "unknown").toLowerCase();
  return aliases[key] || key;
}
export function statusOf(value) {
  if (value?.stale && !TERMINAL.has(normalizedStatus(value.status)))
    return "stale";
  return normalizedStatus(value?.effectiveStatus || value?.status);
}
export function normalizePayload(payload = {}) {
  const run = payload.run
    ? {
        ...payload.run,
        id: String(payload.run.id),
        status: statusOf(payload.run),
      }
    : null;
  return {
    ...payload,
    run,
    jobs: (payload.jobs || []).map((job) => ({
      ...job,
      id: String(job.id),
      attemptId: String(job.attemptId ?? "1"),
      key: job.key || `${job.id}:${job.attemptId ?? "1"}`,
      name: job.name || job.id,
      status: statusOf(job),
      needs: Array.isArray(job.needs) ? job.needs : [],
      matrix: job.matrix || {},
      metrics: job.metrics || {},
      phases: job.phases || [],
    })),
    activities: Array.isArray(payload.activities) ? payload.activities : [],
    diagnostics: payload.diagnostics || [],
  };
}
export function latestJobs(jobs) {
  const byId = new Map();
  for (const job of jobs) {
    const previous = byId.get(job.id);
    const observed =
      timestamp(job.startedAt) ??
      timestamp(job.queuedAt) ??
      timestamp(job.plannedAt) ??
      0;
    const previousObserved =
      timestamp(previous?.startedAt) ??
      timestamp(previous?.queuedAt) ??
      timestamp(previous?.plannedAt) ??
      0;
    const real = !String(job.key).startsWith("planned:");
    const previousReal = !String(previous?.key).startsWith("planned:");
    if (
      !previous ||
      (real && !previousReal) ||
      (real === previousReal && observed >= previousObserved)
    )
      byId.set(job.id, job);
  }
  return [...byId.values()];
}
export function stageGroups(jobs) {
  const current = latestJobs(jobs),
    byId = new Map(current.map((job) => [job.id, job]));
  const planners = current.filter((job) =>
    ["planner", "planning", "plan"].includes(job.kind),
  );
  const plannerIds = new Set(planners.map((job) => job.id));
  const levels = new Map(),
    visiting = new Set(),
    unresolved = new Set();
  function level(id) {
    if (levels.has(id)) return levels.get(id);
    if (visiting.has(id)) {
      unresolved.add(id);
      return 0;
    }
    const job = byId.get(id);
    if (!job) return 0;
    visiting.add(id);
    const knownParents = job.needs.filter((need) => byId.has(need));
    const parents = knownParents.filter((need) => !plannerIds.has(need));
    if (knownParents.length !== job.needs.length) unresolved.add(id);
    const depth = parents.length ? Math.max(...parents.map(level)) + 1 : 0;
    visiting.delete(id);
    levels.set(id, Math.min(depth, current.length));
    return levels.get(id);
  }
  current.forEach((job) => level(job.id));
  const groups = new Map();
  for (const job of current) {
    if (plannerIds.has(job.id)) continue;
    const depth = levels.get(job.id);
    if (!groups.has(depth)) groups.set(depth, []);
    groups
      .get(depth)
      .push({ ...job, unresolvedDependencies: unresolved.has(job.id) });
  }
  const stages = [...groups]
    .sort((a, b) => a[0] - b[0])
    .map(([depth, items]) => {
      const kinds = new Set(items.map((item) => item.kind));
      const kind = kinds.size === 1 ? [...kinds][0] : "mixed";
      const label =
        {
          shared: "Prerequisites",
          package: "Package builds",
          aggregate: "Report",
          reporting: "Report",
          bootstrap: "Preparation",
        }[kind] || `Stage ${depth + 1}`;
      return {
        depth,
        label,
        jobs: items.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        ),
      };
    });
  return planners.length
    ? [
        { depth: -1, label: "Planning", isPlanning: true, jobs: planners },
        ...stages,
      ]
    : stages;
}
export function observedEnd(item, now) {
  const end = timestamp(item.finishedAt);
  if (end !== null) return end;
  const observed =
    timestamp(item.heartbeatAt) ??
    timestamp(item.lastEventAt) ??
    timestamp(item.updatedAt) ??
    timestamp(item.startedAt);
  // Unobserved termination and stale producers must never look like confirmed live work.
  if (
    item.stale ||
    ["stale", "unknown", "incomplete"].includes(statusOf(item)) ||
    TERMINAL.has(statusOf(item))
  )
    return observed;
  return observed === null ? null : Math.max(observed, now);
}
export function elapsed(item, now) {
  const start = timestamp(item.startedAt),
    end = observedEnd(item, now);
  return start === null || end === null ? null : Math.max(0, end - start);
}
export function concurrency(rows, kind) {
  const deltas = new Map();
  for (const row of rows)
    if (row.kind === kind)
      for (const interval of row.intervals) {
        deltas.set(interval.start, (deltas.get(interval.start) || 0) + 1);
        deltas.set(interval.end, (deltas.get(interval.end) || 0) - 1);
      }
  let value = 0,
    peak = 0;
  const steps = [...deltas]
    .sort((a, b) => a[0] - b[0])
    .map(([time, delta]) => {
      value += delta;
      peak = Math.max(peak, value);
      return { time, value };
    });
  return { peak, steps };
}
export function activityModel(activities, job, run, now) {
  const matched = activities.filter(
    (activity) =>
      !job ||
      activity.jobKey === job.key ||
      (activity.jobId === job.id &&
        String(activity.attemptId ?? "1") === job.attemptId),
  );
  const all = [...matched];
  if (job)
    for (const phase of job.phases)
      if (!all.some((activity) => activity.id === phase.id))
        all.push({ ...phase, jobId: job.id, attemptId: job.attemptId });
  const rows = [];
  const untimed = [];
  for (const activity of all) {
    const start = timestamp(activity.startedAt);
    const phase = activity.phase || activity.name;
    const phaseKind = {
      import_plan: "import",
      refresh_cache: "planning",
      import_prerequisites: "import",
      publish: "upload",
      bootstrap: "planning",
      build: "request",
      attempt: "request",
    };
    const kind =
      activity.kind === "phase"
        ? phaseKind[phase] || "request"
        : KINDS[activity.kind]
          ? activity.kind
          : phaseKind[activity.kind] || "request";
    const state = activity.status || "unknown";
    const parent = job || run || {};
    const active =
      !TERMINAL.has(normalizedStatus(state)) &&
      [
        "running",
        "building",
        "downloading",
        "uploading",
        "importing",
        "evaluating",
        "planning",
        "waiting",
        "active",
      ].includes(state);
    let end = timestamp(activity.finishedAt);
    if (end === null && start !== null) {
      const measured = finite(activity.durationSeconds);
      end = active
        ? observedEnd(
            { ...parent, status: parent.status, startedAt: start },
            now,
          )
        : measured === null
          ? null
          : start + measured;
    }
    const id = `${activity.jobKey || `${activity.jobId}:${activity.attemptId || "1"}`}:${activity.id}`;
    const name = ["phase", "attempt"].includes(activity.kind)
      ? PHASE_LABELS[phase] || activity.name || activity.phase || kind
      : activity.name || shortName(activity.drvPath) || activity.phase || kind;
    const row = {
      ...activity,
      id,
      nodeId: activity.drvPath || activity.id,
      name,
      kind,
      state,
      search: [activity.name, activity.drvPath, activity.phase, activity.jobId]
        .filter(Boolean)
        .join(" "),
      neededBy: activity.neededBy || [],
      start,
      end,
      seconds: start !== null && end !== null ? Math.max(0, end - start) : null,
      estimated: false,
      intervals: [],
    };
    if (start === null || end === null) {
      untimed.push(row);
      continue;
    }
    end = Math.max(start, end);
    row.end = end;
    const live =
      active &&
      !parent.stale &&
      !TERMINAL.has(statusOf(parent)) &&
      !["unknown", "incomplete", "stale"].includes(statusOf(parent));
    row.estimated = active && !live;
    row.intervals = [
      { start, end, open: live, estimated: row.estimated, phases: [] },
    ];
    rows.push(row);
  }
  const starts = rows.map((row) => row.start),
    ends = rows.map((row) => row.end);
  const fallbackStart =
    timestamp(job?.startedAt) ?? timestamp(run?.startedAt) ?? now;
  const start = Math.min(fallbackStart, ...starts),
    end = Math.max(
      start + 0.001,
      ...ends,
      observedEnd(job || run || {}, now) ?? start,
    );
  return {
    start,
    end,
    span: end - start,
    rows,
    untimed,
    rowMap: new Map(rows.map((row) => [row.id, row])),
    stats: {
      builds: concurrency(rows, "build"),
      downloads: concurrency(rows, "download"),
    },
  };
}
