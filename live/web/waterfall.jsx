import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@datadog/druids/form/Button";
import { Text } from "@datadog/druids/typography/Text";
import { Query } from "./model.js";
import {
  clampWindow,
  zoomWindow,
  panWindow,
  timeTicks,
  formatTime,
  minimumSpan,
} from "./timeline-math.js";
import "./waterfall.css";

const KINDS = {
  evaluation: { label: "Evaluation", color: "#6882c8" },
  planning: { label: "Planning", color: "#b6954d" },
  request: { label: "Request", color: "#8796b0" },
  build: { label: "Build", color: "#9d72c6" },
  download: { label: "Download", color: "#4a9fad" },
  wait: { label: "Wait", color: "#c39437" },
  upload: { label: "Cache sync", color: "#b975a5" },
  import: { label: "Cache import", color: "#55a584" },
};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const count = (value) => Number(value || 0).toLocaleString("en-US");
const elapsed = (value) => formatTime(value, value < 10 ? 0.01 : 1);
const isPhase = (value) =>
  Number.isFinite(value?.start) &&
  Number.isFinite(value?.end) &&
  value.end >= value.start;
const kindInfo = (row) => KINDS[row.kind] || KINDS.request;

function phaseEntries(row) {
  if (row.kind !== "build") return [];
  return row.intervals
    .flatMap((interval, intervalIndex) =>
      (interval.phases || []).flatMap((phase, phaseIndex) =>
        isPhase(phase)
          ? [
              {
                id: `${row.id}:phase:${intervalIndex}:${phaseIndex}`,
                row,
                phase,
                name: phase.name,
                seconds: phase.end - phase.start,
                start: phase.start,
                end: phase.end,
                intervals: [
                  { ...phase, estimated: !!phase.boundedByActivityEnd },
                ],
                phaseCount: 0,
              },
            ]
          : [],
      ),
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function flattenRows(rows, expanded) {
  return rows.flatMap((row) => {
    const phases = phaseEntries(row);
    const parent = {
      id: row.id,
      row,
      name: row.name,
      seconds: row.seconds,
      start: row.start,
      end: row.end,
      intervals: row.intervals,
      phaseCount: phases.length,
    };
    return expanded?.has(row.id) ? [parent, ...phases] : [parent];
  });
}

function Chevron({ expanded }) {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d={expanded ? "M3 4.5 6 7.5 9 4.5" : "M4.5 3 7.5 6 4.5 9"} />
    </svg>
  );
}

function ActionButton(props) {
  return <Button isTitleCased={false} size="xs" isBorderless {...props} />;
}

export default function Waterfall({
  rows,
  model,
  view,
  select,
  focusRow,
  setWindow,
  zoom,
  patch,
  getLogUrl,
  matchIds,
}) {
  const shell = useRef(null);
  const viewport = useRef(null);
  const ruler = useRef(null);
  const gesture = useRef(null);
  const resize = useRef(null);
  const suppressClick = useRef(false);
  const [scroll, setScroll] = useState(0);
  const [geometry, setGeometry] = useState({
    width: 900,
    height: 450,
    scrollbar: 0,
  });
  const [labelPreview, setLabelPreview] = useState(null);
  const [tooltip, setTooltip] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [dragPreview, setDragPreview] = useState(null);
  const idPrefix = useId().replace(/:/g, "");
  const rowHeight = view.density === "comfortable" ? 38 : 28;
  const defaultLabelWidth = geometry.width < 600 ? 145 : 280;
  const minimumLabelWidth = geometry.width < 600 ? 115 : 160;
  const maximumLabelWidth = Math.max(
    minimumLabelWidth,
    Math.min(520, geometry.width - (geometry.width < 600 ? 210 : 260)),
  );
  const labelWidth = clamp(
    labelPreview ?? view.labelWidth ?? defaultLabelWidth,
    minimumLabelWidth,
    maximumLabelWidth,
  );
  const plotWidth = Math.max(
    1,
    geometry.width - geometry.scrollbar - labelWidth - 1,
  );
  const span = Math.max(
    minimumSpan(model.start, model.end),
    view.to - view.from,
  );
  const expanded = view.expanded;
  const entries = useMemo(() => flattenRows(rows, expanded), [rows, expanded]);
  const activeIndex = useMemo(() => {
    const exact = entries.findIndex(
      (entry) =>
        entry.id === activeId && entry.row.id === view.selection?.rowId,
    );
    return exact >= 0
      ? exact
      : entries.findIndex(
          (entry) => !entry.phase && entry.id === view.selection?.rowId,
        );
  }, [entries, activeId, view.selection?.rowId]);
  const activeEntry = entries[activeIndex];
  const ticks = useMemo(
    () => timeTicks(view.from, view.to, model.start, plotWidth),
    [view.from, view.to, model.start, plotWidth],
  );
  const first = Math.max(0, Math.floor(scroll / rowHeight) - 7);
  const last = Math.min(
    entries.length,
    first + Math.ceil(geometry.height / rowHeight) + 15,
  );
  const relative = (time) => clamp(((time - view.from) / span) * 100, 0, 100);

  useLayoutEffect(() => {
    const element = viewport.current;
    const measure = () =>
      setGeometry({
        width: element.offsetWidth,
        height: element.clientHeight,
        scrollbar: element.offsetWidth - element.clientWidth,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (activeIndex < 0) {
      viewport.current.scrollTop = 0;
      setScroll(0);
    }
    setTooltip(null);
  }, [
    view.search,
    view.outcome,
    view.kinds,
    view.sort,
    view.focus,
    activeIndex,
  ]);

  useLayoutEffect(() => {
    if (activeIndex < 0) return;
    const element = viewport.current;
    const top = activeIndex * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + element.clientHeight)
      element.scrollTop = top + rowHeight - element.clientHeight;
    setScroll(element.scrollTop);
  }, [activeIndex, rowHeight]);

  const toggleExpanded = useCallback(
    (rowId, shouldExpand) => {
      patch((previous) => {
        const next = new Set(previous.expanded || []);
        const open = shouldExpand ?? !next.has(rowId);
        if (open) next.add(rowId);
        else next.delete(rowId);
        return { expanded: next };
      });
    },
    [patch],
  );

  const activate = useCallback(
    (entry, focus = true) => {
      if (!entry) return;
      setActiveId(entry.id);
      select(entry.row.nodeId, entry.row.id);
      if (focus) viewport.current.focus({ preventScroll: true });
    },
    [select],
  );

  const focusEntry = useCallback(
    (entry) => {
      if (!entry) return;
      if (!entry.phase) focusRow(entry.row);
      else {
        const padding = Math.max(
          minimumSpan(model.start, model.end),
          entry.seconds * 0.08,
        );
        setWindow(
          ...clampWindow(
            entry.start - padding,
            entry.end + padding,
            model.start,
            model.end,
          ),
        );
      }
    },
    [focusRow, setWindow, model.start, model.end],
  );

  const cancelGesture = useCallback(() => {
    const current = gesture.current;
    if (current) suppressClick.current = true;
    gesture.current = null;
    resize.current = null;
    setLabelPreview(null);
    setDragPreview(null);
    setTooltip(null);
    if (current?.moved && current.mode === "pan")
      setWindow(current.from, current.to);
  }, [setWindow]);

  useEffect(() => {
    const cancel = (event) => {
      if (event.key !== "Escape" || (!gesture.current && !resize.current))
        return;
      event.preventDefault();
      event.stopPropagation();
      cancelGesture();
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [cancelGesture]);

  useEffect(() => {
    const element = shell.current;
    const listener = (event) => {
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return;
      if (!event.target.closest(".wf-chart, .wf-ruler")) return;
      const rect = ruler.current.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right) return;
      event.preventDefault();
      setTooltip(null);
      const scale =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? geometry.height
            : 1;
      if (event.ctrlKey || event.metaKey) {
        const delta = event.deltaY * scale;
        const anchor = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        setWindow(
          ...zoomWindow(
            view.from,
            view.to,
            Math.exp(clamp(delta, -300, 300) * 0.005),
            anchor,
            model.start,
            model.end,
          ),
        );
      } else {
        const delta =
          (Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY) * scale;
        setWindow(
          ...panWindow(
            view.from,
            view.to,
            (delta / rect.width) * span,
            model.start,
            model.end,
          ),
        );
      }
    };
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, [
    view.from,
    view.to,
    span,
    model.start,
    model.end,
    setWindow,
    geometry.height,
  ]);

  const pointerDown = (event) => {
    suppressClick.current = false;
    if (event.button !== 0 || resize.current) return;
    const target = event.target.closest(".wf-chart, .wf-ruler");
    if (
      !target ||
      (event.pointerType === "touch" && !target.classList.contains("wf-ruler"))
    )
      return;
    const rect = ruler.current.getBoundingClientRect();
    gesture.current = {
      pointerId: event.pointerId,
      mode: event.shiftKey ? "pan" : "range",
      x: event.clientX,
      currentX: event.clientX,
      rect,
      from: view.from,
      to: view.to,
      moved: false,
    };
    event.target.setPointerCapture(event.pointerId);
  };

  const pointerMove = (event) => {
    if (resize.current) {
      const next = clamp(
        resize.current.width + event.clientX - resize.current.x,
        minimumLabelWidth,
        maximumLabelWidth,
      );
      setLabelPreview(next);
      return;
    }
    const current = gesture.current;
    if (current) {
      current.currentX = event.clientX;
      const delta = event.clientX - current.x;
      if (!current.moved && Math.abs(delta) <= 4) return;
      current.moved = true;
      suppressClick.current = true;
      setTooltip(null);
      setCursor(null);
      const width = current.to - current.from;
      if (current.mode === "pan") {
        setDragPreview({ mode: "pan" });
        setWindow(
          ...panWindow(
            current.from,
            current.to,
            (-delta / current.rect.width) * width,
            model.start,
            model.end,
          ),
        );
      } else {
        const a =
          current.from +
          clamp((current.x - current.rect.left) / current.rect.width, 0, 1) *
            width;
        const b =
          current.from +
          clamp(
            (event.clientX - current.rect.left) / current.rect.width,
            0,
            1,
          ) *
            width;
        setDragPreview({
          mode: "range",
          from: Math.min(a, b),
          to: Math.max(a, b),
        });
      }
      return;
    }
    const plot = event.target.closest(".wf-chart, .wf-ruler");
    if (plot && event.pointerType !== "touch") {
      const rect = ruler.current.getBoundingClientRect();
      setCursor(clamp((event.clientX - rect.left) / rect.width, 0, 1));
    } else setCursor(null);
  };

  const pointerUp = (event) => {
    if (resize.current) {
      const width = clamp(
        resize.current.width + event.clientX - resize.current.x,
        minimumLabelWidth,
        maximumLabelWidth,
      );
      resize.current = null;
      setLabelPreview(null);
      patch({ labelWidth: width });
      return;
    }
    const current = gesture.current;
    gesture.current = null;
    setDragPreview(null);
    if (!current?.moved) return;
    if (current.mode === "range") {
      const width = current.to - current.from;
      const a =
        current.from +
        clamp((current.x - current.rect.left) / current.rect.width, 0, 1) *
          width;
      const b =
        current.from +
        clamp((event.clientX - current.rect.left) / current.rect.width, 0, 1) *
          width;
      setWindow(...clampWindow(a, b, model.start, model.end));
    }
    viewport.current.focus({ preventScroll: true });
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape" && (gesture.current || resize.current)) {
      event.preventDefault();
      event.stopPropagation();
      cancelGesture();
      return;
    }
    if (!entries.length) return;
    let next = activeIndex;
    if (event.key === "ArrowDown")
      next =
        activeIndex < 0 ? 0 : Math.min(entries.length - 1, activeIndex + 1);
    else if (event.key === "ArrowUp")
      next =
        activeIndex < 0 ? entries.length - 1 : Math.max(0, activeIndex - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = entries.length - 1;
    else if (event.key === "ArrowRight" && activeEntry?.phaseCount) {
      if (!expanded?.has(activeEntry.row.id))
        toggleExpanded(activeEntry.row.id, true);
      else next = Math.min(entries.length - 1, activeIndex + 1);
    } else if (event.key === "ArrowLeft" && activeEntry) {
      if (activeEntry.phase)
        next = entries.findIndex((entry) => entry.id === activeEntry.row.id);
      else toggleExpanded(activeEntry.row.id, false);
    } else if (event.key === "Enter" || event.key === " ")
      activate(activeEntry || entries[0]);
    else if (
      event.key.toLowerCase() === "f" &&
      !event.ctrlKey &&
      !event.metaKey
    )
      focusEntry(activeEntry);
    else if (event.key === "+" || event.key === "=") zoom(0.65);
    else if (event.key === "-" || event.key === "_") zoom(1 / 0.65);
    else if (event.key === "0") setWindow(model.start, model.end);
    else return;
    event.preventDefault();
    event.stopPropagation();
    if (next >= 0 && next !== activeIndex) activate(entries[next]);
  };

  const showTooltip = (event, entry, interval) => {
    if (gesture.current?.moved || event.pointerType === "touch") return;
    setTooltip({ entry, interval, x: event.clientX, y: event.clientY });
  };
  const tipEntry = tooltip?.entry;
  const tipInterval = tooltip?.interval;
  const tipStart = tipInterval?.start ?? tipEntry?.start;
  const tipEnd = tipInterval?.end ?? tipEntry?.end;
  const tipDuration = tipInterval ? tipEnd - tipStart : tipEntry?.seconds;
  const tipEstimated =
    tipInterval?.estimated ??
    (tipEntry?.phase
      ? tipEntry.phase.boundedByActivityEnd
      : tipEntry?.row.estimated);
  const consumers = tipInterval?.neededBy || tipEntry?.row.neededBy || [];
  const log = activeEntry && getLogUrl?.(activeEntry.row);

  return (
    <div
      ref={shell}
      className="waterfall-shell trace-waterfall"
      data-density={view.density || "compact"}
      data-gesture={dragPreview?.mode || undefined}
      style={{
        "--report-label-width": `${labelWidth}px`,
        "--wf-row-height": `${rowHeight}px`,
        "--wf-scrollbar-width": `${geometry.scrollbar}px`,
      }}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={cancelGesture}
      onLostPointerCapture={() => {
        if (gesture.current || resize.current) cancelGesture();
      }}
      onClickCapture={(event) => {
        if (suppressClick.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressClick.current = false;
        }
      }}
      onDoubleClick={(event) => {
        if (!event.target.closest(".wf-chart, .wf-ruler, .wf-label")) return;
        cancelGesture();
        setWindow(model.start, model.end);
      }}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && (gesture.current || resize.current)) {
          event.preventDefault();
          event.stopPropagation();
          cancelGesture();
        }
      }}
      onPointerLeave={() => {
        if (!gesture.current) setCursor(null);
        setHovered(null);
        setTooltip(null);
      }}
    >
      <div className="waterfall-axis">
        <div className="wf-axis-label">
          <Text size="xs" weight="bold">
            Activity
          </Text>
          <Text size="xs" variant="secondary">
            {count(rows.length)}
          </Text>
          <span className="wf-axis-duration">Duration</span>
        </div>
        <div
          className="wf-ruler"
          ref={ruler}
          aria-label="Timeline ruler. Drag a range to zoom; double-click to reset."
        >
          {ticks.map((tick) => (
            <span
              className="wf-tick"
              key={tick.time}
              style={{ left: `${relative(tick.time)}%` }}
            >
              <span
                className={
                  (relative(tick.time) / 100) * plotWidth <
                  tick.label.length * 3.5 + 4
                    ? "at-start"
                    : (1 - relative(tick.time) / 100) * plotWidth <
                        tick.label.length * 3.5 + 4
                      ? "at-end"
                      : ""
                }
              >
                {tick.label}
              </span>
            </span>
          ))}
          {!ticks.length && (
            <span className="wf-ruler-start">
              {formatTime(view.from - model.start, span / 10)}
            </span>
          )}
        </div>
      </div>
      <div
        className="waterfall-viewport"
        ref={viewport}
        role="treegrid"
        aria-label="Build waterfall. Arrow keys select activities; right and left expand or collapse build phases. F focuses, 0 fits the run."
        aria-rowcount={entries.length}
        aria-colcount={2}
        aria-activedescendant={
          activeIndex >= first && activeIndex < last
            ? `${idPrefix}-row-${activeIndex}`
            : undefined
        }
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          setScroll(event.currentTarget.scrollTop);
          setTooltip(null);
        }}
      >
        <div
          className="waterfall-content"
          style={{ height: Math.max(160, entries.length * rowHeight) }}
        >
          {entries.slice(first, last).map((entry, offset) => {
            const index = first + offset;
            const info = kindInfo(entry.row);
            const selected = index === activeIndex;
            const parentSelected =
              !!entry.phase && entry.row.id === view.selection?.rowId;
            const intervals = entry.intervals.filter(
              (interval) =>
                interval.end >= view.from && interval.start <= view.to,
            );
            return (
              <div
                id={`${idPrefix}-row-${index}`}
                className={`wf-row ${entry.phase ? "wf-phase-row" : ""} ${selected ? "selected" : ""} ${parentSelected ? "parent-selected" : ""} ${hovered === entry.id ? "hovered" : ""} ${matchIds ? (matchIds.has(entry.row.id) ? "is-match" : "is-dimmed") : ""}`}
                key={entry.id}
                data-row={entry.id}
                data-parent-row={entry.phase ? entry.row.id : undefined}
                role="row"
                aria-rowindex={index + 1}
                aria-level={entry.phase ? 2 : 1}
                aria-expanded={
                  entry.phaseCount ? !!expanded?.has(entry.row.id) : undefined
                }
                aria-selected={selected}
                style={{
                  top: index * rowHeight,
                  height: rowHeight,
                  "--bar-color": info.color,
                }}
                onPointerEnter={() => setHovered(entry.id)}
                onPointerLeave={() =>
                  setHovered((current) =>
                    current === entry.id ? null : current,
                  )
                }
              >
                <div className="wf-label-cell" role="gridcell">
                  {entry.phaseCount ? (
                    <button
                      type="button"
                      className="wf-expand"
                      aria-label={`${expanded?.has(entry.row.id) ? "Collapse" : "Expand"} ${entry.phaseCount} phases for ${entry.name}`}
                      aria-expanded={!!expanded?.has(entry.row.id)}
                      tabIndex={-1}
                      onClick={() => {
                        toggleExpanded(entry.row.id);
                        activate(entry);
                      }}
                    >
                      <Chevron expanded={expanded?.has(entry.row.id)} />
                    </button>
                  ) : (
                    <span
                      className={`wf-branch ${entry.phase ? "phase-branch" : ""}`}
                      aria-hidden="true"
                    />
                  )}
                  <button
                    type="button"
                    className="wf-label"
                    tabIndex={-1}
                    onClick={() => activate(entry)}
                    onPointerMove={(event) => showTooltip(event, entry, null)}
                    onPointerLeave={() => setTooltip(null)}
                    aria-label={`${entry.name}, ${entry.phase ? "Build phase" : info.label}, ${elapsed(entry.seconds)}`}
                  >
                    <i className="kind-dot" aria-hidden="true" />
                    <span className="wf-name">
                      <strong>{entry.name}</strong>
                      <small>
                        {entry.phase ? "Build phase" : info.label}
                        {entry.phaseCount
                          ? ` · ${entry.phaseCount} phases`
                          : ""}
                      </small>
                    </span>
                    <span className="wf-duration">
                      {elapsed(entry.seconds)}
                    </span>
                  </button>
                </div>
                <div className="wf-chart" role="gridcell">
                  {intervals.map((interval, intervalIndex) => {
                    const left = relative(interval.start);
                    const width = Math.max(0, relative(interval.end) - left);
                    const pixelWidth = (width / 100) * plotWidth;
                    const label = elapsed(interval.end - interval.start);
                    const labelPixels = label.length * 6 + 8;
                    const end = relative(interval.end);
                    const nextStart = intervals[intervalIndex + 1]
                      ? relative(intervals[intervalIndex + 1].start)
                      : 100;
                    const outside =
                      ((nextStart - end) / 100) * plotWidth > labelPixels;
                    return (
                      <React.Fragment
                        key={`${interval.start}-${intervalIndex}`}
                      >
                        <button
                          type="button"
                          className={`wf-bar ${interval.estimated ? "inferred" : ""} ${interval.open ? "open" : ""}`}
                          tabIndex={-1}
                          style={{ left: `${left}%`, width: `${width}%` }}
                          onClick={() => activate(entry)}
                          aria-label={`${entry.name}, ${entry.phase ? "Build phase" : info.label}, ${elapsed(interval.end - interval.start)}${interval.estimated ? ", inferred timing" : ""}`}
                          onPointerMove={(event) =>
                            showTooltip(event, entry, interval)
                          }
                          onPointerLeave={() => setTooltip(null)}
                        >
                          {!outside && pixelWidth > labelPixels && (
                            <span className="wf-bar-caption">
                              {pixelWidth > 180 && entry.phase
                                ? `${entry.name} · `
                                : ""}
                              {label}
                            </span>
                          )}
                        </button>
                        {outside && (
                          <span
                            className="wf-bar-duration"
                            style={{ left: `${end}%` }}
                            aria-hidden="true"
                          >
                            {label}
                          </span>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {!entries.length && (
            <div className="wf-empty">
              <Text size="md" weight="bold">
                No activities match this view
              </Text>
              <Text size="sm" variant="secondary">
                Widen the time window or reset your filters.
              </Text>
              <ActionButton
                label="Fit full run"
                onClick={() => setWindow(model.start, model.end)}
              />
            </div>
          )}
        </div>
      </div>
      <div
        className="wf-overlay"
        style={{ height: geometry.height }}
        aria-hidden="true"
      >
        {ticks.map((tick) => (
          <i
            className="wf-gridline"
            key={tick.time}
            style={{ left: `${relative(tick.time)}%` }}
          />
        ))}
        {cursor != null && !dragPreview && (
          <div className="time-cursor" style={{ left: `${cursor * 100}%` }}>
            <span
              className={(1 - cursor) * plotWidth < 95 ? "cursor-left" : ""}
            >
              {formatTime(
                view.from - model.start + cursor * span,
                span / plotWidth,
              )}
            </span>
          </div>
        )}
        {dragPreview?.mode === "range" && (
          <div
            className="wf-range-selection"
            style={{
              left: `${relative(dragPreview.from)}%`,
              width: `${relative(dragPreview.to) - relative(dragPreview.from)}%`,
            }}
          >
            <span
              style={{
                left: clamp(
                  ((relative(dragPreview.to) - relative(dragPreview.from)) /
                    200) *
                    plotWidth,
                  45 - (relative(dragPreview.from) / 100) * plotWidth,
                  plotWidth -
                    45 -
                    (relative(dragPreview.from) / 100) * plotWidth,
                ),
              }}
            >
              {elapsed(dragPreview.to - dragPreview.from)}
            </span>
          </div>
        )}
        {dragPreview?.mode === "pan" && (
          <span className="wf-pan-hint">Panning · Esc to cancel</span>
        )}
      </div>
      <div
        className="wf-label-resize"
        role="separator"
        aria-label="Activity column width"
        aria-orientation="vertical"
        aria-valuemin={minimumLabelWidth}
        aria-valuemax={Math.round(maximumLabelWidth)}
        aria-valuenow={Math.round(labelWidth)}
        tabIndex={0}
        style={{ left: labelWidth - 3, height: geometry.height + 34 }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          resize.current = { x: event.clientX, width: labelWidth };
          event.currentTarget.setPointerCapture(event.pointerId);
          setTooltip(null);
        }}
        onKeyDown={(event) => {
          const delta = event.shiftKey ? 40 : 10;
          const width =
            event.key === "ArrowLeft"
              ? labelWidth - delta
              : event.key === "ArrowRight"
                ? labelWidth + delta
                : event.key === "Home"
                  ? minimumLabelWidth
                  : event.key === "End"
                    ? maximumLabelWidth
                    : null;
          if (width == null) return;
          event.preventDefault();
          event.stopPropagation();
          patch({
            labelWidth: clamp(width, minimumLabelWidth, maximumLabelWidth),
          });
        }}
      />
      <div
        className={`wf-selection-toolbar ${activeEntry ? "has-selection" : ""}`}
      >
        {activeEntry ? (
          <>
            <div className="wf-selection-name">
              <i style={{ background: kindInfo(activeEntry.row).color }} />
              <Text size="xs" weight="bold" hasEllipsis>
                {activeEntry.name}
              </Text>
              <span>{elapsed(activeEntry.seconds)}</span>
            </div>
            <div className="wf-selection-actions">
              <ActionButton
                label="Focus interval"
                onClick={() => focusEntry(activeEntry)}
              />
              <ActionButton
                label="Filter name"
                onClick={() =>
                  patch({
                    search: Query.addTerm(view.search, {
                      field: "name",
                      value: activeEntry.row.name,
                    }),
                  })
                }
              />
              {log && <ActionButton label="Open log ↗" href={log} isExternal />}
            </div>
          </>
        ) : (
          <span className="wf-gesture-help">
            Drag to zoom <span>·</span> Shift-drag to pan <span>·</span>{" "}
            Double-click to reset
          </span>
        )}
        <details className="wf-shortcuts">
          <summary aria-label="Waterfall keyboard shortcuts">⌨</summary>
          <div>
            <strong>Explore the waterfall</strong>
            <dl>
              <dt>↑ ↓ / Home End</dt>
              <dd>Select activity</dd>
              <dt>→ / ←</dt>
              <dd>Expand / collapse phases</dd>
              <dt>F</dt>
              <dd>Focus selected interval</dd>
              <dt>+ / −</dt>
              <dd>Zoom in / out</dd>
              <dt>0 / double-click</dt>
              <dd>Fit full run</dd>
              <dt>Esc</dt>
              <dd>Cancel current gesture</dd>
              <dt>Ctrl / ⌘ + wheel</dt>
              <dd>Zoom at pointer</dd>
              <dt>Shift + wheel</dt>
              <dd>Pan time window</dd>
            </dl>
            <p>Touch: scroll activities; drag the ruler to select time.</p>
          </div>
        </details>
      </div>
      {tooltip && (
        <div
          className="activity-tooltip wf-tooltip"
          role="tooltip"
          style={{
            left: Math.max(
              8,
              Math.min(window.innerWidth - 350, tooltip.x + 16),
            ),
            top: Math.max(
              8,
              Math.min(window.innerHeight - 250, tooltip.y + 18),
            ),
          }}
        >
          <div className="wf-tooltip-kind">
            <i style={{ background: kindInfo(tipEntry.row).color }} />
            {tipEntry.phase ? "Build phase" : kindInfo(tipEntry.row).label}
            <span>{tipEntry.row.state}</span>
          </div>
          <Text as="div" size="sm" weight="bold" overflowWrap="anywhere">
            {tipEntry.name}
          </Text>
          {tipEntry.phase && (
            <Text as="div" size="xs" variant="secondary" hasEllipsis>
              {tipEntry.row.name}
            </Text>
          )}
          <dl className="wf-tooltip-stats">
            <div>
              <dt>Duration</dt>
              <dd>{elapsed(tipDuration)}</dd>
            </div>
            <div>
              <dt>Of run wall time</dt>
              <dd>{((tipDuration / model.span) * 100).toFixed(2)}%</dd>
            </div>
            <div>
              <dt>Start</dt>
              <dd>+{formatTime(tipStart - model.start, 0.01)}</dd>
            </div>
            <div>
              <dt>End</dt>
              <dd>+{formatTime(tipEnd - model.start, 0.01)}</dd>
            </div>
          </dl>
          {tipEstimated && (
            <p className="wf-tooltip-note">
              {tipEntry.phase
                ? "Phase end is bounded by activity completion."
                : "Inferred interval; exact activity boundaries were not observed."}
            </p>
          )}
          {!!consumers.length && (
            <p className="wf-tooltip-consumers">
              <strong>{count(consumers.length)} consumers</strong> ·{" "}
              {consumers.slice(0, 3).join(", ")}
              {consumers.length > 3
                ? ` +${count(consumers.length - 3)} more`
                : ""}
            </p>
          )}
          <div className="wf-tooltip-help">
            Click to inspect · F to focus · Double-click to reset
          </div>
        </div>
      )}
    </div>
  );
}
