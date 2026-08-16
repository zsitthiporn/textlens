/**
 * M6-02 (#29), the drag arithmetic only.
 *
 * The reverse-direction cases are the reason this is a separate module rather than two
 * subtractions inside a mousemove handler. Written inline, a right-to-left drag produces a
 * negative width, which CSS declines to draw and `regionSchema` declines to validate - so the
 * bug presents as a picker that appears to do nothing when dragged in two of the four
 * directions, and those are the two nobody tries by hand.
 */

import { describe, expect, it } from 'vitest';

import { clampToWindow, normalizeDrag, physicalSize } from '../../src/renderer/region-picker/drag.js';

describe('normalizeDrag', () => {
  it('produces the rectangle for a left-to-right, top-to-bottom drag', () => {
    expect(normalizeDrag({ x: 100, y: 200 }, { x: 500, y: 350 })).toEqual({
      x: 100,
      y: 200,
      width: 400,
      height: 150,
    });
  });

  it('produces the same rectangle when dragged right to left', () => {
    expect(normalizeDrag({ x: 500, y: 200 }, { x: 100, y: 350 })).toEqual({
      x: 100,
      y: 200,
      width: 400,
      height: 150,
    });
  });

  it('produces the same rectangle when dragged bottom to top', () => {
    expect(normalizeDrag({ x: 100, y: 350 }, { x: 500, y: 200 })).toEqual({
      x: 100,
      y: 200,
      width: 400,
      height: 150,
    });
  });

  it('produces the same rectangle when dragged up and to the left', () => {
    expect(normalizeDrag({ x: 500, y: 350 }, { x: 100, y: 200 })).toEqual({
      x: 100,
      y: 200,
      width: 400,
      height: 150,
    });
  });

  it('never returns a negative size', () => {
    for (const [ax, ay, cx, cy] of [
      [0, 0, -50, -50],
      [10, 10, 10, 10],
      [999, 1, 1, 999],
    ] as const) {
      const rect = normalizeDrag({ x: ax, y: ay }, { x: cx, y: cy });
      expect(rect.width).toBeGreaterThanOrEqual(0);
      expect(rect.height).toBeGreaterThanOrEqual(0);
    }
  });

  it('is a zero-size rect for a click without a drag', () => {
    expect(normalizeDrag({ x: 42, y: 42 }, { x: 42, y: 42 })).toEqual({ x: 42, y: 42, width: 0, height: 0 });
  });
});

describe('clampToWindow', () => {
  it('leaves a point inside the window alone', () => {
    expect(clampToWindow({ x: 100, y: 200 }, 1920, 1080)).toEqual({ x: 100, y: 200 });
  });

  it('pulls a point that ran off the right or bottom back to the edge', () => {
    // A fast drag outruns the compositor, and on a multi-monitor desktop the pointer genuinely
    // crosses onto the next screen. Without this the selection extends past the display it
    // belongs to and converts to a region the monitor does not contain.
    expect(clampToWindow({ x: 5000, y: 5000 }, 1920, 1080)).toEqual({ x: 1920, y: 1080 });
  });

  it('pulls a negative point back to the origin', () => {
    expect(clampToWindow({ x: -300, y: -20 }, 1920, 1080)).toEqual({ x: 0, y: 0 });
  });
});

describe('physicalSize', () => {
  it('is the identity at scale 1.0, which is every display on this machine', () => {
    expect(physicalSize({ x: 0, y: 0, width: 1200, height: 150 }, 1)).toEqual([1200, 150]);
  });

  it('reports the physical px the monitor actually has, not CSS px', () => {
    // The read-out has to match what the user knows about their screen and what the sidecar
    // will crop. On a 150% display, showing 800 for a 1200px subtitle bar is just wrong.
    expect(physicalSize({ x: 0, y: 0, width: 800, height: 100 }, 1.5)).toEqual([1200, 150]);
  });

  it('rounds outward, matching toPhysicalRegion', () => {
    // The number shown during the drag should be the number the region ends up being, not one
    // pixel less.
    expect(physicalSize({ x: 0, y: 0, width: 80.4, height: 80.4 }, 1.25)).toEqual([101, 101]);
  });
});
