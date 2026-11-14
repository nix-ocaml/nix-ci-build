import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { DruidsEnvironment } from "@datadog/druids/layout/DruidsEnvironment";
import { Text } from "@datadog/druids/typography/Text";
import { Button as DruidsButton } from "@datadog/druids/form/Button";
import { InputSearch } from "@datadog/druids/form/InputSearch";
import { Select } from "@datadog/druids/form/Select";
import { Checkbox } from "@datadog/druids/form/Checkbox";
import { ProminentTabList } from "@datadog/druids/nav/ProminentTabList";
import { StatusPill } from "@datadog/druids/pills/StatusPill";
import { Table } from "@datadog/druids/table/Table";
import "@datadog/druids/styles.css";
import "./style.css";
import Waterfall from "./waterfall.jsx";
import TimelineOverview from "./timeline-overview.jsx";
import { clampWindow, zoomWindow } from "./timeline-math.js";
import { useClock, useLiveData, useLocation, useSession } from "./data.jsx";
import {
  Avatar,
  ConnectionsPanel,
  SessionScreen,
  WorkspaceSwitcher,
} from "./connections.jsx";
import { filterWorkspaceRuns, overallStatus } from "./workspaces.js";
import {
  KINDS,
  Query,
  STATUS_ORDER,
  TERMINAL,
  activityModel,
  ago,
  duration,
  elapsed,
  latestJobs,
  number,
  observedEnd,
  safeUrl,
  stageGroups,
  statusOf,
  timestamp,
} from "./model.js";

function Button(props) {
  return <DruidsButton isTitleCased={false} {...props} />;
}
const STATUS_LABEL = {
  planned: "Planned",
  queued: "Queued",
  running: "Running",
  success: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Blocked",
  unknown: "Unknown",
  incomplete: "Incomplete",
  stale: "No heartbeat",
  skipped: "Skipped",
};
const STATUS_COLOR = {
  running: "#7b50c9",
  success: "#36a477",
  failed: "#dc535f",
  stale: "#c68d29",
  incomplete: "#c68d29",
  blocked: "#a77432",
  queued: "#6c86ba",
  planned: "#9da5b6",
  unknown: "#9da5b6",
  cancelled: "#8f96a3",
};
const KINDS_COLOR = {
  build: "#9d72c6",
  download: "#4a9fad",
  evaluation: "#6882c8",
  planning: "#b6954d",
  upload: "#b975a5",
  import: "#55a584",
  wait: "#c39437",
  request: "#8796b0",
};

function Icon({ name, size = 18, ...props }) {
  const paths = {
    runs: "M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z",
    branch: "M6 3v12a4 4 0 0 0 4 4h2m6-14v4a4 4 0 0 1-4 4H6",
    commit: "M3 12h5m8 0h5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    arrow: "M5 12h14m-5-5 5 5-5 5",
    external: "M13 4h7v7m0-7L10 14M9 5H5v15h15v-5",
    pulse: "M2 12h4l3-8 5 16 3-8h5",
    chevron: "m9 5 7 7-7 7",
    clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
    filter: "M4 6h16M7 12h10m-7 6h4",
    check: "m5 12 4 4L19 6",
    alert: "M12 8v5m0 3v.2M2 20h20L12 3Z",
    close: "m6 6 12 12M6 18 18 6",
    menu: "M4 6h16M4 12h16M4 18h16",
    pause: "M8 5v14M16 5v14",
    play: "m8 4 12 8-12 8Z",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name] || paths.runs} />
    </svg>
  );
}
function Status({ state, compact = false }) {
  const status = typeof state === "string" ? state : statusOf(state);
  const label = STATUS_LABEL[status] || status;
  if (compact)
    return (
      <span
        className={`status-dot ${status}`}
        style={{
          "--status-color": STATUS_COLOR[status] || STATUS_COLOR.unknown,
        }}
        title={label}
        aria-label={label}
      />
    );
  return (
    <StatusPill
      size="sm"
      isSoft
      level={
        status === "failed"
          ? "danger"
          : status === "success"
            ? "success"
            : status === "running"
              ? "in-progress"
              : "default"
      }
    >
      {label}
    </StatusPill>
  );
}
function External({ href, children, className = "" }) {
  const url = safeUrl(href);
  return url ? (
    <a
      className={`external-link ${className}`}
      href={url}
      target="_blank"
      rel="noreferrer"
    >
      {children}
      <Icon name="external" size={12} />
    </a>
  ) : (
    <span className={className}>{children}</span>
  );
}
function Empty({ title, children, icon = "pulse" }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={28} />
      </div>
      <Text as="h2" size="lg" weight="bold">
        {title}
      </Text>
      <Text as="p" size="sm" variant="secondary">
        {children}
      </Text>
    </div>
  );
}
function Metric({ label, value, hint, color }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <strong style={color ? { color } : undefined}>{value}</strong>
      <span className="metric-hint">{hint}</span>
    </div>
  );
}

function App() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("nix-live-theme") || "light";
    } catch {
      return "light";
    }
  });
  const [route, navigate] = useLocation();
  const account = useSession();
  const session = account.session;
  const authorized =
    !account.loading &&
    !account.error &&
    !!session &&
    (session.mode === "local" || !!session.user);
  const [paused, setPaused] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [toast, setToast] = useState("");
  const live = useLiveData(
    route.runId,
    paused,
    authorized,
    account.expire,
    account.load,
  );
  const now = useClock(
    live.serverTime,
    live.receivedAt,
    paused,
    !!live.error || live.connection !== "live",
  );
  const runs = useMemo(
    () =>
      filterWorkspaceRuns(
        live.runs,
        session,
        route.workspace,
        route.repository,
      ).sort(
        (a, b) =>
          (b.startedAt || b.updatedAt || 0) - (a.startedAt || a.updatedAt || 0),
      ),
    [live.runs, session, route.workspace, route.repository],
  );
  useEffect(() => {
    if (authorized && route.page === "runs" && !route.runId && runs.length)
      navigate({ runId: runs[0].id, jobKey: null }, true);
  }, [runs, route.runId, route.page, authorized, navigate]);
  useEffect(() => {
    try {
      localStorage.setItem("nix-live-theme", theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  const changeRun = (id) => {
    setPaused(false);
    navigate({ page: "runs", runId: id, jobKey: null, tab: "pipeline" });
    setSidebar(false);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setToast("View link copied");
    } catch {
      setToast("Copy the URL from your address bar to share this view.");
    }
  };
  const connection = paused
    ? "paused"
    : live.error
      ? "unavailable"
      : live.connection;
  const openConnections = () => {
    navigate({ page: "connections" });
    setSidebar(false);
  };
  const changeWorkspace = (workspace, repository = "all") => {
    setPaused(false);
    navigate({
      page: "runs",
      workspace,
      repository,
      runId: null,
      jobKey: null,
      tab: "pipeline",
    });
    setSidebar(false);
  };
  const selectedAccessible =
    live.payload?.run &&
    (session?.mode === "local" ||
      filterWorkspaceRuns([live.payload.run], session).length > 0);
  if (!authorized)
    return (
      <DruidsEnvironment defaultThemePreference={theme}>
        <SessionScreen
          session={session}
          loading={account.loading}
          error={account.error}
          retry={account.load}
          expired={account.expired}
          theme={theme}
          toggleTheme={() => setTheme(theme === "light" ? "dark" : "light")}
        />
      </DruidsEnvironment>
    );
  return (
    <DruidsEnvironment defaultThemePreference={theme}>
      <div className="observatory">
        <a className="skip-link" href="#main">
          Skip to build details
        </a>
        <nav className="app-rail" aria-label="Application">
          <div className="brand-symbol" title="Nix CI Build">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <path d="m16 2 12 7v14l-12 7L4 23V9Z" />
              <path d="m10 12 6 4 6-4M16 16v8M10 12V8m12 4V8" />
            </svg>
          </div>
          <button
            className={`rail-item ${route.page === "runs" ? "active" : ""}`}
            title="Build runs"
            aria-label="Build runs"
            onClick={() => navigate({ page: "runs" })}
          >
            <Icon name="runs" />
          </button>
          {session.mode === "github" && (
            <button
              className={`rail-item ${route.page === "connections" ? "active" : ""}`}
              title="Connections"
              aria-label="Connections"
              onClick={openConnections}
            >
              <Icon name="branch" />
            </button>
          )}
          {session.user ? (
            <button
              className="rail-account"
              title={`Signed in as ${session.user.login}`}
              aria-label="Your GitHub connections"
              onClick={openConnections}
            >
              <Avatar account={session.user} />
            </button>
          ) : (
            <div className="rail-foot" title="Local workspace">
              L
            </div>
          )}
        </nav>
        <header className="app-header">
          <div className="header-title">
            <button
              className="icon-button mobile-only"
              aria-label="Show build runs"
              onClick={() => setSidebar(!sidebar)}
            >
              <Icon name="menu" />
            </button>
            <Text size="sm" weight="bold">
              Build Observatory
            </Text>
            <span className="header-divider" />
            <span className="header-section">CI visibility</span>
            {session.mode === "local" && (
              <span className="local-badge">LOCAL</span>
            )}
          </div>
          <div className="header-actions">
            <span className={`connection ${connection}`} role="status">
              <i />
              {connection === "live"
                ? "Live"
                : connection === "paused"
                  ? "Paused"
                  : connection === "reconnecting"
                    ? "Reconnecting"
                    : connection === "unavailable"
                      ? "Updates unavailable"
                      : "Connecting"}
              {paused && live.pending ? " · new activity" : ""}
            </span>
            <Button
              label={paused ? "Resume" : "Pause"}
              size="xs"
              isBorderless
              onClick={() => setPaused(!paused)}
            />
            <Button label="Copy link" size="xs" isBorderless onClick={copy} />
            <Button
              label={theme === "light" ? "Dark" : "Light"}
              size="xs"
              isBorderless
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            />
            {session.user && (
              <details className="account-menu">
                <summary aria-label={`Account: ${session.user.login}`}>
                  <Avatar account={session.user} />
                  <span>{session.user.login}</span>
                  <span className="account-caret">▾</span>
                </summary>
                <div>
                  <div className="account-menu-identity">
                    <strong>{session.user.name || session.user.login}</strong>
                    <span>@{session.user.login}</span>
                  </div>
                  <button
                    onClick={(event) => {
                      event.currentTarget.closest("details").open = false;
                      openConnections();
                    }}
                  >
                    Connections & workspaces
                  </button>
                  <button
                    disabled={account.signingOut}
                    onClick={account.signOut}
                  >
                    {account.signingOut ? "Signing out…" : "Sign out"}
                  </button>
                </div>
              </details>
            )}
          </div>
        </header>
        <aside
          className={`run-sidebar ${sidebar ? "mobile-open" : ""}`}
          aria-label="Build runs"
        >
          <WorkspaceSwitcher
            session={session}
            workspace={route.workspace}
            repository={route.repository}
            runs={live.runs}
            changeWorkspace={(workspace) => changeWorkspace(workspace)}
            changeRepository={(repository) =>
              changeWorkspace(route.workspace, repository)
            }
            openConnections={openConnections}
          />
          <RunList
            runs={runs}
            selected={route.runId}
            onSelect={changeRun}
            now={now}
            loading={live.loading}
          />
          <footer className="sidebar-footer">
            <span>
              {session.mode === "local" ? "Collector snapshot" : "Last update"}
            </span>
            <code>r{live.revision}</code>
            <span>
              {live.receivedAt ? ago(live.receivedAt) : "Waiting for events"}
            </span>
          </footer>
        </aside>
        {sidebar && (
          <button
            className="sidebar-backdrop"
            aria-label="Close build runs"
            onClick={() => setSidebar(false)}
          />
        )}
        <main className="run-main" id="main" tabIndex={-1}>
          {account.mutationError && route.page !== "connections" && (
            <div className="notice danger" role="alert">
              {account.mutationError}
            </div>
          )}
          {route.page === "connections" && session.mode === "github" ? (
            <ConnectionsPanel
              session={session}
              refresh={account.refreshConnections}
              refreshing={account.refreshing}
              error={account.mutationError}
              notice={account.notice}
              openWorkspace={changeWorkspace}
            />
          ) : (
            <>
              {live.error && (
                <div className="notice danger" role="alert">
                  <Icon name="alert" />
                  <div>
                    <strong>{live.error}</strong>
                    <span>
                      {live.payload
                        ? "Showing the last confirmed snapshot. Timers are paused until the collector reconnects."
                        : "Your selected view is preserved. Choose another run or try again."}
                    </span>
                  </div>
                  <Button label="Retry" size="sm" onClick={live.refresh} />
                </div>
              )}
              {paused && (
                <div className="notice muted">
                  <Icon name="pause" />
                  <span>
                    Updates paused. This view is fixed to the last received
                    snapshot.
                  </span>
                  <Button
                    label="Resume live"
                    size="xs"
                    isBorderless
                    onClick={() => setPaused(false)}
                  />
                </div>
              )}
              {live.payload?.run &&
              live.payload.run.id === route.runId &&
              selectedAccessible ? (
                <RunView
                  payload={live.payload}
                  now={now}
                  route={route}
                  navigate={navigate}
                  paused={paused || !!live.error || live.connection !== "live"}
                />
              ) : live.loading ? (
                <div className="loading-state">
                  <div className="loading-bar" />
                  Loading observed build activity…
                </div>
              ) : session.mode === "github" && !session.connections.length ? (
                <ConnectionsPanel
                  session={session}
                  refresh={account.refreshConnections}
                  refreshing={account.refreshing}
                  error={account.mutationError}
                  notice={account.notice}
                  openWorkspace={changeWorkspace}
                />
              ) : (
                <Empty
                  title={
                    live.payload?.run && !selectedAccessible
                      ? "Repository access has changed"
                      : runs.length
                        ? "Choose a build run"
                        : "Ready for your next build"
                  }
                >
                  {live.payload?.run && !selectedAccessible
                    ? "This repository is no longer available in your connected workspaces. Choose another run or refresh your connections."
                    : runs.length
                      ? "Select a run to explore its jobs, dependencies, and package activity."
                      : session.mode === "github"
                        ? "Workflow runs from your selected repositories appear here as they start. Try another repository or return when the next build begins."
                        : "Runs appear here as soon as a build connects. Planned matrix jobs and live package activities fill in as the build progresses."}
                </Empty>
              )}
            </>
          )}
        </main>
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </div>
    </DruidsEnvironment>
  );
}

function RunList({ runs, selected, onSelect, now, loading }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const filtered = runs.filter(
    (run) =>
      `${run.repository} ${run.workflow} ${run.branch} ${run.commitSha} ${run.pullRequest || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (filter === "all" || filter === "active"
        ? filter === "all" || !TERMINAL.has(overallStatus(run, statusOf(run)))
        : ["failed", "incomplete", "stale", "blocked"].includes(
            overallStatus(run, statusOf(run)),
          )),
  );
  return (
    <>
      <div className="run-list-heading">
        <div>
          <Text as="h1" size="md" weight="bold">
            Build runs
          </Text>
          <span className="count-badge">{runs.length}</span>
        </div>
        <Text as="p" size="xs" variant="secondary">
          Every matrix. Every package. One view.
        </Text>
        <InputSearch
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Repository, branch, PR…"
          size="sm"
          isFullWidth
          ariaAttrs={{ "aria-label": "Search build runs" }}
        />
        <div
          className="segmented-filter"
          role="group"
          aria-label="Filter build runs"
        >
          {[
            ["all", "All runs"],
            ["active", "Active"],
            ["attention", "Attention"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={filter === id ? "active" : ""}
              onClick={() => setFilter(id)}
              aria-pressed={filter === id}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="run-list">
        {filtered.map((run) => (
          <button
            className={`run-list-item ${selected === run.id ? "selected" : ""}`}
            key={run.id}
            onClick={() => onSelect(run.id)}
            aria-current={selected === run.id ? "page" : undefined}
          >
            <div className="run-item-top">
              <span className="repository-name">
                {run.repository || "Unknown repository"}
              </span>
              <span className="run-number">
                {run.runNumber
                  ? `#${run.runNumber}`
                  : run.pullRequest
                    ? `PR #${run.pullRequest}`
                    : `Attempt ${run.runAttempt || 1}`}
              </span>
            </div>
            <div className="run-item-title">
              <Status state={overallStatus(run, statusOf(run))} compact />
              <strong>{run.workflow || "Build"}</strong>
            </div>
            <div className="run-item-ref">
              <Icon name="branch" size={12} />
              <span>{run.branch || "Unknown ref"}</span>
              {run.pullRequest && (
                <span className="pr-chip">#{run.pullRequest}</span>
              )}
            </div>
            <div className="run-item-footer">
              <span>
                {STATUS_LABEL[overallStatus(run, statusOf(run))] ||
                  overallStatus(run, statusOf(run))}
                <span className="dot-separator">·</span>
                {duration(elapsed(run, now))}
              </span>
              <span>{ago(run.startedAt || run.updatedAt, now)}</span>
            </div>
            <div className="run-mini-progress" aria-hidden="true">
              {Object.entries(run.counts || {})
                .filter(([state, count]) => state !== "total" && count > 0)
                .map(([state, count]) => (
                  <i
                    key={state}
                    style={{
                      flex: count,
                      background: STATUS_COLOR[state] || STATUS_COLOR.unknown,
                    }}
                  />
                ))}
            </div>
          </button>
        ))}
        {!filtered.length && (
          <p className="sidebar-empty">
            {loading
              ? "Waiting for the collector…"
              : runs.length
                ? "No runs match these filters."
                : "No runs observed yet."}
          </p>
        )}
      </div>
    </>
  );
}

function RunView({ payload, now, route, navigate, paused }) {
  const { run, jobs, activities, diagnostics } = payload;
  const current = useMemo(() => latestJobs(jobs), [jobs]);
  const selected =
    jobs.find((job) => job.key === route.jobKey) ||
    (route.jobKey?.startsWith("planned:")
      ? current.find((job) => job.id === route.jobKey.slice("planned:".length))
      : null) ||
    null;
  const selectionKey = selected?.key;
  useEffect(() => {
    if (selectionKey && selectionKey !== route.jobKey)
      navigate({ jobKey: selectionKey }, true);
  }, [selectionKey, route.jobKey, navigate]);
  const counts = Object.fromEntries(
    STATUS_ORDER.map((status) => [
      status,
      current.filter((job) => statusOf(job) === status).length,
    ]),
  );
  const stages = useMemo(() => stageGroups(jobs), [jobs]);
  const metric = (key) => {
    const values = current
      .map((job) => job.metrics[key])
      .filter((value) => typeof value === "number");
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const attention = current.filter((job) =>
    ["failed", "blocked", "stale", "incomplete", "unknown"].includes(
      statusOf(job),
    ),
  );
  const repoUrl =
    run.repository && safeUrl(run.url)
      ? `https://github.com/${run.repository}`
      : null;
  const choose = (job) => navigate({ jobKey: job.key });
  const githubSnapshot = run.github || payload.github;
  const github = githubSnapshot?.run || githubSnapshot;
  const githubJobs = payload.githubJobs || githubSnapshot?.jobs || [];
  const workflowState = overallStatus(
    run,
    github
      ? statusOf({
          status:
            github.conclusion ||
            (github.status === "completed" ? "unknown" : github.status),
        })
      : statusOf(run),
  );
  const waitingForTelemetry =
    current.length === 0 &&
    (["waiting", "not_reported"].includes(run.telemetryStatus) ||
      !!github ||
      githubJobs.length > 0);
  const workflowFinished = TERMINAL.has(workflowState) || !!github?.conclusion;
  const githubFailures = githubJobs.filter((job) =>
    ["failure", "timed_out", "startup_failure", "action_required"].includes(
      job.conclusion,
    ),
  );
  const additionalWorkflowFailures = githubFailures.filter(
    (failure) => !attention.some((job) => job.github?.id === failure.id),
  ).length;
  const tabs = [
    {
      value: "pipeline",
      label: "Pipeline",
      count: current.length,
      maxCount: 100000,
    },
    { value: "jobs", label: "Jobs", count: jobs.length, maxCount: 100000 },
    {
      value: "activity",
      label: "Package activity",
      count: activities.length,
      maxCount: 100000,
    },
    {
      value: "workflow",
      label: "Workflow steps",
      count: githubJobs.length,
      maxCount: 100000,
    },
    {
      value: "diagnostics",
      label: "Diagnostics",
      count: diagnostics.length + attention.length + githubFailures.length,
      countLevel:
        attention.some((job) => statusOf(job) === "failed") ||
        githubFailures.length
          ? "danger"
          : "default",
    },
  ].filter(
    (tab) => !waitingForTelemetry || !["jobs", "activity"].includes(tab.value),
  );
  const validTab = tabs.some((tab) => tab.value === route.tab)
    ? route.tab
    : "pipeline";
  const activeJob =
    selected ||
    current.find((job) => statusOf(job) === "running") ||
    current.find((job) => statusOf(job) === "failed") ||
    current[0];
  return (
    <>
      <div className="run-heading">
        <div className="run-breadcrumb">
          <External href={repoUrl}>
            {run.repository || "Unidentified repository"}
          </External>
          <span>/</span>
          <span>Workflow runs</span>
        </div>
        <div className="run-heading-main">
          <div>
            <h1>
              {run.workflow || "Package set build"}
              <span className="heading-number">
                {run.runNumber
                  ? `#${run.runNumber}`
                  : /^\d+$/.test(run.githubRunId || "")
                    ? `#${run.githubRunId}`
                    : ""}
              </span>
            </h1>
            {run.title &&
              run.title !== run.workflow &&
              run.title !== "Package build" && (
                <p className="run-event-title">{run.title}</p>
              )}
            <div className="run-context">
              <span>
                <Icon name="branch" size={14} />
                {run.branch || "Ref not reported"}
              </span>
              {run.pullRequest && (
                <External href={`${repoUrl}/pull/${run.pullRequest}`}>
                  PR #{run.pullRequest}
                </External>
              )}
              {run.commitSha && (
                <External href={`${repoUrl}/commit/${run.commitSha}`}>
                  <Icon name="commit" size={14} />
                  <code>{run.commitSha.slice(0, 8)}</code>
                </External>
              )}
              <span>Attempt {run.runAttempt || 1}</span>
              <span>
                <Icon name="clock" size={13} />
                {run.startedAt
                  ? new Date(run.startedAt * 1000).toLocaleString()
                  : "Start time not observed"}
              </span>
            </div>
          </div>
          <div className="run-heading-status">
            <div>
              <span className="eyebrow">
                {run.workflowStatus || github ? "Workflow" : "Observed builds"}
              </span>
              <Status state={workflowState} />
            </div>
            {safeUrl(run.url) && (
              <External href={run.url}>GitHub Actions</External>
            )}
          </div>
        </div>
      </div>
      <div className="workflow-evidence">
        <span className="evidence-marker" />
        <span>
          {waitingForTelemetry ? (
            workflowFinished ? (
              "No build reports received"
            ) : (
              "Workflow discovered · awaiting package activity"
            )
          ) : github && current.length ? (
            <>
              Build reports:{" "}
              <strong>{STATUS_LABEL[statusOf(run)] || statusOf(run)}</strong>
            </>
          ) : github?.conclusion ? (
            <>
              GitHub workflow:{" "}
              <strong className={githubFailures.length ? "failure-text" : ""}>
                {github.conclusion.replaceAll("_", " ")}
              </strong>
            </>
          ) : github?.status ? (
            <>
              GitHub workflow:{" "}
              <strong>{github.status.replaceAll("_", " ")}</strong>
            </>
          ) : (
            "Build status reflects observed wrapped commands."
          )}
        </span>
        {!github?.status && !github?.conclusion && (
          <span className="evidence-secondary">
            The full GitHub workflow conclusion has not been reconciled.
          </span>
        )}
        {github && (
          <button
            className="text-button"
            onClick={() => navigate({ tab: "workflow" })}
          >
            Inspect workflow steps
          </button>
        )}
        {run.stale && (
          <strong className="warning-text">
            Producer heartbeat overdue; work may still be running.
          </strong>
        )}
      </div>
      {waitingForTelemetry ? (
        <section
          className="run-metrics workflow-metrics"
          aria-label="Workflow metrics"
        >
          <Metric
            label="Workflow time"
            value={duration(elapsed(run, now))}
            hint={
              run.finishedAt ? "Completed workflow" : "Since workflow started"
            }
          />
          <Metric
            label="Runner jobs"
            value={githubJobs.length}
            hint="Jobs reported by GitHub"
          />
          <Metric
            label="Running / queued"
            value={`${githubJobs.filter((job) => job.status === "in_progress").length} / ${githubJobs.filter((job) => ["queued", "waiting", "requested", "pending"].includes(job.status)).length}`}
            hint="Current runner status"
          />
          <Metric
            label="Completed jobs"
            value={
              githubJobs.filter((job) => job.status === "completed").length
            }
            hint="Includes failures and skips"
          />
          <Metric
            label="Build reports"
            value={workflowFinished ? "None received" : "Awaiting"}
            hint="No build reports received"
          />
          <Metric
            label="Failed jobs"
            value={githubFailures.length}
            hint="Includes setup and upload"
            color={githubFailures.length ? "var(--status-failed)" : undefined}
          />
        </section>
      ) : (
        <section className="run-metrics" aria-label="Run metrics">
          <Metric
            label="Observed wall time"
            value={duration(elapsed(run, now))}
            hint={
              run.finishedAt
                ? "Completed observation"
                : paused
                  ? "Snapshot time"
                  : "Since first observation"
            }
          />
          <Metric
            label="Jobs completed"
            value={`${counts.success + counts.failed + counts.cancelled + counts.blocked} / ${current.length}`}
            hint="Of currently known jobs"
          />
          <Metric
            label="Running / queued"
            value={`${counts.running} / ${counts.queued + counts.planned}`}
            hint={
              counts.stale
                ? `${counts.stale} without a heartbeat`
                : "Matrix fills in as discovered"
            }
            color={counts.running ? "var(--report-accent)" : undefined}
          />
          <Metric
            label="Roots built / cached"
            value={`${number(metric("built"))} / ${number(metric("cached"))}`}
            hint={
              metric("actualBuilds") === null
                ? "Reported root request counts"
                : `${number(metric("actualBuilds"))} actual derivation builds`
            }
          />
          <Metric
            label="Downloads"
            value={number(metric("downloads"))}
            hint={
              metric("uploads") === null
                ? "Unreported values show —"
                : `${number(metric("uploads"))} publications`
            }
          />
          <Metric
            label="Needs attention"
            value={attention.length + additionalWorkflowFailures}
            hint={
              githubFailures.length
                ? `${githubFailures.length} GitHub job failures`
                : counts.failed
                  ? `${counts.failed} failed jobs`
                  : counts.stale
                    ? "Check producer connectivity"
                    : "Failures and uncertain outcomes"
            }
            color={
              counts.failed || githubFailures.length
                ? "var(--status-failed)"
                : undefined
            }
          />
        </section>
      )}
      <section className="run-workspace">
        <ProminentTabList
          tabs={tabs}
          selectedTab={validTab}
          onTabChange={(tab) => navigate({ tab })}
          impact="low"
          hasRoundedTabs={false}
        />
        {validTab === "pipeline" && waitingForTelemetry ? (
          <>
            <div
              className={`reporter-waiting ${workflowState === "failed" ? "workflow-failed" : ""}`}
            >
              <span className="reporter-waiting-icon">
                <Icon name={workflowState === "failed" ? "alert" : "pulse"} />
              </span>
              <div>
                <h2>
                  {workflowFinished
                    ? "Workflow finished without build reports"
                    : "Your workflow is underway"}
                </h2>
                <p>
                  {workflowFinished
                    ? "No build reports have arrived for this run. Inspect the runner jobs and steps below, including any failures before the build started."
                    : "Runner jobs appear as GitHub starts them. Package timelines and the dependency pipeline will join this view when build reports arrive."}
                </p>
              </div>
              <Status state={workflowState} />
            </div>
            <WorkflowSteps
              github={github}
              jobs={githubJobs}
              invocations={jobs}
              select={choose}
              now={now}
            />
          </>
        ) : (
          validTab === "pipeline" && (
            <>
              <div className="section-toolbar">
                <div>
                  <Text size="sm" weight="bold">
                    Dependency pipeline
                  </Text>
                  <span className="secondary">
                    {stages.length} observed stages · {current.length} jobs
                  </span>
                </div>
                <div className="legend">
                  <Status state="running" compact />
                  Running
                  <Status state="success" compact />
                  Succeeded
                  <Status state="planned" compact />
                  Planned
                </div>
              </div>
              {current.length ? (
                <Pipeline
                  stages={stages}
                  selected={selected?.key}
                  select={choose}
                  now={now}
                />
              ) : (
                <Empty title="Waiting for the build plan">
                  The planner will announce matrix jobs here. Dependency edges
                  come from the submitted execution plan.
                </Empty>
              )}
              <div className="pipeline-footnote">
                <Icon name="branch" size={13} />
                <span>
                  Stages follow declared dependencies. New jobs appear as the
                  plan arrives; an empty stage is not a successful stage.
                </span>
              </div>
            </>
          )
        )}
        {validTab === "jobs" && (
          <Jobs
            jobs={jobs}
            selected={selected?.key}
            select={choose}
            run={run}
            now={now}
          />
        )}
        {validTab === "workflow" && (
          <WorkflowSteps
            github={github}
            jobs={githubJobs}
            invocations={jobs}
            select={choose}
            now={now}
          />
        )}
        {validTab === "diagnostics" && (
          <>
            {githubFailures.length > 0 && (
              <div className="notice danger">
                <Icon name="alert" />
                <span>
                  {githubFailures.length} GitHub job
                  {githubFailures.length === 1 ? "" : "s"} failed, including
                  steps outside the observed build commands.
                </span>
                <Button
                  label="Inspect workflow steps"
                  size="xs"
                  onClick={() => navigate({ tab: "workflow" })}
                />
              </div>
            )}
            <Diagnostics
              diagnostics={diagnostics}
              attention={attention}
              select={choose}
              now={now}
            />
          </>
        )}
        {(selected || validTab === "activity") && activeJob && (
          <JobDetail
            key={activeJob.key}
            job={activeJob}
            jobs={jobs}
            run={run}
            activities={activities}
            now={now}
            select={choose}
            close={() =>
              navigate({
                jobKey: null,
                tab: validTab === "activity" ? "pipeline" : validTab,
              })
            }
            paused={paused}
          />
        )}
        {validTab === "activity" && !activeJob && (
          <Empty title="No package activity yet">
            Select a job once its invocation is registered. Cached results and
            activities without timing evidence remain separate from measured
            intervals.
          </Empty>
        )}
      </section>
    </>
  );
}

function Pipeline({ stages, selected, select, now }) {
  return (
    <div className="pipeline" aria-label="Build dependency stages">
      {stages.map((stage, index) => (
        <React.Fragment key={stage.depth}>
          {index > 0 && (
            <div
              className={`stage-connector ${stages[index - 1].isPlanning ? "planning-connector" : ""}`}
              aria-hidden="true"
            >
              {stages[index - 1].isPlanning ? (
                <span />
              ) : (
                <Icon name="arrow" size={20} />
              )}
            </div>
          )}
          <section className="pipeline-stage">
            <header>
              <span className="stage-number">{index + 1}</span>
              <h2>{stage.label}</h2>
              <span className="count-badge">{stage.jobs.length}</span>
            </header>
            <div className="stage-jobs">
              {stage.jobs.map((job) => (
                <button
                  key={job.key}
                  className={`job-card ${selected === job.key ? "selected" : ""}`}
                  onClick={() => select(job)}
                  data-job-key={job.key}
                  aria-label={`Inspect ${job.name}: ${STATUS_LABEL[statusOf(job)] || statusOf(job)}`}
                >
                  <div className="job-card-title">
                    <Status state={job} compact />
                    <strong>{job.name}</strong>
                    <Icon name="chevron" size={12} />
                  </div>
                  <div className="job-card-meta">
                    <code>{job.system || "Runner not reported"}</code>
                    <span>{duration(elapsed(job, now))}</span>
                  </div>
                  {Object.keys(job.matrix).length > 0 && (
                    <div className="matrix-values">
                      {Object.entries(job.matrix)
                        .slice(0, 4)
                        .map(([name, value]) => (
                          <span
                            key={name}
                            title={`${name}: ${typeof value === "object" ? JSON.stringify(value) : value}`}
                          >
                            {name}:{" "}
                            {typeof value === "object"
                              ? JSON.stringify(value)
                              : String(value)}
                          </span>
                        ))}
                    </div>
                  )}
                  <div className="job-card-bottom">
                    <span className={`job-state ${statusOf(job)}`}>
                      {STATUS_LABEL[statusOf(job)] || statusOf(job)}
                    </span>
                    {job.needs.length > 0 ? (
                      <span title={job.needs.join(", ")}>
                        {job.needs.length} prerequisite
                        {job.needs.length === 1 ? "" : "s"}
                      </span>
                    ) : (
                      <span>No prerequisites</span>
                    )}
                  </div>
                  {job.unresolvedDependencies && (
                    <span className="dependency-warning">
                      Some prerequisites have not been observed.
                    </span>
                  )}
                  {job.stale && (
                    <span className="dependency-warning">
                      Last heartbeat{" "}
                      {ago(job.heartbeatAt || job.lastEventAt, now)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        </React.Fragment>
      ))}
    </div>
  );
}

function Jobs({ jobs, selected, select, run, now }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const filtered = jobs.filter(
    (job) =>
      `${job.name} ${job.system} ${JSON.stringify(job.matrix)}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (status === "all" || statusOf(job) === status),
  );
  const start = timestamp(run.startedAt) ?? now;
  const span = Math.max(0.001, (observedEnd(run, now) ?? now) - start);
  return (
    <div className="jobs-panel">
      <div className="section-toolbar">
        <InputSearch
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Find jobs or matrix dimensions…"
          size="sm"
          ariaAttrs={{ "aria-label": "Search jobs" }}
          isFullWidth
        />
        <Select
          value={status}
          onChange={setStatus}
          options={[
            { value: "all", label: "All statuses" },
            ...STATUS_ORDER.filter((state) =>
              jobs.some((job) => statusOf(job) === state),
            ).map((state) => ({
              value: state,
              label: STATUS_LABEL[state] || state,
            })),
          ]}
          size="sm"
          ariaLabel="Filter job status"
        />
      </div>
      <div className="jobs-table" role="table" aria-label="Job attempts">
        <div className="jobs-table-header" role="row">
          <span role="columnheader">Job / matrix</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Duration</span>
          <span role="columnheader">Observed run timeline</span>
        </div>
        {filtered.map((job) => (
          <button
            className={`job-table-row ${job.key === selected ? "selected" : ""}`}
            role="row"
            key={job.key}
            onClick={() => select(job)}
          >
            <div role="cell">
              <strong>{job.name}</strong>
              <span>
                {job.system || "Unknown runner"} · attempt {job.attemptId}
              </span>
            </div>
            <div role="cell">
              <Status state={job} />
            </div>
            <code role="cell">{duration(elapsed(job, now))}</code>
            <div className="job-time-cell" role="cell">
              {timestamp(job.startedAt) !== null ? (
                <i
                  style={{
                    left: `${Math.max(0, ((job.startedAt - start) / span) * 100)}%`,
                    width: `${Math.max(0.5, Math.min(100, ((elapsed(job, now) || 0) / span) * 100))}%`,
                    background:
                      STATUS_COLOR[statusOf(job)] || STATUS_COLOR.unknown,
                  }}
                />
              ) : (
                <span>
                  {statusOf(job) === "planned"
                    ? "Awaiting invocation"
                    : "No start observed"}
                </span>
              )}
            </div>
          </button>
        ))}
        {!filtered.length && (
          <p className="inline-empty">No jobs match these filters.</p>
        )}
      </div>
    </div>
  );
}

function Diagnostics({ diagnostics, attention, select, now }) {
  return (
    <div className="diagnostics-panel">
      {attention.map((job) => (
        <button
          key={job.key}
          className={`diagnostic-row ${statusOf(job)}`}
          onClick={() => select(job)}
        >
          <Status state={job} compact />
          <div>
            <strong>{job.name}</strong>
            <p>
              {job.statusReason ||
                (job.stale
                  ? `No recent heartbeat. Last seen ${ago(job.heartbeatAt || job.lastEventAt, now)}; this is not evidence of a build failure.`
                  : statusOf(job) === "blocked"
                    ? "A required dependency did not complete successfully."
                    : statusOf(job) === "failed"
                      ? "The wrapped command reported a failure. Inspect its observed package activity and runner log."
                      : "A final outcome has not been observed for this invocation.")}
            </p>
          </div>
          <Icon name="chevron" size={16} />
        </button>
      ))}
      {diagnostics.map((item, index) => (
        <div className="diagnostic-row" key={item.id || index}>
          <Icon name="alert" />
          <div>
            <strong>
              {item.title || item.kind || item.type || "Collector diagnostic"}
            </strong>
            <p>
              {item.message ||
                (typeof item === "string" ? item : JSON.stringify(item))}
            </p>
          </div>
        </div>
      ))}
      {!attention.length && !diagnostics.length && (
        <Empty title="No issues reported" icon="check">
          There are no failures or uncertain invocation outcomes in the current
          snapshot. This does not establish the outcome of unobserved workflow
          steps.
        </Empty>
      )}
    </div>
  );
}

function WorkflowSteps({ github, jobs, invocations, select, now }) {
  const [expanded, setExpanded] = useState(new Map());
  const toggle = (id, value) =>
    setExpanded((previous) => new Map(previous).set(id, value));
  if (!github && !jobs.length)
    return (
      <Empty title="Waiting for GitHub reconciliation">
        Observed build commands are already available in the pipeline. When
        GitHub reconciliation is configured, this view includes every runner job
        and step, including setup failures before the wrapper starts.
      </Empty>
    );
  const measured = (item) => {
    const start = timestamp(item.startedAt),
      end = timestamp(item.completedAt);
    if (start === null) return null;
    // Provider reconciliation timestamps are milliseconds, unlike observed build events.
    return end !== null
      ? Math.max(0, (end - start) / 1000)
      : item.status === "in_progress"
        ? Math.max(0, now - start / 1000)
        : null;
  };
  return (
    <div className="workflow-jobs">
      <div className="section-toolbar">
        <div>
          <Text size="sm" weight="bold">
            GitHub runner evidence
          </Text>
          <span className="secondary">
            Setup, build, upload, and cleanup steps
          </span>
        </div>
        <External href={github?.url}>Open workflow</External>
      </div>
      {jobs.map((job) => {
        const state =
          job.conclusion ||
          (job.status === "completed" ? "unknown" : job.status);
        const failed = [
          "failure",
          "timed_out",
          "startup_failure",
          "action_required",
        ].includes(state);
        const open = expanded.get(job.id) ?? failed;
        const invocation = invocations.find(
          (item) =>
            item.github?.id === job.id ||
            (job.checkRunId && item.github?.checkRunId === job.checkRunId),
        );
        return (
          <section
            className={`workflow-job ${failed ? "failed" : ""}`}
            key={job.id}
          >
            <button
              className="workflow-job-toggle"
              onClick={() => toggle(job.id, !open)}
              aria-expanded={open}
            >
              <Icon
                name="chevron"
                size={13}
                className={open ? "expanded" : ""}
              />
              <Status state={statusOf({ status: state })} compact />
              <strong>{job.name}</strong>
              <span className="workflow-runner">
                {job.runnerName ||
                  (job.labels || []).join(", ") ||
                  "Runner not reported"}
              </span>
              <code>{duration(measured(job))}</code>
              <Status state={statusOf({ status: state })} />
            </button>
            {open && (
              <>
                <div className="workflow-job-context">
                  <span>
                    {invocation
                      ? "Matched to a recorded invocation by check-run ID."
                      : "No matching build invocation. Runner steps remain visible."}
                  </span>
                  {invocation && (
                    <Button
                      label="Inspect build activity"
                      size="xs"
                      isBorderless
                      onClick={() => select(invocation)}
                    />
                  )}
                  <External href={job.url}>Runner log</External>
                </div>
                <ol className="workflow-step-list">
                  {(job.steps || []).map((step) => (
                    <li key={step.number}>
                      <span className="step-number">{step.number}</span>
                      <Status
                        state={statusOf({
                          status:
                            step.conclusion ||
                            (step.status === "completed"
                              ? "unknown"
                              : step.status),
                        })}
                        compact
                      />
                      <span>{step.name}</span>
                      <code>{duration(measured(step))}</code>
                      <span className="step-outcome">
                        {step.conclusion?.replaceAll("_", " ") ||
                          step.status?.replaceAll("_", " ") ||
                          "Unknown"}
                      </span>
                    </li>
                  ))}
                </ol>
                {!job.steps?.length && (
                  <p className="inline-empty">
                    No step details reported by GitHub yet.
                  </p>
                )}
              </>
            )}
          </section>
        );
      })}
      {!jobs.length && (
        <p className="inline-empty">
          The workflow is known, but its jobs have not been returned by GitHub
          yet.
        </p>
      )}
    </div>
  );
}

function JobDetail({ job, jobs, run, activities, now, select, close, paused }) {
  const attempts = jobs.filter((item) => item.id === job.id);
  const prerequisites = job.needs.map(
    (id) =>
      latestJobs(jobs).find((item) => item.id === id) || {
        id,
        name: id,
        status: "unknown",
      },
  );
  return (
    <section className="job-detail" aria-label={`Job details: ${job.name}`}>
      <header className="job-detail-heading">
        <div>
          <span className="eyebrow">Invocation detail</span>
          <div className="job-detail-title">
            <Status state={job} compact />
            <h2>{job.name}</h2>
            <Status state={job} />
          </div>
          <div className="job-detail-meta">
            <code>{job.system || "Unknown runner"}</code>
            <span>{duration(elapsed(job, now))}</span>
            <span>
              Last event {ago(job.lastEventAt || job.heartbeatAt, now)}
            </span>
            {job.groupId && (
              <span>
                Group <code>{job.groupId}</code>
              </span>
            )}
          </div>
        </div>
        <div className="job-detail-actions">
          {attempts.length > 1 && (
            <Select
              value={job.key}
              onChange={(key) => select(jobs.find((item) => item.key === key))}
              options={attempts.map((item) => ({
                value: item.key,
                label: `Attempt ${item.attemptId} · ${STATUS_LABEL[statusOf(item)] || statusOf(item)}`,
              }))}
              size="sm"
              ariaLabel="Invocation attempt"
            />
          )}
          {safeUrl(job.url || run.url) && (
            <External href={job.url || run.url}>Runner log</External>
          )}
          <button
            className="icon-button"
            aria-label="Close job details"
            onClick={close}
          >
            <Icon name="close" size={17} />
          </button>
        </div>
      </header>
      {job.statusReason && (
        <div
          className={`notice ${statusOf(job) === "failed" ? "danger" : "muted"}`}
        >
          <Icon name="alert" />
          <span>{job.statusReason}</span>
        </div>
      )}
      {job.stale && (
        <div className="notice warning">
          <Icon name="alert" />
          <span>
            Updates stopped arriving. The timeline ends at the last observation;
            the worker may still be running.
          </span>
        </div>
      )}
      {prerequisites.length > 0 && (
        <div className="job-prerequisites">
          <span>Requires</span>
          {prerequisites.map((parent) => (
            <button
              key={parent.id}
              disabled={!parent.key}
              onClick={() => select(parent)}
            >
              <Status state={parent} compact />
              {parent.name}
            </button>
          ))}
        </div>
      )}
      <ActivityExplorer
        job={job}
        run={run}
        activities={activities}
        now={now}
        paused={paused}
      />
    </section>
  );
}

function ActivityExplorer({ job, run, activities, now, paused }) {
  const model = useMemo(
    () => activityModel(activities, job, run, now),
    [activities, job, run, now],
  );
  const [view, setView] = useState(() => ({
    from: model.start,
    to: model.end,
    density: "compact",
    expanded: new Set(),
    selection: null,
    search: "",
    kinds: new Set(Object.keys(KINDS)),
    follow: true,
    tab: "waterfall",
    sort: "start",
    contextMode: false,
  }));
  const [facets, setFacets] = useState(false);
  const patch = useCallback(
    (update) =>
      setView((previous) => ({
        ...previous,
        ...(typeof update === "function" ? update(previous) : update),
      })),
    [],
  );
  const resolvedView = view.follow
    ? { ...view, from: model.start, to: model.end }
    : {
        ...view,
        from: Math.max(model.start, view.from),
        to: Math.min(model.end, Math.max(view.from + 0.001, view.to)),
      };
  const setWindow = useCallback(
    (from, to) => {
      const [a, b] = clampWindow(from, to, model.start, model.end);
      patch({ from: a, to: b, follow: false });
    },
    [model.start, model.end, patch],
  );
  const zoom = useCallback(
    (factor, anchor = 0.5) =>
      setWindow(
        ...zoomWindow(
          resolvedView.from,
          resolvedView.to,
          factor,
          anchor,
          model.start,
          model.end,
        ),
      ),
    [resolvedView.from, resolvedView.to, model.start, model.end, setWindow],
  );
  const select = useCallback(
    (nodeId, rowId) => patch({ selection: { nodeId, rowId } }),
    [patch],
  );
  const focusRow = useCallback(
    (row) => {
      const span = Math.max(0.1, row.end - row.start),
        padding = span * 0.08;
      select(row.nodeId, row.id);
      setWindow(row.start - padding, row.end + padding);
    },
    [select, setWindow],
  );
  const query = useMemo(() => Query.compile(view.search), [view.search]);
  const allRows = useMemo(() => [...model.rows, ...model.untimed], [model]);
  const matches = (row) =>
    (query.terms.some((term) => term.field === "kind") ||
      view.kinds.has(row.kind)) &&
    (query.error || query.match(row));
  const filtered = allRows.filter(matches);
  const rows = (
    view.contextMode
      ? model.rows.filter(
          (row) =>
            query.terms.some((term) => term.field === "kind") ||
            view.kinds.has(row.kind),
        )
      : model.rows.filter(matches)
  ).sort((a, b) =>
    view.sort === "duration"
      ? b.seconds - a.seconds
      : view.sort === "name"
        ? a.name.localeCompare(b.name)
        : a.start - b.start,
  );
  const selected = allRows.find((row) => row.id === view.selection?.rowId);
  const changeKind = (kind) =>
    patch((previous) => {
      const kinds = new Set(previous.kinds);
      kinds.has(kind) ? kinds.delete(kind) : kinds.add(kind);
      const terms = Query.compile(previous.search).terms;
      let search = previous.search;
      for (let index = terms.length - 1; index >= 0; index--)
        if (terms[index].field === "kind")
          search = Query.removeTerm(search, index);
      return { kinds, search };
    });
  const live = !paused && statusOf(job) === "running";
  const activeCount = model.rows.filter((row) =>
    row.intervals.some((interval) => interval.open),
  ).length;
  return (
    <div className="activity-explorer">
      <div className="activity-summary">
        <div>
          <strong>{number(allRows.length)}</strong>
          <span>observed activities</span>
          <span className="dot-separator">·</span>
          <strong>{activeCount}</strong>
          <span>active</span>
          {model.untimed.length > 0 && (
            <span className="untimed-note">
              {model.untimed.length} without complete timing
            </span>
          )}
        </div>
        <div className="activity-tabs">
          <Button
            label="Waterfall"
            size="xs"
            isActive={view.tab === "waterfall"}
            isBorderless
            onClick={() => patch({ tab: "waterfall" })}
          />
          <Button
            label="Activity table"
            size="xs"
            isActive={view.tab === "table"}
            isBorderless
            onClick={() => patch({ tab: "table" })}
          />
        </div>
      </div>
      <div className="activity-query">
        <Button
          label={facets ? "Hide filters" : "Filters"}
          size="sm"
          isActive={facets}
          onClick={() => setFacets(!facets)}
        />
        <InputSearch
          value={view.search}
          onChange={(event) => patch({ search: event.target.value })}
          placeholder="Search activity… kind:build duration:>30s"
          size="sm"
          isFullWidth
          isMonospace
          ariaAttrs={{ "aria-label": "Search package activity" }}
          validationMessage={query.error || undefined}
        />
        <Select
          value={view.sort}
          onChange={(sort) => patch({ sort })}
          options={[
            { value: "start", label: "Start time" },
            { value: "duration", label: "Duration" },
            { value: "name", label: "Name" },
          ]}
          size="sm"
          ariaLabel="Activity ordering"
        />
      </div>
      {(query.terms.length > 0 || query.error) && (
        <div className="query-chips">
          {query.terms.map((term, index) => (
            <Button
              key={`${term.raw}:${index}`}
              label={`${term.raw} ×`}
              size="xs"
              isSoft
              onClick={() =>
                patch({ search: Query.removeTerm(view.search, index) })
              }
            />
          ))}
          {query.error && (
            <span role="alert" className="warning-text">
              {query.error}
            </span>
          )}
          {!query.error && <span>{filtered.length} matches</span>}
        </div>
      )}
      <div className={`activity-workbench ${facets ? "with-facets" : ""}`}>
        {facets && (
          <aside className="activity-facets">
            <h3>Activity type</h3>
            {Object.entries(KINDS)
              .filter(([kind]) => allRows.some((row) => row.kind === kind))
              .map(([kind, label]) => (
                <div className="facet-option" key={kind}>
                  <Checkbox
                    label={label}
                    isChecked={view.kinds.has(kind)}
                    onChange={() => changeKind(kind)}
                  />
                  <span>
                    {allRows.filter((row) => row.kind === kind).length}
                  </span>
                </div>
              ))}
            <h3>Query syntax</h3>
            <p>
              <code>kind:build</code>
              <br />
              <code>status:failed</code>
              <br />
              <code>duration:&gt;30s</code>
              <br />
              <code>name:postgresql</code>
              <br />
              <code>-kind:download</code>
            </p>
            <p>Combine terms with spaces. Quote values containing spaces.</p>
            <Button
              label="Reset filters"
              size="xs"
              isBorderless
              onClick={() =>
                patch({ search: "", kinds: new Set(Object.keys(KINDS)) })
              }
            />
          </aside>
        )}
        <div
          className="activity-chart"
          style={{
            "--live-waterfall-height": `${Math.min(480, Math.max(180, rows.length * (view.density === "compact" ? 28 : 38) + 30))}px`,
          }}
        >
          {view.tab === "waterfall" ? (
            <>
              {model.rows.length > 0 && (
                <TimelineOverview
                  model={model}
                  view={resolvedView}
                  setWindow={setWindow}
                />
              )}
              <div className="waterfall-toolbar">
                <div className="chart-legend">
                  {["build", "download", "upload", "import"]
                    .filter((kind) =>
                      model.rows.some((row) => row.kind === kind),
                    )
                    .map((kind) => (
                      <span key={kind}>
                        <i style={{ background: KINDS_COLOR[kind] }} />
                        {KINDS[kind]}
                      </span>
                    ))}
                </div>
                <div>
                  <Button
                    label={
                      view.follow
                        ? live
                          ? "Following live"
                          : "Fit run"
                        : "Follow run"
                    }
                    size="xs"
                    isActive={view.follow}
                    isBorderless
                    onClick={() => patch({ follow: true })}
                  />
                  <Button
                    label="−"
                    ariaLabel="Zoom out"
                    size="xs"
                    isBorderless
                    onClick={() => zoom(1.5)}
                  />
                  <Button
                    label="+"
                    ariaLabel="Zoom in"
                    size="xs"
                    isBorderless
                    onClick={() => zoom(1 / 1.5)}
                  />
                  <Button
                    label={
                      view.density === "compact" ? "Comfortable" : "Compact"
                    }
                    size="xs"
                    isBorderless
                    onClick={() =>
                      patch({
                        density:
                          view.density === "compact"
                            ? "comfortable"
                            : "compact",
                      })
                    }
                  />
                </div>
              </div>
              {model.rows.length ? (
                <Waterfall
                  rows={rows}
                  model={model}
                  view={resolvedView}
                  select={select}
                  focusRow={focusRow}
                  setWindow={setWindow}
                  zoom={zoom}
                  patch={patch}
                  matchIds={
                    view.contextMode && view.search
                      ? new Set(filtered.map((row) => row.id))
                      : null
                  }
                />
              ) : (
                <Empty
                  title={
                    allRows.length
                      ? "Timing evidence is incomplete"
                      : "Waiting for package activity"
                  }
                >
                  {allRows.length
                    ? "Activities have been reported, but their observed start and end times are not yet available. They remain visible in the activity table."
                    : statusOf(job) === "planned"
                      ? "This job has been planned and has not started its invocation."
                      : "The invocation has no measured Nix activity yet. Build, substitution, import, and publication intervals appear as they are reported."}
                </Empty>
              )}
              <div className="waterfall-help">
                <span>
                  Drag to zoom · Shift + drag to pan · ⌘ / Ctrl + wheel to zoom
                  · Double-click to fit
                </span>
                <span>
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> select <kbd>F</kbd> focus <kbd>0</kbd> fit
                </span>
              </div>
              {model.untimed.length > 0 && (
                <div className="untimed-strip">
                  {model.untimed.length} activities lack complete timing
                  evidence.
                  <Button
                    label="Show in table"
                    size="xs"
                    isBorderless
                    onClick={() => patch({ tab: "table" })}
                  />
                </div>
              )}
            </>
          ) : (
            <ActivityTable rows={filtered} select={select} />
          )}
        </div>
      </div>
      {selected && (
        <ActivityDetail
          row={selected}
          job={job}
          close={() => patch({ selection: null })}
          focus={() =>
            selected.start !== null &&
            selected.end !== null &&
            focusRow(selected)
          }
        />
      )}
    </div>
  );
}

function ActivityTable({ rows, select }) {
  const data = useMemo(
    () => rows.map((row) => ({ ...row, recordedDuration: row.seconds })),
    [rows],
  );
  const columns = useMemo(
    () => [
      {
        id: "name",
        Header: "Activity / package",
        accessor: "name",
        width: 340,
        Cell: ({ row }) => (
          <div className="table-activity-name">
            <strong>{row.original.name}</strong>
            {row.original.drvPath && <code>{row.original.drvPath}</code>}
          </div>
        ),
      },
      {
        id: "kind",
        Header: "Type",
        accessor: "kind",
        width: 110,
        Cell: ({ value }) => KINDS[value] || value,
      },
      {
        id: "status",
        Header: "Status",
        accessor: "state",
        width: 130,
        Cell: ({ value }) => <Status state={statusOf({ status: value })} />,
      },
      {
        id: "duration",
        Header: "Observed duration",
        accessor: "recordedDuration",
        width: 150,
        Cell: ({ value }) => <code>{duration(value)}</code>,
      },
      {
        id: "phase",
        Header: "Phase",
        accessor: "phase",
        width: 150,
        Cell: ({ value }) => value || "—",
      },
    ],
    [],
  );
  const options = useMemo(
    () => ({
      getRowId: (row) => row.id,
      pagination: { pageSize: 30 },
      sorting: { isEnabled: true },
      rowActions: {
        isEnabled: true,
        getOptions: ({ original }) => ({
          onClick: () => select(original.nodeId, original.id),
          "aria-label": `Inspect ${original.name}`,
        }),
      },
    }),
    [select],
  );
  return data.length ? (
    <div className="activity-table">
      <Table data={data} columns={columns} options={options} />
    </div>
  ) : (
    <p className="inline-empty">No activities match this query.</p>
  );
}

function ActivityDetail({ row, job, close, focus }) {
  return (
    <section
      className="activity-inspector"
      aria-label={`Activity details: ${row.name}`}
    >
      <header>
        <span
          className="activity-kind"
          style={{ background: KINDS_COLOR[row.kind] }}
        />
        <h3>{row.name}</h3>
        <Status state={statusOf({ status: row.state })} />
        <div className="inspector-actions">
          {row.start !== null && row.end !== null && (
            <Button
              label="Focus interval"
              size="xs"
              isBorderless
              onClick={focus}
            />
          )}
          <button
            className="icon-button"
            aria-label="Close activity details"
            onClick={close}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </header>
      <dl>
        <div>
          <dt>Activity</dt>
          <dd>{KINDS[row.kind] || row.kind}</dd>
        </div>
        <div>
          <dt>Observed duration</dt>
          <dd>{duration(row.seconds)}</dd>
        </div>
        <div>
          <dt>Start</dt>
          <dd>
            {row.start !== null
              ? new Date(row.start * 1000).toLocaleTimeString()
              : "Not observed"}
          </dd>
        </div>
        <div>
          <dt>End</dt>
          <dd>
            {row.finishedAt
              ? new Date(row.finishedAt * 1000).toLocaleTimeString()
              : row.intervals.some((interval) => interval.open)
                ? "In progress"
                : "Not confirmed"}
          </dd>
        </div>
        <div>
          <dt>Current / last phase</dt>
          <dd>{row.phase || "Not reported"}</dd>
        </div>
        <div>
          <dt>Invocation</dt>
          <dd>{job.name}</dd>
        </div>
        {row.progress && (
          <div>
            <dt>Progress</dt>
            <dd>
              {number(row.progress.done)} / {number(row.progress.expected)}
            </dd>
          </div>
        )}
      </dl>
      {row.drvPath && (
        <div className="derivation-path">
          <span>Derivation</span>
          <code>{row.drvPath}</code>
        </div>
      )}
      {row.estimated && (
        <p className="warning-text">
          The activity has no confirmed completion. Its displayed interval is
          bounded by the last producer observation.
        </p>
      )}
      <p className="inspector-note">
        Raw build logs remain in the runner log. Only measured build metadata is
        sent to this collector.
      </p>
    </section>
  );
}

createRoot(document.getElementById("root")).render(<App />);
