import test from "node:test";
import assert from "node:assert/strict";
import {
  filterWorkspaceRuns,
  repositoriesFor,
  safeNavigation,
  avatarUrl,
  overallStatus,
} from "./workspaces.js";

const session = {
  mode: "github",
  user: { login: "alice" },
  connections: [
    {
      installationId: 1,
      account: { login: "alice", type: "User" },
      repositories: [{ id: 100, fullName: "alice/project", private: true }],
    },
    {
      installationId: 2,
      account: { login: "team", type: "Organization" },
      repositories: [{ id: 200, fullName: "team/packages", private: false }],
    },
  ],
};
const runs = [
  { id: "personal", repository: "Alice/Project", repositoryId: 100 },
  { id: "team", repository: "team/packages", repositoryId: 200 },
  { id: "renamed", repository: "team/old-name", repositoryId: 200 },
  { id: "other", repository: "other/private", repositoryId: 300 },
];

test("workspace filtering uses accessible repository identities, including renamed repositories", () => {
  assert.deepEqual(
    filterWorkspaceRuns(runs, session).map((run) => run.id),
    ["personal", "team", "renamed"],
  );
  assert.deepEqual(
    filterWorkspaceRuns(runs, session, "1").map((run) => run.id),
    ["personal"],
  );
  assert.deepEqual(
    filterWorkspaceRuns(runs, session, "2", "team/packages").map(
      (run) => run.id,
    ),
    ["team", "renamed"],
  );
  assert.deepEqual(filterWorkspaceRuns(runs, session, "missing"), []);
  assert.deepEqual(
    filterWorkspaceRuns(runs, { mode: "github", connections: [] }),
    [],
  );
});

test("local mode keeps observed repositories available without GitHub connections", () => {
  assert.equal(filterWorkspaceRuns(runs, { mode: "local" }).length, 4);
  assert.equal(repositoriesFor({ mode: "local" }, "all", runs).length, 4);
  assert.deepEqual(
    filterWorkspaceRuns(runs, { mode: "local" }, "all", "ALICE/PROJECT").map(
      (run) => run.id,
    ),
    ["personal"],
  );
});

test("navigation and avatars reject executable URLs and untrusted image hosts", () => {
  assert.equal(
    safeNavigation("javascript:alert(1)", "https://builds.example"),
    null,
  );
  assert.equal(
    safeNavigation("data:text/html,hello", "https://builds.example"),
    null,
  );
  assert.equal(
    safeNavigation("/auth/github", "https://builds.example"),
    "/auth/github",
  );
  assert.equal(
    safeNavigation(
      "https://github.com/apps/builds/installations/new",
      "https://builds.example",
    ),
    "https://github.com/apps/builds/installations/new",
  );
  assert.equal(avatarUrl("https://tracker.example/avatar"), null);
  assert.equal(avatarUrl("http://avatars.githubusercontent.com/u/123"), null);
  assert.equal(
    avatarUrl("https://avatars.githubusercontent.com/u/123?v=4"),
    "https://avatars.githubusercontent.com/u/123?v=4",
  );
});

test("workflow outcome takes precedence over a successful wrapped command", () => {
  assert.equal(
    overallStatus({ workflowStatus: "failure", status: "success" }, "success"),
    "failed",
  );
  assert.equal(overallStatus({ workflowStatus: null }, "running"), "running");
  assert.equal(
    overallStatus({ workflowStatus: "in_progress" }, "unknown"),
    "running",
  );
});
