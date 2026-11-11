"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const report = require("./app.js");
const query = require("./query.js");

const drv = (name) => `/nix/store/${"a".repeat(32)}-${name}.drv`;
const output = (name) => `/nix/store/${"b".repeat(32)}-${name}`;
const job = (name, extra = {}) => ({
  drvPath: drv(name),
  name,
  attrs: [name],
  state: "built",
  queuedAt: 100,
  startedAt: 102,
  finishedAt: 120,
  ...extra,
});
const event = (type, time, extra = {}) => ({ type, time, ...extra });
const envelope = (snapshot = {}, events = []) => ({
  snapshot: {
    context: { startedAt: 100, finishedAt: 120 },
    jobs: [],
    derivations: [],
    ...snapshot,
  },
  events,
});
const activity = (type, time, name, id, kind = "build", extra = {}) =>
  event(type, time, {
    drvPath: drv(name),
    name,
    activityId: id,
    requestId: "r",
    activityKind: kind,
    ...extra,
  });

test("precise IDs keep overlapping requests and phases distinct, with union concurrency", () => {
  const model = report.buildModel(
    envelope(
      {
        jobs: [job("app")],
        derivations: [
          {
            drvPath: drv("dep"),
            name: "dep",
            state: "built",
            neededBy: ["app"],
          },
        ],
      },
      [
        activity("activity-start", 102, "dep", "a"),
        activity("activity-start", 104, "dep", "b"),
        activity("phase", 105, "dep", "a", "build", { phase: "buildPhase" }),
        activity("phase", 106, "dep", "b", "build", { phase: "checkPhase" }),
        activity("activity-stop", 108, "dep", "a"),
        activity("activity-stop", 111, "dep", "b"),
      ],
    ),
  );
  const row = model.rows.find((r) => r.kind === "build");
  assert.equal(row.intervals.length, 2);
  assert.equal(row.seconds, 9);
  assert.equal(row.estimated, false);
  assert.deepEqual(
    row.intervals.map((s) => s.phases.map((p) => p.name)),
    [["buildPhase"], ["checkPhase"]],
  );
  assert.deepEqual(
    row.intervals.map((s) => s.phases.map((p) => p.end - p.start)),
    [[3], [5]],
  );
  assert.equal(
    model.stats.builds.peak,
    1,
    "duplicate requests for one lane must not inflate build concurrency",
  );
  assert.equal(model.stats.builds.busy, 9);
});

test("distinct output download lanes remain separate with exact event paths", () => {
  const model = report.buildModel(
    envelope({}, [
      activity("activity-start", 102, "dep", "out", "download", {
        path: output("dep"),
      }),
      activity("activity-start", 103, "dep", "dev", "download", {
        path: output("dep-dev"),
      }),
      activity("activity-stop", 107, "dep", "out", "download", {
        path: output("dep"),
      }),
      activity("activity-stop", 109, "dep", "dev", "download", {
        path: output("dep-dev"),
      }),
    ]),
  );
  assert.equal(model.rows.filter((r) => r.kind === "download").length, 2);
  assert.deepEqual(
    model.rows.filter((r) => r.kind === "download").map((r) => r.name),
    ["dep", "dep-dev"],
  );
  assert.equal(model.stats.downloads.peak, 2);
  assert.equal(model.stats.downloads.busy, 7);
});

test("legacy aggregate activity creates an explicitly inferred window", () => {
  const base = { drvPath: drv("old"), name: "old" };
  const model = report.buildModel(
    envelope({}, [
      event("activity-start", 102, {
        ...base,
        state: "downloading",
        active: 1,
      }),
      event("activity-start", 103, {
        ...base,
        state: "downloading",
        active: 2,
      }),
      event("activity-stop", 105, { ...base, state: "downloading", active: 1 }),
      event("activity-stop", 110, { ...base, state: "finished", active: 0 }),
    ]),
  );
  const row = model.rows[0];
  assert.equal(row.kind, "download");
  assert.equal(row.estimated, true);
  assert.equal(row.intervals.length, 1);
  assert.equal(row.seconds, 8);
  assert.equal(row.open, false);
});

test("partial cancellation caps an unmatched activity at snapshot finish", () => {
  const model = report.buildModel(
    envelope(
      {
        status: "cancelled",
        derivations: [
          {
            drvPath: drv("dep"),
            startedAt: 103,
            finishedAt: 112,
            state: "cancelled",
          },
        ],
      },
      [activity("activity-start", 103, "dep", "unfinished")],
    ),
  );
  const row = model.rows[0];
  assert.equal(row.end, 112);
  assert.equal(row.open, true);
  assert.equal(row.seconds, 9);
  assert.equal(row.state, "cancelled");
});

test("old snapshot-only reports avoid inventing an exact phase timeline", () => {
  const model = report.buildModel(
    envelope({
      derivations: [
        {
          drvPath: drv("dep"),
          startedAt: 103,
          finishedAt: 118,
          buildSeconds: 7,
          phase: "fixupPhase",
          state: "built",
        },
      ],
    }),
  );
  const row = model.rows[0];
  assert.equal(row.seconds, 15);
  assert.equal(row.estimated, true);
  assert.deepEqual(row.intervals[0].phases, []);
});

test("cached roots and null timestamps do not become timed builds", () => {
  const model = report.buildModel(
    envelope({
      jobs: [
        job("cached", {
          state: "cached",
          startedAt: null,
          finishedAt: 101,
          attrs: ["cached", "alias"],
        }),
      ],
      derivations: [
        {
          drvPath: drv("unused"),
          startedAt: null,
          finishedAt: null,
          seconds: 0,
        },
      ],
      evaluation: {
        attrs: 3,
        errors: [{ attr: "bad", error: "error: missing dependency" }],
      },
    }),
  );
  assert.equal(model.rows.length, 0);
  assert.equal(model.stats.cached, 1);
  assert.equal(model.stats.aliases, 1);
  assert.equal(model.stats.attrs, 3);
  assert.equal(model.stats.roots, 1);
  assert.equal(model.diagnostics.length, 1);
});

test("stage events take precedence over legacy inferred durations", () => {
  const model = report.buildModel(
    envelope(
      {
        context: {
          startedAt: 100,
          finishedAt: 120,
          evaluationSeconds: 19,
          planningSeconds: 1,
        },
      },
      [
        event("stage", 102, { stage: "evaluation", state: "started" }),
        event("stage", 106, { stage: "evaluation", state: "finished" }),
        event("stage", 106, { stage: "planning", state: "started" }),
        event("stage", 110, { stage: "planning", state: "finished" }),
      ],
    ),
  );
  assert.deepEqual(
    model.rows.map((r) => [r.kind, r.start, r.end, r.estimated]),
    [
      ["evaluation", 102, 106, false],
      ["planning", 106, 110, false],
    ],
  );
});

test("legacy stage boundaries end at the observed plan event", () => {
  const model = report.buildModel(
    envelope(
      {
        context: {
          startedAt: 100,
          finishedAt: 120,
          evaluationSeconds: 4,
          planningSeconds: 3,
        },
      },
      [event("plan", 110)],
    ),
  );
  assert.deepEqual(
    model.rows.map((r) => [r.kind, r.start, r.end]),
    [
      ["planning", 107, 110],
      ["evaluation", 103, 107],
    ],
  );
  assert.ok(model.rows.every((r) => r.estimated));
});

test("upload events use precise starts and flag older duration reconstruction", () => {
  const first = output("first"),
    second = output("second");
  const model = report.buildModel(
    envelope(
      {
        uploads: [
          { path: first, seconds: 3, logPath: "logs/a.log" },
          { path: second, seconds: 30 },
        ],
      },
      [
        event("upload-start", 106, { path: first }),
        event("upload", 109, { path: first, state: "uploaded" }),
        event("upload", 110, { path: second, state: "uploaded" }),
      ],
    ),
  );
  const exact = model.rowMap.get(`upload:${first}`),
    inferred = model.rowMap.get(`upload:${second}`);
  assert.equal(exact.start, 106);
  assert.equal(exact.estimated, false);
  assert.equal(exact.logPath, "logs/a.log");
  assert.equal(
    inferred.start,
    100,
    "an inferred start cannot precede this run",
  );
  assert.equal(inferred.end, 110);
  assert.equal(inferred.estimated, true);
});

test("multiple cache import attempts retain their actual intervals", () => {
  const id = drv("dep");
  const model = report.buildModel(
    envelope({}, [
      event("cache-import-start", 102, {
        drvPath: id,
        source: "file:///cache",
      }),
      event("cache-import-finished", 106, { drvPath: id, state: "cancelled" }),
      event("cache-import-start", 109, {
        drvPath: id,
        source: "file:///cache",
      }),
      event("cache-import-finished", 112, { drvPath: id, state: "imported" }),
    ]),
  );
  const row = model.rowMap.get(`import:${id}`);
  assert.equal(row.intervals.length, 2);
  assert.equal(row.seconds, 7);
  assert.equal(row.state, "imported");
});

test("snapshot terminal states close interrupted syncs and imports without pretending a stop event exists", () => {
  const path = output("cancelled"),
    id = drv("imported");
  const model = report.buildModel(
    envelope(
      {
        status: "cancelled",
        uploads: [
          {
            path,
            state: "cancelled",
            startedAt: 102,
            finishedAt: 111,
            logPath: "logs/cancelled.log",
          },
        ],
        cacheReuse: [
          {
            drvPath: id,
            state: "cancelled",
            startedAt: 104,
            finishedAt: 113,
            logPath: "logs/import.log",
          },
        ],
      },
      [
        event("upload-start", 102, { path }),
        event("cache-import-start", 104, { drvPath: id }),
      ],
    ),
  );
  const sync = model.rowMap.get(`upload:${path}`),
    imported = model.rowMap.get(`import:${id}`);
  assert.equal(sync.state, "cancelled");
  assert.equal(sync.end, 111);
  assert.equal(sync.open, true);
  assert.equal(sync.logPath, "logs/cancelled.log");
  assert.equal(imported.state, "cancelled");
  assert.equal(imported.end, 113);
  assert.equal(imported.open, true);
  assert.equal(imported.logPath, "logs/import.log");
});

test("legacy request waits cannot pair across simultaneous requests", () => {
  const model = report.buildModel(
    envelope({ jobs: [job("a"), job("b")] }, [
      event("request-wait", 102, {
        requestId: "a",
        drvs: [drv("a")],
        reason: "output lock",
      }),
      event("request-wait", 104, {
        requestId: "b",
        drvs: [drv("b")],
        reason: "build slot",
      }),
      event("request-wait-ended", 107, {
        requestId: "a",
        drvs: [drv("a")],
        seconds: 5,
      }),
      event("request-wait-ended", 110, {
        requestId: "b",
        drvs: [drv("b")],
        seconds: 6,
      }),
    ]),
  );
  const a = model.rowMap.get("wait:request:legacy:a"),
    b = model.rowMap.get("wait:request:legacy:b");
  assert.equal(a.start, 102);
  assert.equal(a.end, 107);
  assert.equal(a.nodeId, drv("a"));
  assert.equal(b.start, 104);
  assert.equal(b.end, 110);
  assert.equal(b.nodeId, drv("b"));
  assert.equal(a.estimated, true);
  assert.equal(b.estimated, true);
});

test("ambiguous old waits within one request use the recorded elapsed duration", () => {
  const model = report.buildModel(
    envelope({}, [
      event("request-wait", 102, { requestId: "a" }),
      event("request-wait", 104, { requestId: "a" }),
      event("request-wait-ended", 107, { requestId: "a", seconds: 3 }),
      event("request-wait-ended", 109, { requestId: "a", seconds: 7 }),
    ]),
  );
  const row = model.rowMap.get("wait:request:legacy:a");
  assert.deepEqual(
    row.intervals.map((s) => [s.start, s.end]),
    [
      [102, 109],
      [104, 107],
    ],
  );
  assert.equal(row.open, false);
  assert.equal(row.estimated, true);
});

test("dependency links, aliases, and consumer focus are preserved", () => {
  const dep = drv("dep"),
    app = drv("app");
  const model = report.buildModel(
    envelope(
      {
        jobs: [job("app", { attrs: ["app", "alias"] })],
        plan: {
          builds: [
            {
              drvPath: app,
              inputs: [{ drvPath: dep, outputs: ["dev"] }],
              outputs: { out: output("app") },
            },
          ],
        },
        derivations: [
          {
            drvPath: dep,
            neededBy: ["alias"],
            inputs: [{ drvPath: drv("tool"), outputs: ["out"] }],
            state: "built",
          },
        ],
      },
      [
        activity("activity-start", 103, "dep", "d"),
        activity("activity-stop", 107, "dep", "d"),
      ],
    ),
  );
  assert.deepEqual(model.nodes.get(app).inputs, [
    { drvPath: dep, outputs: ["dev"] },
  ]);
  assert.deepEqual(model.parents.get(dep), [app]);
  assert.equal(model.producers.get(output("app")), app);
  assert.ok(
    report.filterRows(model, { focus: app }).some((r) => r.nodeId === dep),
  );
  assert.equal(
    report.filterRows(model, {
      kinds: new Set(["build"]),
      search: "alias",
      start: 108,
      end: 120,
    }).length,
    0,
  );
});

test("past invocations in an append-only event log cannot contaminate the current report", () => {
  const model = report.buildModel(
    envelope({}, [
      activity("activity-start", 90, "old", "old"),
      activity("activity-stop", 95, "old", "old"),
      activity("activity-start", 105, "new", "new"),
      activity("activity-stop", 110, "new", "new"),
      activity("activity-start", 130, "future", "future"),
    ]),
  );
  assert.equal(model.events.length, 2);
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].name, "new");
  assert.equal(model.rows[0].open, false);
});

test("empty, old, and malformed optional data have bounded sensible defaults", () => {
  for (const value of [
    {},
    { snapshot: {} },
    { snapshot: null, events: [null, {}, { time: "100" }] },
    { snapshot: { jobs: null, plan: [], evaluation: null } },
  ]) {
    const model = report.buildModel(value);
    assert.equal(model.rows.length, 0);
    assert.equal(model.stats.roots, 0);
    assert.ok(Number.isFinite(model.extent));
  }
  const input = envelope();
  input.warnings = ["Events stream was incomplete"];
  const model = report.buildModel(input);
  assert.equal(model.diagnostics[0].type, "Report data warning");
});

test("safe links reject executable and escaping paths while retaining local logs", () => {
  assert.equal(report.safeLog("logs/build a#b.log"), "logs/build%20a%23b.log");
  for (const path of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "//example.com/x",
    "logs/../secret",
    "logs/%2e%2e/secret",
    "logs/%5c..%5csecret",
    "logs/a\nlog",
    "../logs/a",
  ])
    assert.equal(report.safeLog(path), null, path);
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///a",
    "https://user:pass@example.com",
    "/local",
  ])
    assert.equal(report.safeUrl(url), null, url);
  assert.equal(
    report.safeUrl("https://github.com/org/repo/actions/runs/1"),
    "https://github.com/org/repo/actions/runs/1",
  );
  assert.equal(
    report.diagnosticCause("long trace\nmore trace\nerror: missing ocaml_pcre"),
    "error: missing ocaml_pcre",
  );
});

test("thousands of root packages remain complete while the view window is bounded", () => {
  const jobs = Array.from({ length: 12000 }, (_, i) =>
    job(`package-${i}`, {
      state: i === 11 ? "failed" : "cached",
      startedAt: null,
      finishedAt: 101,
    }),
  );
  const model = report.buildModel(envelope({ jobs }));
  assert.equal(model.stats.roots, 12000);
  assert.equal(model.stats.cached, 11999);
  assert.equal(model.rows.length, 0);
  for (const scrollTop of [0, 10000, 600000]) {
    const range = report.visibleRange(12000, scrollTop, 484, 56);
    assert.ok(range.last - range.first <= 20);
    assert.ok(range.first >= 0);
    assert.ok(range.last <= 12000);
  }
  assert.deepEqual(report.visibleRange(0, 0, 484, 44), { first: 0, last: 0 });
});

test("concurrency integrates overlaps without counting idle gaps or double-counting endpoints", () => {
  const rows = [
    {
      kind: "build",
      intervals: [
        { start: 1, end: 4 },
        { start: 3, end: 5 },
      ],
    },
    {
      kind: "build",
      intervals: [
        { start: 5, end: 7 },
        { start: 9, end: 10 },
      ],
    },
    { kind: "download", intervals: [{ start: 1, end: 10 }] },
  ];
  const c = report.concurrency(rows, "build", 0, 10);
  assert.equal(c.peak, 1);
  assert.equal(c.busy, 7);
  assert.equal(c.average, 0.7);
  assert.equal(
    report.intervalSeconds([
      { start: 2, end: 8 },
      { start: 4, end: 10 },
    ]),
    8,
  );
});

test("template is self-contained and has exactly one of each embedding token", () => {
  const html = fs.readFileSync(path.join(__dirname, "template.html"), "utf8");
  for (const marker of [
    "__REPORT_STYLE__",
    "__REPORT_SCRIPT__",
    "__REPORT_DATA__",
  ])
    assert.equal(html.split(marker).length - 1, 1);
  assert.ok(html.includes('type="application/json" id="report-data"'));
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)=["']https?:/i);
  const js = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  assert.doesNotMatch(
    js,
    /\.innerHTML\s*=|insertAdjacentHTML\s*\(/,
    "untrusted report data must stay text, not markup",
  );
});

function queryModel() {
  return report.buildModel(
    envelope(
      {
        jobs: [
          job("app", { attrs: ["packages.piaf"] }),
          job("other", { attrs: ["packages.other"] }),
        ],
        derivations: [
          {
            drvPath: drv("curl"),
            name: "curl library",
            state: "built",
            neededBy: ["packages.piaf"],
          },
          {
            drvPath: drv("short"),
            name: "short library",
            state: "built",
            neededBy: ["packages.piaf"],
          },
          {
            drvPath: drv("curl-tls"),
            name: "curl TLS",
            state: "failed",
            neededBy: ["packages.other"],
          },
        ],
      },
      [
        activity("activity-start", 102, "curl", "curl", "build", {
          name: "curl library",
        }),
        activity("activity-start", 103, "short", "short"),
        activity("activity-start", 104, "curl-tls", "tls"),
        activity("activity-stop", 105, "short", "short"),
        activity("activity-stop", 112, "curl", "curl", "build", {
          name: "curl library",
        }),
        activity("activity-stop", 117, "curl-tls", "tls"),
      ],
    ),
  );
}

test("structured query filters combine actual activity kind, outcome, consumers, and elapsed seconds", () => {
  const model = queryModel();
  const source =
    "kind:build status:built name:curl needed-by:piaf duration:>=5s";
  const matches = report.filterRows(model, { search: source });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].nodeId, drv("curl"));
  assert.equal(matches[0].seconds, 10);
  assert.deepEqual(
    report
      .filterRows(model, { search: "kind:build -status:built" })
      .map((r) => r.nodeId),
    [drv("curl-tls")],
  );
  assert.equal(report.filterRows(model, { search: "unknown:curl" }).length, 0);
  assert.equal(
    report.filterRows(model, { search: 'name:"unclosed' }).length,
    0,
  );
  const compiled = query.compile(source);
  assert.deepEqual(
    report.filterRows(model, { query: compiled }).map((r) => r.id),
    matches.map((r) => r.id),
  );
});

test("structured queries preserve explicit lane, time-window, outcome, and consumer-focus filters", () => {
  const model = queryModel(),
    compiled = query.compile("kind:build name:curl");
  assert.deepEqual(
    report
      .filterRows(model, { query: compiled, focus: drv("app") })
      .map((r) => r.nodeId),
    [drv("curl")],
  );
  assert.deepEqual(
    report
      .filterRows(model, { query: compiled, state: "failed" })
      .map((r) => r.nodeId),
    [drv("curl-tls")],
  );
  assert.deepEqual(
    report
      .filterRows(model, { query: compiled, start: 113, end: 120 })
      .map((r) => r.nodeId),
    [drv("curl-tls")],
  );
  assert.equal(
    report.filterRows(model, { query: compiled, kinds: new Set(["download"]) })
      .length,
    0,
  );
  assert.equal(
    report.filterRows(model, {
      search: "curl packages.piaf",
      focus: drv("other"),
    }).length,
    0,
  );
});

test("view fragments round-trip a query, chosen lanes, zoom, focus, and inspector selection", () => {
  const model = queryModel(),
    row = model.rows.find(
      (r) => r.kind === "build" && r.nodeId === drv("curl"),
    );
  const state = {
    tab: "timeline",
    search: 'name:"curl library" -status:failed needed-by:piaf duration:>250ms',
    outcome: "built",
    kinds: new Set(["build", "download"]),
    from: 104.125,
    to: 117.5,
    sort: "duration",
    packageSort: "time",
    focus: drv("app"),
    selection: { nodeId: row.nodeId, rowId: row.id },
    inspectorTab: "dependencies",
  };
  const fragment = report.viewFragment(state, model);
  assert.ok(fragment.startsWith("#view=timeline&"));
  assert.ok(!fragment.includes('"'));
  assert.deepEqual(report.readView(fragment, model), state);
  assert.deepEqual(
    report
      .filterRows(model, { search: report.readView(fragment, model).search })
      .map((r) => r.nodeId),
    [drv("curl")],
  );
});

test("view fragments preserve a deliberately empty kind selection and node-only package details", () => {
  const model = queryModel();
  const state = {
    tab: "packages",
    search: "",
    outcome: "all",
    kinds: new Set(),
    from: model.start,
    to: model.end,
    sort: "start",
    packageSort: "attention",
    focus: null,
    selection: { nodeId: drv("app"), rowId: null },
    inspectorTab: "metadata",
  };
  assert.deepEqual(
    report.readView(report.viewFragment(state, model), model),
    state,
  );
  const defaults = report.readView("#view=timeline", model);
  assert.equal(defaults.kinds.has("build"), true);
  assert.equal(defaults.kinds.has("request"), false);
  assert.equal(defaults.kinds.has("wait"), false);
  assert.equal(defaults.selection, null);
});

test("malformed view choices and stale report identities cannot select nonexistent data", () => {
  const model = queryModel();
  const fragment =
    "#view=unknown&status=unknown&kinds=build,__proto__,unknown&sort=unknown&packages=unknown&detail=unknown&row=missing&node=missing&focus=missing&from=-500&to=500";
  const state = report.readView(fragment, model);
  assert.equal(state.tab, "timeline");
  assert.equal(state.outcome, "all");
  assert.deepEqual([...state.kinds], ["build"]);
  assert.equal(state.sort, "start");
  assert.equal(state.packageSort, "attention");
  assert.equal(state.inspectorTab, "overview");
  assert.equal(state.selection, null);
  assert.equal(state.focus, null);
  assert.equal(state.from, model.start);
  assert.equal(state.to, model.end);
  const row = model.rows.find(
    (r) => r.kind === "build" && r.nodeId === drv("curl"),
  );
  const contradictory = new URLSearchParams({
    view: "timeline",
    row: row.id,
    node: drv("other"),
  });
  assert.deepEqual(report.readView("#" + contradictory, model).selection, {
    nodeId: drv("curl"),
    rowId: row.id,
  });
  const fallback = new URLSearchParams({
    view: "packages",
    row: "stale",
    node: drv("app"),
  });
  assert.deepEqual(report.readView("#" + fallback, model).selection, {
    nodeId: drv("app"),
    rowId: null,
  });
});

test("view parsing bounds inputs and handles non-finite times, bad encoding, and an empty report", () => {
  const model = queryModel();
  for (const value of [
    null,
    undefined,
    "",
    "#section",
    "#q=curl",
    "#view=timeline&" + "x".repeat(32768),
  ]) {
    assert.equal(
      report.readView(value, model),
      null,
      String(value).slice(0, 30),
    );
  }
  const state = report.readView(
    "#view=timeline&from=NaN&to=Infinity&q=%E0%A4%A",
    model,
  );
  assert.equal(state.from, model.start);
  assert.equal(state.to, model.end);
  assert.equal(typeof state.search, "string");
  const bounded = report.readView(
    "#view=timeline&q=" + "x".repeat(9000),
    model,
  );
  assert.equal(bounded.search.length, query.limits.characters);
  const empty = report.buildModel({});
  const emptyState = report.readView(
    "#view=timeline&from=-10&to=10&row=missing",
    empty,
  );
  assert.equal(emptyState.from, empty.start);
  assert.equal(emptyState.to, empty.end);
  assert.equal(emptyState.selection, null);
});
