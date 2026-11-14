(function (global) {
  "use strict";

  const Query =
    typeof module !== "undefined" && module.exports
      ? require("./query.js")
      : global.NixReportQuery;
  const TIMELINE_ROW_HEIGHT = 32,
    PACKAGE_ROW_HEIGHT = 44;

  const KINDS = {
    evaluation: {
      label: "Evaluation",
      short: "Evaluate",
      color: "--evaluation",
    },
    planning: { label: "Planning", short: "Plan", color: "--planning" },
    request: { label: "Request", short: "Requests", color: "--request" },
    build: { label: "Build", short: "Builds", color: "--build" },
    download: { label: "Download", short: "Downloads", color: "--download" },
    wait: { label: "Wait", short: "Waits", color: "--wait" },
    upload: { label: "Cache sync", short: "Syncs", color: "--upload" },
    import: { label: "Cache import", short: "Imports", color: "--import" },
  };
  const DEFAULT_KINDS = Object.keys(KINDS).filter(
    (kind) => kind !== "request" && kind !== "wait",
  );
  const array = (value) => (Array.isArray(value) ? value : []);
  const object = (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const string = (value) => (typeof value === "string" ? value : "");
  const number = (value) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const positive = (value) => Math.max(0, number(value) || 0);
  const strings = (value) => array(value).filter((x) => typeof x === "string");
  const unique = (values) => [...new Set(values)];
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const shortName = (value) =>
    string(value)
      .split("/")
      .pop()
      .replace(/^[0-9a-z]{32}-/, "")
      .replace(/\.drv$/, "");
  const kindFor = (value) =>
    ({
      building: "build",
      downloading: "download",
      waiting: "wait",
      build: "build",
      download: "download",
      wait: "wait",
    })[value] || "wait";
  const count = (value) => positive(value).toLocaleString("en-US");
  function duration(value) {
    const seconds = positive(value);
    if (seconds < 0.01) return "0s";
    if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
    if (seconds < 60)
      return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
    if (seconds < 3600)
      return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)
        .toString()
        .padStart(2, "0")}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  function bytes(value) {
    if (number(value) === null) return "unknown";
    if (value < 1024) return `${Math.round(value)} B`;
    const unit = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
    return `${(value / Math.pow(1024, unit)).toFixed(1)} ${["B", "KiB", "MiB", "GiB"][unit]}`;
  }
  function safeLog(value) {
    const path = string(value);
    // Keep reports portable, and never turn data into an arbitrary local-file URL.
    if (!path.startsWith("logs/") || /[\\\u0000-\u001f]/.test(path))
      return null;
    let decoded;
    try {
      decoded = decodeURIComponent(path);
    } catch (_) {
      return null;
    }
    if (
      /[\\\u0000-\u001f]/.test(decoded) ||
      decoded.split("/").some((p) => p === ".." || p === ".")
    )
      return null;
    return path.split("/").map(encodeURIComponent).join("/");
  }
  function safeUrl(value) {
    try {
      const url = new URL(string(value));
      return ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
        ? url.href
        : null;
    } catch (_) {
      return null;
    }
  }
  function mergeIntervals(intervals) {
    const sorted = intervals
      .filter(
        (s) =>
          number(s.start) !== null && number(s.end) !== null && s.end > s.start,
      )
      .slice()
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const result = [];
    for (const segment of sorted) {
      const last = result[result.length - 1];
      if (last && segment.start <= last.end)
        last.end = Math.max(last.end, segment.end);
      else result.push({ start: segment.start, end: segment.end });
    }
    return result;
  }
  function intervalSeconds(intervals) {
    return mergeIntervals(intervals).reduce(
      (sum, s) => sum + s.end - s.start,
      0,
    );
  }
  function concurrency(rows, kind, start, end) {
    const points = new Map();
    for (const row of rows) {
      if (row.kind !== kind) continue;
      for (const s of mergeIntervals(row.intervals)) {
        const a = clamp(s.start, start, end),
          b = clamp(s.end, start, end);
        if (b > a) {
          points.set(a, (points.get(a) || 0) + 1);
          points.set(b, (points.get(b) || 0) - 1);
        }
      }
    }
    const steps = [{ time: start, value: 0 }];
    let active = 0,
      peak = 0,
      busy = 0,
      area = 0,
      previous = start;
    for (const [time, delta] of [...points].sort((a, b) => a[0] - b[0])) {
      if (active > 0) busy += time - previous;
      area += active * (time - previous);
      active += delta;
      peak = Math.max(peak, active);
      steps.push({ time, value: active });
      previous = time;
    }
    steps.push({ time: end, value: 0 });
    return {
      steps,
      peak,
      busy,
      average: end > start ? area / (end - start) : 0,
    };
  }
  function diagnosticCause(value) {
    const lines = string(value)
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    const errors = lines.filter((x) => /(^|\s)error:/.test(x));
    return (
      errors[errors.length - 1] ||
      lines[lines.length - 1] ||
      "No diagnostic message recorded"
    ).slice(0, 800);
  }
  function stateMatches(state, filter) {
    if (filter === "all") return true;
    if (filter === "failed")
      return ["failed", "blocked", "error"].includes(state);
    if (filter === "active")
      return [
        "queued",
        "submitted",
        "building",
        "downloading",
        "waiting",
        "importing",
        "uploading",
      ].includes(state);
    return state === filter;
  }

  function buildModel(envelope) {
    const data = object(envelope),
      snapshot = object(data.snapshot || data),
      context = object(snapshot.context);
    // events.jsonl can contain earlier invocations when a report directory was
    // reused. Do not clamp those events into spurious activity at this run's start.
    const events = array(data.events)
      .filter(
        (e) =>
          e &&
          number(e.time) !== null &&
          (number(context.startedAt) === null || e.time >= context.startedAt) &&
          (number(context.finishedAt) === null ||
            e.time <= context.finishedAt + 0.001),
      )
      .slice()
      .sort((a, b) => a.time - b.time);
    const jobs = array(snapshot.jobs).filter((x) => x && typeof x === "object");
    const activities = array(snapshot.derivations).filter(
      (x) => x && typeof x === "object",
    );
    const plan = object(snapshot.plan),
      nodes = new Map(),
      rows = new Map(),
      producers = new Map();
    let minimum = Infinity,
      maximum = -Infinity;
    const observe = (time) => {
      if (number(time) !== null) {
        minimum = Math.min(minimum, time);
        maximum = Math.max(maximum, time);
      }
    };
    for (const event of events) observe(event.time);
    for (const entry of [
      ...jobs,
      ...activities,
      ...array(snapshot.uploads),
      ...array(snapshot.cacheReuse),
    ]) {
      observe(entry.queuedAt);
      observe(entry.startedAt);
      observe(entry.finishedAt);
    }
    observe(context.startedAt);
    observe(context.finishedAt);
    const start =
      number(context.startedAt) ?? (Number.isFinite(minimum) ? minimum : 0);
    const end = Math.max(
      start,
      number(context.finishedAt) ??
        Math.max(
          Number.isFinite(maximum) ? maximum : start,
          start + positive(context.elapsedSeconds),
        ),
    );
    const span = end - start,
      extent = Math.max(span, 0.001);
    const ensureNode = (id, source) => {
      if (!id) return null;
      if (!nodes.has(id))
        nodes.set(id, {
          id,
          name: shortName(id),
          attrs: [],
          neededBy: [],
          inputs: [],
          outputs: [],
          state: "unobserved",
          root: false,
        });
      const n = nodes.get(id),
        s = object(source);
      if (string(s.name)) n.name = s.name;
      if (string(s.system)) n.system = s.system;
      n.neededBy = unique(n.neededBy.concat(strings(s.neededBy)));
      return n;
    };
    for (const item of array(plan.builds)) {
      const node = ensureNode(item.drvPath, item);
      if (!node) continue;
      node.plan = item;
      node.inputs = array(item.inputs);
      node.outputs = Object.values(object(item.outputs)).filter(
        (x) => typeof x === "string",
      );
    }
    for (const item of activities) {
      const node = ensureNode(string(item.drvPath) || string(item.path), item);
      if (!node) continue;
      node.activity = item;
      node.state = string(item.state) || node.state;
      node.outputs = unique(node.outputs.concat(strings(item.outputPaths)));
      if (Array.isArray(item.inputs)) node.inputs = item.inputs;
    }
    for (const item of jobs) {
      const node = ensureNode(item.drvPath, item);
      if (!node) continue;
      node.job = item;
      node.root = true;
      node.attrs = strings(item.attrs);
      node.state = string(item.state) || node.state;
    }
    for (const node of nodes.values())
      for (const output of node.outputs) producers.set(output, node.id);
    const byAttr = new Map();
    for (const n of nodes.values())
      if (n.root) for (const attr of n.attrs) byAttr.set(attr, n.id);
    const add = (kind, key, node, a, b, extra) => {
      if (!KINDS[kind] || number(a) === null || number(b) === null) return;
      const from = clamp(a, start, end),
        to = clamp(b, start, end);
      if (to < from) return;
      const id = `${kind}:${key}`;
      if (!rows.has(id))
        rows.set(id, {
          id,
          kind,
          key,
          nodeId: node ? node.id : null,
          name: node ? node.name : KINDS[kind].label,
          intervals: [],
          neededBy: node ? node.neededBy : [],
          state: node ? node.state : "finished",
        });
      const row = rows.get(id);
      row.intervals.push(
        Object.assign(
          { start: from, end: to, estimated: false, open: false },
          extra,
        ),
      );
      if (extra && extra.name) row.name = extra.name;
      if (extra && extra.state) row.state = extra.state;
      if (extra && extra.logPath) row.logPath = extra.logPath;
      if (extra && extra.neededBy)
        row.neededBy = unique(row.neededBy.concat(extra.neededBy));
    };
    for (const job of jobs) {
      const node = nodes.get(job.drvPath);
      if (number(job.startedAt) !== null) {
        add(
          "request",
          job.drvPath,
          node,
          job.startedAt,
          number(job.finishedAt) ?? end,
          { open: number(job.finishedAt) === null, logPath: job.logPath },
        );
        if (
          number(job.queuedAt) !== null &&
          job.startedAt - job.queuedAt >= 0.05
        )
          add(
            "wait",
            `queue:${job.drvPath}`,
            node,
            job.queuedAt,
            job.startedAt,
            {
              reason:
                "Wrapper queue · includes remaining evaluation and planning",
              name: `${node.name} · queue`,
            },
          );
      } else if (job.state === "queued" && number(job.queuedAt) !== null) {
        add("wait", `queue:${job.drvPath}`, node, job.queuedAt, end, {
          open: true,
          reason: "Wrapper queue · not yet submitted",
          name: `${node.name} · queue`,
        });
      }
    }
    const active = new Map(),
      legacy = new Map(),
      phaseEvents = new Map(),
      uploads = new Map(),
      imports = new Map(),
      waits = new Map(),
      stages = new Map();
    const uploadRecords = new Map(
      array(snapshot.uploads).map((u) => [u.path, u]),
    );
    const importRecords = new Map(
      array(snapshot.cacheReuse).map((i) => [i.drvPath, i]),
    );
    const observedActivityNodes = new Set();
    const activityIdentity = (e) =>
      string(e.activityId) ? `${string(e.requestId)}:${e.activityId}` : null;
    const activityKey = (e, kind) =>
      kind === "download" && string(e.path)
        ? e.path
        : string(e.drvPath) || string(e.path);
    const waitKey = (e) =>
      string(e.id) || `legacy:${string(e.requestId) || "unknown"}`;
    const closeActivity = (opened, time, extra) => {
      const key = activityKey(opened.event, opened.kind),
        node = ensureNode(
          string(opened.event.drvPath) || string(opened.event.path),
          opened.event,
        );
      if (!key) return;
      const snapshotEnd =
        node && node.activity && number(node.activity.finishedAt);
      const boundedEnd =
        extra && extra.open && snapshotEnd !== null && snapshotEnd !== undefined
          ? Math.min(time, snapshotEnd)
          : time;
      add(
        opened.kind,
        key,
        node,
        opened.time,
        Math.max(opened.time, boundedEnd),
        Object.assign(
          {
            activityId: opened.event.activityId,
            requestId: opened.event.requestId,
            attempt: opened.event.attempt,
            path: opened.event.path,
            estimated: opened.estimated,
            neededBy: strings(opened.event.neededBy),
            name:
              opened.kind === "download" && string(opened.event.path)
                ? shortName(opened.event.path)
                : undefined,
          },
          extra,
        ),
      );
    };
    for (const event of events) {
      const id = string(event.drvPath) || string(event.path);
      if (id) ensureNode(id, event);
      if (event.type === "activity-start") {
        observedActivityNodes.add(id);
        const kind = kindFor(event.activityKind || event.state),
          identity = activityIdentity(event);
        if (identity) {
          if (active.has(identity))
            closeActivity(active.get(identity), event.time, {
              estimated: true,
            });
          active.set(identity, {
            event,
            time: event.time,
            kind,
            estimated: false,
          });
        } else {
          if (!legacy.has(id)) legacy.set(id, new Map());
          const kinds = legacy.get(id);
          if (!kinds.has(kind))
            kinds.set(kind, { event, time: event.time, kind, estimated: true });
        }
      } else if (event.type === "activity-stop") {
        const identity = activityIdentity(event);
        if (identity && active.has(identity)) {
          closeActivity(active.get(identity), event.time);
          active.delete(identity);
        } else if (
          !identity &&
          legacy.has(id) &&
          (number(event.active) === null || event.active === 0)
        ) {
          for (const opened of legacy.get(id).values())
            closeActivity(opened, event.time);
          legacy.delete(id);
        }
      } else if (event.type === "phase") {
        if (!phaseEvents.has(id)) phaseEvents.set(id, []);
        phaseEvents.get(id).push(event);
      } else if (event.type === "stage") {
        if (event.state === "started") stages.set(event.stage, event.time);
        else if (event.state === "finished" && stages.has(event.stage)) {
          add(
            event.stage,
            event.stage,
            null,
            stages.get(event.stage),
            event.time,
          );
          stages.delete(event.stage);
        }
      } else if (event.type === "upload-start") uploads.set(event.path, event);
      else if (event.type === "upload") {
        const record = uploadRecords.get(event.path);
        const opened = uploads.get(event.path);
        const from = opened
          ? opened.time
          : record && number(record.startedAt) !== null
            ? record.startedAt
            : record
              ? event.time - positive(record.seconds)
              : null;
        const node =
          nodes.get(producers.get(event.path)) || ensureNode(event.path);
        add("upload", event.path, node, from, event.time, {
          estimated: !opened && !(record && number(record.startedAt) !== null),
          state: event.state,
          path: event.path,
          logPath: record && record.logPath,
          name: shortName(event.path),
        });
        uploads.delete(event.path);
      } else if (event.type === "cache-import-start")
        imports.set(event.drvPath, event);
      else if (event.type === "cache-import-finished") {
        const opened = imports.get(event.drvPath),
          record = importRecords.get(event.drvPath);
        const from = opened
          ? opened.time
          : event.time - positive(event.seconds);
        add(
          "import",
          event.drvPath,
          nodes.get(event.drvPath),
          from,
          event.time,
          {
            estimated: !opened,
            state: event.state,
            logPath: event.logPath || (record && record.logPath),
            source: opened && opened.source,
            error: event.error,
          },
        );
        imports.delete(event.drvPath);
      } else if (event.type === "request-wait") {
        const key = waitKey(event);
        if (!waits.has(key)) waits.set(key, []);
        waits.get(key).push(event);
      } else if (event.type === "request-wait-ended") {
        const key = waitKey(event),
          openings = waits.get(key) || [],
          legacyWait = !string(event.id);
        const inferredStart =
          number(event.seconds) === null
            ? null
            : event.time - positive(event.seconds);
        let index = 0;
        if (inferredStart !== null)
          for (let i = 1; i < openings.length; i++)
            if (
              Math.abs(openings[i].time - inferredStart) <
              Math.abs(openings[index].time - inferredStart)
            )
              index = i;
        const opened = openings[index];
        const from =
          legacyWait && inferredStart !== null
            ? inferredStart
            : opened
              ? opened.time
              : inferredStart;
        const roots = strings(event.drvs || (opened && opened.drvs))
          .map((d) => nodes.get(d))
          .filter(Boolean);
        add("wait", `request:${key}`, roots[0], from, event.time, {
          estimated: legacyWait || !opened,
          reason: event.reason || (opened && opened.reason),
          neededBy: roots.flatMap((n) => n.attrs),
          name:
            string(event.reason) ||
            string(opened && opened.reason) ||
            "Nix request waiting",
        });
        openings.splice(index, 1);
        if (!openings.length) waits.delete(key);
      }
    }
    for (const opened of active.values())
      closeActivity(opened, end, { open: true });
    for (const kinds of legacy.values())
      for (const opened of kinds.values())
        closeActivity(opened, end, { open: true });
    for (const [stage, time] of stages)
      add(stage, stage, null, time, end, { open: true });
    for (const [path, opened] of uploads) {
      const record = uploadRecords.get(path) || {};
      add(
        "upload",
        path,
        nodes.get(producers.get(path)) || ensureNode(path),
        opened.time,
        number(record.finishedAt) ?? end,
        {
          open: true,
          state: string(record.state) || "uploading",
          path,
          name: shortName(path),
          logPath: record.logPath || opened.logPath,
        },
      );
    }
    for (const [drv, opened] of imports) {
      const record = importRecords.get(drv) || {};
      add(
        "import",
        drv,
        nodes.get(drv),
        opened.time,
        number(record.finishedAt) ?? end,
        {
          open: true,
          state: string(record.state) || "importing",
          source: opened.source,
          logPath: record.logPath || opened.logPath,
          error: record.error,
        },
      );
    }
    for (const [id, openings] of waits)
      for (const opened of openings) {
        const roots = strings(opened.drvs)
          .map((d) => nodes.get(d))
          .filter(Boolean);
        add("wait", `request:${id}`, roots[0], opened.time, end, {
          open: true,
          estimated: !string(opened.id),
          reason: opened.reason,
          neededBy: roots.flatMap((n) => n.attrs),
          name: string(opened.reason) || "Nix request waiting",
        });
      }
    // Old snapshots can be useful without an event stream, but spans are not
    // presented as exact build phases or as measured resource utilization.
    for (const activity of activities) {
      const id = string(activity.drvPath) || string(activity.path),
        node = nodes.get(id);
      if (
        !node ||
        observedActivityNodes.has(id) ||
        number(activity.startedAt) === null
      )
        continue;
      const kind = positive(activity.buildSeconds)
        ? "build"
        : positive(activity.downloadSeconds)
          ? "download"
          : kindFor(activity.state);
      add(
        kind,
        id,
        node,
        activity.startedAt,
        number(activity.finishedAt) ?? end,
        {
          estimated: true,
          open: number(activity.finishedAt) === null,
          reason:
            "Observation window from snapshot; exact activity boundaries unavailable",
        },
      );
    }
    const planEvent = events.find((e) => e.type === "plan");
    const planningEnd = planEvent
      ? planEvent.time
      : Math.min(
          end,
          start +
            positive(context.evaluationSeconds) +
            positive(context.planningSeconds),
        );
    const planningStart = Math.max(
      start,
      planningEnd - positive(context.planningSeconds),
    );
    if (
      ![...rows.values()].some((r) => r.kind === "planning") &&
      positive(context.planningSeconds)
    )
      add("planning", "planning", null, planningStart, planningEnd, {
        estimated: true,
      });
    if (
      ![...rows.values()].some((r) => r.kind === "evaluation") &&
      positive(context.evaluationSeconds)
    )
      add(
        "evaluation",
        "evaluation",
        null,
        Math.max(start, planningStart - positive(context.evaluationSeconds)),
        planningStart,
        { estimated: true },
      );
    for (const upload of array(snapshot.uploads))
      if (
        !rows.has(`upload:${upload.path}`) &&
        number(upload.startedAt) !== null
      )
        add(
          "upload",
          upload.path,
          nodes.get(producers.get(upload.path)) || ensureNode(upload.path),
          upload.startedAt,
          number(upload.finishedAt) ?? end,
          {
            open: number(upload.finishedAt) === null,
            state: upload.state,
            logPath: upload.logPath,
            path: upload.path,
            name: shortName(upload.path),
          },
        );
    for (const item of array(snapshot.cacheReuse))
      if (
        !rows.has(`import:${item.drvPath}`) &&
        number(item.startedAt) !== null
      )
        add(
          "import",
          item.drvPath,
          nodes.get(item.drvPath) || ensureNode(item.drvPath, item),
          item.startedAt,
          number(item.finishedAt) ?? end,
          {
            open: number(item.finishedAt) === null,
            state: item.state,
            logPath: item.logPath,
            source: item.source,
          },
        );
    for (const wait of array(snapshot.waits))
      if (
        !rows.has(`wait:request:${waitKey(wait)}`) &&
        number(wait.startedAt) !== null
      ) {
        const roots = strings(wait.drvs)
          .map((d) => nodes.get(d))
          .filter(Boolean);
        add("wait", `request:${waitKey(wait)}`, roots[0], wait.startedAt, end, {
          open: true,
          estimated: !string(wait.id),
          name: string(wait.reason) || "Nix request waiting",
          reason: wait.reason,
          neededBy: roots.flatMap((n) => n.attrs),
        });
      }
    const resultRows = [...rows.values()];
    for (const row of resultRows) {
      row.intervals.sort((a, b) => a.start - b.start);
      row.start = row.intervals.reduce((a, x) => Math.min(a, x.start), end);
      row.end = row.intervals.reduce((a, x) => Math.max(a, x.end), start);
      row.seconds = intervalSeconds(row.intervals);
      row.estimated = row.intervals.some((x) => x.estimated);
      row.open = row.intervals.some((x) => x.open);
      const node = nodes.get(row.nodeId);
      row.neededBy = unique(row.neededBy.concat(node ? node.neededBy : []));
      row.search = [
        row.name,
        row.key,
        node && node.attrs.join(" "),
        row.neededBy.join(" "),
        row.kind,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (row.kind === "build") {
        for (const segment of row.intervals) {
          const phases = (phaseEvents.get(row.nodeId) || []).filter(
            (e) =>
              e.time >= segment.start &&
              e.time <= segment.end &&
              (!e.activityId ||
                !segment.activityId ||
                e.activityId === segment.activityId),
          );
          segment.phases = phases.map((event, index) => ({
            name: string(event.phase),
            start: event.time,
            end:
              index + 1 < phases.length ? phases[index + 1].time : segment.end,
            boundedByActivityEnd: index + 1 === phases.length,
          }));
        }
      }
    }
    const diagnostics = [];
    if (string(snapshot.error))
      diagnostics.push({
        type: "Run error",
        name: "Run could not complete",
        message: snapshot.error,
        severity: "error",
      });
    for (const failure of array(snapshot.rootFailures))
      diagnostics.push({
        type: "Root failure",
        name: failure.name || shortName(failure.drvPath),
        message: string(failure.message),
        excerpt: strings(failure.excerpt).join("\n"),
        nodeId: failure.drvPath,
        affected: strings(failure.affected),
        logPath: failure.logPath,
        severity: "error",
      });
    for (const error of array(object(snapshot.evaluation).errors))
      diagnostics.push({
        type: "Evaluation error",
        name:
          string(error.attr) || string(error.name) || "Attribute evaluation",
        message:
          string(error.error) || string(error.message) || JSON.stringify(error),
        severity: "error",
      });
    for (const warning of strings(snapshot.warnings))
      diagnostics.push({
        type: "Warning",
        name: diagnosticCause(warning),
        message: warning,
        severity: "warning",
      });
    for (const warning of strings(data.warnings))
      diagnostics.push({
        type: "Report data warning",
        name: diagnosticCause(warning),
        message: warning,
        severity: "warning",
      });
    for (const upload of array(snapshot.uploads))
      if (upload.state === "failed")
        diagnostics.push({
          type: "Cache sync failed",
          name: shortName(upload.path),
          message: string(upload.error),
          logPath: upload.logPath,
          severity: "error",
        });
    const rootNodes = [...nodes.values()].filter((n) => n.root);
    for (const node of nodes.values())
      node.search = [
        node.name,
        node.id,
        node.attrs.join(" "),
        node.neededBy.join(" "),
      ]
        .join(" ")
        .toLowerCase();
    const builds = concurrency(resultRows, "build", start, end),
      downloads = concurrency(resultRows, "download", start, end);
    const buildRows = resultRows
      .filter((r) => r.kind === "build")
      .sort((a, b) => b.seconds - a.seconds);
    const stats = {
      roots: rootNodes.length,
      attrs: Math.max(
        positive(object(snapshot.evaluation).attrs),
        rootNodes.reduce((sum, n) => sum + n.attrs.length, 0),
      ),
      aliases: rootNodes.reduce(
        (sum, n) => sum + Math.max(0, n.attrs.length - 1),
        0,
      ),
      cached: rootNodes.filter((n) => n.state === "cached").length,
      complete: rootNodes.filter(
        (n) => !["queued", "submitted"].includes(n.state),
      ).length,
      failed: rootNodes.filter((n) => ["failed", "blocked"].includes(n.state))
        .length,
      buildCount: unique(buildRows.map((r) => r.nodeId || r.key)).length,
      imported: array(snapshot.cacheReuse).filter((x) => x.state === "imported")
        .length,
      builds,
      downloads,
    };
    const parents = new Map();
    for (const n of nodes.values())
      for (const input of n.inputs)
        if (input && input.drvPath) {
          if (!parents.has(input.drvPath)) parents.set(input.drvPath, []);
          parents.get(input.drvPath).push(n.id);
        }
    return {
      snapshot,
      context,
      events,
      plan,
      nodes,
      byAttr,
      parents,
      producers,
      rows: resultRows,
      rowMap: rows,
      jobs: rootNodes,
      diagnostics,
      start,
      end,
      span,
      extent,
      stats,
      buildRows,
    };
  }

  function filterRows(model, options) {
    const o = object(options),
      query = o.query || Query.compile(string(o.search)),
      from = number(o.start) ?? model.start,
      to = number(o.end) ?? model.end;
    return model.rows.filter(
      (row) =>
        (!o.kinds || o.kinds.has(row.kind)) &&
        query.match(row) &&
        stateMatches(row.state, o.state || "all") &&
        row.end >= from &&
        row.start <= to &&
        (!o.focus ||
          row.nodeId === o.focus ||
          row.neededBy.some((attr) => model.byAttr.get(attr) === o.focus)),
    );
  }
  function visibleRange(length, scrollTop, height, rowHeight, overscan = 5) {
    const first = clamp(
      Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan,
      0,
      length,
    );
    return {
      first,
      last: Math.min(
        length,
        first + Math.ceil(Math.max(0, height) / rowHeight) + 2 * overscan,
      ),
    };
  }

  function viewFragment(state, model) {
    const params = new URLSearchParams();
    params.set("view", state.tab);
    if (state.search) params.set("q", state.search);
    if (state.outcome !== "all") params.set("status", state.outcome);
    params.set("kinds", [...state.kinds].join(","));
    if (state.from > model.start)
      params.set("from", (state.from - model.start).toFixed(3));
    if (state.to < model.end)
      params.set("to", (state.to - model.start).toFixed(3));
    if (state.sort !== "start") params.set("sort", state.sort);
    if (state.packageSort !== "attention")
      params.set("packages", state.packageSort);
    if (state.focus) params.set("focus", state.focus);
    if (state.selection) {
      if (state.selection.nodeId) params.set("node", state.selection.nodeId);
      if (state.selection.rowId) params.set("row", state.selection.rowId);
      params.set("detail", state.inspectorTab);
    }
    return "#" + params.toString();
  }

  function readView(fragment, model) {
    if (typeof fragment !== "string" || fragment.length > 32768) return null;
    const params = new URLSearchParams(fragment.replace(/^#/, ""));
    if (!params.has("view")) return null;
    const choice = (key, choices, fallback) =>
      choices.includes(params.get(key)) ? params.get(key) : fallback;
    const time = (key, fallback) => {
      if (!params.has(key)) return fallback;
      const value = Number(params.get(key));
      return Number.isFinite(value)
        ? clamp(model.start + value, model.start, model.end)
        : fallback;
    };
    const row = model.rowMap.get(params.get("row"));
    const node = model.nodes.get(params.get("node"));
    return {
      tab: choice("view", ["timeline", "packages", "diagnostics"], "timeline"),
      search: (params.get("q") || "").slice(0, 8192),
      outcome: choice(
        "status",
        ["all", "failed", "active", "built", "cached", "cancelled"],
        "all",
      ),
      kinds: new Set(
        params.has("kinds")
          ? params
              .get("kinds")
              .split(",")
              .filter((k) => Object.hasOwn(KINDS, k))
          : DEFAULT_KINDS,
      ),
      from: time("from", model.start),
      to: time("to", model.end),
      sort: choice("sort", ["start", "duration", "kind", "name"], "start"),
      packageSort: choice(
        "packages",
        ["attention", "time", "name", "state"],
        "attention",
      ),
      inspectorTab: choice(
        "detail",
        ["overview", "dependencies", "metadata"],
        "overview",
      ),
      selection: row
        ? { nodeId: row.nodeId, rowId: row.id }
        : node
          ? { nodeId: node.id, rowId: null }
          : null,
      focus: model.nodes.has(params.get("focus")) ? params.get("focus") : null,
    };
  }

  function boot(document) {
    const $ = (id) => document.getElementById(id);
    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text);
      return node;
    };
    let envelope;
    try {
      envelope = JSON.parse($("report-data").textContent);
    } catch (_) {
      $("run-title").textContent = "This report’s data could not be read";
      $("run-status").textContent = "Invalid data";
      return;
    }
    const model = buildModel(envelope),
      state = {
        tab: "timeline",
        search: "",
        outcome: "all",
        kinds: new Set(DEFAULT_KINDS),
        from: model.start,
        to: model.end,
        sort: "start",
        packageSort: "attention",
        focus: null,
        selection: null,
        diagnosticPage: 0,
        inspectorTab: "overview",
      };
    let filteredRows = [],
      filteredPackages = [],
      pendingFrame = false,
      toastTimer,
      restoringView = true;
    const color = (kind) => `var(${KINDS[kind].color})`;
    const setKind = (node, kind) =>
      node.style.setProperty("--kind-color", color(kind));
    const button = (text, className, action) => {
      const node = el("button", className, text);
      node.type = "button";
      node.addEventListener("click", action);
      return node;
    };
    const appendText = (parent, tag, className, text) => {
      const child = el(tag, className, text);
      parent.append(child);
      return child;
    };
    const empty = (parent, title, text) => {
      const box = el("div", "empty-state");
      appendText(box, "strong", "", title);
      appendText(box, "p", "", text);
      parent.append(box);
    };
    const toast = (text) => {
      clearTimeout(toastTimer);
      $("toast").textContent = text;
      $("toast").hidden = false;
      toastTimer = setTimeout(() => {
        $("toast").hidden = true;
      }, 2200);
    };
    const copy = async (text) => {
      try {
        await global.navigator.clipboard.writeText(text);
        toast("Copied to clipboard");
      } catch (_) {
        const textarea = el("textarea", "", text);
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        textarea.select();
        let copied = false;
        try {
          copied = document.execCommand("copy");
        } catch (_) {
          /* The text remains available in the detail panel. */
        }
        textarea.remove();
        toast(
          copied
            ? "Copied to clipboard"
            : "Select and copy the command in the detail panel",
        );
      }
    };
    function saveView() {
      if (restoringView) return;
      try {
        global.history.replaceState(null, "", viewFragment(state, model));
      } catch (_) {
        /* Some browsers restrict history for local files. */
      }
    }
    function updateSearch(value) {
      state.search = value;
      $("search").value = value;
      state.diagnosticPage = 0;
      refilter(true);
    }
    function addQueryTerm(field, value) {
      updateSearch(Query.addTerm(state.search, { field, value }));
    }
    function renderQuery(query) {
      $("query-error").hidden = !query.error;
      $("query-error").textContent = query.error || "";
      $("search").setAttribute("aria-invalid", String(Boolean(query.error)));
      const chips = $("active-filters");
      const focus = focusedKey(chips);
      chips.replaceChildren();
      query.terms.forEach((term, index) => {
        const chip = button(`${term.raw} ×`, "filter-chip", () =>
          updateSearch(Query.removeTerm(state.search, index)),
        );
        chip.dataset.focusKey = `term-${index}`;
        chip.setAttribute("aria-label", `Remove filter ${term.raw}`);
        chips.append(chip);
      });
      if (state.outcome !== "all") {
        const chip = button(`outcome:${state.outcome} ×`, "filter-chip", () => {
          state.outcome = "all";
          $("state-filter").value = "all";
          refilter(true);
        });
        chip.dataset.focusKey = "outcome";
        chips.append(chip);
      }
      chips.hidden = !chips.children.length;
      restoreFocus(chips, focus, $("search"));
    }
    function packageQueryRow(node) {
      return {
        ...node,
        kind: "request",
        seconds:
          number(node.job.startedAt) === null
            ? null
            : number(node.job.activeSeconds),
      };
    }
    function renderStateFacets(query) {
      const container = $("facet-states"),
        focus = focusedKey(container);
      container.replaceChildren();
      const candidates =
        state.tab === "diagnostics"
          ? model.diagnostics.map(diagnosticQueryRow).filter(query.match)
          : state.tab === "packages"
            ? model.jobs.map(packageQueryRow).filter(query.match)
            : filterRows(model, {
                query,
                kinds: query.terms.some((t) => t.field === "kind")
                  ? null
                  : state.kinds,
                start: state.from,
                end: state.to,
                focus: state.focus,
              });
      for (const [value, label] of [
        ["all", "All outcomes"],
        ["failed", "Failed / blocked"],
        ["active", "In progress"],
        ["built", "Built"],
        ["cached", "Cached"],
        ["cancelled", "Cancelled"],
      ]) {
        const b = button("", "facet-toggle", () => {
          state.outcome = value;
          $("state-filter").value = value;
          refilter(true);
        });
        b.dataset.focusKey = value;
        b.setAttribute("aria-pressed", String(state.outcome === value));
        appendText(b, "span", "facet-label", label);
        appendText(
          b,
          "span",
          "facet-count",
          count(candidates.filter((r) => stateMatches(r.state, value)).length),
        );
        container.append(b);
      }
      restoreFocus(container, focus);
      $("facet-summary").textContent =
        state.tab === "diagnostics"
          ? `${count(candidates.filter((r) => stateMatches(r.state, state.outcome)).length)} diagnostics`
          : state.tab === "packages"
            ? `${count(filteredPackages.length)} packages`
            : `${count(filteredRows.length)} activities`;
      $("facet-kinds").hidden = state.tab !== "timeline";
    }
    const linkLog = (parent, path) => {
      if (!safeLog(path)) return;
      const hosted = model.context.logsAvailable === false;
      const href = hosted ? safeUrl(model.context.artifactUrl) : safeLog(path);
      if (href) {
        const a = appendText(
          parent,
          "a",
          "button secondary compact",
          hosted ? "Download full logs ↗" : "Open log ↗",
        );
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
    };
    const stateLabel = (value) => {
      const label = el("span", "state-label", value || "unobserved");
      if (/^[a-z-]+$/.test(value)) label.classList.add(`state-${value}`);
      return label;
    };
    const focusedKey = (container) =>
      container.contains(document.activeElement)
        ? document.activeElement.dataset.focusKey || "viewport"
        : null;
    const restoreFocus = (container, key, fallback) => {
      if (!key) return;
      const target = [...container.querySelectorAll("[data-focus-key]")].find(
        (node) => node.dataset.focusKey === key,
      );
      if (target || fallback)
        (target || fallback).focus({ preventScroll: true });
    };
    function select(nodeId, rowId) {
      const fromInspector = $("inspector").contains(document.activeElement);
      state.selection = { nodeId, rowId };
      renderInspector();
      renderVisible();
      saveView();
      if (fromInspector) {
        $("inspector-title").tabIndex = -1;
        $("inspector-title").focus({ preventScroll: true });
      }
      if (global.innerWidth < 900)
        $("inspector").scrollIntoView({
          behavior:
            global.matchMedia &&
            global.matchMedia("(prefers-reduced-motion: reduce)").matches
              ? "instant"
              : "smooth",
          block: "start",
        });
    }
    function focusActivity(row) {
      state.search = "";
      $("search").value = "";
      state.outcome = "all";
      $("state-filter").value = "all";
      state.focus = null;
      state.kinds.add(row.kind);
      renderKindFilters();
      setTab("timeline");
      const padding = Math.max(0.1, (row.end - row.start) * 0.08);
      setWindow(row.start - padding, row.end + padding);
      const index = filteredRows.findIndex(
        (candidate) => candidate.id === row.id,
      );
      if (index >= 0)
        $("timeline-scroll").scrollTop = Math.max(
          0,
          index * TIMELINE_ROW_HEIGHT - 64,
        );
      select(row.nodeId, row.id);
      restoreFocus($("timeline-rows"), `${row.id}:label`);
    }
    function setTab(tab) {
      state.tab = tab;
      for (const name of ["timeline", "packages", "diagnostics"]) {
        $(name + "-panel").hidden = name !== tab;
        $("tab-" + name).setAttribute("aria-selected", String(name === tab));
        $("tab-" + name).tabIndex = name === tab ? 0 : -1;
      }
      refilter();
      if (tab === "timeline") drawOverview();
      saveView();
    }
    function setWindow(a, b) {
      const minimum = model.extent / 1000;
      state.from = clamp(Math.min(a, b), model.start, model.end);
      state.to = clamp(
        Math.max(a, b),
        Math.min(model.end, state.from + minimum),
        model.end,
      );
      if (state.to - state.from < minimum)
        state.from = Math.max(model.start, state.to - minimum);
      $("window-start").value = Math.round(
        ((state.from - model.start) / model.extent) * 1000,
      );
      $("window-end").value = Math.round(
        ((state.to - model.start) / model.extent) * 1000,
      );
      $("window-start").setAttribute(
        "aria-valuetext",
        `${duration(state.from - model.start)} into run`,
      );
      $("window-end").setAttribute(
        "aria-valuetext",
        `${duration(state.to - model.start)} into run`,
      );
      $("window-label").textContent =
        `${duration(state.from - model.start)} — ${duration(state.to - model.start)}`;
      const left = ((state.from - model.start) / model.extent) * 100,
        right = ((model.end - state.to) / model.extent) * 100;
      $("brush").style.left = `${left}%`;
      $("brush").style.right = `${right}%`;
      renderAxis();
      refilter();
    }
    function zoom(factor) {
      const center = (state.from + state.to) / 2,
        half = Math.max(
          model.extent / 2000,
          ((state.to - state.from) * factor) / 2,
        );
      let a = center - half,
        b = center + half;
      if (a < model.start) {
        b += model.start - a;
        a = model.start;
      }
      if (b > model.end) {
        a -= b - model.end;
        b = model.end;
      }
      setWindow(a, b);
    }
    function refilter(resetScroll) {
      const query = Query.compile(state.search);
      filteredRows = filterRows(model, {
        query,
        state: state.outcome,
        kinds: query.terms.some((term) => term.field === "kind")
          ? null
          : state.kinds,
        start: state.from,
        end: state.to,
        focus: state.focus,
      });
      const kindOrder = Object.keys(KINDS);
      filteredRows.sort((a, b) =>
        state.sort === "duration"
          ? b.seconds - a.seconds || a.start - b.start
          : state.sort === "name"
            ? a.name.localeCompare(b.name)
            : state.sort === "kind"
              ? kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) ||
                a.start - b.start
              : a.start - b.start ||
                kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind),
      );
      filteredPackages = model.jobs.filter(
        (n) =>
          query.match(packageQueryRow(n)) &&
          stateMatches(n.state, state.outcome),
      );
      const rank = {
        failed: 0,
        blocked: 1,
        submitted: 2,
        queued: 3,
        cancelled: 4,
        built: 5,
        cached: 6,
      };
      filteredPackages.sort((a, b) =>
        state.packageSort === "name"
          ? a.name.localeCompare(b.name)
          : state.packageSort === "time"
            ? positive(b.job.activeSeconds) - positive(a.job.activeSeconds)
            : state.packageSort === "state"
              ? a.state.localeCompare(b.state) || a.name.localeCompare(b.name)
              : (rank[a.state] ?? 9) - (rank[b.state] ?? 9) ||
                positive(b.job.activeSeconds) - positive(a.job.activeSeconds) ||
                a.name.localeCompare(b.name),
      );
      $("timeline-count").textContent =
        `${count(filteredRows.length)} activity lanes`;
      $("timeline-rows").style.height =
        `${Math.max(110, filteredRows.length * TIMELINE_ROW_HEIGHT)}px`;
      $("package-rows").style.height =
        `${Math.max(110, filteredPackages.length * PACKAGE_ROW_HEIGHT)}px`;
      $("package-footnote").textContent =
        `${count(filteredPackages.length)} of ${count(model.jobs.length)} unique root derivations · request time includes dependency work and Nix waiting; build time is observed builder activity.`;
      $("focus-strip").hidden = !state.focus;
      const focus = model.nodes.get(state.focus);
      $("focus-label").textContent = focus
        ? `Work needed by ${focus.attrs[0] || focus.name}`
        : "";
      if (resetScroll) {
        $("timeline-scroll").scrollTop = 0;
        $("package-scroll").scrollTop = 0;
      }
      renderVisible();
      renderDiagnostics();
      renderQuery(query);
      renderKindFilters(query);
      renderStateFacets(query);
      saveView();
    }
    function renderAxis() {
      const ticks = $("axis-ticks");
      ticks.replaceChildren();
      for (let i = 0; i < 5; i++) {
        const tick = el(
          "span",
          "tick",
          duration(
            state.from - model.start + ((state.to - state.from) * i) / 4,
          ),
        );
        tick.style.left = `${i * 25}%`;
        ticks.append(tick);
      }
    }
    function renderVisible() {
      if (state.tab === "timeline") renderTimeline();
      if (state.tab === "packages") renderPackages();
    }
    function renderTimeline() {
      const viewport = $("timeline-scroll"),
        container = $("timeline-rows"),
        focus = focusedKey(container);
      container.replaceChildren();
      if (!filteredRows.length) {
        empty(
          container,
          model.rows.length
            ? "No activities match this view"
            : "No timed activity recorded",
          model.rows.length
            ? "Widen the time window or reset your filters."
            : "Cached packages and evaluation failures remain available in the other tabs.",
        );
        restoreFocus(container, focus, viewport);
        return;
      }
      const range = visibleRange(
          filteredRows.length,
          viewport.scrollTop,
          viewport.clientHeight || 484,
          TIMELINE_ROW_HEIGHT,
        ),
        span = Math.max(0.001, state.to - state.from);
      const fragment = document.createDocumentFragment();
      for (let i = range.first; i < range.last; i++) {
        const row = filteredRows[i],
          wrapper = el("div", "timeline-row"),
          label = button("", "row-label", () => select(row.nodeId, row.id));
        wrapper.style.top = `${i * TIMELINE_ROW_HEIGHT}px`;
        wrapper.dataset.row = row.id;
        wrapper.dataset.index = String(i);
        label.dataset.focusKey = `${row.id}:label`;
        label.addEventListener("dblclick", () => focusActivity(row));
        if (
          state.selection &&
          (state.selection.rowId === row.id ||
            (!state.selection.rowId && state.selection.nodeId === row.nodeId))
        )
          wrapper.classList.add("selected");
        const dot = el("span", "kind-dot");
        setKind(dot, row.kind);
        label.append(dot);
        const copy = el("span", "row-copy");
        appendText(copy, "span", "row-name", row.name);
        const node = model.nodes.get(row.nodeId),
          consumers = row.neededBy.length
            ? ` · ${count(row.neededBy.length)} consumer${row.neededBy.length === 1 ? "" : "s"}`
            : node && node.root
              ? " · requested"
              : "";
        appendText(
          copy,
          "span",
          "row-subtitle",
          `${KINDS[row.kind].label}${consumers}`,
        );
        label.append(copy);
        appendText(label, "span", "row-duration", duration(row.seconds));
        label.title = `${row.name} · ${KINDS[row.kind].label} · ${duration(row.seconds)} observed span`;
        wrapper.append(label);
        const chart = el("div", "row-chart");
        let segmentIndex = 0;
        for (const segment of row.intervals) {
          const thisSegment = segmentIndex++;
          if (segment.end < state.from || segment.start > state.to) continue;
          const a = clamp(segment.start, state.from, state.to),
            b = clamp(segment.end, state.from, state.to);
          const bar = button("", "interval", () => select(row.nodeId, row.id));
          setKind(bar, row.kind);
          bar.dataset.focusKey = `${row.id}:bar:${thisSegment}`;
          bar.addEventListener("dblclick", () => focusActivity(row));
          bar.dataset.segment = String(thisSegment);
          bar.style.left = `${((a - state.from) / span) * 100}%`;
          bar.style.width = `${Math.max(0.08, ((b - a) / span) * 100)}%`;
          if (segment.estimated) bar.classList.add("estimated");
          if (segment.open) bar.classList.add("open");
          bar.title = `${row.name}\n${KINDS[row.kind].label}: +${duration(segment.start - model.start)} → +${duration(segment.end - model.start)} (${duration(segment.end - segment.start)})${segment.estimated ? "\nTiming inferred from incomplete or legacy observations" : ""}${segment.open ? "\nEnd not observed; shown through snapshot" : ""}`;
          bar.setAttribute("aria-label", bar.title.replace(/\n/g, ". "));
          if ((b - a) / span > 0.075)
            bar.textContent = duration(segment.end - segment.start);
          for (const phase of array(segment.phases))
            if (phase.start > a && phase.start < b) {
              const marker = el("span", "phase-marker");
              marker.style.left = `${((phase.start - a) / Math.max(0.001, b - a)) * 100}%`;
              bar.append(marker);
            }
          chart.append(bar);
        }
        wrapper.append(chart);
        fragment.append(wrapper);
      }
      container.append(fragment);
      restoreFocus(container, focus, viewport);
      $("timeline-footnote").textContent =
        `${count(model.events.length)} events · ${model.rows.some((r) => r.open) ? "contains open intervals" : "relative to run start"}`;
    }
    function renderPackages() {
      const viewport = $("package-scroll"),
        container = $("package-rows"),
        focus = focusedKey(container);
      container.replaceChildren();
      if (!filteredPackages.length) {
        empty(
          container,
          "No packages match this view",
          model.jobs.length
            ? "Try another name or outcome filter."
            : "No requested derivations were decoded. Check Diagnostics for evaluation errors.",
        );
        restoreFocus(container, focus, viewport);
        return;
      }
      const range = visibleRange(
          filteredPackages.length,
          viewport.scrollTop,
          viewport.clientHeight || 484,
          PACKAGE_ROW_HEIGHT,
        ),
        fragment = document.createDocumentFragment();
      for (let i = range.first; i < range.last; i++) {
        const node = filteredPackages[i],
          row = button("", "package-row", () => select(node.id, null));
        row.style.top = `${i * PACKAGE_ROW_HEIGHT}px`;
        row.dataset.index = String(i);
        row.dataset.focusKey = node.id;
        if (state.selection && state.selection.nodeId === node.id)
          row.classList.add("selected");
        const main = el("span", "package-main");
        appendText(
          main,
          "span",
          "row-name package-title",
          node.attrs.join(", ") || node.name,
        );
        appendText(main, "span", "row-subtitle package-name", node.name);
        row.append(
          main,
          stateLabel(node.state),
          el(
            "span",
            "mono",
            number(node.job.startedAt) === null
              ? "—"
              : duration(node.job.activeSeconds),
          ),
          el(
            "span",
            "mono",
            positive(node.job.buildSeconds)
              ? duration(node.job.buildSeconds)
              : "—",
          ),
        );
        row.title = `${node.name} · ${node.state}`;
        fragment.append(row);
      }
      container.append(fragment);
      restoreFocus(container, focus, viewport);
    }
    function renderInspector() {
      const panel = $("inspector");
      panel.replaceChildren();
      panel.scrollTop = 0;
      const resize = el("div", "inspector-resize");
      resize.setAttribute("role", "separator");
      resize.setAttribute("aria-label", "Resize activity details");
      resize.setAttribute("aria-orientation", "vertical");
      resize.tabIndex = 0;
      const resizeWidth = (width) => {
        const next = clamp(width, 260, Math.min(600, global.innerWidth * 0.45));
        $("workspace-grid").style.setProperty("--inspector-width", `${next}px`);
        resize.setAttribute("aria-valuenow", String(Math.round(next)));
        drawOverview();
      };
      resize.setAttribute("aria-valuemin", "260");
      resize.setAttribute(
        "aria-valuemax",
        String(Math.min(600, Math.floor(global.innerWidth * 0.45))),
      );
      resize.setAttribute(
        "aria-valuenow",
        String(Math.round(panel.getBoundingClientRect().width)),
      );
      let resizeOrigin = null;
      resize.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        resizeOrigin = {
          x: event.clientX,
          width: panel.getBoundingClientRect().width,
        };
        resize.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      resize.addEventListener("pointermove", (event) => {
        if (resizeOrigin)
          resizeWidth(resizeOrigin.width + resizeOrigin.x - event.clientX);
      });
      for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
        resize.addEventListener(event, () => {
          resizeOrigin = null;
        });
      resize.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        resizeWidth(
          event.key === "Home"
            ? 260
            : event.key === "End"
              ? 600
              : panel.getBoundingClientRect().width +
                (event.key === "ArrowLeft" ? 20 : -20),
        );
      });
      panel.append(resize);
      if (!state.selection) {
        const placeholder = el("div", "inspector-placeholder");
        appendText(placeholder, "span", "inspect-illustration", "↳");
        appendText(placeholder, "div", "eyebrow", "FOLLOW THE WORK");
        const title = appendText(placeholder, "h2", "", "Select an activity");
        title.id = "inspector-title";
        appendText(
          placeholder,
          "p",
          "",
          "Inspect its timing, build phases, consumers, and dependency links. Cached packages live in the Packages tab.",
        );
        panel.append(placeholder);
        return;
      }
      const node = model.nodes.get(state.selection.nodeId),
        row = model.rowMap.get(state.selection.rowId),
        name = row ? row.name : node ? node.name : "Activity";
      const head = el("div", "inspector-head"),
        heading = el("div", "inspector-heading");
      appendText(
        heading,
        "span",
        "eyebrow",
        row
          ? KINDS[row.kind].label.toUpperCase()
          : node && node.root
            ? "REQUESTED PACKAGE"
            : "DEPENDENCY",
      );
      const close = button("×", "icon-button", () => {
        state.selection = null;
        renderInspector();
        renderVisible();
        saveView();
        $("tab-" + state.tab).focus({ preventScroll: true });
      });
      close.setAttribute("aria-label", "Close activity details");
      heading.append(close);
      head.append(heading);
      const title = appendText(head, "h2", "", name);
      title.id = "inspector-title";
      if (row || node) head.append(stateLabel(row ? row.state : node.state));
      const tags = el("div", "detail-tags");
      if (row)
        tags.append(
          button(`kind:${row.kind}`, "tag-filter", () =>
            addQueryTerm("kind", row.kind),
          ),
        );
      tags.append(
        button("Filter this name", "tag-filter", () =>
          addQueryTerm("name", name),
        ),
      );
      head.append(tags);
      const actions = el("div", "detail-actions");
      linkLog(
        actions,
        (row && row.logPath) ||
          (node && ((node.activity || {}).logPath || (node.job || {}).logPath)),
      );
      if (row)
        actions.append(
          button("Focus time window", "button secondary compact", () => {
            const padding = Math.max(0.1, (row.end - row.start) * 0.12);
            setTab("timeline");
            setWindow(row.start - padding, row.end + padding);
          }),
        );
      if (node && node.root)
        actions.append(
          button("Follow needed work", "button secondary compact", () => {
            state.focus = node.id;
            state.search = "";
            $("search").value = "";
            state.outcome = "all";
            $("state-filter").value = "all";
            state.kinds = new Set(Object.keys(KINDS));
            renderKindFilters();
            setTab("timeline");
            setWindow(model.start, model.end);
            refilter(true);
          }),
        );
      head.append(actions);
      panel.append(head);
      const tabs = el("div", "inspector-tabs");
      tabs.setAttribute("role", "tablist");
      tabs.setAttribute("aria-label", "Activity details");
      panel.append(tabs);
      const tabNames = node
        ? ["overview", "dependencies", "metadata"]
        : ["overview"];
      if (!tabNames.includes(state.inspectorTab))
        state.inspectorTab = "overview";
      const contents = new Map();
      const showDetail = (name, focus = false) => {
        state.inspectorTab = name;
        for (const tab of tabs.children) {
          const selected = tab.dataset.detail === name;
          tab.setAttribute("aria-selected", String(selected));
          tab.tabIndex = selected ? 0 : -1;
          if (selected && focus) tab.focus({ preventScroll: true });
        }
        for (const [key, content] of contents) content.hidden = key !== name;
        panel.scrollTop = 0;
        saveView();
      };
      for (const name of tabNames) {
        const tab = button(
          name[0].toUpperCase() + name.slice(1),
          "inspector-tab",
          () => showDetail(name),
        );
        tab.dataset.detail = name;
        tab.id = `detail-tab-${name}`;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-controls", `detail-panel-${name}`);
        tabs.append(tab);
        const content = el("div", "inspector-content");
        content.id = `detail-panel-${name}`;
        content.setAttribute("role", "tabpanel");
        content.setAttribute("aria-labelledby", tab.id);
        contents.set(name, content);
        panel.append(content);
      }
      tabs.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const i = tabNames.indexOf(state.inspectorTab);
        showDetail(
          tabNames[
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabNames.length - 1
                : (i + (event.key === "ArrowRight" ? 1 : tabNames.length - 1)) %
                  tabNames.length
          ],
          true,
        );
      });
      const section = (title, tab = "overview") => {
        const s = el("section", "inspector-section");
        appendText(s, "h3", "", title);
        contents.get(tab).append(s);
        return s;
      };
      const timing = section("Timing"),
        grid = el("div", "detail-grid");
      const stat = (label, value) => {
        const box = el("div", "detail-stat");
        appendText(box, "span", "", label);
        appendText(box, "strong", "", value);
        grid.append(box);
      };
      if (row) {
        stat("Observed span", duration(row.seconds));
        stat("Starts into run", duration(row.start - model.start));
        stat("Ends into run", duration(row.end - model.start));
        stat("Intervals", count(row.intervals.length));
      } else if (node && node.job) {
        stat(
          "Request wall time",
          number(node.job.startedAt) === null
            ? "—"
            : duration(node.job.activeSeconds),
        );
        stat("Observed build time", duration(node.job.buildSeconds));
        stat("Wrapper queue", duration(node.job.queueSeconds));
        stat("Attribute aliases", count(Math.max(0, node.attrs.length - 1)));
      }
      timing.append(grid);
      if (row && row.estimated)
        appendText(
          timing,
          "p",
          "badge-estimated",
          "Inferred timing. Legacy events may combine overlapping requests; this is an observation window, not an exact per-output execution trace.",
        );
      if (row && row.open)
        appendText(
          timing,
          "p",
          "badge-estimated",
          "An end event was not recorded. This interval stops at the recorded finish or final snapshot boundary.",
        );
      if (row && row.kind === "request")
        appendText(
          timing,
          "p",
          "",
          "Request wall time includes required dependencies and Nix waiting. It is not the package’s own build duration.",
        );
      if (row && row.kind === "upload")
        appendText(
          timing,
          "p",
          "",
          "Successful cache sync means nix copy succeeded. Already cached outputs may transfer no bytes.",
        );
      if (row && row.kind === "wait")
        appendText(
          timing,
          "p",
          "",
          row.intervals.map((s) => s.reason).filter(Boolean)[0] ||
            "Nix reported waiting. The event does not identify a resource bottleneck.",
        );
      if (node && node.state === "cached")
        appendText(
          timing,
          "p",
          "",
          "Requested outputs were available locally or in a configured cache. No package build was needed; its cached dependency branch may be absent from the plan.",
        );
      const buildRows =
        row && row.kind === "build"
          ? [row]
          : model.rows.filter(
              (r) => r.kind === "build" && node && r.nodeId === node.id,
            );
      const phases = buildRows
        .flatMap((r) => r.intervals.flatMap((s) => array(s.phases)))
        .sort((a, b) => a.start - b.start);
      if (phases.length) {
        const phasesSection = section("Observed build phases"),
          phaseTotal = phases.reduce((sum, p) => sum + p.end - p.start, 0);
        const showPhases = (limit) => {
          const body = el("div");
          for (const p of phases.slice(0, limit)) {
            const line = button("", "phase-list-row", () => {
              setTab("timeline");
              const padding = Math.max(0.1, (p.end - p.start) * 0.1);
              setWindow(p.start - padding, p.end + padding);
            });
            line.title = `Focus ${p.name || "phase"} in the waterfall`;
            appendText(line, "span", "", p.name || "Unnamed phase");
            appendText(
              line,
              "span",
              "phase-duration",
              duration(p.end - p.start),
            );
            body.append(line);
            const track = el("div", "phase-track"),
              fill = el("div", "phase-fill");
            fill.style.width = `${((p.end - p.start) / Math.max(0.001, phaseTotal)) * 100}%`;
            track.append(fill);
            body.append(track);
          }
          if (phases.length > limit)
            body.append(
              button(
                `Show all ${count(phases.length)} phases`,
                "more-button",
                () => {
                  body.replaceWith(showPhases(phases.length));
                },
              ),
            );
          return body;
        };
        phasesSection.append(showPhases(12));
        appendText(
          phasesSection,
          "p",
          "",
          "Elapsed between phase notifications; the last phase ends at the observed activity stop. Repeated phases may belong to retries.",
        );
      }
      if (node) {
        const flow = section("Dependency neighborhood", "dependencies"),
          inputNodes = node.inputs.filter((x) => x && string(x.drvPath));
        const linkList = (parent, values, render, limit = 8) => {
          const list = el("div");
          for (const value of values.slice(0, limit))
            list.append(render(value));
          if (values.length > limit)
            list.append(
              button(
                `Show ${count(values.length - limit)} more`,
                "more-button",
                () => {
                  list.replaceWith(
                    linkList(parent, values, render, values.length),
                  );
                },
              ),
            );
          return list;
        };
        const nodeLink = (id, subtitle) => {
          const target = model.nodes.get(id);
          const b = button(
            target ? target.attrs[0] || target.name : shortName(id),
            "flow-node",
            () => {
              if (!model.nodes.has(id))
                model.nodes.set(id, {
                  id,
                  name: shortName(id),
                  attrs: [],
                  neededBy: [],
                  inputs: [],
                  outputs: [],
                  state: "unobserved",
                  root: false,
                });
              select(id, null);
            },
          );
          if (subtitle) appendText(b, "small", "", subtitle);
          return b;
        };
        appendText(
          flow,
          "div",
          "flow-label",
          `${count(inputNodes.length)} recorded direct inputs`,
        );
        if (inputNodes.length)
          flow.append(
            linkList(flow, inputNodes, (edge) =>
              nodeLink(
                edge.drvPath,
                `Outputs: ${strings(edge.outputs).join(", ") || "unspecified"}`,
              ),
            ),
          );
        else
          appendText(
            flow,
            "p",
            "",
            "No direct input edges recorded for this node.",
          );
        appendText(flow, "div", "flow-arrow", "↓");
        appendText(
          flow,
          "div",
          "flow-node flow-selected",
          node.attrs[0] || node.name,
        );
        appendText(flow, "div", "flow-arrow", "↓");
        const consumers = unique(
          (row ? row.neededBy : []).concat(node.neededBy),
        );
        appendText(
          flow,
          "div",
          "flow-label",
          `${count(consumers.length)} requested consumers`,
        );
        if (consumers.length)
          flow.append(
            linkList(flow, consumers, (attr) => {
              const b = nodeLink(model.byAttr.get(attr) || attr);
              b.firstChild.textContent = attr;
              return b;
            }),
          );
        else
          appendText(
            flow,
            "p",
            "",
            node.root
              ? "This node is itself a requested package."
              : "No root attribution recorded. Cached branches may be pruned.",
          );
        const parents = model.parents.get(node.id) || [];
        if (parents.length) {
          appendText(
            flow,
            "div",
            "flow-label",
            "Direct dependents in this plan",
          );
          flow.append(linkList(flow, parents, (id) => nodeLink(id), 5));
        }
        if (node.job && node.job.failure) {
          const failure = section("Why this package failed");
          appendText(
            failure,
            "p",
            "",
            object(node.job.failure).message || "A required dependency failed.",
          );
          for (const id of strings(object(node.job.failure).dependencyPath))
            failure.append(nodeLink(id));
        }
        const reproduction =
          string(node.job && node.job.reproduction) ||
          (node.id.endsWith(".drv")
            ? `nix build -L --no-link '${node.id.replace(/'/g, "'\\''")}^*'`
            : "");
        if (reproduction) {
          const repro = section("Reproduce", "metadata");
          appendText(repro, "pre", "code-block", reproduction);
          repro.append(
            button("Copy command", "button secondary compact", () =>
              copy(reproduction),
            ),
          );
        }
        const details = section("Identity & outputs", "metadata");
        appendText(details, "pre", "code-block", node.id);
        details.append(button("Copy path", "text-button", () => copy(node.id)));
        if (node.system)
          appendText(details, "p", "", `Build platform: ${node.system}`);
        if (node.attrs.length)
          appendText(details, "p", "", `Attributes: ${node.attrs.join(", ")}`);
        if (node.outputs.length) {
          const list = el("details");
          appendText(
            list,
            "summary",
            "",
            `${count(node.outputs.length)} recorded outputs`,
          );
          for (const path of node.outputs)
            appendText(list, "pre", "code-block", path);
          details.append(list);
        }
      }
      showDetail(state.inspectorTab);
    }
    function renderDiagnostics() {
      const container = $("diagnostics-list");
      container.replaceChildren();
      const query = Query.compile(state.search);
      const diagnostics = model.diagnostics.filter(
        (d) =>
          query.match(diagnosticQueryRow(d)) &&
          stateMatches(diagnosticQueryRow(d).state, state.outcome),
      );
      if (!diagnostics.length) {
        empty(
          container,
          model.diagnostics.length
            ? "No diagnostics match your search"
            : "No recorded failures or warnings",
          model.diagnostics.length
            ? "Try a different name or clear the search field."
            : "The run has no reported root failures, evaluation errors, or cache sync failures.",
        );
        return;
      }
      const size = 25,
        pages = Math.ceil(diagnostics.length / size);
      state.diagnosticPage = Math.min(state.diagnosticPage, pages - 1);
      for (const d of diagnostics.slice(
        state.diagnosticPage * size,
        (state.diagnosticPage + 1) * size,
      )) {
        const card = el(
          "article",
          `diagnostic-card${d.severity === "warning" ? " warning" : ""}`,
        );
        appendText(card, "div", "eyebrow", d.type);
        appendText(card, "h3", "", d.name);
        appendText(card, "p", "", diagnosticCause(d.message));
        if (d.message.length > 250 || d.excerpt) {
          const details = el("details");
          appendText(details, "summary", "", "Diagnostic details");
          appendText(
            details,
            "pre",
            "code-block diagnostic-detail",
            [d.message, d.excerpt].filter(Boolean).join("\n\n"),
          );
          card.append(details);
        }
        if (array(d.affected).length)
          appendText(card, "p", "", `Affected: ${d.affected.join(", ")}`);
        const actions = el("div", "detail-actions");
        if (d.nodeId)
          actions.append(
            button("Inspect dependency", "button secondary compact", () =>
              select(d.nodeId, null),
            ),
          );
        linkLog(actions, d.logPath);
        card.append(actions);
        container.append(card);
      }
      if (pages > 1) {
        const pager = el("div", "diagnostic-pagination");
        const previous = button("← Previous", "button compact", () => {
          state.diagnosticPage--;
          renderDiagnostics();
        });
        previous.disabled = state.diagnosticPage === 0;
        const next = button("Next →", "button compact", () => {
          state.diagnosticPage++;
          renderDiagnostics();
        });
        next.disabled = state.diagnosticPage >= pages - 1;
        pager.append(
          previous,
          el("span", "", `Page ${state.diagnosticPage + 1} of ${pages}`),
          next,
        );
        container.append(pager);
      }
    }
    function diagnosticQueryRow(d) {
      return {
        name: d.name,
        search: [d.name, d.message, d.excerpt, ...array(d.affected)]
          .join(" ")
          .toLowerCase(),
        neededBy: array(d.affected),
        state: d.severity === "error" ? "failed" : "warning",
        kind:
          d.type === "Evaluation error"
            ? "evaluation"
            : d.type === "Cache sync failed"
              ? "upload"
              : d.type === "Root failure"
                ? "build"
                : "",
        seconds: null,
      };
    }
    function renderKindFilters(query = Query.compile(state.search)) {
      const container = $("kind-filters"),
        focus = focusedKey(container);
      container.replaceChildren();
      const candidates = filterRows(model, {
        query,
        state: state.outcome,
        start: state.from,
        end: state.to,
        focus: state.focus,
      });
      const kindTerms = query.terms.filter((term) => term.field === "kind"),
        kindQuery = Query.compile(kindTerms.map((term) => term.raw).join(" "));
      for (const [kind, info] of Object.entries(KINDS)) {
        if (!model.rows.some((r) => r.kind === kind)) continue;
        const b = button("", "kind-toggle", (event) => {
          if (kindTerms.length) {
            state.kinds = new Set(
              Object.keys(KINDS).filter((k) => kindQuery.match({ kind: k })),
            );
            for (let i = query.terms.length - 1; i >= 0; i--)
              if (query.terms[i].field === "kind")
                state.search = Query.removeTerm(state.search, i);
            $("search").value = state.search;
          }
          if (event.altKey) state.kinds = new Set([kind]);
          else if (state.kinds.has(kind)) state.kinds.delete(kind);
          else state.kinds.add(kind);
          refilter(true);
        });
        appendText(b, "span", "facet-label", info.short);
        appendText(
          b,
          "span",
          "facet-count",
          count(candidates.filter((r) => r.kind === kind).length),
        );
        b.dataset.focusKey = kind;
        b.setAttribute(
          "aria-pressed",
          String(
            kindTerms.length
              ? kindQuery.match({ kind })
              : state.kinds.has(kind),
          ),
        );
        b.title = `${info.label} · Alt-click to show only this type`;
        setKind(b, kind);
        container.append(b);
      }
      restoreFocus(container, focus);
    }
    function drawOverview() {
      const canvas = $("overview-canvas"),
        width = canvas.clientWidth,
        height = canvas.clientHeight;
      if (!width || !height) return;
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      const css = global.getComputedStyle(document.documentElement),
        maximum = Math.max(
          1,
          model.stats.builds.peak,
          model.stats.downloads.peak,
        );
      ctx.strokeStyle = css.getPropertyValue("--border").trim();
      ctx.lineWidth = 1;
      for (let y = 1; y <= 3; y++) {
        ctx.beginPath();
        ctx.moveTo(0, height - (y * (height - 12)) / 3);
        ctx.lineTo(width, height - (y * (height - 12)) / 3);
        ctx.stroke();
      }
      for (const kind of ["download", "build"]) {
        const points =
          kind === "build"
            ? model.stats.builds.steps
            : model.stats.downloads.steps;
        const shade = css.getPropertyValue(KINDS[kind].color).trim();
        ctx.beginPath();
        ctx.moveTo(0, height);
        let last = 0;
        for (const point of points) {
          const x = ((point.time - model.start) / model.extent) * width;
          ctx.lineTo(x, height - (last / maximum) * (height - 10));
          ctx.lineTo(x, height - (point.value / maximum) * (height - 10));
          last = point.value;
        }
        ctx.lineTo(width, height);
        ctx.closePath();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = shade;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        last = 0;
        ctx.moveTo(0, height);
        for (const point of points) {
          const x = ((point.time - model.start) / model.extent) * width;
          ctx.lineTo(x, height - (last / maximum) * (height - 10));
          ctx.lineTo(x, height - (point.value / maximum) * (height - 10));
          last = point.value;
        }
        ctx.strokeStyle = shade;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.fillStyle = css.getPropertyValue("--muted").trim();
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText(String(maximum), 5, 12);
      $("overview-empty").hidden =
        model.stats.builds.peak + model.stats.downloads.peak > 0;
    }
    function renderOverview() {
      const s = model.stats,
        snapshot = model.snapshot,
        context = model.context;
      const title =
        string(context.flake).replace(/^\.?#/, "") || "Build report";
      $("run-title").textContent = title;
      document.title = `${title} · Build explorer`;
      const meta = $("run-meta");
      const platforms = unique(model.jobs.map((n) => n.system).filter(Boolean));
      for (const text of [
        string(context.repository || context.repo),
        platforms.join(", "),
        number(context.startedAt) !== null
          ? new Date(context.startedAt * 1000).toLocaleString()
          : "",
        context.runAttempt ? `Attempt ${context.runAttempt}` : "",
      ])
        if (text) appendText(meta, "span", "", text);
      if (string(context.gitSha))
        appendText(meta, "span", "meta-sha", context.gitSha.slice(0, 8));
      const status = string(snapshot.status) || "partial";
      $("run-status").textContent =
        status === "success"
          ? "Completed successfully"
          : status === "failed"
            ? "Completed with failures"
            : status === "planned"
              ? "Plan only"
              : status;
      if (/^[a-z-]+$/.test(status))
        $("run-status").classList.add(`status-${status}`);
      const url = safeUrl(context.runUrl);
      if (url) {
        $("run-link").href = url;
        $("run-link").hidden = false;
      }
      const metrics = [
        [
          "Run wall time",
          duration(model.span),
          "Evaluation through final snapshot",
        ],
        [
          "Root derivations",
          `${count(s.complete)} / ${count(s.roots)}`,
          `${count(s.attrs)} evaluated attributes${s.aliases ? ` · ${count(s.aliases)} aliases` : ""}`,
        ],
        [
          "Cached roots",
          count(s.cached),
          s.roots
            ? `${((s.cached / s.roots) * 100).toFixed(1)}% of requested derivations`
            : "No requested derivations decoded",
        ],
        [
          "Observed builds",
          count(s.buildCount),
          `${duration(s.builds.busy)} with ≥1 build lane active`,
        ],
        [
          "Download window",
          duration(s.downloads.busy),
          `${count(s.downloads.peak)} peak concurrent download lanes`,
        ],
        [
          "Peak build lanes",
          count(s.builds.peak),
          "Distinct build derivations in flight",
        ],
      ];
      for (const [label, value, sub] of metrics) {
        const box = el("div", "metric");
        appendText(box, "div", "metric-label", label);
        appendText(box, "div", "metric-value", value);
        appendText(box, "div", "metric-sub", sub);
        $("metrics").append(box);
      }
      const insights = $("insights");
      const insight = (icon, title, text, action) => {
        const card = action
          ? button("", "insight", action)
          : el("div", "insight");
        appendText(card, "span", "insight-icon", icon);
        const content = el("div");
        appendText(content, "strong", "", title);
        appendText(content, "p", "", text);
        card.append(content);
        insights.append(card);
      };
      const errors = model.diagnostics.filter((d) => d.severity === "error");
      if (errors.length)
        insight(
          "!",
          `${count(errors.length)} diagnostics need attention`,
          `${count(s.failed)} requested derivations failed or blocked. Start with the recorded root causes.`,
          () => setTab("diagnostics"),
        );
      else if (model.buildRows.length) {
        const longest = model.buildRows[0];
        insight(
          "↗",
          "Longest observed build",
          `${longest.name} · ${duration(longest.seconds)}${longest.estimated ? " inferred span" : " observed activity"}. Inspect its phases and consumers.`,
          () => focusActivity(longest),
        );
      } else
        insight(
          "✓",
          s.roots && s.cached === s.roots
            ? "Everything requested was cached"
            : "No builder activity recorded",
          s.roots
            ? "Explore the requested packages and cache outcomes below."
            : "This report may be incomplete or contain evaluation errors.",
          () => setTab("packages"),
        );
      const busy = model.stats.builds.busy;
      insight(
        "≋",
        "Parallelism at a glance",
        busy
          ? `${count(s.builds.peak)} build lanes at peak; ${s.builds.average.toFixed(1)} active on average across the whole run. Brush the overview to inspect a quieter stretch.`
          : "No timed builds to compare. Cache reuse and evaluation can still account for run time.",
      );
      const finishedRequests = model.rows.filter(
        (r) => r.kind === "request" && !r.open,
      );
      const lastRoot = finishedRequests.reduce(
        (last, r) => Math.max(last, r.end),
        model.start,
      );
      const tail = model.rows
        .filter((r) => ["upload", "import"].includes(r.kind))
        .flatMap((r) =>
          r.intervals.map((i) => ({
            start: Math.max(i.start, lastRoot),
            end: i.end,
          })),
        );
      const allRequestsFinished =
        model.jobs.every((n) => !["queued", "submitted"].includes(n.state)) &&
        !model.rows.some((r) => r.kind === "request" && r.open);
      const tailSeconds =
        finishedRequests.length && allRequestsFinished
          ? intervalSeconds(tail)
          : 0;
      if (tailSeconds > 0.1)
        insight(
          "↑",
          "Cache work after the last request",
          `${duration(tailSeconds)} of observed sync/import work remained after requested builds finished. Successful sync can be a no-op.`,
          () => {
            state.kinds = new Set(["upload", "import"]);
            renderKindFilters();
            setTab("timeline");
            setWindow(lastRoot, model.end);
          },
        );
      else if (s.imported)
        insight(
          "↙",
          "Outputs reused during this run",
          `${count(s.imported)} derivations imported after they became available in a cache.`,
          () => {
            state.kinds = new Set(["import"]);
            renderKindFilters();
            refilter(true);
          },
        );
      else
        insight(
          "⌁",
          "Follow the dependency path",
          "Select a build to see its requested consumers and recorded direct inputs. The plan prunes already cached branches.",
        );
      $("package-count").textContent = count(s.roots);
      $("diagnostic-count").textContent = count(model.diagnostics.length);
      const pipeline = $("pipeline"),
        stages = [];
      for (const kind of ["evaluation", "planning"])
        for (const row of model.rows.filter((r) => r.kind === kind))
          for (const interval of row.intervals)
            stages.push({ kind, name: KINDS[kind].label, ...interval });
      const requests = model.rows.filter((r) => r.kind === "request");
      if (requests.length)
        stages.push({
          kind: "build",
          name: "Build requests",
          start: requests.reduce((a, r) => Math.min(a, r.start), model.end),
          end: requests.reduce((a, r) => Math.max(a, r.end), model.start),
        });
      stages.sort((a, b) => a.start - b.start);
      let cursor = model.start;
      const addStage = (stage) => {
        const stageStart = Math.max(cursor, stage.start),
          stageEnd = Math.max(stageStart, stage.end);
        if (stageEnd <= stageStart) return;
        const b = button(
          `${stage.name} · ${duration(stageEnd - stageStart)}`,
          "stage",
          () => setWindow(stageStart, stageEnd),
        );
        setKind(b, stage.kind);
        b.style.flex = `${(stageEnd - stageStart) / model.extent} 1 0`;
        b.title = `${stage.name}: ${duration(stageEnd - stageStart)}${stage.estimated ? " (inferred boundaries)" : ""}`;
        pipeline.append(b);
        cursor = stageEnd;
      };
      for (const stage of stages) {
        if (stage.start - cursor > 0.1)
          addStage({
            kind: "request",
            name: "Other",
            start: cursor,
            end: stage.start,
          });
        addStage(stage);
      }
      if (model.end - cursor > 0.1)
        addStage({
          kind: "upload",
          name: requests.length ? "Finishing" : "Other recorded time",
          start: cursor,
          end: model.end,
        });
      if (!pipeline.children.length)
        appendText(pipeline, "span", "stage", "No timed stages recorded");
      const contextGrid = el("dl", "context-grid");
      for (const [key, value] of Object.entries(context))
        if (value !== null && value !== "" && typeof value !== "object") {
          const item = el("div");
          appendText(item, "dt", "", key);
          appendText(item, "dd", "", String(value));
          contextGrid.append(item);
        }
      $("context-content").append(contextGrid);
      $("generated-note").textContent =
        `${count(model.events.length)} recorded events · no network requests`;
    }
    $("search").addEventListener("input", (event) => {
      updateSearch(event.target.value);
    });
    $("state-filter").addEventListener("change", (event) => {
      state.outcome = event.target.value;
      refilter(true);
    });
    $("timeline-sort").addEventListener("change", (event) => {
      state.sort = event.target.value;
      refilter(true);
    });
    $("package-sort").addEventListener("change", (event) => {
      state.packageSort = event.target.value;
      refilter(true);
    });
    for (const name of ["timeline", "packages", "diagnostics"])
      $("tab-" + name).addEventListener("click", () => setTab(name));
    document
      .querySelector("[role=tablist]")
      .addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        const names = ["timeline", "packages", "diagnostics"],
          index = names.indexOf(state.tab);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? 2
              : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
        setTab(names[next]);
        $("tab-" + names[next]).focus();
        event.preventDefault();
      });
    function resetFilters() {
      state.search = "";
      state.outcome = "all";
      state.focus = null;
      state.kinds = new Set(DEFAULT_KINDS);
      $("search").value = "";
      $("state-filter").value = "all";
      renderKindFilters();
      setWindow(model.start, model.end);
      refilter(true);
    }
    $("clear-filters").addEventListener("click", resetFilters);
    $("facet-reset").addEventListener("click", resetFilters);
    $("copy-view").addEventListener("click", () =>
      copy(global.location.href.split("#")[0] + viewFragment(state, model)),
    );
    $("clear-focus").addEventListener("click", () => {
      state.focus = null;
      refilter(true);
    });
    $("zoom-in").addEventListener("click", () => zoom(0.5));
    $("zoom-out").addEventListener("click", () => zoom(2));
    $("zoom-fit").addEventListener("click", () =>
      setWindow(model.start, model.end),
    );
    $("window-start").addEventListener("input", (event) =>
      setWindow(
        Math.min(
          model.start + (Number(event.target.value) / 1000) * model.extent,
          state.to - model.extent / 1000,
        ),
        state.to,
      ),
    );
    $("window-end").addEventListener("input", (event) =>
      setWindow(
        state.from,
        Math.max(
          model.start + (Number(event.target.value) / 1000) * model.extent,
          state.from + model.extent / 1000,
        ),
      ),
    );
    let drag = null;
    const pointerTime = (event) => {
      const rect = $("overview").getBoundingClientRect();
      return (
        model.start +
        clamp((event.clientX - rect.left) / rect.width, 0, 1) * model.extent
      );
    };
    $("overview").addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      drag = {
        time: pointerTime(event),
        x: event.clientX,
        from: state.from,
        to: state.to,
        moved: false,
      };
      $("overview").setPointerCapture(event.pointerId);
    });
    $("overview").addEventListener("pointermove", (event) => {
      if (drag && (drag.moved || Math.abs(event.clientX - drag.x) >= 4)) {
        drag.moved = true;
        setWindow(drag.time, pointerTime(event));
      }
    });
    $("overview").addEventListener("pointerup", (event) => {
      if (drag !== null) {
        const current = pointerTime(event);
        if (!drag.moved) {
          const width = drag.to - drag.from;
          const start = clamp(
            current - width / 2,
            model.start,
            model.end - width,
          );
          setWindow(start, start + width);
        } else setWindow(drag.time, current);
        drag = null;
      }
    });
    $("overview").addEventListener("pointercancel", () => {
      drag = null;
    });
    const waterfall = $("timeline-scroll"),
      shell = waterfall.parentElement;
    const cursor = el("div", "time-cursor"),
      cursorLabel = el("span", "time-cursor-label");
    cursor.append(cursorLabel);
    cursor.hidden = true;
    cursor.setAttribute("aria-hidden", "true");
    shell.append(cursor);
    const tooltip = el("div", "activity-tooltip");
    tooltip.hidden = true;
    tooltip.setAttribute("aria-hidden", "true");
    document.body.append(tooltip);
    const hideCursor = () => {
      cursor.hidden = true;
      tooltip.hidden = true;
    };
    let pan = null;
    waterfall.addEventListener("pointermove", (event) => {
      if (pan) {
        const delta =
          ((pan.x - event.clientX) / pan.width) * (pan.to - pan.from);
        const a = clamp(
          pan.from + delta,
          model.start,
          model.end - (pan.to - pan.from),
        );
        setWindow(a, a + pan.to - pan.from);
        hideCursor();
        return;
      }
      const chart = event.target.closest(".row-chart");
      if (!chart) {
        hideCursor();
        return;
      }
      const rect = chart.getBoundingClientRect(),
        outer = shell.getBoundingClientRect();
      const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const time = state.from + fraction * (state.to - state.from);
      cursor.style.left = `${event.clientX - outer.left}px`;
      cursor.style.top = `${waterfall.offsetTop}px`;
      cursor.hidden = false;
      cursorLabel.textContent = `+${duration(time - model.start)}`;
      const row = model.rowMap.get(chart.closest("[data-row]").dataset.row);
      const interval = event.target.closest(".interval");
      if (!row || !interval) {
        tooltip.hidden = true;
        return;
      }
      const segment = row.intervals[Number(interval.dataset.segment)];
      tooltip.replaceChildren();
      appendText(tooltip, "strong", "", row.name);
      appendText(
        tooltip,
        "div",
        "",
        `${KINDS[row.kind].label} · ${duration(segment.end - segment.start)} · ${row.state}`,
      );
      appendText(
        tooltip,
        "div",
        "",
        `+${duration(segment.start - model.start)} → +${duration(segment.end - model.start)}`,
      );
      const phase = array(segment.phases).find(
        (p) => p.start <= time && p.end >= time,
      );
      if (phase)
        appendText(
          tooltip,
          "div",
          "",
          `${phase.name} · ${duration(phase.end - phase.start)}`,
        );
      if (segment.estimated)
        appendText(tooltip, "small", "", "Inferred timing");
      tooltip.hidden = false;
      const bounds = tooltip.getBoundingClientRect();
      tooltip.style.left = `${clamp(event.clientX + 14, 8, global.innerWidth - bounds.width - 8)}px`;
      tooltip.style.top = `${clamp(event.clientY + 16, 8, global.innerHeight - bounds.height - 8)}px`;
    });
    waterfall.addEventListener("pointerleave", hideCursor);
    waterfall.addEventListener("scroll", hideCursor, { passive: true });
    waterfall.addEventListener("pointerdown", (event) => {
      const chart = event.target.closest(".row-chart");
      if (event.button !== 0 || !chart || event.target.closest("button"))
        return;
      pan = {
        x: event.clientX,
        from: state.from,
        to: state.to,
        width: chart.getBoundingClientRect().width,
      };
      waterfall.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
      waterfall.addEventListener(event, () => {
        pan = null;
      });
    waterfall.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        const chart = waterfall.querySelector(".row-chart");
        if (!chart) return;
        event.preventDefault();
        hideCursor();
        const rect = chart.getBoundingClientRect();
        const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        const anchor = state.from + fraction * (state.to - state.from);
        const width = clamp(
          (state.to - state.from) *
            Math.exp(clamp(event.deltaY, -100, 100) * 0.01),
          model.extent / 1000,
          model.extent,
        );
        const a = clamp(
          anchor - width * fraction,
          model.start,
          model.end - width,
        );
        setWindow(a, a + width);
      },
      { passive: false },
    );
    for (const id of ["timeline-scroll", "package-scroll"])
      $(id).addEventListener(
        "scroll",
        () => {
          if (!pendingFrame) {
            pendingFrame = true;
            global.requestAnimationFrame(() => {
              pendingFrame = false;
              renderVisible();
            });
          }
        },
        { passive: true },
      );
    for (const [viewId, contentId, rowHeight, getRows] of [
      [
        "timeline-scroll",
        "timeline-rows",
        TIMELINE_ROW_HEIGHT,
        () => filteredRows,
      ],
      [
        "package-scroll",
        "package-rows",
        PACKAGE_ROW_HEIGHT,
        () => filteredPackages,
      ],
    ]) {
      $(viewId).addEventListener("keydown", (event) => {
        if (
          !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) ||
          event.altKey ||
          event.metaKey ||
          event.ctrlKey
        )
          return;
        const rows = getRows();
        if (!rows.length) return;
        const current = document.activeElement.closest("[data-index]"),
          index = current
            ? Number(current.dataset.index)
            : Math.floor($(viewId).scrollTop / rowHeight) - 1;
        const target = clamp(
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : index + (event.key === "ArrowDown" ? 1 : -1),
          0,
          rows.length - 1,
        );
        const top = target * rowHeight,
          viewport = $(viewId);
        if (top < viewport.scrollTop) viewport.scrollTop = top;
        if (top + rowHeight > viewport.scrollTop + viewport.clientHeight)
          viewport.scrollTop = top + rowHeight - viewport.clientHeight;
        renderVisible();
        const wrapper = $(contentId).querySelector(`[data-index="${target}"]`),
          control =
            wrapper &&
            (wrapper.tagName === "BUTTON"
              ? wrapper
              : wrapper.querySelector("button"));
        if (control) control.focus({ preventScroll: true });
        event.preventDefault();
      });
    }
    document.addEventListener("keydown", (event) => {
      if (
        event.key === "/" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(
          document.activeElement.tagName,
        )
      ) {
        event.preventDefault();
        $("search").focus();
      }
      if (event.key === "Escape") {
        const wasInside = $("inspector").contains(document.activeElement);
        state.selection = null;
        renderInspector();
        renderVisible();
        saveView();
        if (wasInside) $("tab-" + state.tab).focus({ preventScroll: true });
      }
    });
    const initialTheme =
      global.matchMedia &&
      global.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    document.documentElement.dataset.theme = initialTheme;
    $("theme-toggle").addEventListener("click", () => {
      document.documentElement.dataset.theme =
        document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      drawOverview();
    });
    global.addEventListener("resize", () => {
      drawOverview();
      renderVisible();
    });
    function restoreView() {
      restoringView = true;
      const saved =
        readView(global.location.hash, model) ||
        readView("#view=timeline", model);
      Object.assign(state, saved);
      $("search").value = state.search;
      $("state-filter").value = state.outcome;
      $("timeline-sort").value = state.sort;
      $("package-sort").value = state.packageSort;
      setWindow(state.from, state.to);
      setTab(state.tab);
      renderInspector();
      if (state.selection) {
        const isTimeline = state.tab === "timeline";
        const index = isTimeline
          ? filteredRows.findIndex((r) => r.id === state.selection.rowId)
          : filteredPackages.findIndex((n) => n.id === state.selection.nodeId);
        if (index >= 0) {
          $(isTimeline ? "timeline-scroll" : "package-scroll").scrollTop =
            index * (isTimeline ? TIMELINE_ROW_HEIGHT : PACKAGE_ROW_HEIGHT);
          renderVisible();
        }
      }
      restoringView = false;
    }
    global.addEventListener("hashchange", () => {
      if (!global.location.hash || readView(global.location.hash, model))
        restoreView();
    });
    document.querySelector(".skip-link").addEventListener("click", (event) => {
      event.preventDefault();
      $("workspace").tabIndex = -1;
      $("workspace").focus();
      $("workspace").scrollIntoView({ block: "start" });
    });
    if (global.innerWidth <= 700) $("facet-disclosure").open = false;
    renderOverview();
    restoreView();
    drawOverview();
    // A small read-only handle supports deterministic browser checks and makes
    // it possible to inspect the loaded model without any server or framework.
    global.NixBuildReport = Object.freeze({
      model,
      state,
      select,
      setTab,
      setWindow,
    });
  }
  const api = {
    buildModel,
    mergeIntervals,
    intervalSeconds,
    concurrency,
    filterRows,
    visibleRange,
    safeLog,
    safeUrl,
    diagnosticCause,
    duration,
    bytes,
    viewFragment,
    readView,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document !== "undefined") {
    try {
      boot(document);
    } catch (error) {
      const message = document.createElement("p");
      message.className = "fatal-message";
      message.textContent =
        "The interactive view could not be initialized. The full run remains available in results.json and summary.md. " +
        String(error.message || error);
      document.body.append(message);
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
