/**
 * Two-pass layout: fill, measure, place, reveal (issue M5-03, feature U7).
 *
 * The reference project *guessed* each box's height from `characters / charactersPerLine *
 * lineHeight`. For Thai that guess is wrong in both directions at once: glyph widths vary, there
 * is no space to count words at, and the line breaker's decisions depend on dictionary lookups
 * that no arithmetic reproduces. A height guessed short leaves boxes overlapping the text below;
 * guessed long leaves a hole and pushes the next box off the screen. Either way the failure is
 * silent - the overlay looks like it is working.
 *
 * So nothing is guessed. The box is filled, laid out invisibly, and its height is **read back
 * from the browser that just laid it out**. That is the only source that knows.
 *
 * ## One forced reflow, and where it comes from
 *
 * Reading geometry from an element whose styles have just changed forces the browser to lay the
 * document out synchronously, right then. Do it inside a loop that also writes, and the cost is
 * paid once per box - the "layout thrashing" pattern, 30 reflows for 30 boxes, inside a 16ms
 * budget.
 *
 * This module is therefore written as three strictly separated phases:
 *
 *   1. **write** every box's text, language and width - no reads at all;
 *   2. **read** every box's height - no writes at all, so one reflow covers all of them;
 *   3. **write** every final position and reveal - no reads follow, so nothing forces a second.
 *
 * The phase boundaries are recorded in {@link RenderStats.phaseLog}, so a future edit that
 * interleaves a read back into phase 1 fails a test rather than quietly costing 30x. That log is
 * self-reported, which is why it is not the only evidence: `tests/main/overlay/` reads Chromium's
 * own `LayoutCount` across a render through the CDP performance domain, and the marks emitted
 * here (`textlens:measure`, `textlens:render`) are readable with `performance.getEntriesByName`.
 *
 * ## Why the user never sees the hidden pass
 *
 * Both passes happen inside one synchronous call, made from one `requestAnimationFrame`
 * callback. The browser cannot paint in the middle of a task, so the `visibility: hidden` state
 * of phase 1 is never presented - there is no frame in which it could be. Not a timing race that
 * usually wins: it is unobservable by construction.
 */

import type { OverlayRenderMessage } from './contract.js';
import { BoxPool, type PooledBox } from './node-pool.js';
import {
  placeBoxes,
  type PlacementRequest,
  type Rect,
  type SkipReason,
} from './placement.js';

/** What the renderer draws: text already in CSS px space. */
export interface LayoutEntry {
  readonly text: string;
  /** **CSS px, overlay-window-relative.** The conversion happened before this module. */
  readonly anchor: Rect;
  /** `true` when `text` is the untranslated original (design doc section 7). */
  readonly degraded: boolean;
}

/**
 * The last hop of the three-space coordinate contract: logical px, absolute on the virtual
 * desktop -> CSS px, relative to the overlay window (`src/main/utils/coordinates.ts`, invariant 3).
 *
 * It is a subtraction and only a subtraction. CSS px and Electron's logical px are the same unit,
 * so any multiplication here would be the DPI bug the reference project shipped, reintroduced at
 * the last possible step - and on a 100%-scale display it would be invisible.
 *
 * Lives in this module rather than in `overlay.ts` so it can be tested at all: `overlay.ts`
 * touches `document` while it is being imported, which a Node-environment test cannot do.
 */
export function toLayoutEntries(message: OverlayRenderMessage): LayoutEntry[] {
  const { x: originX, y: originY } = message.origin;
  return message.payload.entries.map((entry) => ({
    text: entry.text,
    anchor: {
      x: entry.bbox.x - originX,
      y: entry.bbox.y - originY,
      width: entry.bbox.width,
      height: entry.bbox.height,
    },
    degraded: entry.origin === 'degraded',
  }));
}

/** Minimal `performance`. The global satisfies it in both Chromium and Node. */
export interface MarkRecorder {
  mark(name: string): unknown;
  measure(name: string, startMark: string, endMark: string): unknown;
}

export interface LayoutOptions {
  readonly screen: { readonly width: number; readonly height: number };
  /** A box is at least this wide, so a short label's long translation does not become a column. */
  readonly minBoxWidth?: number;
  /** Upper bound on box width, as a fraction of the viewport. */
  readonly maxBoxWidthRatio?: number;
  readonly gap?: number;
  readonly maxDisplacement?: number;
  readonly marks?: MarkRecorder;
}

export type LayoutPhase = 'write' | 'read';

export interface RenderStats {
  /** Entries in the payload. */
  readonly requested: number;
  /** Entries that got a box at all - `min(requested, pool.capacity)`. */
  readonly claimed: number;
  /** Entries dropped because the pool was full. */
  readonly truncated: number;
  /** Boxes actually visible after placement. */
  readonly drawn: number;
  /** Claimed boxes that anti-overlap could not place, by reason. Invariant 4's evidence. */
  readonly skipped: readonly SkipReason[];
  /** Exact rectangle tests during collision detection. */
  readonly comparisons: number;
  /** Phase order, collapsed. A correct render is exactly `['write', 'read', 'write']`. */
  readonly phaseLog: readonly LayoutPhase[];
  /** Heights as measured, index-aligned with the claimed boxes. */
  readonly measuredHeights: readonly number[];
}

export const DEFAULT_MIN_BOX_WIDTH = 140;
export const DEFAULT_MAX_BOX_WIDTH_RATIO = 0.9;

export const MARK_MEASURE_START = 'textlens:measure-start';
export const MARK_MEASURE_END = 'textlens:measure-end';
export const MARK_RENDER_START = 'textlens:render-start';
export const MARK_RENDER_END = 'textlens:render-end';
export const MEASURE_MEASURE_PHASE = 'textlens:measure';
export const MEASURE_RENDER = 'textlens:render';

/**
 * Draw one payload. Synchronous, and expected to be called from inside a `requestAnimationFrame`
 * callback - see the module comment on why that is what makes the hidden pass unobservable.
 */
export function renderEntries<E extends PooledBox>(
  entries: readonly LayoutEntry[],
  pool: BoxPool<E>,
  options: LayoutOptions,
): RenderStats {
  const marks = options.marks;
  const phaseLog: LayoutPhase[] = [];
  const note = (phase: LayoutPhase): void => {
    if (phaseLog[phaseLog.length - 1] !== phase) phaseLog.push(phase);
  };

  marks?.mark(MARK_RENDER_START);

  const screen = options.screen;
  const minWidth = options.minBoxWidth ?? DEFAULT_MIN_BOX_WIDTH;
  const maxWidth = Math.max(
    screen.width * (options.maxBoxWidthRatio ?? DEFAULT_MAX_BOX_WIDTH_RATIO),
    1,
  );

  const claimed = Math.min(entries.length, pool.capacity);
  const boxes = pool.take(claimed);
  const widths: number[] = [];

  // ---- phase 1: writes only -------------------------------------------------------------
  note('write');
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    const entry = entries[index];
    if (box === undefined || entry === undefined) continue;

    const width = clamp(entry.anchor.width, Math.min(minWidth, maxWidth), maxWidth);
    widths.push(width);

    box.textContent = entry.text;
    // H3: this attribute is the whole reason this project runs on Chromium. It is what selects
    // ICU's Thai dictionary line breaker; without it the text is broken as if it were Latin,
    // which for a script with no inter-word spaces means "not broken at all" until the box
    // overflows. A degraded entry is untranslated English and is tagged as such - marking
    // English `th` would ask the Thai breaker to segment Latin words.
    box.setAttribute('lang', entry.degraded ? 'en' : 'th');
    box.setAttribute('data-origin', entry.degraded ? 'degraded' : 'translated');
    box.style.width = `${String(width)}px`;
    box.style.display = 'block';
    // Laid out, but not presented. `visibility` rather than `opacity` because an opacity-0 box
    // is still composited, and rather than `display: none` because a display-none box has no
    // geometry to measure - which is the entire point of this pass.
    box.style.visibility = 'hidden';
  }

  // ---- phase 2: reads only. One reflow covers every box. ---------------------------------
  marks?.mark(MARK_MEASURE_START);
  note('read');
  const heights: number[] = [];
  for (const box of boxes) {
    heights.push(box.getBoundingClientRect().height);
  }
  marks?.mark(MARK_MEASURE_END);
  marks?.measure(MEASURE_MEASURE_PHASE, MARK_MEASURE_START, MARK_MEASURE_END);

  // ---- phase 3: pure computation, no DOM at all ------------------------------------------
  const requests: PlacementRequest[] = [];
  for (let index = 0; index < boxes.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    requests.push({
      anchor: entry.anchor,
      width: widths[index] ?? 0,
      // The measured height, never a guess. This line is issue M5-03.
      height: heights[index] ?? 0,
    });
  }

  const placementOptions = {
    screen,
    ...(options.gap === undefined ? {} : { gap: options.gap }),
    ...(options.maxDisplacement === undefined ? {} : { maxDisplacement: options.maxDisplacement }),
  };
  const outcome = placeBoxes(requests, placementOptions);

  // ---- phase 4: writes only. Nothing reads after this, so no second reflow is forced. -----
  note('write');
  const skipped: SkipReason[] = [];
  let drawn = 0;
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    if (box === undefined) continue;

    const position = outcome.positions[index] ?? null;
    if (position === null) {
      // No room: hidden rather than drawn somewhere wrong. Counted, so the reason survives.
      const reason = outcome.skipped[index];
      if (reason !== undefined && reason !== null) skipped.push(reason);
      box.style.display = 'none';
      box.style.visibility = 'hidden';
      continue;
    }

    // U5: `transform`, never `left`/`top`. A transform change is handled by the compositor and
    // does not invalidate layout; changing `left` would put every box back through layout on
    // every frame, which is precisely what the pool and the single reflow exist to avoid.
    box.style.transform = `translate3d(${String(position.x)}px, ${String(position.y)}px, 0)`;
    box.style.visibility = 'visible';
    drawn += 1;
  }

  marks?.mark(MARK_RENDER_END);
  marks?.measure(MEASURE_RENDER, MARK_RENDER_START, MARK_RENDER_END);

  return {
    requested: entries.length,
    claimed,
    truncated: entries.length - claimed,
    drawn,
    skipped,
    comparisons: outcome.comparisons,
    phaseLog,
    measuredHeights: heights,
  };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(value, low), high);
}
