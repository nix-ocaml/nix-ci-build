import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Text } from "@datadog/druids/typography/Text";
import { Button } from "@datadog/druids/form/Button";
import {
  clampWindow,
  panWindow,
  minimumSpan,
  formatTime,
  timeTicks,
} from "./timeline-math.js";
import "./timeline-overview.css";

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const COLORS = { build: "#9d72c6", download: "#4a9fad" };

function concurrencyPath(points, start, extent, peak) {
  let last = 0;
  let line = "M 0 50";
  for (const point of points || []) {
    const x = clamp((point.time - start) / extent, 0, 1) * 1000;
    const y = 50 - (Math.max(0, point.value) / peak) * 44;
    line += ` L ${x} ${50 - (last / peak) * 44} L ${x} ${y}`;
    last = Math.max(0, point.value);
  }
  line += ` L 1000 ${50 - (last / peak) * 44}`;
  return { line, area: `${line} L 1000 50 L 0 50 Z` };
}

export default function TimelineOverview({ model, view, setWindow }) {
  const plot = useRef(null);
  const gesture = useRef(null);
  const frame = useRef(null);
  const pending = useRef(null);
  const update = useRef(setWindow);
  update.current = setWindow;
  const [plotWidth, setPlotWidth] = useState(800);
  const [dragging, setDragging] = useState(false);
  const start = model.start;
  const end = model.end;
  const extent = Math.max(0, end - start);
  const minimum = Math.min(extent, minimumSpan(start, end));
  const [from, to] = clampWindow(view.from, view.to, start, end);
  const current = useRef([from, to]);
  current.current = [from, to];
  const span = to - from;
  const full = !extent || span >= extent - minimum / 2;
  const percent = (time) => (extent ? ((time - start) / extent) * 100 : 0);
  const peak = Math.max(1, model.stats.builds.peak, model.stats.downloads.peak);
  const paths = useMemo(
    () => [
      {
        kind: "download",
        ...concurrencyPath(
          model.stats.downloads.steps,
          start,
          extent || 1,
          peak,
        ),
      },
      {
        kind: "build",
        ...concurrencyPath(model.stats.builds.steps, start, extent || 1, peak),
      },
    ],
    [model, start, extent, peak],
  );
  const ticks = useMemo(
    () => timeTicks(start, end, start, plotWidth),
    [start, end, plotWidth],
  );
  const precision = Math.max(0.001, span / 100);
  const rangeLabel = `${formatTime(from - start, precision)} → ${formatTime(to - start, precision)}`;

  useLayoutEffect(() => {
    const element = plot.current;
    if (!element) return;
    const measure = () => setPlotWidth(element.clientWidth || 800);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function cancelFrame() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    pending.current = null;
  }
  function queue(next) {
    pending.current = next;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const next = pending.current;
      pending.current = null;
      if (next && gesture.current) update.current(...next);
    });
  }
  function cancelGesture() {
    const active = gesture.current;
    gesture.current = null;
    cancelFrame();
    setDragging(false);
    if (active) update.current(...active.original);
  }
  useEffect(() => {
    const escape = (event) => {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        event.stopPropagation();
        cancelGesture();
      }
    };
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("keydown", escape, true);
      gesture.current = null;
      cancelFrame();
    };
  }, []);

  function timeAt(clientX, rect) {
    return (
      start +
      clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * extent
    );
  }
  function gestureWindow(active, clientX) {
    const time = timeAt(clientX, active.rect);
    const [a, b] = active.original;
    const delta = ((clientX - active.x) / active.rect.width) * extent;
    if (active.mode === "start")
      return [clamp(a + delta, start, b - minimum), b];
    if (active.mode === "end") return [a, clamp(b + delta, a + minimum, end)];
    if (active.mode === "pan") return panWindow(a, b, delta, start, end);
    return clampWindow(active.anchor, time, start, end, minimum);
  }
  function pointerDown(event) {
    if (event.button !== 0 || !extent || gesture.current) return;
    const rect = plot.current.getBoundingClientRect();
    const anchor = timeAt(event.clientX, rect);
    const edge = event.target.closest("[data-overview-edge]")?.dataset
      .overviewEdge;
    const inside = anchor >= from && anchor <= to;
    const mode =
      edge ||
      (event.shiftKey || (inside && full)
        ? "select"
        : inside
          ? "pan"
          : "outside");
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      rect,
      anchor,
      mode,
      original: [...current.current],
      moved: false,
    };
    event.target.closest("[role=slider]")?.focus({ preventScroll: true });
    plot.current.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function pointerMove(event) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (!active.moved && Math.abs(event.clientX - active.x) < 4) return;
    active.moved = true;
    setDragging(true);
    queue(gestureWindow(active, event.clientX));
  }
  function pointerUp(event) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const next = active.moved
      ? gestureWindow(active, event.clientX)
      : active.mode === "outside"
        ? panWindow(
            ...active.original,
            active.anchor - (active.original[0] + active.original[1]) / 2,
            start,
            end,
          )
        : null;
    gesture.current = null;
    cancelFrame();
    setDragging(false);
    if (next) update.current(...next);
    if (plot.current.hasPointerCapture(event.pointerId))
      plot.current.releasePointerCapture(event.pointerId);
  }
  function reset() {
    gesture.current = null;
    cancelFrame();
    setDragging(false);
    update.current(start, end);
  }
  function keyboard(event, edge) {
    if (!extent) return;
    const directions = {
      ArrowLeft: -1,
      ArrowDown: -1,
      ArrowRight: 1,
      ArrowUp: 1,
      PageUp: -10,
      PageDown: 10,
    };
    const direction = directions[event.key];
    if (!direction && !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = extent * (event.shiftKey ? 0.001 : 0.01);
    let next;
    if (edge === "start") {
      const position =
        event.key === "Home"
          ? start
          : event.key === "End"
            ? to - minimum
            : from + direction * step;
      next = [clamp(position, start, to - minimum), to];
    } else if (edge === "end") {
      const position =
        event.key === "Home"
          ? from + minimum
          : event.key === "End"
            ? end
            : to + direction * step;
      next = [from, clamp(position, from + minimum, end)];
    } else {
      const delta =
        event.key === "Home"
          ? start - from
          : event.key === "End"
            ? end - to
            : direction * step;
      next = panWindow(from, to, delta, start, end);
    }
    update.current(...next);
  }

  return (
    <section
      className="timeline-overview"
      aria-label="Run overview and time window"
    >
      <div className="overview-heading">
        <Text as="strong" size="xs" weight="bold">
          Overview
        </Text>
        <div className="overview-legend" aria-label="Observed concurrency">
          <span>
            <i style={{ background: COLORS.build }} />
            Builds
          </span>
          <span>
            <i style={{ background: COLORS.download }} />
            Downloads
          </span>
          <span className="overview-peak">
            {peak === 1 &&
            !model.stats.builds.peak &&
            !model.stats.downloads.peak
              ? "No timed activity"
              : `${peak} peak lanes`}
          </span>
        </div>
        <Button
          isTitleCased={false}
          size="xs"
          label="Full run"
          onClick={reset}
        />
      </div>
      <div className="overview-range">
        <div
          ref={plot}
          className={`overview-plot${dragging ? " is-dragging" : ""}`}
          data-testid="overview-plot"
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={cancelGesture}
          onLostPointerCapture={() => {
            if (gesture.current) cancelGesture();
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            reset();
          }}
        >
          <svg
            viewBox="0 0 1000 54"
            preserveAspectRatio="none"
            role="img"
            aria-label="Concurrent observed builds and downloads across the full run"
          >
            {[18, 34, 50].map((y) => (
              <line
                key={y}
                x1="0"
                x2="1000"
                y1={y}
                y2={y}
                className="overview-gridline"
              />
            ))}
            {paths.map((path) => (
              <g key={path.kind}>
                <path
                  d={path.area}
                  fill={COLORS[path.kind]}
                  fillOpacity="0.16"
                />
                <path
                  d={path.line}
                  fill="none"
                  stroke={COLORS[path.kind]}
                  strokeWidth="1.2"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            ))}
          </svg>
          <div
            className="overview-shade overview-shade-start"
            style={{ width: `${percent(from)}%` }}
          />
          <div
            className="overview-shade overview-shade-end"
            style={{ width: `${extent ? 100 - percent(to) : 0}%` }}
          />
          <div
            className="overview-brush"
            style={{
              left: `${percent(from)}%`,
              width: `${extent ? (span / extent) * 100 : 100}%`,
            }}
          >
            <div
              className="overview-window"
              data-testid="overview-window"
              role="slider"
              tabIndex={extent ? 0 : -1}
              aria-label="Time window position"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, extent - span)}
              aria-valuenow={from - start}
              aria-valuetext={`${rangeLabel}, ${formatTime(span, precision)} wide`}
              aria-describedby="overview-gesture-help overview-keyboard-help"
              onKeyDown={(event) => keyboard(event)}
            />
            <div
              className="overview-handle overview-handle-start"
              data-overview-edge="start"
              role="slider"
              tabIndex={extent ? 0 : -1}
              aria-label="Time window start"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, to - start - minimum)}
              aria-valuenow={from - start}
              aria-valuetext={`${formatTime(from - start, precision)} into run`}
              aria-describedby="overview-keyboard-help"
              onKeyDown={(event) => keyboard(event, "start")}
            >
              <span aria-hidden="true" />
            </div>
            <div
              className="overview-handle overview-handle-end"
              data-overview-edge="end"
              role="slider"
              tabIndex={extent ? 0 : -1}
              aria-label="Time window end"
              aria-orientation="horizontal"
              aria-valuemin={Math.min(extent, from - start + minimum)}
              aria-valuemax={extent}
              aria-valuenow={to - start}
              aria-valuetext={`${formatTime(to - start, precision)} into run`}
              aria-describedby="overview-keyboard-help"
              onKeyDown={(event) => keyboard(event, "end")}
            >
              <span aria-hidden="true" />
            </div>
          </div>
        </div>
        <div className="overview-scale" aria-hidden="true">
          {ticks.map((tick) => (
            <span key={tick.time} style={{ left: `${percent(tick.time)}%` }}>
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <div className="overview-footer">
        <output className="overview-range-value">
          {rangeLabel}
          <span> · {formatTime(span, precision)} window</span>
        </output>
        <Text as="span" size="xs" variant="secondary">
          Double-click to reset
        </Text>
      </div>
      <span className="overview-sr-only" id="overview-gesture-help">
        Drag the window to pan. Drag a handle to adjust its boundary. Shift-drag
        to select a new range. Click outside the window to recenter it.
        Double-click to reset the full run.
      </span>
      <span className="overview-sr-only" id="overview-keyboard-help">
        Arrow keys adjust one percent of the run. Hold Shift for a finer
        adjustment. Home and End move to the allowed bounds. Escape cancels a
        drag.
      </span>
    </section>
  );
}
