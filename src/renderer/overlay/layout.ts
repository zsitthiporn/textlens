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
 * self-reported, which is why it is not the only evidence: `scripts/overlay-layout-check.mjs`
 * drives a real Electron window and reads Chromium's own `LayoutCount` across a render through
 * the CDP performance domain - measured at 1 for a 30-box render, not 30. The marks emitted here
 * (`textlens:measure`, `textlens:render`) are readable with `performance.getEntriesByName`.
 *
 * That check deliberately does not live in `npm test`. vitest runs under Node with no layout
 * engine at all, and the two things worth proving here - that Thai breaks on word boundaries and
 * that the measured height is the rendered height - are exactly what a DOM emulation cannot
 * answer. A test of either under jsdom passes without breaking a line or measuring a pixel.
 *
 * ## Why the user never sees the hidden pass
 *
 * Both passes happen inside one synchronous call, made from one `requestAnimationFrame`
 * callback. The browser cannot paint in the middle of a task, so the `visibility: hidden` state
 * of phase 1 is never presented - there is no frame in which it could be. Not a timing race that
 * usually wins: it is unobservable by construction.
 */

import { StickyAnchors } from './anchor.js';
import { selectWithinBudget, type BudgetDrop } from './budget.js';
import type { OverlayRenderMessage } from './contract.js';
import { BoxPool, type PooledBox } from './node-pool.js';
import {
  placeBoxes,
  type PlacementRequest,
  type Rect,
  type SkipReason,
} from './placement.js';
import { renderSignature, SlotAllocator, slotKey, type SlotState } from './transitions.js';

/** What the renderer draws: text already in CSS px space. */
export interface LayoutEntry {
  readonly text: string;
  /**
   * The OCR text this was translated from.
   *
   * Carried through to this module because #35 keys its sticky anchors on it. Keying on `text`
   * instead would look like it worked and prove nothing: two frames of an unchanged subtitle
   * produce the *identical* Thai string, so a translated-text key is stable even when the
   * mechanism under test is not doing anything.
   */
  readonly sourceText: string;
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
    sourceText: entry.sourceText,
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
  /** Fraction of the viewport translations may cover in total (#27). Omitted means no quota. */
  readonly maxAreaRatio?: number;
  readonly marks?: MarkRecorder;
  /** Crossfade duration in ms (#37). 0 swaps instantly and frees a departing box at once. */
  readonly fadeMs?: number;
  /** Milliseconds. Drives fade-out expiry only; a counter is fine in a test. */
  readonly now?: () => number;
}

export type LayoutPhase = 'write' | 'read';

export interface RenderStats {
  /** Entries in the payload. */
  readonly requested: number;
  /** Entries that got a box at all - `min(requested, pool.capacity)`. */
  readonly claimed: number;
  /** Entries dropped because the pool was full. */
  readonly truncated: number;
  /**
   * Entries the area budget declined to draw (#27).
   *
   * Kept apart from {@link truncated} and from {@link skipped} on purpose: three different things
   * stop a box reaching the screen - the screen is too full of translation (this), the pool has no
   * node left (`truncated`), and anti-overlap found nowhere to put it (`skipped`) - and only the
   * first is a decision. Collapsing them into one number is how "the overlay dropped six" becomes
   * a fact nobody can act on.
   */
  readonly budgetDropped: number;
  /** Entries beyond what the pool could ever hold, dropped by priority rather than arrival (#27). */
  readonly overCapacity: number;
  /** Every entry the budget declined, with its area. Invariant 4's evidence for *which*. */
  readonly budgetDrops: readonly BudgetDrop[];
  /** Total anchor area actually drawn, CSS px². */
  readonly budgetKeptArea: number;
  /** The quota in force this frame, CSS px². */
  readonly budgetArea: number;
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
  /**
   * A6: this payload would have painted the picture already on screen, so nothing was written
   * and nothing was measured. `phaseLog` is empty when this is true, which is the check that the
   * skip really skipped rather than doing the work and discarding it.
   */
  readonly unchanged: boolean;
  /** What the picture is, as compared. Two equal signatures mean two equal pictures. */
  readonly signature: string;
  /** Boxes that were not on screen before this frame and fade in. */
  readonly entering: number;
  /** Boxes whose anchor left the payload. Still drawn, fading out. */
  readonly leaving: number;
  /** Boxes kept at the same anchor whose text changed - A9's crossfade, the case it is for. */
  readonly crossfaded: number;
  /** Anchors held from the previous frame rather than recomputed. #35's counter. */
  readonly heldAnchors: number;
}

/**
 * Everything the renderer remembers between frames.
 *
 * Passed in rather than owned by this module because "between frames" has to survive a call, and
 * a module-level singleton would make two independent tests share one. Reset wholesale when the
 * epoch changes - see {@link OverlayRenderMessage}.
 */
export class RenderSession {
  readonly anchors: StickyAnchors;
  readonly slots: SlotAllocator;
  /** The picture currently on screen, as {@link renderSignature} describes it. */
  signature: string | null = null;

  constructor(options: { capacity: number; grid?: number; tolerance?: number; maxEntries?: number }) {
    this.anchors = new StickyAnchors({
      ...(options.grid === undefined ? {} : { grid: options.grid }),
      ...(options.tolerance === undefined ? {} : { tolerance: options.tolerance }),
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    });
    this.slots = new SlotAllocator(options.capacity);
  }

  reset(): void {
    this.anchors.clear();
    this.slots.clear();
    this.signature = null;
  }
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
  session: RenderSession,
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
  const fadeMs = options.fadeMs ?? 0;
  const now = (options.now ?? Date.now)();

  // ---- phase 0: pure computation. Nothing below is written unless the picture differs. ----
  //
  // #35 runs first and everything downstream sees its answer: the signature A6 compares, the
  // identity A9 keys a box on, and the rectangle placement is computed from. Stabilising later
  // would leave each of those churning on raw jitter, and each of them would look like its own
  // separate bug.
  let heldAnchors = 0;
  const stabilized = entries.map((entry) => {
    const resolved = session.anchors.resolve(entry.sourceText, entry.anchor);
    if (resolved.decision === 'held') heldAnchors += 1;
    return { ...entry, anchor: resolved.anchor };
  });

  // #27, and it runs here for two reasons. Before slot assignment, because culling afterwards
  // would leave the pool handing out its last boxes in arrival order - the exact bug. And before
  // the signature, so that "the same picture" means the same *drawn* picture: a payload that
  // differs only in a block the budget threw away paints nothing new and must still count as
  // unchanged.
  const budget = selectWithinBudget(stabilized, {
    capacity: pool.capacity,
    maxAreaRatio: options.maxAreaRatio ?? 1,
    screen,
  });
  const visible = budget.kept.map((index) => stabilized[index]).filter((entry) => entry !== undefined);
  const overCapacity = budget.dropped.filter((drop) => drop.reason === 'over-capacity').length;
  const budgetDropped = budget.dropped.length - overCapacity;

  const signature = renderSignature(visible, screen);
  if (signature === session.signature) {
    // A6. No writes, no reads, no placement - and an empty `phaseLog`, which is how a test tells
    // this apart from a render that did all the work and then wrote the same values back.
    marks?.mark(MARK_RENDER_END);
    marks?.measure(MEASURE_RENDER, MARK_RENDER_START, MARK_RENDER_END);
    return {
      requested: entries.length,
      claimed: 0,
      truncated: 0,
      // Reported even on a skip: the payload really did carry blocks that are not being drawn,
      // and a caller logging "0 dropped" for a frame that dropped six would be worse than silent.
      budgetDropped,
      overCapacity,
      budgetDrops: budget.dropped,
      budgetKeptArea: budget.keptArea,
      budgetArea: budget.budgetArea,
      drawn: 0,
      skipped: [],
      comparisons: 0,
      phaseLog,
      measuredHeights: [],
      unchanged: true,
      signature,
      entering: 0,
      leaving: 0,
      crossfaded: 0,
      heldAnchors,
    };
  }

  // Reclaim any box whose fade-out finished before this frame arrived.
  for (const index of session.slots.sweep(now, fadeMs)) {
    const box = pool.boxes[index];
    if (box === undefined) continue;
    box.style.display = 'none';
    box.style.visibility = 'hidden';
    box.setText('', false);
  }

  const assignment = session.slots.assign(uniqueKeys(visible), now);
  // Everything still on screen keeps its box, including the ones on their way out. `take(n)`
  // cannot express that set; see `BoxPool.retain`.
  pool.retain(session.slots.retained);

  const claimed = visible.length - assignment.exhausted;
  const widths: number[] = [];
  const boxes: (E | undefined)[] = [];
  const states: (SlotState | null)[] = [];
  let entering = 0;
  let crossfaded = 0;

  // ---- phase 1: writes only -------------------------------------------------------------
  note('write');
  for (let index = 0; index < visible.length; index += 1) {
    const entry = visible[index];
    const slotIndex = assignment.indices[index] ?? null;
    const state = assignment.states[index] ?? null;
    const box = slotIndex === null ? undefined : pool.boxes[slotIndex];
    boxes.push(box);
    states.push(state);
    if (box === undefined || entry === undefined) {
      widths.push(0);
      continue;
    }

    const width = clamp(entry.anchor.width, Math.min(minWidth, maxWidth), maxWidth);
    widths.push(width);

    // A9. A box kept at the same anchor whose words changed is the case the crossfade exists
    // for: the plate stays, the text inside it dissolves. Anything else - a brand new box, or
    // the identical string arriving again - has nothing to fade between and must not pay for a
    // transition it cannot show.
    const textChanged = box.text !== entry.text;
    const fade = fadeMs > 0 && state === 'holding' && textChanged;
    if (fade) crossfaded += 1;
    box.setText(entry.text, fade);

    // H3. Chromium does break Thai on real word boundaries, and that is the reason this project
    // runs on it: measured with `scripts/overlay-layout-check.mjs`, a 180-character Thai string in
    // a 240px box breaks five times and every break lands on an `Intl.Segmenter('th')` word
    // boundary.
    //
    // **This attribute is not what makes that happen.** It used to say so here, and that was
    // wrong: on Electron 43 the break offsets are byte-identical with `lang="th"`, with
    // `lang="en"`, and with no `lang` attribute at all - Blink detects Thai script and selects the
    // dictionary breaker itself. What actually has to survive is `word-break: normal` in
    // `overlay.css`; setting `break-all` moves all five breaks off word boundaries, which is the
    // measurement that identifies the load-bearing property.
    //
    // It is still set, and should stay set - font selection, shaping and accessibility all read
    // it, and it is simply correct HTML. It is recorded as not load-bearing for line breaking so
    // that nobody keeps some other thing on the strength of believing it is. A degraded entry is
    // untranslated English and is tagged as such for the same reasons.
    //
    // Measured on Electron 43 / Chromium 43. Engine behaviour here is not contractual and a
    // future version could reintroduce a dependence on `lang`; the check script is what would
    // catch that.
    box.setAttribute('lang', entry.degraded ? 'en' : 'th');
    box.setAttribute('data-origin', entry.degraded ? 'degraded' : 'translated');
    box.style.width = `${String(width)}px`;
    box.style.display = 'block';
    if (state === 'entering') {
      entering += 1;
      // Transparent now, opaque in phase 4. The reflow phase 2 forces in between is what commits
      // this value, which is what makes the change in phase 4 a transition rather than a jump -
      // the measurement pass and the fade-in need the same style flush, so the fade is free.
      if (fadeMs > 0) box.style.opacity = '0';
    }
    // Laid out, but not presented. `visibility` rather than `opacity` because an opacity-0 box
    // is still composited, and rather than `display: none` because a display-none box has no
    // geometry to measure - which is the entire point of this pass.
    box.style.visibility = 'hidden';
  }

  // A box whose anchor is gone from this payload fades where it stands - same transform, same
  // text - rather than blinking out. Its index stays retained until `sweep` reclaims it.
  for (const index of assignment.leaving) {
    const box = pool.boxes[index];
    if (box === undefined) continue;
    box.style.opacity = fadeMs > 0 ? '0' : '1';
    if (fadeMs <= 0) {
      box.style.display = 'none';
      box.style.visibility = 'hidden';
    }
  }

  // ---- phase 2: reads only. One reflow covers every box. ---------------------------------
  marks?.mark(MARK_MEASURE_START);
  note('read');
  const heights: number[] = [];
  for (const box of boxes) {
    heights.push(box === undefined ? 0 : box.getBoundingClientRect().height);
  }
  marks?.mark(MARK_MEASURE_END);
  marks?.measure(MEASURE_MEASURE_PHASE, MARK_MEASURE_START, MARK_MEASURE_END);

  // ---- phase 3: pure computation, no DOM at all ------------------------------------------
  const requests: PlacementRequest[] = [];
  for (let index = 0; index < visible.length; index += 1) {
    const entry = visible[index];
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
    box.style.opacity = '1';
    drawn += 1;
  }

  marks?.mark(MARK_RENDER_END);
  marks?.measure(MEASURE_RENDER, MARK_RENDER_START, MARK_RENDER_END);

  session.signature = signature;

  return {
    requested: entries.length,
    claimed,
    truncated: assignment.exhausted,
    budgetDropped,
    overCapacity,
    budgetDrops: budget.dropped,
    budgetKeptArea: budget.keptArea,
    budgetArea: budget.budgetArea,
    drawn,
    skipped,
    comparisons: outcome.comparisons,
    phaseLog,
    measuredHeights: heights,
    unchanged: false,
    signature,
    entering,
    leaving: assignment.leaving.length,
    crossfaded,
    heldAnchors,
  };
}

/**
 * One key per entry, disambiguated when two anchors land on the same point.
 *
 * Two OCR blocks can stabilize onto one rectangle - overlapping reads of the same line, or two
 * short labels a few px apart snapping into the same grid cell. Left alone, both entries would
 * claim the same box and the second would overwrite the first: one translation on screen where
 * there should be two, with no error and nothing to count. The suffix is derived from position in
 * the payload, which `text-pipeline.ts` keeps stable, so the disambiguation is stable too.
 */
function uniqueKeys(entries: readonly LayoutEntry[]): string[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const base = slotKey(entry.anchor);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${String(count)}`;
  });
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(value, low), high);
}
