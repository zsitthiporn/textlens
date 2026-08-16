/**
 * Anchor snapping and sticky placement (issue M8-01 / #35).
 *
 * ## The metric
 *
 * "No flicker" is not testable as stated, so this file measures one number instead: **how many
 * times the placed position of a box changes across a run of frames in which its text did not
 * change**. The target is zero, and the number is produced by running the real
 * {@link placeBoxes} over stabilized anchors rather than by inspecting the anchors themselves -
 * because the anchor is only an intermediate, and a test that asserted on it would pass even if
 * placement went on to move the box for some other reason.
 *
 * Every stability test here therefore ends at a *position*, and counts changes in it.
 */

import { describe, expect, it } from 'vitest';

import {
  KEY_CELL,
  StickyAnchors,
  anchorKey,
  normalizeKey,
  snap,
  snapRect,
  within,
} from '../../src/renderer/overlay/anchor.js';
import { placeBoxes, type Point } from '../../src/renderer/overlay/placement.js';
import type { Rect } from '../../src/renderer/overlay/spatial-hash.js';

const SCREEN = { width: 1920, height: 1080 };

/** A subtitle-ish anchor, deliberately *not* already on the 8px grid. */
const BASE: Rect = { x: 501, y: 903, width: 640, height: 42 };

/**
 * Run one text through a sequence of raw anchors and report the placed position each time.
 *
 * The box's own size is held constant so that any movement in the result comes from the anchor,
 * which is what is under test.
 */
function positionsFor(
  sticky: StickyAnchors,
  text: string,
  raws: readonly Rect[],
): (Point | null)[] {
  return raws.map((raw) => {
    const { anchor } = sticky.resolve(text, raw);
    const outcome = placeBoxes([{ anchor, width: 400, height: 60 }], { screen: SCREEN });
    return outcome.positions[0] ?? null;
  });
}

function distinct(points: readonly (Point | null)[]): number {
  return new Set(points.map((point) => JSON.stringify(point))).size;
}

/** `count` readings of the same rectangle, displaced by a deterministic +-`amplitude` wobble. */
function jitter(base: Rect, count: number, amplitude: number): Rect[] {
  const wobble = [0, 1, -1, 2, -2, 3, -3, 1, -1, 0];
  return Array.from({ length: count }, (_unused, index) => {
    const dx = ((wobble[index % wobble.length] ?? 0) * amplitude) / 3;
    const dy = ((wobble[(index + 3) % wobble.length] ?? 0) * amplitude) / 3;
    return { x: base.x + dx, y: base.y + dy, width: base.width, height: base.height };
  });
}

describe('snap', () => {
  it('quantises to the grid', () => {
    expect(snap(501, 8)).toBe(504);
    expect(snap(499, 8)).toBe(496);
    expect(snap(0, 8)).toBe(0);
  });

  it('gives a finite answer for a non-finite reading', () => {
    // A NaN anchor placed a box at the clamp corner rather than throwing, so this is the one
    // input where a silent wrong answer was actually reachable.
    expect(snap(Number.NaN, 8)).toBe(0);
    expect(snap(Number.POSITIVE_INFINITY, 8)).toBe(0);
  });

  it('never snaps a rectangle to zero size', () => {
    const snapped = snapRect({ x: 0, y: 0, width: 3, height: 2 }, 8);
    expect(snapped.width).toBe(8);
    expect(snapped.height).toBe(8);
  });
});

describe('the grid alone is not the mechanism', () => {
  /**
   * The falsification the module comment claims: quantising an unstable value leaves it unstable,
   * and makes the jump *bigger*. If this ever starts passing as "stable", grid snapping would be
   * sufficient and the hysteresis below would be dead weight - so this test failing is how that
   * claim gets rechecked.
   */
  it('flips a whole cell when the anchor sits near a boundary', () => {
    const nearBoundary = 500; // 500/8 = 62.5 - exactly between two cells
    const snapped = [nearBoundary - 3, nearBoundary + 3].map((x) => snap(x, 8));

    expect(snapped[0]).toBe(496);
    expect(snapped[1]).toBe(504);
    // A 6px wobble in the input became an 8px jump in the output.
    expect(Math.abs((snapped[1] ?? 0) - (snapped[0] ?? 0))).toBe(8);
  });
});

describe('StickyAnchors', () => {
  it('holds one position across 10 frames of +-3px jitter', () => {
    const sticky = new StickyAnchors();
    const points = positionsFor(sticky, 'get to the port', jitter(BASE, 10, 3));

    expect(points).toHaveLength(10);
    // The metric: one distinct position across ten frames means the box never moved.
    expect(distinct(points)).toBe(1);
  });

  it('would have moved on those same frames without stabilization', () => {
    // The control. Without this, the assertion above is satisfied by any implementation - including
    // one that returns a constant - and would keep passing if jitter stopped reaching the module.
    const points = jitter(BASE, 10, 3).map((raw) => {
      const outcome = placeBoxes([{ anchor: raw, width: 400, height: 60 }], { screen: SCREEN });
      return outcome.positions[0] ?? null;
    });

    expect(distinct(points)).toBeGreaterThan(1);
  });

  it('reports every frame after the first as held', () => {
    const sticky = new StickyAnchors();
    const decisions = jitter(BASE, 10, 3).map((raw) => sticky.resolve('get to the port', raw).decision);

    expect(decisions[0]).toBe('new');
    expect(decisions.slice(1)).toEqual(Array.from({ length: 9 }, () => 'held'));
  });

  it('follows the text when the bbox really moves', () => {
    const sticky = new StickyAnchors();
    const moved = { ...BASE, y: BASE.y - 50 };
    const points = positionsFor(sticky, 'get to the port', [BASE, moved]);

    expect(distinct(points)).toBe(2);
    expect(sticky.resolve('get to the port', moved).decision).toBe('held');
  });

  it('recomputes rather than trailing a bbox that walks in one direction', () => {
    // The drift case the module comment argues about. Each step is 3px - inside the tolerance -
    // but the comparison is against the anchor in use, so the second step already exceeds it.
    const sticky = new StickyAnchors({ tolerance: 6 });
    const walk = Array.from({ length: 8 }, (_unused, index) => ({ ...BASE, y: BASE.y + index * 3 }));

    const anchors = walk.map((raw) => sticky.resolve('walking subtitle', raw));

    for (let index = 0; index < walk.length; index += 1) {
      const held = anchors[index]?.anchor;
      const raw = walk[index];
      if (held === undefined || raw === undefined) throw new Error('missing frame');
      // The guarantee: the anchor in use is never further than the tolerance from the truth.
      // Snapping can add up to half a grid cell on top of it, which is why the bound is not 6.
      expect(Math.abs(held.y - raw.y)).toBeLessThanOrEqual(6 + 8 / 2);
    }
  });

  it('holds through width jitter alone', () => {
    // Width feeds the box's own width in layout.ts, which changes its measured height, which
    // changes placement. Stabilizing only the corner would leave this path open.
    const sticky = new StickyAnchors();
    const widths = [640, 642, 638, 641, 639];
    const anchors = widths.map((width) => sticky.resolve('same line', { ...BASE, width }).anchor);

    expect(new Set(anchors.map((rect) => rect.width)).size).toBe(1);
  });

  it('gives different text its own anchor', () => {
    const sticky = new StickyAnchors();
    sticky.resolve('first line', BASE);
    const second = sticky.resolve('a completely different line', BASE);

    expect(second.decision).toBe('new');
    expect(sticky.size).toBe(2);
  });

  it('keeps the same string at two places apart', () => {
    const sticky = new StickyAnchors();
    const here: Rect = { x: 100, y: 100, width: 200, height: 40 };
    const there: Rect = { x: 100, y: 900, width: 200, height: 40 };

    const first = sticky.resolve('Continue', here);
    const second = sticky.resolve('Continue', there);

    expect(sticky.size).toBe(2);
    expect(first.anchor.y).not.toBe(second.anchor.y);
    // And each keeps holding its own, rather than the second overwriting the first.
    expect(sticky.resolve('Continue', { ...here, y: here.y + 2 }).anchor.y).toBe(first.anchor.y);
    expect(sticky.resolve('Continue', { ...there, y: there.y + 2 }).anchor.y).toBe(second.anchor.y);
  });

  it('treats case and spacing differences as the same line', () => {
    const sticky = new StickyAnchors();
    sticky.resolve('Get to the  port', BASE);
    expect(sticky.resolve('get to the port', BASE).decision).toBe('held');
    expect(sticky.size).toBe(1);
  });

  it('stays bounded', () => {
    const sticky = new StickyAnchors({ maxEntries: 4 });
    for (let index = 0; index < 200; index += 1) {
      sticky.resolve(`line number ${String(index)}`, { ...BASE, y: index * KEY_CELL * 2 });
    }
    expect(sticky.size).toBe(4);
  });

  it('evicts least-recently-used, not least-recently-added', () => {
    const sticky = new StickyAnchors({ maxEntries: 2 });
    const a: Rect = { x: 0, y: 0, width: 100, height: 20 };
    const b: Rect = { x: 0, y: 500, width: 100, height: 20 };
    const c: Rect = { x: 0, y: 900, width: 100, height: 20 };

    sticky.resolve('alpha', a);
    sticky.resolve('bravo', b);
    sticky.resolve('alpha', a); // touch: alpha is now the most recent
    sticky.resolve('charlie', c); // evicts bravo

    expect(sticky.resolve('alpha', a).decision).toBe('held');
    expect(sticky.resolve('bravo', b).decision).toBe('new');
  });

  it('forgets everything on clear', () => {
    const sticky = new StickyAnchors();
    sticky.resolve('get to the port', BASE);
    sticky.clear();

    expect(sticky.size).toBe(0);
    expect(sticky.resolve('get to the port', BASE).decision).toBe('new');
  });

  it('rejects a grid or a cap that would fail silently', () => {
    expect(() => new StickyAnchors({ grid: 0 })).toThrow(RangeError);
    expect(() => new StickyAnchors({ grid: Number.NaN })).toThrow(RangeError);
    expect(() => new StickyAnchors({ maxEntries: 0 })).toThrow(RangeError);
  });

  it('honours a configured grid and tolerance', () => {
    const coarse = new StickyAnchors({ grid: 32, tolerance: 0 });
    expect(coarse.resolve('x', { x: 100, y: 100, width: 64, height: 32 }).anchor.x).toBe(96);
    // tolerance 0 means any movement at all recomputes.
    expect(coarse.resolve('x', { x: 101, y: 100, width: 64, height: 32 }).decision).toBe('moved');
  });
});

describe('helpers', () => {
  it('keys on text and a coarse cell', () => {
    expect(anchorKey('Hello', { x: 0, y: 0, width: 1, height: 1 })).toBe('0:0:hello');
    expect(anchorKey('Hello', { x: KEY_CELL, y: 0, width: 1, height: 1 })).toBe('1:0:hello');
  });

  it('normalizes only case and whitespace', () => {
    expect(normalizeKey('  Get  to\tthe port ')).toBe('get to the port');
    // Not fuzzy: dedup has already ruled on jitter, so a real character difference is real.
    expect(normalizeKey('port')).not.toBe(normalizeKey('part'));
  });

  it('measures each axis independently', () => {
    const held: Rect = { x: 0, y: 0, width: 100, height: 20 };
    expect(within({ x: 6, y: 6, width: 100, height: 20 }, held, 6)).toBe(true);
    expect(within({ x: 7, y: 0, width: 100, height: 20 }, held, 6)).toBe(false);
    expect(within({ x: 0, y: 0, width: 107, height: 20 }, held, 6)).toBe(false);
    expect(within({ x: 0, y: 0, width: 100, height: 27 }, held, 6)).toBe(false);
  });
});
