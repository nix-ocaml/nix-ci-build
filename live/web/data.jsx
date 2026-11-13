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
    runId,
    jobKey: query.get("job"),
    tab: query.get("view") || "pipeline",
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
      const path = next.runId ? `/runs/${encodeURIComponent(next.runId)}` : "/";
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
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "This run has not been observed by this collector."
        : `Collector returned HTTP ${response.status}.`,
    );
  return response.json();
}

export function useLiveData(runId, paused) {
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
  });
  refs.current.runId = runId;
  refs.current.paused = paused;

  const refresh = useCallback(async () => {
    const state = refs.current;
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
      generation === state.generation &&
      !controller.signal.aborted;
    try {
      const [list, detail] = await Promise.all([
        json("/api/runs", controller.signal),
        target
          ? json(`/api/runs/${encodeURIComponent(target)}`, controller.signal)
          : Promise.resolve(null),
      ]);
      if (!current()) return;
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
  }, [runId, refresh]);
  useEffect(() => {
    if (paused) {
      refs.current.controller?.abort();
      refs.current.generation++;
    } else refresh();
  }, [paused, refresh]);
  useEffect(() => {
    const state = refs.current;
    state.mounted = true;
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
    source.addEventListener("open", () => setConnection("live"));
    source.addEventListener("ready", () => {
      setConnection("live");
      schedule();
    });
    source.addEventListener("invalidate", schedule);
    source.addEventListener("error", () => setConnection("reconnecting"));
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
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

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
