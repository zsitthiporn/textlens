/**
 * M6-03 (#30) and M6-04 (#31).
 *
 * The padding tests look trivial and are not: spike S1 measured that a crop through a glyph
 * breaks Windows OCR outright rather than degrading it - `Logician` came back as `ogician` -
 * and the recognizer reports no confidence at all (#47), so nothing downstream can catch it.
 * The clamp cases are the ones that matter most in practice, because the region this app is
 * built for is a subtitle at the very bottom of the screen, which is exactly where padding
 * runs off the monitor.
 */

import { describe, expect, it } from 'vitest';

import {
  EdgeWarningThrottle,
  MIN_REGION_PX,
  checkRegionSize,
  checkSavedRegion,
  clampRegion,
  effectiveDiffThreshold,
  findEdgeContact,
  padRegion,
} from '../../src/main/services/region-guard.js';
import { DEFAULT_CONFIG, type SavedRegion } from '../../src/shared/config-schema.js';
import type { MonitorInfo, OcrLine, Rect } from '../../src/shared/protocol.js';

const MONITOR: readonly [number, number] = [1920, 1080];

function line(x: number, y: number, width: number, height: number): OcrLine {
  return { text: 'sample', bbox: [x, y, width, height] };
}

describe('padRegion', () => {
  it('grows the region on every side', () => {
    expect(padRegion([400, 400, 600, 200], 8, MONITOR)).toEqual([392, 392, 616, 216]);
  });

  it('is the identity at zero padding, which is what the #30 regression test compares against', () => {
    expect(padRegion([400, 400, 600, 200], 0, MONITOR)).toEqual([400, 400, 600, 200]);
  });

  it('clamps at the bottom edge, which is where subtitle regions actually live', () => {
    // A region flush with the bottom of a 1080p screen. Padding it downward without clamping
    // produces a region 8px taller than the monitor, and the sidecar either fails or silently
    // returns something smaller - both worse than being padded on three sides.
    const result = padRegion([400, 1000, 1200, 80], 8, MONITOR);

    expect(result).toEqual([392, 992, 1216, 88]);
    expect(result[1] + result[3]).toBe(1080);
  });

  it('clamps at the origin without sliding the region off the text', () => {
    // Clamping the origin while keeping the width would move the region right, away from the
    // content the user aimed at. Growing what can grow and leaving the rest keeps it in place.
    const result = padRegion([0, 0, 300, 100], 8, MONITOR);

    expect(result).toEqual([0, 0, 308, 108]);
  });

  it('clamps a region that already fills the whole monitor', () => {
    expect(padRegion([0, 0, 1920, 1080], 16, MONITOR)).toEqual([0, 0, 1920, 1080]);
  });

  it('never produces a negative size', () => {
    // A region outside the monitor entirely - which `checkSavedRegion` rejects before this is
    // reached, but a clamp that can go negative is a clamp that produces an invalid `configure`.
    const result = padRegion([3000, 3000, 100, 100], 8, MONITOR);

    expect(result[2]).toBeGreaterThanOrEqual(0);
    expect(result[3]).toBeGreaterThanOrEqual(0);
  });
});

describe('clampRegion', () => {
  it('confines a region to the monitor without growing it', () => {
    expect(clampRegion([1800, 1000, 400, 200], MONITOR)).toEqual([1800, 1000, 120, 80]);
  });

  it('leaves a region that already fits exactly as it was', () => {
    expect(clampRegion([400, 900, 1200, 150], MONITOR)).toEqual([400, 900, 1200, 150]);
  });
});

/**
 * #50's regression guard: "มี regression test ที่จะพังถ้าเกณฑ์นี้กลับไปกินการเปลี่ยนแปลงขนาด
 * subtitle อีก".
 *
 * The measurement these numbers come from is recorded in `effectiveDiffThreshold`'s doc comment
 * and in `config-schema.ts`. The short version: on a 1600x460 region, `0.01` detected one line
 * of 40px subtitle text and `0.02` did not, which brackets that change between roughly 7,400 and
 * 14,700 changed physical px. `SUBTITLE_CHANGE_PX` below is the *pessimistic* end of the
 * bracket, deliberately, and then some - real subtitles are smaller and lower-contrast than the
 * test's were.
 */
describe('effectiveDiffThreshold (#50)', () => {
  /**
   * A conservative estimate of how many physical px one subtitle line change actually covers.
   *
   * Below the measured 7,400 floor on purpose. A test that used the measured value would pass
   * for a threshold that only just works on *this* machine's test text.
   */
  const SUBTITLE_CHANGE_PX = 5_000;

  /** Every region size a user might plausibly end up with, including the two that failed. */
  const REGIONS: readonly (readonly [string, Rect])[] = [
    ['cropped 1200x220', [400, 900, 1200, 220]],
    ['loose 1600x460', [200, 780, 1600, 460]],
    ['half of an ultrawide', [0, 0, 1720, 1440]],
    ['full 1920x1080', [0, 0, 1920, 1080]],
    ['full 3440x1440', [0, 0, 3440, 1440]],
  ];

  it('detects a subtitle-sized change at every region size a user could pick', () => {
    for (const [name, region] of REGIONS) {
      const threshold = effectiveDiffThreshold(
        region,
        DEFAULT_CONFIG.capture.diffThreshold,
        DEFAULT_CONFIG.capture.diffMinChangedPx,
      );
      const changedFraction = SUBTITLE_CHANGE_PX / (region[2] * region[3]);

      // This is the assertion that fails if anyone raises the default back toward 0.02, or
      // removes the absolute floor: on the larger regions the fraction alone is not enough.
      expect(changedFraction, `${name} must clear its own threshold`).toBeGreaterThan(threshold);
    }
  });

  it('is the plain fraction on a region small enough for the fraction to be the stricter rule', () => {
    // 1200x220 = 264,000 px. The floor would be 4000/264000 = 0.0152, far looser than 0.005, so
    // the configured fraction governs - which is what keeps a small region from being woken by
    // noise.
    expect(effectiveDiffThreshold([0, 0, 1200, 220], 0.005, 4_000)).toBeCloseTo(0.005, 9);
  });

  it('falls back to the absolute floor once the region is large enough for the fraction to go deaf', () => {
    // 3440x1440 = 4,953,600 px. 0.005 of that is 24,768 px - roughly three subtitle lines, which
    // is exactly the deafness #50 reported. The floor brings it back to 4,000.
    const threshold = effectiveDiffThreshold([0, 0, 3440, 1440], 0.005, 4_000);

    expect(threshold * 3440 * 1440).toBeCloseTo(4_000, 6);
    expect(threshold).toBeLessThan(0.005);
  });

  it('never lets the floor make a tiny region hair-trigger', () => {
    // On a 100x50 box the floor alone would demand 80% of the region change. The fraction wins,
    // which is the other half of why this is a `min` of two rules rather than one rule.
    expect(effectiveDiffThreshold([0, 0, 100, 50], 0.005, 4_000)).toBeCloseTo(0.005, 9);
  });

  it('reproduces the exact failure #50 reported, so it cannot come back unnoticed', () => {
    // The issue's own configuration: full-screen 3440x1440 at 0.02. A subtitle-sized change is
    // 0.001 of that region, which 0.02 discards - 20x too small to be seen.
    const old = 0.02;
    const changedFraction = SUBTITLE_CHANGE_PX / (3440 * 1440);
    expect(changedFraction).toBeLessThan(old);

    // And the same change under what ships now.
    const now = effectiveDiffThreshold(
      [0, 0, 3440, 1440],
      DEFAULT_CONFIG.capture.diffThreshold,
      DEFAULT_CONFIG.capture.diffMinChangedPx,
    );
    expect(changedFraction).toBeGreaterThan(now);
  });

  it('leaves a degenerate region with the configured fraction rather than Infinity', () => {
    // Dividing by a zero area would send Infinity or NaN as a threshold, and the sidecar would
    // compare against it and never once report a change - silently.
    expect(effectiveDiffThreshold([0, 0, 0, 0], 0.005, 4_000)).toBe(0.005);
  });
});

describe('checkSavedRegion', () => {
  const saved: SavedRegion = {
    rect: [400, 900, 1200, 150],
    monitorId: '\\\\.\\DISPLAY1',
    monitorSize: [1920, 1080],
  };
  const attached: MonitorInfo = { id: '\\\\.\\DISPLAY1', scale: 1, bounds: [0, 0, 1920, 1080] };

  it('accepts a region whose monitor is attached and unchanged', () => {
    const verdict = checkSavedRegion(saved, [attached]);

    expect(verdict.ok).toBe(true);
  });

  it('rejects a region whose monitor is gone rather than moving it to another screen', () => {
    const verdict = checkSavedRegion(saved, [
      { id: '\\\\.\\DISPLAY2', scale: 1, bounds: [0, 0, 2560, 1440] },
    ]);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('monitor-missing');
    // The message is the whole point: #31 requires the user be told, not that the app cope.
    expect(verdict.message).toContain('DISPLAY1');
  });

  it('rejects a region whose monitor changed resolution instead of rescaling it', () => {
    // Rescaling is the tempting fix and it is wrong: a region is chosen by pointing at content,
    // and content does not move proportionally when a display changes mode. A rescaled region
    // lands somewhere plausible and wrong, which is the failure that looks like success.
    const verdict = checkSavedRegion(saved, [
      { id: '\\\\.\\DISPLAY1', scale: 1, bounds: [0, 0, 2560, 1440] },
    ]);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('resolution-changed');
    expect(verdict.message).toContain('1920x1080');
    expect(verdict.message).toContain('2560x1440');
  });

  it('rejects a region that does not fit the monitor it names', () => {
    const verdict = checkSavedRegion(
      { rect: [1800, 1000, 400, 200], monitorId: '\\\\.\\DISPLAY1', monitorSize: [1920, 1080] },
      [attached],
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('out-of-bounds');
  });

  it('notices a resolution change even when the monitor id is unchanged', () => {
    // The id alone cannot distinguish these, which is exactly why `monitorSize` is stored.
    //
    // The *reason* is asserted, not just the rejection. A mutation run showed why: with the
    // size comparison removed this region still came back `ok: false`, because a 1200px-wide
    // rectangle does not fit a 1080px-wide monitor and the bounds check caught it instead. The
    // test passed while the thing it names was gone.
    const rotated = checkSavedRegion(saved, [
      { id: '\\\\.\\DISPLAY1', scale: 1, bounds: [0, 0, 1080, 1920] },
    ]);

    expect(rotated.ok).toBe(false);
    if (rotated.ok) return;
    expect(rotated.reason).toBe('resolution-changed');
  });

  it('rejects a region that still fits after the resolution changed', () => {
    // The case the bounds check cannot catch: the monitor got *bigger*, so the old rectangle is
    // still inside it and is still pointing at the wrong content. Only `monitorSize` sees this.
    const verdict = checkSavedRegion(
      { rect: [10, 10, 200, 100], monitorId: '\\\\.\\DISPLAY1', monitorSize: [1920, 1080] },
      [{ id: '\\\\.\\DISPLAY1', scale: 1, bounds: [0, 0, 3440, 1440] }],
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('resolution-changed');
  });
});

describe('checkRegionSize', () => {
  it('accepts a subtitle-sized region', () => {
    expect(checkRegionSize([400, 900, 1200, 150]).ok).toBe(true);
  });

  it('refuses an accidental click with a reason rather than silently widening it', () => {
    const result = checkRegionSize([400, 900, 4, 3]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(String(MIN_REGION_PX));
  });

  it('refuses a region that is wide but not tall', () => {
    expect(checkRegionSize([0, 0, 1200, 4]).ok).toBe(false);
  });
});

describe('findEdgeContact', () => {
  const region: Rect = [400, 900, 1200, 150];

  it('reports nothing when every line sits clear of the edges', () => {
    const report = findEdgeContact([line(20, 20, 400, 40), line(20, 80, 600, 40)], region);

    expect(report.edges).toEqual([]);
    expect(report.lines).toBe(0);
  });

  it('reports the right edge when a line runs to it', () => {
    // bbox is region-relative, so the right edge is the region's *width*, not its x + width.
    // Comparing against a monitor-relative edge instead would report every frame as clipped.
    const report = findEdgeContact([line(20, 20, 1180, 40)], region);

    expect(report.edges).toContain('right');
    expect(report.lines).toBe(1);
  });

  it('reports the left and top edges', () => {
    const report = findEdgeContact([line(0, 0, 300, 40)], region);

    expect(report.edges).toContain('left');
    expect(report.edges).toContain('top');
  });

  it('reports the bottom edge', () => {
    const report = findEdgeContact([line(20, 110, 300, 40)], region);

    expect(report.edges).toContain('bottom');
  });

  it('counts lines, not edges, so two clipped lines are two lines', () => {
    const report = findEdgeContact([line(0, 20, 300, 40), line(0, 80, 300, 40)], region);

    expect(report.lines).toBe(2);
    expect(report.edges).toEqual(['left']);
  });

  it('tolerates a line that ends a pixel short of the edge', () => {
    // OCR boxes are not pixel-exact, and a line ending one pixel inside the region means the
    // same thing as one ending exactly on it.
    const report = findEdgeContact([line(20, 20, 1179, 40)], region);

    expect(report.edges).toContain('right');
  });
});

describe('EdgeWarningThrottle', () => {
  it('reports the first occurrence immediately', () => {
    const throttle = new EdgeWarningThrottle(30_000, () => 0);

    expect(throttle.shouldReport({ edges: ['right'], lines: 1 })).toBe(true);
  });

  it('suppresses the same edges within the interval', () => {
    let now = 0;
    const throttle = new EdgeWarningThrottle(30_000, () => now);

    expect(throttle.shouldReport({ edges: ['right'], lines: 1 })).toBe(true);
    now = 5_000;
    expect(throttle.shouldReport({ edges: ['right'], lines: 1 })).toBe(false);
    now = 29_999;
    expect(throttle.shouldReport({ edges: ['right'], lines: 1 })).toBe(false);
  });

  it('reports again once the interval has elapsed', () => {
    let now = 0;
    const throttle = new EdgeWarningThrottle(30_000, () => now);
    throttle.shouldReport({ edges: ['right'], lines: 1 });

    now = 30_000;

    expect(throttle.shouldReport({ edges: ['right'], lines: 1 })).toBe(true);
  });

  it('reports a different set of edges at once rather than waiting out the interval', () => {
    // Text spilling off the right edge and text spilling off the bottom are different problems
    // with different fixes. Suppressing the second because the first was recent would hide it
    // for as long as the first keeps recurring.
    let now = 0;
    const throttle = new EdgeWarningThrottle(30_000, () => now);
    expect(throttle.shouldReport({ edges: ['right'], lines: 1 })).toBe(true);

    now = 100;

    expect(throttle.shouldReport({ edges: ['bottom'], lines: 1 })).toBe(true);
  });

  it('never reports a clean frame, and re-arms so the next problem is immediate', () => {
    let now = 0;
    const throttle = new EdgeWarningThrottle(30_000, () => now);
    throttle.shouldReport({ edges: ['right'], lines: 1 });

    now = 10;
    expect(throttle.shouldReport({ edges: [], lines: 0 })).toBe(false);

    // Clipping starts again well inside the interval. It is reported at once, because the
    // problem going away and coming back is new information.
    now = 20;
    expect(throttle.shouldReport({ edges: ['right'], lines: 1 })).toBe(true);
  });
});
