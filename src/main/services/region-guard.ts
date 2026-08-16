/**
 * Everything that stands between the rectangle a user dragged and the rectangle the sidecar
 * crops with (issues M6-03 / #30 and M6-04 / #31, features R7 and R2).
 *
 * Three jobs, all of them pure functions over rectangles:
 *
 *   1. **Pad and clamp** the saved region before it becomes a `configure`.
 *   2. **Decide whether a saved region still means anything** on the hardware attached now.
 *   3. **Notice when recognised text is touching the edge** of the region, and say so.
 *
 * ## Why padding is a correctness feature and not a nicety
 *
 * Spike S1 measured what happens when a crop cuts through a glyph, and it is not graceful
 * degradation: `Logician` came back from Windows OCR as `ogician`, `arithmetic` as
 * `cithmetic`. The recognizer does not report low confidence - it cannot, it reports no
 * confidence at all (#47) - so a clipped region produces fluent, wrong words that the
 * translator then translates fluently and wrongly. There is no downstream stage that can catch
 * it, which is why it has to be prevented here.
 *
 * And a user *will* clip. The box they drag is the box they see, and the antialiased edge of a
 * letter extends past what they see. So the app quietly grows their rectangle rather than
 * asking them to be more careful than a human can be with a mouse.
 *
 * ## Why the edge check exists as well
 *
 * Padding fixes the case where the user was one or two pixels tight. It cannot fix the case
 * where the text genuinely extends past the region - a longer subtitle line than the one that
 * was on screen when they drew the box. That shows up as a recognised line whose bbox is
 * *against* the region's edge, and the only useful response is to tell the user to widen it.
 * Under invariant 4 this cannot be silent, and under the latency budget it cannot fire on every
 * frame either, so the report is throttled.
 *
 * ## No `electron`, no I/O, no state except the throttle
 *
 * Same reason as everywhere else in `services/`: this has to be testable in plain Node against
 * mixed-DPI hardware that is not attached to the machine.
 */

import type { SavedRegion } from '../../shared/config-schema.js';
import type { MonitorInfo, OcrLine, Rect } from '../../shared/protocol.js';

/**
 * Grow `region` by `padding` on every side, clamped to the monitor.
 *
 * The region is monitor-relative, so the monitor is `[0, 0, width, height]` in the same space
 * and clamping is against that rather than against the monitor's position on the desktop.
 *
 * Clamping is what stops the padding turning a legal region into an illegal one: a subtitle
 * box dragged to the very bottom of the screen is the *normal* case for this app, and padding
 * it downward without clamping produces a region that runs off the monitor. The sidecar would
 * either fail or silently return a smaller frame, and both are worse than a region that is
 * padded on three sides.
 *
 * @param monitorSize `[width, height]` of the monitor in physical px.
 */
export function padRegion(region: Rect, padding: number, monitorSize: readonly [number, number]): Rect {
  const [monitorWidth, monitorHeight] = monitorSize;
  const [x, y, width, height] = region;

  // Each edge is moved independently and then clamped, rather than clamping the origin and
  // keeping the size: the latter slides the region back onto the monitor, moving it away from
  // the text the user aimed at. Growing what can grow and leaving the rest is the behaviour
  // that keeps the region over the same content.
  const left = Math.max(0, x - padding);
  const top = Math.max(0, y - padding);
  const right = Math.min(monitorWidth, x + width + padding);
  const bottom = Math.min(monitorHeight, y + height + padding);

  return [left, top, Math.max(0, right - left), Math.max(0, bottom - top)];
}

/**
 * Confine a region to a monitor without padding it.
 *
 * Used for a region that was saved when the monitor was larger. It is deliberately **not** the
 * recovery path for a resolution change - {@link checkSavedRegion} rejects those outright,
 * because a clamped region is still pointing at the wrong content. This exists so that a region
 * which is legal but for a pixel of rounding cannot become an invalid `configure`.
 */
export function clampRegion(region: Rect, monitorSize: readonly [number, number]): Rect {
  return padRegion(region, 0, monitorSize);
}

/**
 * Which of the two change-detection knobs actually governs a given region (#50, #54).
 *
 * ## The root cause #50 names
 *
 * `configure.diffThreshold` is a *fraction* of the region's pixels, so one number means wildly
 * different things at different region sizes. Measured on this machine (3440x1440, 40px white
 * text on black replaced every 700ms, 800ms poll, 8s per cell, counting the sidecar's own
 * `frame` vs `nochange` lines):
 *
 * | region              | pixels | 0.02      | 0.01 | 0.005 | 0.002 |
 * |---------------------|--------|-----------|------|-------|-------|
 * | 1200x220 (cropped)  | 264k   | 8 frames  | 8    | 8     | 8     |
 * | 1600x460 (loose)    | 736k   | **1**     | 8    | 8     | 8     |
 * | 3440x1440 (full)    | 4.95M  | **3**     | 8    | 8     | 8     |
 *
 * The same subtitle change sails past 0.02 on a cropped region and is thrown away on a loose
 * one. Nothing about the *content* changed between those rows - only the denominator.
 *
 * From the 1600x460 row, where 0.01 detects and 0.02 does not, one line of that text is between
 * 7,400 and 14,700 changed physical px. (The full-screen row cannot be used for this: it
 * contains the rest of the desktop, which is why it registers changes at 0.02 that have nothing
 * to do with the subtitle.)
 *
 * ## What this does about it, stated the way it actually behaves
 *
 *     effective = min(fraction, maxRequiredPx / regionArea)
 *
 * **`min` picks the more *sensitive* of the two, not the stricter one.** A smaller threshold
 * fires on a smaller change, so the lower number is the one that wakes up more easily. #54 was
 * filed because this was described as a "floor" in #50's commit and closing comment, and a floor
 * is what `max` would have given - the opposite behaviour. The word was wrong; the code was not,
 * and it must stay `min`: `max` restores #50 immediately, and three regression tests in
 * `tests/main/region-guard.test.ts` exist to make that failure loud.
 *
 * Read `maxRequiredPx` as a **ceiling on the demand**: "however large the region, never require
 * more than this many changed pixels before calling it a change." Multiplying the effective
 * fraction back out gives `min(fraction * area, maxRequiredPx)`, which is that sentence exactly.
 *
 * The two clauses protect opposite ends and neither alone is enough:
 *
 *   - The **pixel ceiling** stops a large region from going deaf. A subtitle is the same number
 *     of pixels whether the box around it is tight or covers the screen, so the thing that
 *     should stay constant is a pixel count, not a ratio.
 *   - The **fraction** stops a tiny region from being hair-trigger. On a 100x50 box the ceiling
 *     alone would demand 80% of the region change, which is nonsense in the other direction, so
 *     the user's fraction wins there.
 *
 * ## And the consequence #54 is really about
 *
 * Whichever term is smaller wins outright, so on a large region the user's `diffThreshold` has
 * **no effect at all**:
 *
 * | region             | pixels | `fraction` 0.005 | `4000/area` | in force        |
 * |--------------------|--------|------------------|-------------|-----------------|
 * | 1200x220           | 264k   | 0.005            | 0.0152      | **fraction**    |
 * | 3440x1440          | 4.95M  | 0.005            | 0.000807    | **maxRequiredPx** |
 *
 * A user on a full-screen region who finds the app too twitchy and raises `diffThreshold` from
 * 0.005 to 0.05 sees nothing change, and until #54 nothing said why. That is what
 * {@link DiffThresholdDecision.governedBy} is for, and why the caller logs it.
 *
 * Deliberately computed here in Node rather than in the sidecar's `ChangeDetector`: it needs no
 * pixels, only the region's dimensions, and the C# side has its own test suite and its own
 * language. Nothing about the wire changes - the sidecar still receives one fraction and still
 * compares it the way it always has.
 */
export interface DiffThresholdDecision {
  /** The fraction to put on the wire. */
  readonly effective: number;
  /**
   * Which term produced {@link effective}.
   *
   * `'fraction'` means the user's `diffThreshold` is live. `'maxRequiredPx'` means it is inert
   * and the region's size decided instead - the case invariant 4 says cannot be silent.
   */
  readonly governedBy: 'fraction' | 'maxRequiredPx';
  /** Changed physical px this threshold actually demands. The number a human can picture. */
  readonly requiredPx: number;
}

/**
 * @param fraction the user's `capture.diffThreshold`.
 * @param maxRequiredPx the user's `capture.diffMaxRequiredPx`.
 */
export function decideDiffThreshold(
  region: Rect,
  fraction: number,
  maxRequiredPx: number,
): DiffThresholdDecision {
  const area = region[2] * region[3];
  // A degenerate region cannot produce a meaningful ratio, and dividing by it would send
  // Infinity or NaN as a threshold - which the sidecar would compare against and never satisfy.
  if (!Number.isFinite(area) || area <= 0) {
    return { effective: fraction, governedBy: 'fraction', requiredPx: 0 };
  }

  const ceilingAsFraction = maxRequiredPx / area;
  // Ties go to `'fraction'`: when both terms give the same number the user's knob is not being
  // overridden by anything, and reporting it as overridden would be a warning about nothing.
  const governedBy = ceilingAsFraction < fraction ? 'maxRequiredPx' : 'fraction';
  const effective = Math.min(fraction, ceilingAsFraction);
  return { effective, governedBy, requiredPx: effective * area };
}

/**
 * The `diffThreshold` to actually send for a given region (#50).
 *
 * The number only. {@link decideDiffThreshold} is the same computation with the reason attached;
 * this wrapper exists because most callers want the wire value and nothing else.
 */
export function effectiveDiffThreshold(region: Rect, fraction: number, maxRequiredPx: number): number {
  return decideDiffThreshold(region, fraction, maxRequiredPx).effective;
}

/** Why a saved region could not be used as-is. */
export type SavedRegionVerdict =
  /** Usable: the monitor is attached and is still the size it was. */
  | { readonly ok: true; readonly monitor: MonitorInfo }
  /** The monitor the region was drawn on is not attached any more. */
  | { readonly ok: false; readonly reason: 'monitor-missing'; readonly message: string }
  /** The monitor is attached but its resolution changed, so the rectangle means something else. */
  | { readonly ok: false; readonly reason: 'resolution-changed'; readonly message: string }
  /** The rectangle does not fit the monitor it names, which means the pair is inconsistent. */
  | { readonly ok: false; readonly reason: 'out-of-bounds'; readonly message: string };

/**
 * Decide whether a saved region can still be applied (#31).
 *
 * Every failure returns a message rather than a bare code, because all three end up in front of
 * the user: #31's criteria are that a missing monitor and a changed resolution are both
 * *reported*, never silently substituted. The tempting alternative - scale the old rectangle to
 * the new resolution - is specifically rejected: a region is chosen by pointing at content, and
 * content does not move proportionally when a display's mode changes. A remapped region lands
 * somewhere plausible and wrong, which is the failure that looks like success.
 */
export function checkSavedRegion(
  saved: SavedRegion,
  monitors: readonly MonitorInfo[],
): SavedRegionVerdict {
  const monitor = monitors.find((entry) => entry.id === saved.monitorId);
  if (monitor === undefined) {
    return {
      ok: false,
      reason: 'monitor-missing',
      message:
        `the saved region was drawn on ${saved.monitorId}, which is not attached; `
        + 'pick a region again rather than having it applied to a different screen',
    };
  }

  const [savedWidth, savedHeight] = saved.monitorSize;
  const width = monitor.bounds[2];
  const height = monitor.bounds[3];
  if (width !== savedWidth || height !== savedHeight) {
    return {
      ok: false,
      reason: 'resolution-changed',
      message:
        `${saved.monitorId} was ${savedWidth}x${savedHeight} when the region was saved and is now `
        + `${width}x${height}; the saved region no longer points at the same part of the screen`,
    };
  }

  const [x, y, rectWidth, rectHeight] = saved.rect;
  if (x + rectWidth > width || y + rectHeight > height) {
    return {
      ok: false,
      reason: 'out-of-bounds',
      message:
        `the saved region ${JSON.stringify(saved.rect)} does not fit inside ${saved.monitorId} `
        + `(${width}x${height}), so the two disagree about what was saved`,
    };
  }

  return { ok: true, monitor };
}

/**
 * The minimum region the picker will accept, in physical px.
 *
 * Small enough not to obstruct a genuinely short subtitle, large enough that an accidental
 * click-and-twitch is rejected rather than becoming a region that can never contain a word.
 * #29 requires that an undersized selection is refused *with a reason*, not silently widened.
 */
export const MIN_REGION_PX = 32;

export type RegionRejection = { readonly ok: false; readonly message: string };
export type RegionAcceptance = { readonly ok: true };

/** Is this rectangle big enough to be worth capturing? */
export function checkRegionSize(region: Rect, minimum = MIN_REGION_PX): RegionAcceptance | RegionRejection {
  const [, , width, height] = region;
  if (width < minimum || height < minimum) {
    return {
      ok: false,
      message: `the selected region is ${width}x${height} physical px; the minimum is ${minimum}x${minimum}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Edge detection
// ---------------------------------------------------------------------------

/**
 * How close a bbox has to come to the region's edge to count as touching it, in physical px.
 *
 * Not zero. OCR bounding boxes are not pixel-exact, and a line of text that genuinely ends one
 * pixel inside the region is not meaningfully different from one that ends exactly on the edge
 * - both mean the user is about to lose the end of a word. Two pixels of slack catches the
 * real case without firing on text that merely sits near the edge.
 */
const EDGE_SLOP_PX = 2;

export interface EdgeReport {
  /** Which edges recognised text is up against. Empty means nothing is clipped. */
  readonly edges: readonly ('left' | 'top' | 'right' | 'bottom')[];
  /** How many recognised lines touch at least one edge. */
  readonly lines: number;
}

/**
 * Which edges of the region have recognised text pressed against them (#30).
 *
 * `lines[].bbox` is physical px **relative to the region's top-left**, so the region's own
 * position never enters this: the far edges are the region's width and height. Getting that
 * wrong would compare a region-relative box against a monitor-relative edge and report every
 * frame as clipped, which is how a warning becomes noise and then gets turned off.
 */
export function findEdgeContact(lines: readonly OcrLine[], region: Rect, slop = EDGE_SLOP_PX): EdgeReport {
  const [, , width, height] = region;
  const edges = new Set<'left' | 'top' | 'right' | 'bottom'>();
  let touching = 0;

  for (const line of lines) {
    const [x, y, lineWidth, lineHeight] = line.bbox;
    let touched = false;
    if (x <= slop) {
      edges.add('left');
      touched = true;
    }
    if (y <= slop) {
      edges.add('top');
      touched = true;
    }
    if (x + lineWidth >= width - slop) {
      edges.add('right');
      touched = true;
    }
    if (y + lineHeight >= height - slop) {
      edges.add('bottom');
      touched = true;
    }
    if (touched) touching += 1;
  }

  return { edges: [...edges], lines: touching };
}

/**
 * Rate-limits the edge warning so it cannot fire on every frame (#30).
 *
 * A stateful object rather than a timestamp threaded through the caller, because the caller is
 * the frame handler and the whole point is that it should not have to think about this. The
 * clock is injectable for the same reason it is everywhere else in this codebase: a test that
 * waits 30 real seconds to prove a throttle is a test nobody runs.
 *
 * Reports again when the *set of edges* changes, not only when the interval elapses. Text
 * spilling off the right edge and text spilling off the bottom are different problems with
 * different fixes, and suppressing the second because the first was reported recently would
 * hide it for as long as the first keeps recurring.
 */
export class EdgeWarningThrottle {
  readonly #intervalMs: number;
  readonly #now: () => number;

  #lastAt = Number.NEGATIVE_INFINITY;
  #lastKey = '';

  constructor(intervalMs = 30_000, now: () => number = Date.now) {
    this.#intervalMs = intervalMs;
    this.#now = now;
  }

  /**
   * @returns whether this report should be surfaced to the user now.
   */
  shouldReport(report: EdgeReport): boolean {
    if (report.edges.length === 0) {
      // Nothing is clipped. Clear the memo so that when it starts again it is reported at once
      // rather than waiting out an interval that began the last time it happened.
      this.#lastKey = '';
      return false;
    }

    const key = [...report.edges].sort().join(',');
    const now = this.#now();
    if (key !== this.#lastKey || now - this.#lastAt >= this.#intervalMs) {
      this.#lastKey = key;
      this.#lastAt = now;
      return true;
    }
    return false;
  }
}
