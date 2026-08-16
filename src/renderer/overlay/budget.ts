/**
 * Screen area budget and priority ordering (issue M5-05 / #27, feature U4).
 *
 * ## The problem, with the numbers from the run that found it
 *
 * A capture of a full 3440x1440 screen produced `requested: 54` against a pool of 48:
 * `truncated: 6`, then `skipped: ["no-room", "no-room"]` on top. Truncating is correct - #23 says
 * in as many words that more blocks than boxes must draw what fits rather than crash - but *which*
 * six were dropped was decided by nothing more than their position in the payload. The pool ran
 * out and the rest fell off the end.
 *
 * That is the wrong six as often as not. The subtitle this app exists to translate is typically
 * the largest text in the frame, and a payload arrives in reading order, so on a screen whose top
 * half is full of interface chrome the subtitle at the bottom is precisely what arrival order
 * discards. The user sees the incidental text translated and the thing they were watching gone,
 * with a log line that says six were dropped and nothing about which.
 *
 * ## Two orderings, deliberately different
 *
 * **Selection is by area, largest first.** With no confidence value to weight it - Windows OCR
 * reports none at all (#47), and inventing one is forbidden - the size of the recognised block is
 * the only signal available, and it is a good one for this use case: a subtitle is big, a
 * watermark is small.
 *
 * **Placement stays in reading order.** The kept set is returned in the payload's own order, which
 * `text-grouping.ts` has already sorted top-to-bottom then left-to-right. Two reasons, and the
 * second is the load-bearing one:
 *
 *   - The issue asks for it: placement from the top down is what makes the result stable.
 *   - `layout.ts`'s `uniqueKeys` disambiguates two entries that land on the same anchor by their
 *     position in the list. Handing placement a list sorted by *area* would make those suffixes
 *     depend on relative sizes, which wobble frame to frame as the recognizer's boxes breathe -
 *     so a box would change slot identity without moving, and A6's "same picture, no work" and
 *     A9's crossfade would both start missing. Selecting by area and then restoring reading order
 *     keeps every downstream key derived from geometry alone.
 *
 * ## Why this is not in `placement.ts`
 *
 * The issue names that file, and it is the wrong home. `placement.ts` says of itself that it
 * "places in the order it is given and never reorders", and #35's sticky anchors depend on it
 * being a deterministic function of its input. Sorting inside it would make the position of one
 * box depend on the sizes of all the others - the opposite property. This runs *before* it, and
 * before slot assignment too: culling after the pool has handed out boxes would mean the pool
 * still ran out in arrival order, which is the bug.
 *
 * ## Area is the anchor's, not the drawn box's
 *
 * The rectangle measured here is the OCR block, because that is the only one that exists yet -
 * the drawn box's height comes from `layout.ts`'s measurement pass, which happens after slot
 * assignment, which happens after this. The anchor is also the more meaningful quantity: it is
 * how much of the screen the *source text* occupies, which is what "translate the important
 * things" means, and it is the same number the priority ordering uses.
 */

import type { Rect } from './placement.js';

/** Only the rectangle matters here; the caller keeps whatever else its entries carry. */
export interface BudgetCandidate {
  readonly anchor: Rect;
}

export type DropReason =
  /** More entries than the pool can ever hold, and this one was not among the largest. */
  | 'over-capacity'
  /** Keeping it would have pushed the total past the screen-area quota. */
  | 'over-budget';

export interface BudgetDrop {
  /** Index into the caller's original array. */
  readonly index: number;
  readonly reason: DropReason;
  /** The anchor area that lost, in CSS px². Evidence for *why* this one and not another. */
  readonly area: number;
}

export interface BudgetOutcome {
  /** Indices to draw, in the caller's original (reading) order. */
  readonly kept: readonly number[];
  /** Indices not drawn, in the caller's original order. Invariant 4's evidence. */
  readonly dropped: readonly BudgetDrop[];
  /** Total anchor area kept, CSS px². */
  readonly keptArea: number;
  /** The quota that was applied, CSS px². */
  readonly budgetArea: number;
}

export interface BudgetOptions {
  /** Most boxes that can exist at once - the node pool's capacity. */
  readonly capacity: number;
  /** Fraction of the viewport the source blocks may cover in total, 0..1. */
  readonly maxAreaRatio: number;
  readonly screen: { readonly width: number; readonly height: number };
}

/**
 * Choose which entries get drawn.
 *
 * Deterministic: no clock, no randomness, and every comparison falls back to the entry's index, so
 * two equal-area blocks always resolve the same way. Identical input gives an identical answer,
 * which is what lets `layout.ts` keep treating an unchanged payload as unchanged.
 */
export function selectWithinBudget(
  entries: readonly BudgetCandidate[],
  options: BudgetOptions,
): BudgetOutcome {
  const screenArea = Math.max(0, options.screen.width) * Math.max(0, options.screen.height);
  const budgetArea = screenArea * clampRatio(options.maxAreaRatio);
  const capacity = Number.isInteger(options.capacity) && options.capacity > 0 ? options.capacity : 0;

  const ranked = entries
    .map((entry, index) => ({ index, area: areaOf(entry.anchor) }))
    // Largest first; ties broken by the earlier position in reading order.
    //
    // The tiebreak is **explicit rather than load-bearing**, and that is worth saying because a
    // mutation check found it: `Array.prototype.sort` has been required to be stable since
    // ES2019, so removing `|| (a.index - b.index)` changes nothing and no test can tell. It is
    // kept because it states the intent at the point of the decision - "equal blocks resolve by
    // reading order" is a rule this module owes its callers, and leaving it implicit in a
    // language guarantee is how it gets broken by someone reaching for a faster sort later.
    .sort((a, b) => (b.area - a.area) || (a.index - b.index));

  const kept: number[] = [];
  const dropped: BudgetDrop[] = [];
  let keptArea = 0;

  for (const candidate of ranked) {
    if (kept.length >= capacity) {
      dropped.push({ index: candidate.index, reason: 'over-capacity', area: candidate.area });
      continue;
    }
    // The largest block is kept whatever it costs. A single subtitle wider than the quota is the
    // app's main use case, not an abuse of it, and dropping everything would leave a blank overlay
    // that looks exactly like a translation failure - the confidently-wrong outcome invariant 4
    // exists to prevent. Every *later* block is still measured against the full budget, so one
    // oversized block does not license a second.
    if (kept.length > 0 && keptArea + candidate.area > budgetArea) {
      dropped.push({ index: candidate.index, reason: 'over-budget', area: candidate.area });
      continue;
    }
    kept.push(candidate.index);
    keptArea += candidate.area;
  }

  return {
    // Back into reading order: see the module comment on why placement must not see area order.
    kept: kept.sort((a, b) => a - b),
    dropped: dropped.sort((a, b) => a.index - b.index),
    keptArea,
    budgetArea,
  };
}

/** A rectangle's area, and never a negative or non-finite one. */
function areaOf(rect: Rect): number {
  const area = rect.width * rect.height;
  return Number.isFinite(area) && area > 0 ? area : 0;
}

/**
 * The quota as a multiple of the screen's area, or `Infinity` for "no quota".
 *
 * 1 really does mean no quota, rather than "a quota equal to the screen", and the difference is
 * not academic. Recognised blocks do not overlap, so their areas sum to less than the screen in
 * any real frame - which makes a ratio of 1 *look* like no limit right up until some frame with
 * overlapping or duplicated boxes trips it, and then translations vanish for a reason nobody can
 * reconstruct. An explicit `Infinity` says what the config comment says.
 */
function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return ratio >= 1 ? Number.POSITIVE_INFINITY : ratio;
}
