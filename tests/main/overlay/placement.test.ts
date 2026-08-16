/**
 * M5-04 (#26), feature U3 - anti-overlap placement, and M5-04's spatial hash.
 *
 * `placeBoxes` is a pure function, which is what makes the last acceptance criterion checkable
 * at all: *identical input gives identical positions every time*. M8's sticky placement is built
 * on that, so it is tested by running the same input twice and comparing the complete position
 * set - not by reading the source and observing that it looks pure.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_DISPLACEMENT,
  placeBoxes,
  rectDistance,
  type PlacementRequest,
} from '../../../src/renderer/overlay/placement.js';
import { SpatialHash, overlaps, type Rect } from '../../../src/renderer/overlay/spatial-hash.js';

const SCREEN = { width: 1200, height: 800 };

function box(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

/** The rectangles actually drawn, in request order, skipping the ones that were not placed. */
function drawn(
  requests: readonly PlacementRequest[],
  positions: readonly ({ x: number; y: number } | null)[],
): Rect[] {
  const rects: Rect[] = [];
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const position = positions[index];
    if (request === undefined || position === undefined || position === null) continue;
    rects.push({ ...position, width: request.width, height: request.height });
  }
  return rects;
}

describe('overlaps', () => {
  it('treats touching edges as not overlapping, so adjacent boxes are legal', () => {
    expect(overlaps(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBe(false);
    expect(overlaps(box(0, 0, 10, 10), box(9.9, 0, 10, 10))).toBe(true);
    expect(overlaps(box(0, 0, 10, 10), box(0, 10, 10, 10))).toBe(false);
  });
});

describe('SpatialHash', () => {
  it('finds an overlap regardless of how many cells either rectangle spans', () => {
    const hash = new SpatialHash(32);
    hash.insert(box(0, 0, 500, 500));
    expect(hash.intersects(box(480, 480, 10, 10))).toBe(true);
    expect(hash.intersects(box(600, 600, 10, 10))).toBe(false);
  });

  it('never reports an overlap that is not there, whatever the cell size', () => {
    for (const cellSize of [1, 7, 32, 128, 4096]) {
      const hash = new SpatialHash(cellSize);
      hash.insert(box(0, 0, 100, 20));
      // Directly below, sharing a cell at most cell sizes and never actually overlapping.
      expect(hash.intersects(box(0, 20, 100, 20))).toBe(false);
    }
  });

  it('refuses a cell size that would collapse the grid into one bucket', () => {
    expect(() => new SpatialHash(0)).toThrow(RangeError);
    expect(() => new SpatialHash(Number.NaN)).toThrow(RangeError);
  });

  it('keeps collision work far below the quadratic figure at 30 boxes', () => {
    // 30 boxes scattered across the screen, each trying up to 15 candidate positions. The naive
    // form is 30 * 15 * 30 = 13500 exact tests; the grid should be an order of magnitude under.
    const requests = scatter(30);
    const outcome = placeBoxes(requests, { screen: SCREEN });

    expect(outcome.comparisons).toBeLessThan(1350);
  });
});

describe('placeBoxes - the cascade', () => {
  it('puts a lone box directly below its anchor', () => {
    const requests = [{ anchor: box(100, 100, 200, 30), width: 200, height: 40 }];
    const { positions } = placeBoxes(requests, { screen: SCREEN, gap: 4 });

    expect(positions[0]).toEqual({ x: 100, y: 134 });
  });

  it('moves the second of two colliding boxes', () => {
    const anchor = box(100, 100, 200, 30);
    const requests = [
      { anchor, width: 200, height: 40 },
      { anchor, width: 200, height: 40 },
    ];

    const { positions, placedCount } = placeBoxes(requests, { screen: SCREEN, gap: 4 });

    expect(placedCount).toBe(2);
    expect(positions[0]).toEqual({ x: 100, y: 134 });
    expect(positions[1]).not.toEqual(positions[0]);
    expect(overlaps(drawn(requests, positions)[0] as Rect, drawn(requests, positions)[1] as Rect)).toBe(
      false,
    );
  });

  it('falls back to the right when below is taken', () => {
    const anchor = box(100, 100, 200, 30);
    const requests = [
      { anchor, width: 200, height: 40 },
      { anchor, width: 200, height: 40 },
    ];

    const { positions } = placeBoxes(requests, { screen: SCREEN, gap: 4 });

    // anchor.x + anchor.width + gap, anchor.y - the second position in the documented order.
    expect(positions[1]).toEqual({ x: 304, y: 100 });
  });

  it('goes above when below is clamped onto the anchor and the right is occupied', () => {
    const screen = { width: 400, height: 200 };
    const requests = [
      // Parks a box across the space to the right of the second anchor.
      { anchor: box(104, 100, 100, 20), width: 100, height: 40 },
      // Bottom of a short screen: `below` has nowhere to go and clamps back over the anchor.
      { anchor: box(0, 150, 100, 40), width: 100, height: 40 },
    ];

    const { positions } = placeBoxes(requests, { screen, gap: 4 });

    expect(positions[0]).toEqual({ x: 104, y: 124 });
    // anchor.y - height - gap = 150 - 40 - 4.
    expect(positions[1]).toEqual({ x: 0, y: 106 });
  });

  it('never lets a box cover the text it is translating', () => {
    // A tall anchor at the very bottom: every downward candidate clamps back over it.
    const screen = { width: 300, height: 200 };
    const requests = [{ anchor: box(0, 120, 300, 80), width: 300, height: 60 }];

    const { positions } = placeBoxes(requests, { screen, gap: 4 });
    const rects = drawn(requests, positions);

    for (const rect of rects) {
      expect(overlaps(rect, requests[0]?.anchor as Rect)).toBe(false);
    }
  });
});

describe('placeBoxes - the constraints', () => {
  it('keeps every box inside all four screen edges', () => {
    const requests: PlacementRequest[] = [
      { anchor: box(-40, -30, 200, 30), width: 200, height: 40 },
      { anchor: box(1150, 10, 200, 30), width: 200, height: 40 },
      { anchor: box(10, 770, 200, 30), width: 200, height: 40 },
      { anchor: box(1190, 790, 300, 30), width: 300, height: 60 },
      ...scatter(20),
    ];

    const { positions } = placeBoxes(requests, { screen: SCREEN });

    for (const rect of drawn(requests, positions)) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(SCREEN.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(SCREEN.height);
    }
  });

  it('keeps a displaced box close enough to its anchor to be attributable', () => {
    // Twelve boxes stacked on one anchor: everything after the first has to move somewhere.
    const anchor = box(400, 300, 240, 30);
    const requests = Array.from({ length: 12 }, () => ({ anchor, width: 240, height: 36 }));

    const { positions } = placeBoxes(requests, { screen: SCREEN });

    for (let index = 0; index < requests.length; index += 1) {
      const position = positions[index];
      const request = requests[index];
      if (position === null || position === undefined || request === undefined) continue;
      const rect = { ...position, width: request.width, height: request.height };
      expect(rectDistance(rect, anchor)).toBeLessThanOrEqual(DEFAULT_MAX_DISPLACEMENT);
    }
  });

  it('skips a box rather than overlapping, and says why', () => {
    const anchor = box(400, 300, 240, 30);
    // Far more boxes than the cascade has positions for, all fighting over one anchor.
    const requests = Array.from({ length: 40 }, () => ({ anchor, width: 240, height: 36 }));

    const outcome = placeBoxes(requests, { screen: SCREEN });
    const rects = drawn(requests, outcome.positions);

    expect(outcome.skippedCount).toBeGreaterThan(0);
    expect(outcome.skipped.filter((reason) => reason === 'no-room').length).toBe(
      outcome.skippedCount,
    );
    for (let a = 0; a < rects.length; a += 1) {
      for (let b = a + 1; b < rects.length; b += 1) {
        expect(overlaps(rects[a] as Rect, rects[b] as Rect)).toBe(false);
      }
    }
  });

  it('reports a box larger than the screen as too-large rather than as a busy screen', () => {
    const requests = [{ anchor: box(0, 0, 100, 20), width: 2000, height: 40 }];

    const outcome = placeBoxes(requests, { screen: SCREEN });

    expect(outcome.positions[0]).toBeNull();
    expect(outcome.skipped[0]).toBe('too-large');
  });

  it('never overlaps any two drawn boxes, on a deliberately dense screen', () => {
    const requests = dense(60);

    const outcome = placeBoxes(requests, { screen: SCREEN });
    const rects = drawn(requests, outcome.positions);

    expect(rects.length).toBeGreaterThan(5);
    for (let a = 0; a < rects.length; a += 1) {
      for (let b = a + 1; b < rects.length; b += 1) {
        expect(overlaps(rects[a] as Rect, rects[b] as Rect)).toBe(false);
      }
    }
  });
});

describe('placeBoxes - determinism (M8 depends on this)', () => {
  it('produces an identical position set for identical input, twice over', () => {
    const requests = scatter(30);

    const first = placeBoxes(requests, { screen: SCREEN });
    // Unrelated work in between, to catch any module-level state leaking across calls.
    placeBoxes(dense(40), { screen: { width: 640, height: 480 } });
    const second = placeBoxes(requests, { screen: SCREEN });

    expect(second.positions).toEqual(first.positions);
    expect(second.skipped).toEqual(first.skipped);
    expect(second.placedCount).toBe(first.placedCount);
  });

  it('produces the same answer for a fresh but equal copy of the input', () => {
    const requests = scatter(30);
    // Structurally equal, referentially distinct: an implementation keyed on object identity -
    // a WeakMap cache, a Set of requests - would diverge here and not in the test above.
    const copy = requests.map((request) => ({
      anchor: { ...request.anchor },
      width: request.width,
      height: request.height,
    }));

    expect(placeBoxes(copy, { screen: SCREEN }).positions).toEqual(
      placeBoxes(requests, { screen: SCREEN }).positions,
    );
  });

  it('depends on input order and nothing else', () => {
    const requests = scatter(12);
    const reversed = [...requests].reverse();

    const forward = placeBoxes(requests, { screen: SCREEN });
    const backward = placeBoxes(reversed, { screen: SCREEN });

    // Reversing genuinely changes the answer - which is what makes the "identical input,
    // identical output" test above a real constraint rather than one satisfied by a constant.
    expect(backward.positions).not.toEqual(forward.positions);
    // ...and reversing back reproduces the original exactly.
    expect(placeBoxes([...reversed].reverse(), { screen: SCREEN }).positions).toEqual(
      forward.positions,
    );
  });
});

describe('placeBoxes - budget', () => {
  it('places 30 boxes in well under 5ms', () => {
    const requests = scatter(30);
    placeBoxes(requests, { screen: SCREEN }); // warm the JIT; the budget is for the steady state

    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 200; round += 1) {
      const startedAt = performance.now();
      placeBoxes(requests, { screen: SCREEN });
      best = Math.min(best, performance.now() - startedAt);
    }

    expect(best).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// Fixtures. Deterministic by construction - a seeded generator, never Math.random, because a
// determinism suite built on a random input set could not be re-run against a failure.
// ---------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Boxes spread over the screen the way subtitles and UI labels are: mostly not touching. */
function scatter(count: number): PlacementRequest[] {
  const random = lcg(20260816);
  return Array.from({ length: count }, () => {
    const width = 120 + Math.floor(random() * 320);
    const height = 28 + Math.floor(random() * 60);
    const x = Math.floor(random() * (SCREEN.width - width));
    const y = Math.floor(random() * (SCREEN.height - height - 80));
    return { anchor: box(x, y, width, 26), width, height };
  });
}

/** A pathological screen: everything piled into one corner, most of it unplaceable. */
function dense(count: number): PlacementRequest[] {
  const random = lcg(7);
  return Array.from({ length: count }, () => {
    const x = 200 + Math.floor(random() * 120);
    const y = 200 + Math.floor(random() * 120);
    return { anchor: box(x, y, 260, 24), width: 260, height: 44 };
  });
}
