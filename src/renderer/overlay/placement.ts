/**
 * Anti-overlap placement (issue M5-04, feature U3, design doc section 4's renderer branch).
 *
 * One block of source text gets one translation box, and the boxes are anchored to wherever OCR
 * found their originals - so on a busy screen they collide. This module decides where each one
 * actually goes, in the order the design doc names: **below -> right -> above -> nudge down**.
 *
 * ## Pure on purpose
 *
 * Nothing here touches the DOM. It takes rectangles and returns rectangles, which is what makes
 * the last acceptance criterion testable at all: *identical input gives identical positions
 * every time*. That is not a nicety. M8's sticky placement reuses the previous frame's position
 * for text that has not changed, and "has not changed" is only a safe test if the algorithm
 * would have produced the same answer anyway - a placement that varied with `Map` iteration
 * order or with wall-clock time would make sticky placement paper over a moving target.
 *
 * So: no `Math.random`, no clock, no container iteration order reaching a result, and
 * {@link SpatialHash} deliberately answers only `boolean` (see its module comment).
 *
 * ## Displacement is measured to the anchor, not to the ideal slot
 *
 * The issue's constraint is that a box moved too far "no longer reads as belonging to its source
 * line". The natural reading is distance from where the box *wanted* to be, but that gets the
 * `right` candidate wrong: for a 900px-wide subtitle, sitting beside the source text is a 900px
 * displacement from the ideal below-slot while being visually adjacent to the original - the
 * best possible outcome, rejected by the metric meant to protect it.
 *
 * Distance is therefore measured **rectangle to rectangle, box to its own anchor** (0 when they
 * touch). `right` scores 0 like `below` does, and a box nudged 120px down the screen scores 120
 * and eventually fails, which is the case the constraint was written for.
 *
 * ## A box never covers its own anchor
 *
 * Every candidate is clamped into the viewport, and clamping can push a candidate back over the
 * text it is translating - a subtitle on the last scanline has no room below it, so `below`
 * clamps upward onto the subtitle itself. Covering the original defeats side-by-side mode (U2;
 * covering it is U11, a different feature that is not in the MVP), so an overlapping candidate
 * is rejected and the cascade moves on to `above`.
 *
 * ## No room means no box
 *
 * When every candidate fails, the box is **skipped**. Drawing it overlapping something else
 * would damage two translations to display one. Which boxes deserve the space when the screen
 * is full is the area-budget question, and that is issue #27 (feature U4) - this module places
 * in the order it is given and never reorders.
 */

import { SpatialHash, overlaps, type Rect } from './spatial-hash.js';

export type { Rect };

/** One box waiting for a home: its source rectangle, and its already-measured size. */
export interface PlacementRequest {
  /** The OCR block's rectangle in **CSS px, overlay-window-relative**. */
  readonly anchor: Rect;
  /** Measured by M5-03's first pass. Never guessed from character counts. */
  readonly width: number;
  readonly height: number;
}

export interface PlacementOptions {
  /** The overlay viewport in CSS px. Boxes are confined to it on all four sides. */
  readonly screen: { readonly width: number; readonly height: number };
  /** Space between a box and its anchor. */
  readonly gap?: number;
  /** How far a box may sit from its anchor and still read as belonging to it. */
  readonly maxDisplacement?: number;
  /** Vertical step for the `nudge down` stage. */
  readonly nudgeStep?: number;
  /** How many nudges to try before giving up on a box. */
  readonly nudgeCount?: number;
  /** Keeps boxes off the extreme screen edge. 0 allows a box flush against it. */
  readonly margin?: number;
  /** Grid resolution for collision detection. See {@link SpatialHash}. */
  readonly cellSize?: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type SkipReason =
  /** Wider or taller than the viewport itself; no position could ever hold it. */
  | 'too-large'
  /** Every candidate either collided or sat further from the anchor than allowed. */
  | 'no-room';

export interface PlacementOutcome {
  /**
   * Index-aligned with the requests, `null` where a box was skipped.
   *
   * Aligned rather than compacted, for the same reason `text-pipeline.ts` refuses to zip its
   * translation results: a compacted list has to be re-paired with its inputs by the caller, and
   * getting that wrong puts a translation under someone else's text with no error anywhere.
   */
  readonly positions: readonly (Point | null)[];
  /** Index-aligned with the requests, `null` where a box was placed. Invariant 4's evidence. */
  readonly skipped: readonly (SkipReason | null)[];
  readonly placedCount: number;
  readonly skippedCount: number;
  /** Exact rectangle tests performed. Evidence that collision detection stayed sub-quadratic. */
  readonly comparisons: number;
}

export const DEFAULT_GAP = 4;
export const DEFAULT_MAX_DISPLACEMENT = 140;
export const DEFAULT_NUDGE_STEP = 10;
export const DEFAULT_NUDGE_COUNT = 12;

/** Distance between two rectangles: 0 when they touch or overlap. */
export function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0);
  const dy = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0);
  return Math.hypot(dx, dy);
}

/**
 * Place every box, in the order given.
 *
 * @returns positions index-aligned with `requests`; `null` where the box must not be drawn.
 */
export function placeBoxes(
  requests: readonly PlacementRequest[],
  options: PlacementOptions,
): PlacementOutcome {
  const gap = options.gap ?? DEFAULT_GAP;
  const maxDisplacement = options.maxDisplacement ?? DEFAULT_MAX_DISPLACEMENT;
  const nudgeStep = options.nudgeStep ?? DEFAULT_NUDGE_STEP;
  const nudgeCount = options.nudgeCount ?? DEFAULT_NUDGE_COUNT;
  const margin = options.margin ?? 0;
  const screen = options.screen;

  const hash = new SpatialHash(options.cellSize);
  const positions: (Point | null)[] = [];
  const skipped: (SkipReason | null)[] = [];
  let placedCount = 0;
  let skippedCount = 0;

  for (const request of requests) {
    const placement = placeOne(request, {
      hash,
      screen,
      gap,
      maxDisplacement,
      nudgeStep,
      nudgeCount,
      margin,
    });

    if (placement.point === null) {
      positions.push(null);
      skipped.push(placement.reason);
      skippedCount += 1;
      continue;
    }

    hash.insert({ ...placement.point, width: request.width, height: request.height });
    positions.push(placement.point);
    skipped.push(null);
    placedCount += 1;
  }

  return { positions, skipped, placedCount, skippedCount, comparisons: hash.comparisons };
}

interface PlaceOneContext {
  readonly hash: SpatialHash;
  readonly screen: { readonly width: number; readonly height: number };
  readonly gap: number;
  readonly maxDisplacement: number;
  readonly nudgeStep: number;
  readonly nudgeCount: number;
  readonly margin: number;
}

function placeOne(
  request: PlacementRequest,
  context: PlaceOneContext,
): { point: Point; reason: null } | { point: null; reason: SkipReason } {
  const { anchor, width, height } = request;
  const { screen, margin } = context;

  const maxX = screen.width - margin - width;
  const maxY = screen.height - margin - height;
  if (maxX < margin || maxY < margin) {
    // Nothing to try: the box cannot be inside the viewport at any position. Reported as its own
    // reason because it means "the text is too big for this screen", not "the screen is busy".
    return { point: null, reason: 'too-large' };
  }

  for (const candidate of candidates(request, context)) {
    const x = clamp(candidate.x, margin, maxX);
    const y = clamp(candidate.y, margin, maxY);
    const rect: Rect = { x, y, width, height };

    // Clamping can slide a candidate back over the text it translates; see the module comment.
    if (overlaps(rect, anchor)) continue;
    if (rectDistance(rect, anchor) > context.maxDisplacement) continue;
    if (context.hash.intersects(rect)) continue;

    return { point: { x, y }, reason: null };
  }

  return { point: null, reason: 'no-room' };
}

/**
 * The candidate positions, in the order the design doc fixes: below, right, above, then nudged
 * progressively further down from below.
 *
 * A generator so a box that fits in the first position never computes the rest, and - more to
 * the point - so the order is written down once, in one place, in the order it is tried.
 */
function* candidates(request: PlacementRequest, context: PlaceOneContext): Generator<Point> {
  const { anchor, height } = request;
  const { gap, nudgeStep, nudgeCount } = context;

  const belowY = anchor.y + anchor.height + gap;

  yield { x: anchor.x, y: belowY };
  yield { x: anchor.x + anchor.width + gap, y: anchor.y };
  yield { x: anchor.x, y: anchor.y - height - gap };

  for (let step = 1; step <= nudgeCount; step += 1) {
    yield { x: anchor.x, y: belowY + step * nudgeStep };
  }
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(value, low), high);
}
