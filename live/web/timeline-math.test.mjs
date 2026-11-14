import test from "node:test";
import assert from "node:assert/strict";
import {
  clampWindow,
  zoomWindow,
  panWindow,
  timeTicks,
  formatTime,
} from "./timeline-math.js";

const close = (a, b, tolerance = 0.000002) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} ≈ ${b}`);

test("pointer-anchored zoom preserves the time under the pointer", () => {
  const start = 1794319333.080647;
  for (const anchor of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
    const from = start + 100,
      to = start + 500;
    const [left, right] = zoomWindow(from, to, 0.6, anchor, start, start + 669);
    close(left + (right - left) * anchor, from + (to - from) * anchor);
    close(right - left, 240);
  }
});

test("panning stops at each run boundary without shrinking the window", () => {
  assert.deepEqual(panWindow(20, 60, -100, 0, 100), [0, 40]);
  assert.deepEqual(panWindow(20, 60, 100, 0, 100), [60, 100]);
  assert.deepEqual(panWindow(20, 60, 12, 0, 100), [32, 72]);
});

test("dragged backwards, tiny, invalid, and out-of-bounds selections stay usable", () => {
  assert.deepEqual(clampWindow(70, 20, 0, 100), [20, 70]);
  assert.deepEqual(clampWindow(-20, 120, 0, 100), [0, 100]);
  assert.deepEqual(clampWindow(NaN, 20, 0, 100), [0, 100]);
  assert.deepEqual(clampWindow(40, 40, 40, 40), [40, 40]);
  const [from, to] = clampWindow(50, 50, 0, 100);
  assert.ok(to > from);
  close(to - from, 0.001);
});

test("repeated anchored zoom and pan retain finite bounded windows", () => {
  const start = 1794319333.080647,
    end = start + 669;
  let window = [start, end];
  for (let i = 0; i < 200; i++) {
    window = zoomWindow(
      ...window,
      i % 3 === 0 ? 3 : 0.6,
      (i % 11) / 10,
      start,
      end,
    );
    window = panWindow(...window, (i % 2 ? 1 : -1) * (i * 6), start, end);
    assert.ok(window.every(Number.isFinite));
    assert.ok(window[0] >= start - 0.000002 && window[1] <= end + 0.000002);
    assert.ok(window[1] - window[0] >= 0.000999);
  }
});

test("tick labels stay aligned to the run, readable, and unique at subsecond zoom", () => {
  const start = 1794319333.080647;
  const ticks = timeTicks(start + 0.027, start + 0.069, start, 600);
  assert.ok(ticks.length >= 3);
  assert.equal(new Set(ticks.map((tick) => tick.label)).size, ticks.length);
  for (const tick of ticks) {
    assert.ok(tick.time >= start + 0.027 && tick.time <= start + 0.069);
    assert.match(tick.label, /ms$/);
  }
  assert.equal(formatTime(119.9999, 1), "2m 00s");
  assert.equal(formatTime(0.041, 0.001), "41ms");
  assert.equal(formatTime(0), "0s");
});
