/**
 * Anchor snapping and sticky placement (issue M8-01 / #35, features A7, A8).
 *
 * The number one cause of per-bbox flicker is not the renderer: it is that OCR reports the same
 * unchanged line at a slightly different rectangle on every frame. Design doc section 5 puts the
 * jitter at +-2-3px. The reference project treats the symptom by delaying redraws; this treats
 * the cause by deciding that a box whose text has not changed does not get a new position.
 *
 * ## Grid snapping alone does not work, and fails *worse* than doing nothing
 *
 * The obvious reading of "snap bbox เข้า grid" is `round(x / grid) * grid`, and it does not
 * satisfy the issue's own first acceptance criterion. An anchor sitting near a cell boundary -
 * which is 3 anchors in 8 for a 8px grid and +-3px jitter - flips between two cells, and when it
 * flips the box moves a **whole cell**. Unsnapped, the same jitter moves it 3px. Quantising an
 * unstable value gives an unstable value with a coarser step.
 *
 * So the grid is not the mechanism. The mechanism is **hysteresis**: once an anchor has been
 * chosen for a piece of text, it is kept until the truth has moved further than
 * {@link StickyAnchorOptions.tolerance} away from *it*. The grid still earns its place - it is
 * applied when an anchor is (re)computed, so two readings a pixel apart resolve to one position
 * and the value in use is a round number rather than whatever the recognizer said on the frame
 * that happened to trigger the recompute.
 *
 * ## Comparing against the held value is what bounds drift
 *
 * The comparison is `|raw - held| <= tolerance`, never `|raw - previousRaw|`. That distinction is
 * the whole safety argument: a recognizer that walks 3px per frame in one direction would satisfy
 * a per-step test forever and leave the box arbitrarily far from its text, while against the held
 * value the second frame already exceeds the tolerance and the anchor is recomputed. **A box can
 * never sit more than `tolerance` from the truth**, which is why the tolerance is set below a
 * line height: the failure it forbids is a translation held over the wrong line.
 *
 * ## Width and height are stabilised too, not just x and y
 *
 * `layout.ts` derives a box's width from `anchor.width` and measures its height in that width.
 * A width that jitters therefore changes the measured height, which changes the placement input,
 * which moves the box - with x and y perfectly still. Stabilising only the corner would leave
 * that path open and it would look exactly like the bug this module claims to have fixed.
 *
 * ## What is stabilised is the *input*, not the output
 *
 * The issue says to cache the computed position. This caches the **anchor** instead and lets
 * `placement.ts` run normally, because a cached output position is a position that never went
 * through collision detection: replay it into a frame that has since acquired a neighbour and two
 * boxes overlap, silently, with the anti-overlap cascade never consulted. Feeding a stable input
 * to a deterministic algorithm gets the same stability with the invariant intact - and
 * `placement.ts`'s module comment already promises the determinism this relies on.
 *
 * The consequence, stated because it is a real limit rather than an oversight: stability is
 * per-anchor, not per-box. A box can still move when the *set* of boxes changes, because a new
 * neighbour can take the slot the cascade would have given it. Holding a position through that
 * would mean holding an overlap.
 *
 * ## Pure, and keyed by text *and* place
 *
 * No clock, no DOM, no globals. The cache key is normalized text plus a coarse cell, because the
 * same string legitimately appears twice on one screen - a repeated label, a name in two
 * subtitles - and a text-only key would drag the second occurrence onto the first one's anchor.
 */

import type { Rect } from './spatial-hash.js';

export interface StickyAnchorOptions {
  /** Grid resolution in CSS px, applied when an anchor is computed. `capture.render.anchorGrid`. */
  readonly grid: number;
  /** How far the truth may drift from the held anchor before it is recomputed, in CSS px. */
  readonly tolerance: number;
  /** Hard cap on remembered anchors. Least-recently-used entries are evicted first. */
  readonly maxEntries: number;
}

export const DEFAULT_ANCHOR_GRID = 8;
export const DEFAULT_ANCHOR_TOLERANCE = 6;
export const DEFAULT_STICKY_MAX_ENTRIES = 128;

/**
 * How far apart two anchors may be keyed as the same one, in CSS px.
 *
 * Coarse on purpose and unrelated to {@link StickyAnchorOptions.tolerance}: this only decides
 * which remembered anchor a reading is *compared against*, and the tolerance then decides whether
 * it is reused. Too fine and a line that legitimately moved half a cell looks like new text; too
 * coarse and two different lines of the same subtitle share a slot. 64 is several line heights,
 * which is the scale at which "the same line of text, roughly here" stops being true.
 */
export const KEY_CELL = 64;

/** Why this frame's anchor is what it is. Exists so a test can assert the reason, not just the value. */
export type AnchorDecision =
  /** No entry existed. The snapped reading was stored and used. */
  | 'new'
  /** An entry existed and the reading was within tolerance of it, so the box did not move. */
  | 'held'
  /** An entry existed and the reading had moved too far, so it was recomputed. */
  | 'moved';

export interface StabilizedAnchor {
  readonly anchor: Rect;
  readonly decision: AnchorDecision;
}

interface Entry {
  rect: Rect;
}

/**
 * Remembers where each piece of text was last placed.
 *
 * Not a free function with a `Map` parameter, because the eviction order is part of the
 * behaviour: `Map` iterates in insertion order, and re-inserting on every hit is what turns that
 * into a least-recently-used order. That is a fact about this class and does not belong in a
 * caller.
 */
export class StickyAnchors {
  readonly #entries = new Map<string, Entry>();
  readonly #grid: number;
  readonly #tolerance: number;
  readonly #maxEntries: number;

  constructor(options: Partial<StickyAnchorOptions> = {}) {
    const grid = options.grid ?? DEFAULT_ANCHOR_GRID;
    if (!(grid > 0) || !Number.isFinite(grid)) {
      // A zero or negative grid would make `snap` produce NaN or Infinity and every box would be
      // placed at the clamp corner - 48 boxes stacked in one place, with no error anywhere.
      throw new RangeError(`grid must be a positive finite number, got ${String(grid)}`);
    }
    const maxEntries = options.maxEntries ?? DEFAULT_STICKY_MAX_ENTRIES;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`maxEntries must be a positive integer, got ${String(maxEntries)}`);
    }

    this.#grid = grid;
    this.#tolerance = options.tolerance ?? DEFAULT_ANCHOR_TOLERANCE;
    this.#maxEntries = maxEntries;
  }

  /** Live entries. The acceptance criterion "sticky cache ไม่โตไม่จำกัด" is checked against this. */
  get size(): number {
    return this.#entries.size;
  }

  /** Forget everything. Called when the epoch changes - a new region, monitor or display. */
  clear(): void {
    this.#entries.clear();
  }

  /**
   * The anchor to place `text` at this frame.
   *
   * @param text The **source** text, not the translation. Two frames of the same subtitle differ
   *             in their OCR reading, and `normalizeKey` is what makes those one key; the Thai
   *             translation of an unchanged line is already identical, so keying on it would hide
   *             whether this works.
   */
  resolve(text: string, raw: Rect): StabilizedAnchor {
    const key = anchorKey(text, raw);
    const existing = this.#entries.get(key);

    if (existing !== undefined && within(raw, existing.rect, this.#tolerance)) {
      // Re-insert so `Map`'s insertion order stays a least-recently-used order.
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return { anchor: existing.rect, decision: 'held' };
    }

    const rect = snapRect(raw, this.#grid);
    if (existing !== undefined) this.#entries.delete(key);
    this.#entries.set(key, { rect });
    this.#evict();
    return { anchor: rect, decision: existing === undefined ? 'new' : 'moved' };
  }

  #evict(): void {
    while (this.#entries.size > this.#maxEntries) {
      // `Map` iteration is insertion order and every hit re-inserts, so the first key is the
      // least recently used one.
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) return;
      this.#entries.delete(oldest.value);
    }
  }
}

/**
 * The cache key: what the text is, and roughly where it is.
 *
 * Coordinates are floored to {@link KEY_CELL} rather than rounded, so the key is a plain
 * function of position with no boundary behaviour worth reasoning about - a reading that crosses
 * a key cell boundary simply misses, gets a fresh entry, and the stale one is evicted in time.
 * A miss costs one repositioned box; the alternative failure, two unrelated lines sharing a key,
 * costs a box parked on top of another line's text.
 */
export function anchorKey(text: string, rect: Rect): string {
  const cellX = Math.floor(rect.x / KEY_CELL);
  const cellY = Math.floor(rect.y / KEY_CELL);
  return `${String(cellX)}:${String(cellY)}:${normalizeKey(text)}`;
}

/**
 * Text, reduced to what two readings of the same line have in common.
 *
 * Case and whitespace only. Deliberately **not** `dedup.ts`'s `normalizeForComparison` and
 * deliberately not fuzzy: this module runs in the renderer bundle, which cannot import from
 * `main/`, and a second copy of that function here would be a second thing to keep in step. More
 * to the point, fuzziness is not needed at this stage - `dedup.ts` has already decided that a
 * jittery re-read of the same line is the same line, so text that reaches the renderer twice with
 * one character different is text that genuinely differs by one character, and giving it its own
 * anchor is correct.
 */
export function normalizeKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/gu, ' ');
}

/** Snap one coordinate to the grid. Exported so a test can pin it independently of the cache. */
export function snap(value: number, grid: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value / grid) * grid;
}

/**
 * Snap a rectangle.
 *
 * Width and height are snapped with a floor of one grid cell: a zero-width anchor is a rectangle
 * `placement.ts` would happily place a box against and `layout.ts` would clamp to `minBoxWidth`,
 * so the failure would be a box of the wrong width rather than an error.
 */
export function snapRect(rect: Rect, grid: number): Rect {
  return {
    x: snap(rect.x, grid),
    y: snap(rect.y, grid),
    width: Math.max(snap(rect.width, grid), grid),
    height: Math.max(snap(rect.height, grid), grid),
  };
}

/**
 * Whether `raw` is close enough to `held` on every axis, including size.
 *
 * Chebyshev rather than Euclidean - each axis independently - so the guarantee is one a reader
 * can hold: no edge of the box is ever more than `tolerance` from where it belongs. A Euclidean
 * test would admit a rectangle `tolerance` off in x *and* in y, which is further than the number
 * appears to promise.
 */
export function within(raw: Rect, held: Rect, tolerance: number): boolean {
  return (
    Math.abs(raw.x - held.x) <= tolerance &&
    Math.abs(raw.y - held.y) <= tolerance &&
    Math.abs(raw.width - held.width) <= tolerance &&
    Math.abs(raw.height - held.height) <= tolerance
  );
}
