/**
 * M3-01. The bug this converter exists to prevent is invisible on the hardware it was
 * written on: all three attached displays run at scaleFactor 1.0, so physical and logical
 * px are numerically identical and a completely wrong implementation passes every
 * observation anyone could make here. That is precisely how the reference project shipped
 * its DPI bug.
 *
 * So the load-bearing cases below are synthetic `Display` objects at 1.25 / 1.5 / 2.0, and
 * the single most important one is `mixed DPI`: a second display whose logical origin is
 * *not* its physical origin divided by its own scale. A suite without that test would pass
 * against an implementation that divides the wire's `monitor.bounds`, which is exactly the
 * implementation the design doc forbids.
 */

import { describe, expect, it } from 'vitest';

import type { Rect } from '../../src/shared/protocol.js';
import {
  toLogicalRect,
  toPhysicalRegion,
  unionRects,
  type CssRect,
  type DisplayGeometry,
  type LogicalRect,
} from '../../src/main/utils/coordinates.js';

/** Physical-px rect, in the wire's `[x, y, width, height]` order. */
function rect(x: number, y: number, width: number, height: number): Rect {
  return [x, y, width, height];
}

function display(x: number, y: number, scaleFactor: number): DisplayGeometry {
  return { bounds: { x, y }, scaleFactor };
}

/** Exact to well past any plausible rendering precision, but tolerant of IEEE-754 dust. */
function expectRect(actual: LogicalRect, expected: LogicalRect): void {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
  expect(actual.width).toBeCloseTo(expected.width, 9);
  expect(actual.height).toBeCloseTo(expected.height, 9);
}

describe('toLogicalRect', () => {
  describe('scale 1.0', () => {
    it('passes a bbox through unchanged when the region and the display are both at the origin', () => {
      const result = toLogicalRect(rect(120, 40, 300, 28), rect(0, 0, 1200, 200), display(0, 0, 1.0));

      expectRect(result, { x: 120, y: 40, width: 300, height: 28 });
    });

    it('is the case that proves nothing on this machine', () => {
      // Every attached display here is 1.0, so this assertion also holds for an
      // implementation that ignores scale entirely, one that divides monitor.bounds, and
      // one that multiplies instead of dividing. It is included for completeness and is
      // explicitly *not* the evidence that this module is correct.
      const identity = toLogicalRect(rect(7, 9, 11, 13), rect(0, 0, 100, 100), display(0, 0, 1.0));

      expectRect(identity, { x: 7, y: 9, width: 11, height: 13 });
    });
  });

  describe('scale 1.5', () => {
    it('divides the region-relative physical position by the display scale', () => {
      // (300 + 60) / 1.5 = 240 ; (150 + 30) / 1.5 = 120 ; 450 / 1.5 = 300 ; 36 / 1.5 = 24
      const result = toLogicalRect(rect(60, 30, 450, 36), rect(300, 150, 1200, 400), display(0, 0, 1.5));

      expectRect(result, { x: 240, y: 120, width: 300, height: 24 });
    });

    it('keeps the fractional part rather than rounding it away', () => {
      // 361 / 1.5 = 240.666... - a rounding implementation returns 241 and is off by a
      // third of a pixel before the renderer has even seen the box.
      const result = toLogicalRect(rect(61, 31, 100, 20), rect(300, 150, 1200, 400), display(0, 0, 1.5));

      expectRect(result, {
        x: 361 / 1.5,
        y: 181 / 1.5,
        width: 100 / 1.5,
        height: 20 / 1.5,
      });
      expect(Number.isInteger(result.x)).toBe(false);
    });
  });

  describe('scale 1.25', () => {
    it('produces the exact quotient, not a rounded one', () => {
      // 13 / 1.25 = 10.4 exactly. Hand-computed, not read back from the implementation.
      const result = toLogicalRect(rect(10, 25, 13, 30), rect(0, 0, 800, 600), display(0, 0, 1.25));

      expectRect(result, { x: 8, y: 20, width: 10.4, height: 24 });
    });

    it('does not accumulate an off-by-one across physically adjacent boxes', () => {
      // Three 13px-wide boxes that touch exactly in physical px: 10..23, 23..36, 36..49.
      const region = rect(0, 0, 800, 600);
      const scaled = display(0, 0, 1.25);
      const first = toLogicalRect(rect(10, 0, 13, 30), region, scaled);
      const second = toLogicalRect(rect(23, 0, 13, 30), region, scaled);
      const third = toLogicalRect(rect(36, 0, 13, 30), region, scaled);

      // They must still touch after conversion. An implementation that rounds each rect's
      // origin and size independently gets 8/10, 18/10, 29/10 - so the second box ends at
      // 28 while the third starts at 29, and a 1px seam opens up between two halves of the
      // same word. Grouping and anti-overlap both see that seam as real.
      expect(first.x + first.width).toBeCloseTo(second.x, 9);
      expect(second.x + second.width).toBeCloseTo(third.x, 9);

      // And the whole run spans exactly the physical extent it did before: 39 / 1.25 = 31.2
      expect(third.x + third.width - first.x).toBeCloseTo(31.2, 9);
    });
  });

  describe('region offset', () => {
    it('adds the region origin in physical px, before scaling', () => {
      // The order matters at non-integer scales: (200 + 50) / 1.25 = 200, whereas scaling
      // the two separately and adding gives 160 + 40 = 200 here but drifts as soon as
      // either term is rounded. Asserting the sum-then-scale value pins the order.
      const result = toLogicalRect(rect(50, 90, 100, 40), rect(200, 110, 1000, 300), display(0, 0, 1.25));

      expectRect(result, { x: 200, y: 160, width: 80, height: 32 });
    });

    it('leaves the region out of it entirely when the region is at the origin', () => {
      const atOrigin = toLogicalRect(rect(50, 90, 100, 40), rect(0, 0, 1000, 300), display(0, 0, 1.25));

      expectRect(atOrigin, { x: 40, y: 72, width: 80, height: 32 });
    });
  });

  describe('display left of primary', () => {
    it('produces negative logical coordinates', () => {
      // Real hardware: \\.\DISPLAY2 is a 1080x1920 portrait panel at logical (-1080, 6).
      const display2 = display(-1080, 6, 1.0);

      const result = toLogicalRect(rect(25, 40, 200, 30), rect(0, 0, 1080, 1920), display2);

      expectRect(result, { x: -1055, y: 46, width: 200, height: 30 });
      expect(result.x).toBeLessThan(0);
    });

    it('stays negative when the scale is not 1.0', () => {
      // Same panel hypothetically at 150%: (0 + 300) / 1.5 = 200, and -1080 + 200 = -880.
      // An implementation that scaled the display origin too would return -1080/1.5 + 200
      // = -520 and put the overlay 360px inside the wrong part of the desktop.
      const result = toLogicalRect(rect(300, 600, 90, 45), rect(0, 0, 1080, 1920), display(-1080, 6, 1.5));

      expectRect(result, { x: -880, y: 406, width: 60, height: 30 });
    });
  });

  describe('mixed DPI', () => {
    /*
     * THE test. Two displays laid out left to right:
     *
     *   A: 3840x2160 @200%, physical origin (0,0)    -> Electron DIP bounds x = 0
     *   B: 1920x1080 @100%, physical origin (3840,0) -> Electron DIP bounds x = 1920
     *
     * B's logical origin is 1920 because Chromium places displays adjacent in DIP space:
     * A occupies 3840/2 = 1920 DIP of width, so B starts where A ends. It is NOT
     * physical/scale, which for B is 3840 / 1.0 = 3840.
     */
    const displayA = display(0, 0, 2.0);
    const displayB = display(1920, 0, 1.0);
    /** What the sidecar puts on the wire for B: raw physical px from Win32. */
    const wireBoundsB: Rect = [3840, 0, 1920, 1080];

    it("uses Electron's DIP origin, not the wire's physical origin divided by scale", () => {
      const result = toLogicalRect(rect(10, 20, 400, 30), rect(100, 50, 1200, 200), displayB);

      // (100 + 10) / 1.0 + 1920 = 2030
      expect(result.x).toBeCloseTo(2030, 9);

      // The bug this whole issue exists to prevent yields 110 + 3840 / 1.0 = 3950 - a
      // 1920px error, which is an overlay drawn on the wrong monitor entirely.
      const dividingTheWireBounds = 110 + wireBoundsB[0] / displayB.scaleFactor;
      expect(dividingTheWireBounds).toBe(3950);
      expect(result.x).not.toBeCloseTo(dividingTheWireBounds, 9);
    });

    it('converts each display with its own scale', () => {
      const bbox = rect(10, 20, 400, 30);
      const region = rect(100, 50, 1200, 200);

      const onA = toLogicalRect(bbox, region, displayA);
      const onB = toLogicalRect(bbox, region, displayB);

      // Identical physical input, different displays, different answers - because the
      // scale is read per display and not once per process.
      expectRect(onA, { x: 55, y: 35, width: 200, height: 15 });
      expectRect(onB, { x: 2030, y: 70, width: 400, height: 30 });
    });

    it('keeps the origin unscaled when the high-DPI display is the one with a non-zero origin', () => {
      /*
       * The mirror of the layout above, and the case that separates the two ways to get
       * this wrong:
       *
       *   C: 1920x1080 @100%, physical origin (0,0)    -> DIP bounds x = 0
       *   D: 3840x2160 @200%, physical origin (1920,0) -> DIP bounds x = 1920
       *
       * D is high-DPI *and* offset, so its origin term and its scale term are both
       * non-trivial and each wrong implementation lands somewhere different.
       */
      const displayD = display(1920, 0, 2.0);
      const wirePhysicalOriginD = 1920;

      const result = toLogicalRect(rect(40, 10, 200, 60), rect(600, 100, 1200, 400), displayD);

      // (600 + 40) / 2.0 + 1920 = 320 + 1920 = 2240
      expect(result.x).toBeCloseTo(2240, 9);

      // Dividing the wire's physical origin by D's own scale: 320 + 1920/2 = 1280.
      expect(320 + wirePhysicalOriginD / displayD.scaleFactor).toBe(1280);
      expect(result.x).not.toBeCloseTo(1280, 9);

      // Folding the origin in before scaling: (600 + 40 + 1920) / 2 = 1280 as well - two
      // different mistakes, the same 960px error, neither of them 2240.
      expect((600 + 40 + displayD.bounds.x) / displayD.scaleFactor).toBe(1280);
    });

    it('places a box on B beyond the logical width of A, and nowhere near its physical width', () => {
      // A ends at DIP x = 1920. Anything on B must land at or past that, and well short of
      // A's *physical* right edge at 3840 unless it is genuinely far into B.
      const nearLeftEdgeOfB = toLogicalRect(rect(0, 0, 10, 10), rect(0, 0, 1920, 1080), displayB);

      expect(nearLeftEdgeOfB.x).toBeCloseTo(1920, 9);
      expect(nearLeftEdgeOfB.x).toBeLessThan(3840);
    });
  });

  describe('invalid input', () => {
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      'refuses a scaleFactor of %p rather than returning Infinity or NaN coordinates',
      (scaleFactor) => {
        expect(() => toLogicalRect(rect(0, 0, 1, 1), rect(0, 0, 1, 1), display(0, 0, scaleFactor))).toThrow(
          RangeError,
        );
      },
    );
  });
});

describe('unionRects', () => {
  it('encloses every rect it is given', () => {
    const result = unionRects([
      { x: 10, y: 20, width: 100, height: 30 },
      { x: 5, y: 60, width: 40, height: 30 },
      { x: 80, y: 40, width: 200, height: 10 },
    ]);

    expect(result).toEqual({ x: 5, y: 20, width: 275, height: 70 });
  });

  it('returns the rect itself for a single input', () => {
    expect(unionRects([{ x: 1, y: 2, width: 3, height: 4 }])).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it('handles negative origins', () => {
    const result = unionRects([
      { x: -1055, y: 46, width: 200, height: 30 },
      { x: -1000, y: 100, width: 200, height: 20 },
    ]);

    // Right edge is max(-1055 + 200, -1000 + 200) = -800, so the union spans 255px and the
    // second rect - not the first - decides it. Bottom is 120, so the height is 120 - 46.
    expect(result).toEqual({ x: -1055, y: 46, width: 255, height: 74 });
  });

  it('is undefined for an empty list rather than a zero rect at the origin', () => {
    expect(unionRects([])).toBeUndefined();
  });
});

/**
 * M6-02 (#29). Same blindness as the forward converter, same remedy: every meaningful case
 * here is at a scale factor no display on this machine can produce.
 *
 * The extra thing this suite has to pin down is the **rounding direction**. Rounding to
 * nearest passes any "is the region about right?" check a human could make, and loses up to
 * half a physical pixel off an edge - which spike S1 measured as the difference between
 * `Logician` and `ogician`.
 */
describe('toPhysicalRegion', () => {
  const css = (x: number, y: number, width: number, height: number): CssRect => ({ x, y, width, height });

  it('is the identity at scale 1.0 on the primary display, which proves nothing', () => {
    // Included for completeness. This assertion also holds for an implementation that ignores
    // the scale factor entirely, and every display on this machine is 1.0.
    const result = toPhysicalRegion(css(400, 900, 1200, 150), { x: 0, y: 0 }, display(0, 0, 1.0));

    expect(result).toEqual([400, 900, 1200, 150]);
  });

  it('scales a selection on a 150% display', () => {
    const result = toPhysicalRegion(css(400, 900, 1200, 150), { x: 0, y: 0 }, display(0, 0, 1.5));

    expect(result).toEqual([600, 1350, 1800, 225]);
  });

  it('subtracts the display origin before scaling, not after', () => {
    // Display at DIP x=1920 running at 200%: a selection 100 DIP into it is 200 physical px
    // into it, *not* (1920 + 100) * 2. Scaling before subtracting puts the region 3840px away
    // - off the monitor entirely - and the sidecar would clamp or fail rather than show the
    // user where the mistake was.
    const result = toPhysicalRegion(css(100, 50, 300, 200), { x: 1920, y: 0 }, display(1920, 0, 2.0));

    expect(result).toEqual([200, 100, 600, 400]);
  });

  it('handles a display to the left of primary, whose origin is negative', () => {
    const result = toPhysicalRegion(css(40, 60, 200, 100), { x: -1080, y: 6 }, display(-1080, 6, 1.0));

    expect(result).toEqual([40, 60, 200, 100]);
  });

  it('uses the window origin rather than assuming the picker covers the display', () => {
    // The ground truth records a real case: a picker asked for the display's full bounds on a
    // secondary monitor and got back a window 48px shorter, sitting at the work area's origin.
    // If the conversion assumed the window started at the display origin, every region picked
    // on that monitor would be offset by the difference.
    const insetWindow = toPhysicalRegion(css(0, 0, 100, 100), { x: 1920, y: 48 }, display(1920, 0, 2.0));

    expect(insetWindow).toEqual([0, 96, 200, 200]);
  });

  it('rounds outward so the region always contains what the user drew', () => {
    // At 125% a selection on a half-pixel boundary lands between physical pixels. 10.5 -> 10
    // (floor) and the far edge 110.5 -> 111 (ceil), so the region grows by a pixel rather than
    // shaving one off a glyph the user deliberately included.
    const result = toPhysicalRegion(css(8.4, 8.4, 80, 80), { x: 0, y: 0 }, display(0, 0, 1.25));

    // Origin 10, far edge 111, so the *width* is 101 - one physical px wider than the 100 the
    // selection covers exactly. Writing 111 here would be confusing a far edge with a size.
    expect(result).toEqual([10, 10, 101, 101]);
    // Contains the exact rectangle, in both directions.
    expect(result[0]).toBeLessThanOrEqual(8.4 * 1.25);
    expect(result[0] + result[2]).toBeGreaterThanOrEqual((8.4 + 80) * 1.25);
  });

  it('returns integers at every scale factor, because the schema and the sidecar demand them', () => {
    for (const scaleFactor of [1.0, 1.25, 1.5, 1.75, 2.0]) {
      const result = toPhysicalRegion(css(13.3, 7.7, 101.1, 49.9), { x: 0, y: 0 }, display(0, 0, scaleFactor));
      for (const value of result) {
        expect(Number.isInteger(value)).toBe(true);
      }
      expect(result[2]).toBeGreaterThan(0);
      expect(result[3]).toBeGreaterThan(0);
    }
  });

  it('round-trips a region back through toLogicalRect to within the outward rounding', () => {
    // The two functions are inverses, and this is the assertion that keeps them so. A bbox at
    // the region's own origin must come back at the selection's logical origin.
    const target = display(1920, 0, 1.5);
    const selection = css(200, 120, 640, 200);
    const region = toPhysicalRegion(selection, { x: 1920, y: 0 }, target);

    const back = toLogicalRect([0, 0, region[2], region[3]], region, target);

    expect(back.x).toBeCloseTo(selection.x + 1920, 6);
    expect(back.y).toBeCloseTo(selection.y, 6);
    expect(back.width).toBeCloseTo(selection.width, 6);
    expect(back.height).toBeCloseTo(selection.height, 6);
  });

  it('refuses a scale factor that would place every region nowhere', () => {
    expect(() => toPhysicalRegion(css(0, 0, 10, 10), { x: 0, y: 0 }, display(0, 0, 0))).toThrow(RangeError);
    expect(() => toPhysicalRegion(css(0, 0, 10, 10), { x: 0, y: 0 }, display(0, 0, NaN))).toThrow(RangeError);
  });
});
