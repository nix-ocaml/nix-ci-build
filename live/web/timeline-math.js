const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function minimumSpan(start, end) {
  return Math.max(0.001, (end - start) / 1_000_000);
}

// Keep the window's width when it reaches an edge. All gestures use the same
// bounds, so dragging, keyboard navigation, and wheel zoom cannot diverge.
export function clampWindow(
  from,
  to,
  start,
  end,
  minSpan = minimumSpan(start, end),
) {
  const extent = end - start;
  if (!(extent > 0)) return [start, end];
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [start, end];
  if (from > to) [from, to] = [to, from];
  const width = clamp(to - from, Math.min(minSpan, extent), extent);
  const left = clamp((from + to - width) / 2, start, end - width);
  return [left, left + width];
}

export function zoomWindow(
  from,
  to,
  factor,
  anchor,
  start,
  end,
  minSpan = minimumSpan(start, end),
) {
  if (!Number.isFinite(factor) || factor <= 0)
    return clampWindow(from, to, start, end, minSpan);
  const fraction = Number.isFinite(anchor) ? clamp(anchor, 0, 1) : 0.5;
  const fixedTime = from + (to - from) * fraction;
  const width = clamp(
    (to - from) * factor,
    Math.min(minSpan, end - start),
    end - start,
  );
  return clampWindow(
    fixedTime - width * fraction,
    fixedTime + width * (1 - fraction),
    start,
    end,
    minSpan,
  );
}

export function panWindow(from, to, delta, start, end) {
  return clampWindow(from + delta, to + delta, start, end);
}

export function formatTime(seconds, step = 1) {
  if (!Number.isFinite(seconds)) return "—";
  const sign = seconds < 0 ? "−" : "";
  const value = Math.abs(seconds);
  if (value < 0.0000005) return "0s";
  if (value < 0.001) return `${sign}${Number((value * 1e6).toFixed(1))}µs`;
  if (value < 1) return `${sign}${Number((value * 1000).toFixed(1))}ms`;
  const precision =
    step < 1 ? Math.min(3, Math.max(1, Math.ceil(-Math.log10(step)))) : 0;
  const rounded = Number(value.toFixed(precision));
  if (rounded < 60) return `${sign}${rounded.toFixed(precision)}s`;
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = (rounded % 60)
    .toFixed(precision)
    .padStart(precision ? 3 + precision : 2, "0");
  return `${sign}${hours ? `${hours}h ` : ""}${minutes}m ${remainder}s`;
}

export function timeTicks(from, to, start, plotWidth) {
  const span = to - from;
  if (!(span > 0)) return [{ time: from, label: formatTime(from - start) }];
  const target = span / Math.max(2, Math.floor(plotWidth / 100));
  const steps = [
    0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30,
    60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400,
  ];
  const step =
    steps.find((value) => value >= target) || Math.ceil(target / 86400) * 86400;
  const first = Math.ceil((from - start - step * 1e-6) / step);
  const last = Math.floor((to - start + step * 1e-6) / step);
  const ticks = [];
  for (let i = first; i <= last && ticks.length < 100; i++) {
    const offset = i * step;
    ticks.push({ time: start + offset, label: formatTime(offset, step) });
  }
  return ticks;
}
