import test from "node:test";
import assert from "node:assert/strict";
import {
  activityModel,
  latestJobs,
  stageGroups,
  normalizePayload,
  observedEnd,
  elapsed,
  safeUrl,
  Query,
} from "./model.js";

const base = {
  id: "linux",
  key: "invocation-1",
  attemptId: "one",
  status: "running",
  startedAt: 100,
  lastEventAt: 130,
  heartbeatAt: 140,
  phases: [],
  needs: [],
};
const event = {
  id: "activity-1",
  jobKey: base.key,
  jobId: base.id,
  attemptId: base.attemptId,
  name: "ocaml-topkg",
  kind: "build",
  status: "building",
  startedAt: 110,
};

test("live intervals extend to the clock, stale intervals stop at the last heartbeat", () => {
  const live = activityModel([event], base, {}, 200).rows[0];
  assert.equal(live.end, 200);
  assert.equal(live.intervals[0].open, true);
  const stale = activityModel([event], { ...base, stale: true }, {}, 200)
    .rows[0];
  assert.equal(stale.end, 140);
  assert.equal(stale.intervals[0].open, false);
  assert.equal(stale.estimated, true);
  assert.equal(elapsed({ ...base, stale: true }, 200), 40);
});

test("unmeasured cached and incomplete activities never acquire a zero duration", () => {
  const unmeasured = { ...event, status: "cached", startedAt: 110 };
  const model = activityModel([unmeasured], base, {}, 200);
  assert.equal(model.rows.length, 0);
  assert.equal(model.untimed.length, 1);
  assert.equal(model.untimed[0].seconds, null);
  assert.equal(Query.compile("duration:0").match(model.untimed[0]), false);
  assert.equal(Query.compile("status:cached").match(model.untimed[0]), true);
  const measured = activityModel(
    [{ ...unmeasured, durationSeconds: 0 }],
    base,
    {},
    200,
  );
  assert.equal(measured.rows[0].seconds, 0);
});

test("completed parents freeze unfinished activity at observed evidence", () => {
  const model = activityModel(
    [event],
    { ...base, status: "success", finishedAt: 160 },
    {},
    200,
  );
  assert.equal(model.rows[0].end, 160);
  assert.equal(model.rows[0].estimated, true);
  assert.equal(model.rows[0].intervals[0].open, false);
  assert.equal(
    observedEnd({ status: "unknown", startedAt: 100, lastEventAt: 130 }, 200),
    130,
  );
});

test("attempt selection uses observation time rather than random UUID order", () => {
  const jobs = normalizePayload({
    jobs: [
      {
        ...base,
        key: "planned:linux",
        attemptId: "planned",
        startedAt: null,
        plannedAt: 90,
      },
      { ...base, key: "older", attemptId: "zzz", startedAt: 110 },
      { ...base, key: "newer", attemptId: "aaa", startedAt: 150 },
      {
        ...base,
        key: "planned:linux",
        attemptId: "zzzz",
        startedAt: null,
        plannedAt: 200,
      },
    ],
  }).jobs;
  assert.equal(latestJobs(jobs)[0].key, "newer");
});

test("activity identity is scoped to invocation, not just package name", () => {
  const other = {
    ...event,
    jobKey: "other",
    jobId: "darwin",
    attemptId: "two",
  };
  const model = activityModel([event, other], base, {}, 200);
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].id, "invocation-1:activity-1");
});

test("dependency stages are derived from actual needs and expose missing edges", () => {
  const jobs = normalizePayload({
    jobs: [
      { id: "package", kind: "package", needs: ["shared"] },
      { id: "plan", kind: "plan", needs: [] },
      { id: "shared", kind: "shared", needs: ["plan"] },
      { id: "lost", kind: "package", needs: ["unobserved"] },
    ],
  }).jobs;
  const groups = stageGroups(jobs);
  assert.equal(groups[0].label, "Planning");
  assert.equal(
    groups.find((group) => group.jobs.some((job) => job.id === "package"))
      .depth,
    1,
  );
  assert.equal(
    stageGroups(jobs.filter((job) => job.id !== "lost")).find((group) =>
      group.jobs.some((job) => job.id === "shared"),
    ).label,
    "Prerequisites",
  );
  assert.equal(
    groups.flatMap((group) => group.jobs).find((job) => job.id === "lost")
      .unresolvedDependencies,
    true,
  );
  assert.equal(
    stageGroups(
      normalizePayload({
        jobs: [
          { id: "a", needs: ["b"] },
          { id: "b", needs: ["a"] },
        ],
      }).jobs,
    )
      .flatMap((group) => group.jobs)
      .some((job) => job.unresolvedDependencies),
    true,
  );
});

test("outbound links accept only HTTP(S) and unknown metrics stay nullable", () => {
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("file:///etc/passwd"), null);
  assert.equal(
    safeUrl("https://github.com/nix-ocaml/nix-ci-build"),
    "https://github.com/nix-ocaml/nix-ci-build",
  );
  assert.deepEqual(
    normalizePayload({ jobs: [{ id: "planned" }] }).jobs[0].metrics,
    {},
  );
});
