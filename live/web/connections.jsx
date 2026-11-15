import React, { useState } from "react";
import { Text } from "@datadog/druids/typography/Text";
import { Button as DruidsButton } from "@datadog/druids/form/Button";
import { InputSearch } from "@datadog/druids/form/InputSearch";
import { Select } from "@datadog/druids/form/Select";
import {
  avatarUrl,
  repositoriesFor,
  safeNavigation,
  workspaceKey,
} from "./workspaces.js";

function Button(props) {
  return <DruidsButton isTitleCased={false} {...props} />;
}

export function Avatar({ account, size = "sm" }) {
  const [failed, setFailed] = useState(false);
  const src = avatarUrl(account?.avatarUrl);
  return (
    <span className={`account-avatar ${size}`} aria-hidden="true">
      {src && !failed ? (
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        (account?.login || account?.name || "?").slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

function GithubMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width="18"
      height="18"
      aria-hidden="true"
    >
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.61-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.64-1.33-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.5 9.5 0 0 1 12 6.83a9.5 9.5 0 0 1 2.5.34c1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.68-4.58 4.93.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>
  );
}

export function SessionScreen({
  session,
  loading,
  error,
  retry,
  theme,
  toggleTheme,
  expired,
}) {
  const url = new URL(
    safeNavigation(session?.signInUrl || "/auth/github", location.origin) ||
      "/auth/github",
    location.origin,
  );
  const returnQuery = new URLSearchParams(location.search);
  returnQuery.delete("auth_error");
  url.searchParams.set(
    "returnTo",
    location.pathname + (returnQuery.size ? `?${returnQuery}` : ""),
  );
  const signIn = safeNavigation(url.href, location.origin);
  const callbackFailed = new URLSearchParams(location.search).has("auth_error");
  return (
    <div className="session-screen">
      <header>
        <div className="session-wordmark">
          <span className="session-brand">◇</span>Build Observatory
        </div>
        <Button
          label={theme === "light" ? "Dark theme" : "Light theme"}
          size="sm"
          isBorderless
          onClick={toggleTheme}
        />
      </header>
      <main className="session-main">
        <div className="session-story">
          <span className="session-eyebrow">A clearer view of every build</span>
          <h1>
            From commit
            <br />
            to every package.
          </h1>
          <p>
            Follow your workflows as they happen. See the dependencies, find the
            slow builds, and understand what needs attention.
          </p>
          <div className="session-pipeline" aria-hidden="true">
            <div>
              <span>01</span>
              <strong>Plan</strong>
              <i />
            </div>
            <b>→</b>
            <div>
              <span>02</span>
              <strong>Dependencies</strong>
              <i />
              <i />
            </div>
            <b>→</b>
            <div>
              <span>03</span>
              <strong>Packages</strong>
              <i />
              <i />
              <i />
            </div>
          </div>
          <div className="session-highlights">
            <span>Live workflow progress</span>
            <span>Package-level timelines</span>
            <span>Personal & team workspaces</span>
          </div>
        </div>
        <section className="sign-in-card">
          {loading ? (
            <>
              <span className="sign-in-symbol">
                <GithubMark />
              </span>
              <Text as="h2" size="lg" weight="bold">
                Opening your workspace
              </Text>
              <p>Checking your session…</p>
              <div className="loading-bar" />
            </>
          ) : error ? (
            <>
              <span className="sign-in-symbol">!</span>
              <Text as="h2" size="lg" weight="bold">
                Unable to connect
              </Text>
              <p>{error}</p>
              <Button label="Try again" size="md" onClick={retry} />
            </>
          ) : (
            <>
              <span className="sign-in-symbol">
                <GithubMark />
              </span>
              <Text as="h2" size="lg" weight="bold">
                Welcome to your build workspace
              </Text>
              <p>
                {expired
                  ? "Your session has expired. Sign in again to continue where you left off."
                  : "Sign in with GitHub to see the repositories you and your teams have connected."}
              </p>
              {callbackFailed && (
                <div className="sign-in-error" role="alert">
                  GitHub sign-in could not be completed. Try again.
                </div>
              )}
              <a className="github-sign-in" href={signIn || "/auth/github"}>
                <GithubMark />
                Continue with GitHub<span>↗</span>
              </a>
              <div className="sign-in-note">
                Your repository access follows your GitHub permissions.
              </div>
            </>
          )}
        </section>
      </main>
      <footer>One place to understand your builds.</footer>
    </div>
  );
}

export function WorkspaceSwitcher({
  session,
  workspace,
  repository,
  runs,
  changeWorkspace,
  changeRepository,
  openConnections,
}) {
  const connections = session.connections || [];
  const selected = connections.find((item) => workspaceKey(item) === workspace);
  const repositories = repositoriesFor(session, workspace, runs);
  const options = [
    {
      value: "all",
      label: session.mode === "local" ? "All repositories" : "All workspaces",
    },
    ...connections.map((connection) => ({
      value: workspaceKey(connection),
      label: `${connection.account.login}${connection.account.type === "Organization" ? " · Team" : " · Personal"}`,
    })),
  ];
  return (
    <div className="workspace-switcher">
      {session.mode === "github" && (
        <>
          <div className="workspace-heading">
            <span>Workspace</span>
            <button onClick={openConnections}>Manage</button>
          </div>
          <div className="workspace-selection">
            <Avatar account={selected?.account || session.user} />
            <Select
              options={options}
              value={workspace}
              onChange={changeWorkspace}
              ariaLabel="Workspace"
              isFullWidth
              size="sm"
            />
          </div>
        </>
      )}
      <div className="repository-filter">
        <span>
          Repository <b>{repositories.length}</b>
        </span>
        <Select
          options={[
            {
              value: "all",
              label: `All repositories (${repositories.length})`,
            },
            ...repositories.map((item) => ({
              value: item.fullName,
              label: item.fullName,
            })),
          ]}
          value={repository}
          onChange={changeRepository}
          ariaLabel="Repository"
          isFullWidth
          size="sm"
        />
      </div>
    </div>
  );
}

export function ConnectionsPanel({
  session,
  refresh,
  refreshing,
  error,
  openWorkspace,
  notice,
}) {
  const [query, setQuery] = useState("");
  const connections = session.connections || [];
  const total = repositoriesFor(session).length;
  const installUrl = safeNavigation(session.installUrl, location.origin);
  const visibleConnections = connections.filter(
    (connection) =>
      connection.account.login.toLowerCase().includes(query.toLowerCase()) ||
      (connection.repositories || []).some((repository) =>
        repository.fullName.toLowerCase().includes(query.toLowerCase()),
      ),
  );
  return (
    <section className="connections-page">
      <div className="connections-breadcrumb">Account / Connections</div>
      <header>
        <div>
          <h1>Your GitHub connections</h1>
          <p>
            Bring your personal projects and team repositories into one build
            view.
          </p>
        </div>
        <div className="connections-actions">
          <Button
            label={refreshing ? "Refreshing…" : "Refresh connections"}
            size="sm"
            isDisabled={refreshing}
            onClick={refresh}
          />
          {installUrl && (
            <Button
              label="Connect a workspace"
              href={installUrl}
              isExternal
              size="sm"
            />
          )}
        </div>
      </header>
      <div className="connected-identity">
        <Avatar account={session.user} size="lg" />
        <div>
          <strong>{session.user.name || session.user.login}</strong>
          <span>@{session.user.login}</span>
        </div>
        <div className="connected-totals">
          <strong>{connections.length}</strong> workspace
          {connections.length === 1 ? "" : "s"}
          <span>·</span>
          <strong>{total}</strong> repositor{total === 1 ? "y" : "ies"}
        </div>
      </div>
      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice muted" role="status">
          {notice}
        </div>
      )}
      {connections.length ? (
        <>
          <div className="connections-search">
            <InputSearch
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a workspace or repository…"
              isFullWidth
              size="sm"
              ariaAttrs={{ "aria-label": "Search connections" }}
            />
            <span>Repository access is managed on GitHub.</span>
          </div>
          <div className="connection-cards">
            {visibleConnections.map((connection) => (
              <ConnectionCard
                key={connection.installationId}
                connection={connection}
                query={query}
                openWorkspace={openWorkspace}
                installUrl={installUrl}
              />
            ))}
          </div>
          {!visibleConnections.length && (
            <p className="inline-empty">
              No workspaces or repositories match this search.
            </p>
          )}
        </>
      ) : (
        <div className="connect-empty">
          <div className="connect-illustration">
            <span>◇</span>
            <i />
            <GithubMark />
          </div>
          <h2>Connect your first workspace</h2>
          <p>
            Choose a personal account or organization on GitHub, then select the
            repositories whose builds you want to follow.
          </p>
          {installUrl ? (
            <Button
              label="Choose repositories on GitHub"
              href={installUrl}
              isExternal
              size="md"
            />
          ) : (
            <p className="connection-unavailable">
              New connections are not available right now. Refresh to check for
              an existing connection.
            </p>
          )}
          <span>
            Already connected? Refresh connections to bring it into view.
          </span>
        </div>
      )}
      <div className="connections-footnote">
        <strong>You stay in control.</strong>
        <span>
          Only repositories you can access on GitHub appear here. If a workspace
          is missing, check its installation and repository access on GitHub,
          then refresh.
        </span>
      </div>
    </section>
  );
}

function ConnectionCard({ connection, query, openWorkspace, installUrl }) {
  const [expanded, setExpanded] = useState(false);
  const account = connection.account;
  const matchAccount = account.login
    .toLowerCase()
    .includes(query.toLowerCase());
  const repositories = (connection.repositories || []).filter(
    (repository) =>
      matchAccount ||
      repository.fullName.toLowerCase().includes(query.toLowerCase()),
  );
  if (query && !matchAccount && !repositories.length) return null;
  const shown = expanded || query ? repositories : repositories.slice(0, 5);
  return (
    <article className="connection-card">
      <header>
        <Avatar account={account} size="lg" />
        <div>
          <h2>{account.login}</h2>
          <span>
            {account.type === "Organization"
              ? "Organization workspace"
              : "Personal workspace"}
          </span>
        </div>
        <span className="connection-installed">
          <i />
          Connected
        </span>
      </header>
      <div className="connection-repositories-heading">
        <span>Repositories</span>
        <strong>{connection.repositories?.length || 0}</strong>
      </div>
      <ul>
        {shown.map((repository) => (
          <li key={repository.id || repository.fullName}>
            <span className="repo-glyph" aria-hidden="true">
              ▤
            </span>
            <button
              onClick={() =>
                openWorkspace(workspaceKey(connection), repository.fullName)
              }
            >
              {repository.fullName}
            </button>
            <span className="repository-visibility">
              {repository.private ? "Private" : "Public"}
            </span>
          </li>
        ))}
      </ul>
      {!repositories.length && (
        <p className="no-repositories">
          No accessible repositories in this workspace.
        </p>
      )}
      {repositories.length > 5 && !query && (
        <button
          className="show-repositories"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? "Show fewer repositories"
            : `Show ${repositories.length - 5} more repositories`}
        </button>
      )}
      <footer>
        <Button
          label="View builds"
          size="sm"
          onClick={() => openWorkspace(workspaceKey(connection), "all")}
        />
        {installUrl && (
          <a href={installUrl} target="_blank" rel="noreferrer">
            Manage access ↗
          </a>
        )}
      </footer>
    </article>
  );
}
