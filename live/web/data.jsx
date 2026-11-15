import { useCallback, useEffect, useRef, useState } from "react";
import { normalizePayload } from "./model.js";

export function readLocation() {
  let runId = null;
  const match = location.pathname.match(/^\/runs\/(.+?)\/?$/);
  if (match)
    try {
      runId = decodeURIComponent(match[1]);
    } catch {}
  const query = new URLSearchParams(location.search);
  return {
    page:
      location.pathname.replace(/\/$/, "") === "/connections"
        ? "connections"
        : "runs",
    runId,
    jobKey: query.get("job"),
    tab: query.get("view") || "pipeline",
    workspace: query.get("workspace") || "all",
    repository: query.get("repository") || "all",
  };
}

export function useLocation() {
  const [route, setRoute] = useState(readLocation);
  useEffect(() => {
    const change = () => setRoute(readLocation());
    window.addEventListener("popstate", change);
    return () => window.removeEventListener("popstate", change);
  }, []);
  const navigate = useCallback((change, replace = false) => {
    setRoute((previous) => {
      const next = { ...previous, ...change };
      const params = new URLSearchParams();
      if (next.jobKey) params.set("job", next.jobKey);
      if (next.tab && next.tab !== "pipeline") params.set("view", next.tab);
      if (next.workspace && next.workspace !== "all")
        params.set("workspace", next.workspace);
      if (next.repository && next.repository !== "all")
        params.set("repository", next.repository);
      const path =
        next.page === "connections"
          ? "/connections"
          : next.runId
            ? `/runs/${encodeURIComponent(next.runId)}`
            : "/";
      history[replace ? "replaceState" : "pushState"](
        {},
        "",
        path + (params.size ? `?${params}` : ""),
      );
      return next;
    });
  }, []);
  return [route, navigate];
}

async function json(url, signal) {
  const response = await fetch(url, {
    signal,
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const error = new Error(
      response.status === 401
        ? "Your session has expired."
        : response.status === 403
          ? "You no longer have access to this run."
          : response.status === 404
            ? "This run is not available in your workspace."
            : "Build updates are temporarily unavailable.",
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export function useSession() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mutationError, setMutationError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [expired, setExpired] = useState(false);
  const [notice, setNotice] = useState("");
  const refs = useRef({ session: null, generation: 0 });
  refs.current.session = session;
  const load = useCallback(async (options = {}) => {
    const background = options.background === true;
    const generation = ++refs.current.generation;
    if (!background) setLoading(true);
    setError(null);
    try {
      const result = await json("/api/session");
      if (!["local", "github"].includes(result.mode))
        throw new Error("Unable to open your workspace. Please try again.");
      if (generation !== refs.current.generation) return;
      setSession({ ...result, connections: result.connections || [] });
      setLoading(false);
    } catch {
      if (generation !== refs.current.generation) return;
      setLoading(false);
      if (background)
        setMutationError(
          "We couldn't update your repository access. Refresh connections to try again.",
        );
      else
        setError(
          "We couldn't reach your workspace. Check your connection and try again.",
        );
    }
  }, []);
  useEffect(() => {
    load();
    return () => {
      refs.current.generation++;
    };
  }, [load]);
  const expire = useCallback(() => {
    refs.current.generation++;
    setSession((previous) => ({
      ...previous,
      mode: "github",
      user: null,
      connections: [],
    }));
    setExpired(true);
    setMutationError(null);
    setNotice("");
  }, []);
  const mutate = useCallback(
    async (path) => {
      const csrfToken = refs.current.session?.csrfToken;
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
        },
        body: "{}",
      });
      if (response.status === 401) {
        expire();
        throw new Error("Please sign in again to continue.");
      }
      if (!response.ok)
        throw new Error(
          path === "/auth/logout"
            ? "We couldn't sign you out. Please try again."
            : "We couldn't refresh your connections. Your previous view is still available.",
        );
      return response.json();
    },
    [expire],
  );
  const refreshConnections = useCallback(async () => {
    const generation = refs.current.generation;
    setRefreshing(true);
    setMutationError(null);
    setNotice("");
    try {
      const result = await mutate("/api/connections/refresh");
      if (generation !== refs.current.generation) return;
      setSession({ ...result, connections: result.connections || [] });
      setNotice("Connections refreshed. Your repository access is up to date.");
    } catch (cause) {
      setMutationError(cause.message);
    } finally {
      setRefreshing(false);
    }
  }, [mutate]);
  const signOut = useCallback(async () => {
    refs.current.generation++;
    setSigningOut(true);
    setMutationError(null);
    try {
      await mutate("/auth/logout");
      refs.current.generation++;
      setSession((previous) => ({
        ...previous,
        user: null,
        connections: [],
        csrfToken: undefined,
      }));
      setExpired(false);
    } catch (cause) {
      setMutationError(cause.message);
    } finally {
      setSigningOut(false);
    }
  }, [mutate]);
  return {
    session,
    loading,
    error,
    load,
    expire,
    expired,
    refreshConnections,
    refreshing,
    mutationError,
    notice,
    signOut,
    signingOut,
  };
}

export function useLiveData(
  runId,
  paused,
  enabled = true,
  onUnauthorized,
  onAccess,
) {
  const [runs, setRuns] = useState([]);
  const [payload, setPayload] = useState(null);
  const [connection, setConnection] = useState("connecting");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [receivedAt, setReceivedAt] = useState(null);
  const [serverTime, setServerTime] = useState(null);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const refs = useRef({
    runId,
    paused,
    controller: null,
    generation: 0,
    timer: null,
    mounted: true,
    enabled,
    onUnauthorized,
  });
  refs.current.runId = runId;
  refs.current.paused = paused;
  refs.current.enabled = enabled;
  refs.current.onUnauthorized = onUnauthorized;
  refs.current.onAccess = onAccess;

  const refresh = useCallback(async () => {
    const state = refs.current;
    if (!state.enabled) return;
    if (state.paused) {
      setPending(true);
      return;
    }
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const generation = ++state.generation,
      target = state.runId;
    const current = () =>
      state.mounted &&
      state.enabled &&
      generation === state.generation &&
      !controller.signal.aborted;
    try {
      const [listResult, detailResult] = await Promise.allSettled([
        json("/api/runs", controller.signal),
        target
          ? json(`/api/runs/${encodeURIComponent(target)}`, controller.signal)
          : Promise.resolve(null),
      ]);
      if (!current()) return;
      if (listResult.status === "fulfilled")
        setRuns(listResult.value.runs || []);
      // An explicit denial takes precedence over a concurrent transient failure.
      const accessFailure = [listResult, detailResult].find(
        (result) =>
          result.status === "rejected" &&
          [401, 403, 404].includes(result.reason.status),
      );
      if (accessFailure) throw accessFailure.reason;
      if (listResult.status === "rejected") throw listResult.reason;
      if (detailResult.status === "rejected") throw detailResult.reason;
      const list = listResult.value,
        detail = detailResult.value;
      setRuns(list.runs || []);
      setPayload(detail ? normalizePayload(detail) : null);
      setRevision(Math.max(list.revision || 0, detail?.revision || 0));
      setServerTime(detail?.now ?? list.now ?? Date.now() / 1000);
      setReceivedAt(Date.now() / 1000);
      setError(null);
      setPending(false);
      setLoading(false);
    } catch (cause) {
      if (!current()) return;
      if (cause.status === 401) {
        setRuns([]);
        setPayload(null);
        setConnection("signed-out");
        setLoading(false);
        state.source?.close();
        state.onUnauthorized?.();
        return;
      }
      if (cause.status === 403 || cause.status === 404) {
        setPayload(null);
        setReceivedAt(null);
        setServerTime(null);
        setPending(false);
        state.onAccess?.({ background: true });
      }
      setError(cause.message);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPayload(null);
    setLoading(true);
    setError(null);
    // Navigation is explicit even while an existing view is paused.
    if (!refs.current.paused) refresh();
  }, [runId, enabled, refresh]);
  useEffect(() => {
    if (paused) {
      refs.current.controller?.abort();
      refs.current.generation++;
    } else refresh();
  }, [paused, enabled, refresh]);
  useEffect(() => {
    const state = refs.current;
    state.mounted = true;
    if (!enabled) {
      setRuns([]);
      setPayload(null);
      setLoading(false);
      setError(null);
      setConnection("idle");
      return;
    }
    setConnection("connecting");
    const schedule = () => {
      if (state.paused) {
        setPending(true);
        return;
      }
      if (!state.timer)
        state.timer = setTimeout(() => {
          state.timer = null;
          refresh();
        }, 300);
    };
    const source = new EventSource("/api/events");
    state.source = source;
    source.addEventListener("open", () => setConnection("live"));
    source.addEventListener("ready", () => {
      setConnection("live");
      schedule();
    });
    source.addEventListener("invalidate", schedule);
    source.addEventListener("access", () =>
      state.onAccess?.({ background: true }),
    );
    source.addEventListener("auth", () => {
      source.close();
      setRuns([]);
      setPayload(null);
      setConnection("signed-out");
      state.onUnauthorized?.();
    });
    source.addEventListener("error", () => {
      setConnection("reconnecting");
      refresh();
    });
    const poll = setInterval(refresh, 15000);
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      state.mounted = false;
      source.close();
      state.controller?.abort();
      clearInterval(poll);
      clearTimeout(state.timer);
      state.timer = null;
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled, refresh]);

  return {
    runs,
    payload,
    connection,
    error,
    loading,
    receivedAt,
    serverTime,
    revision,
    pending,
    refresh,
  };
}

export function useClock(serverTime, receivedAt, paused, disconnected) {
  const [clock, setClock] = useState(Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  return serverTime === null
    ? clock
    : paused || disconnected
      ? serverTime
      : serverTime + Math.max(0, clock - (receivedAt ?? clock));
}
