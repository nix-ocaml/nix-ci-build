export function workspaceKey(connection) {
  return String(connection.installationId);
}

export function repositoriesFor(session, workspace = "all", runs = []) {
  const repositories = new Map();
  if (session?.mode === "local") {
    for (const run of runs)
      if (run.repository)
        repositories.set(run.repository.toLowerCase(), {
          id: run.repositoryId ?? null,
          fullName: run.repository,
          private: null,
        });
  } else {
    for (const connection of session?.connections || []) {
      if (workspace !== "all" && workspaceKey(connection) !== workspace)
        continue;
      for (const repository of connection.repositories || []) {
        if (repository.fullName)
          repositories.set(repository.fullName.toLowerCase(), repository);
      }
    }
  }
  return [...repositories.values()].sort((a, b) =>
    a.fullName.localeCompare(b.fullName),
  );
}

export function filterWorkspaceRuns(
  runs,
  session,
  workspace = "all",
  repository = "all",
) {
  const repositories = repositoriesFor(session, workspace, runs);
  const names = new Set(
    repositories.map((item) => item.fullName.toLowerCase()),
  );
  const ids = new Set(
    repositories
      .filter((item) => item.id != null)
      .map((item) => String(item.id)),
  );
  const selectedRepository = repositories.find(
    (item) =>
      item.fullName.toLowerCase() === repository.toLowerCase() ||
      String(item.id) === repository,
  );
  return runs.filter((run) => {
    const name = String(run.repository || "").toLowerCase();
    const accessible =
      session?.mode === "local" ||
      names.has(name) ||
      (run.repositoryId != null && ids.has(String(run.repositoryId)));
    if (!accessible) return false;
    return (
      repository === "all" ||
      name === repository.toLowerCase() ||
      (run.repositoryId != null &&
        selectedRepository?.id != null &&
        String(run.repositoryId) === String(selectedRepository.id)) ||
      (run.repositoryId != null && String(run.repositoryId) === repository)
    );
  });
}

export function safeNavigation(value, origin = "http://localhost") {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value, origin);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.origin === origin
      ? url.pathname + url.search + url.hash
      : url.href;
  } catch {
    return null;
  }
}

export function avatarUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "avatars.githubusercontent.com"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function overallStatus(run, fallback) {
  const value = run?.workflowStatus;
  if (!value) return fallback;
  return (
    {
      failure: "failed",
      in_progress: "running",
      completed: "unknown",
      pending: "queued",
      canceled: "cancelled",
      timed_out: "failed",
      action_required: "failed",
      neutral: "neutral",
    }[value] || value
  );
}
