/**
 * Merging OCR lines into translatable blocks (issue M3-02, feature O5).
 *
 * OCR hands back one box per visual line. Translating those line by line produces bad
 * output, because a sentence split across three lines becomes three fragments that the
 * translator has no way to relate - so lines are merged into blocks before anything else
 * looks at them.
 *
 * This lives on the Node side rather than in the sidecar (CLAUDE.md invariant 2) so that
 * swapping the OCR engine touches one file. It consumes `LogicalRect`, which means it runs
 * *after* coordinate conversion, matching the data flow in design doc section 4. Importing
 * that type is not scale arithmetic; there is none in this file, and there must not be.
 *
 * ## The thresholds are measurements, not round numbers
 *
 * Spike S1 measured a real Helldivers 2 briefing panel and recorded vertical gap divided by
 * line height:
 *
 * | relationship               | ratio |
 * |----------------------------|-------|
 * | lines within one paragraph | 0.08  |
 * | heading -> body            | 0.92  |
 * | across paragraphs          | 1.16  |
 *
 * The reference project used 1.0. That sits only 16% below the real paragraph break at 1.16
 * - one font change away from flipping - and, worse, it sits *above* the heading gap at
 * 0.92, so every heading gets swallowed into the paragraph beneath it and translated as part
 * of the same sentence. The default here is **0.5**: the midpoint of 0.08 and 0.92, inside
 * the 0.4-0.5 band the spike recommends, and far from both measured values in both
 * directions.
 *
 * Both thresholds are options rather than constants because the spike's numbers come from a
 * single image and explicitly say so.
 *
 * Out of scope, later issues: noise filtering (#14), feedback-loop filters (#15), dedup
 * (#16). This module drops nothing - a line that arrives comes out inside some block.
 */

import { unionRects, type LogicalRect } from './coordinates.js';

/** One OCR line after coordinate conversion. */
export interface PositionedLine {
  readonly text: string;
  /** Logical px, absolute on the virtual desktop - the output of `toLogicalRect`. */
  readonly rect: LogicalRect;
}

/** Lines merged into one unit of translation. */
export interface TextBlock {
  /** The lines that make it up, in reading order. Never empty. */
  readonly lines: readonly PositionedLine[];
  /** `lines` joined with single spaces - what gets sent to the translator. */
  readonly text: string;
  /** The smallest logical rect enclosing every line in the block. */
  readonly bbox: LogicalRect;
}

export interface GroupingOptions {
  /**
   * Vertical gap divided by line height, above which two stacked lines are different
   * blocks. Default 0.5; see the module comment for why not 1.0.
   */
  readonly paragraphGapRatio?: number;
  /**
   * Horizontal gap divided by line height, above which two lines are different columns.
   *
   * Default 1.5, and **weakly constrained**: spike S1 offers exactly one data point for it
   * (`MISSION` at x=187 and `40 MINUTES` at x=589 on the same row, 299px apart at a line
   * height around 30px - a ratio near 10). Anything from about 1 to 5 separates that case
   * correctly; 1.5 is chosen to also split narrower two-column layouts, and wants a second
   * measurement before anyone trusts it precisely.
   */
  readonly columnGapRatio?: number;
}

export const DEFAULT_PARAGRAPH_GAP_RATIO = 0.5;
export const DEFAULT_COLUMN_GAP_RATIO = 1.5;

/**
 * Group lines into blocks.
 *
 * Lines are sorted into reading order (top edge, then left edge) and then walked, comparing
 * each line with the previous one. A break is declared when either the vertical gap or the
 * horizontal gap is too large relative to the line height.
 *
 * Ratios divide by the **shorter** of the two line heights. That choice is deliberate and
 * matters at exactly the case the thresholds were measured for: a tall heading above normal
 * body text. Dividing by the taller line would shrink the ratio and merge the heading into
 * the paragraph - the reference project's bug arrived at from the other direction.
 *
 * @returns Blocks in reading order. Empty input yields `[]`.
 */
export function groupLines(lines: readonly PositionedLine[], options: GroupingOptions = {}): TextBlock[] {
  const paragraphGapRatio = options.paragraphGapRatio ?? DEFAULT_PARAGRAPH_GAP_RATIO;
  const columnGapRatio = options.columnGapRatio ?? DEFAULT_COLUMN_GAP_RATIO;

  if (lines.length === 0) return [];

  // Copy before sorting: the caller's array is not ours to reorder.
  const ordered = [...lines].sort(compareReadingOrder);

  const blocks: TextBlock[] = [];
  let current: PositionedLine[] = [];

  for (const line of ordered) {
    const previous = current[current.length - 1];
    if (previous !== undefined && breaksBlock(previous, line, paragraphGapRatio, columnGapRatio)) {
      blocks.push(buildBlock(current));
      current = [];
    }
    current.push(line);
  }

  if (current.length > 0) blocks.push(buildBlock(current));

  return blocks;
}

/** Top edge first, then left edge, so two boxes on one row are adjacent in the walk. */
function compareReadingOrder(a: PositionedLine, b: PositionedLine): number {
  if (a.rect.y !== b.rect.y) return a.rect.y - b.rect.y;
  return a.rect.x - b.rect.x;
}

function breaksBlock(
  previous: PositionedLine,
  next: PositionedLine,
  paragraphGapRatio: number,
  columnGapRatio: number,
): boolean {
  // The shorter line sets the scale. See the doc comment on `groupLines`.
  const referenceHeight = Math.min(previous.rect.height, next.rect.height);

  // A zero or negative height makes every ratio meaningless (and divides by zero), so the
  // only safe answer is to keep the degenerate line out of its neighbour's block rather
  // than merge on a number that means nothing. Such lines are #14's to remove.
  if (!(referenceHeight > 0)) return true;

  // Column break. Checked first and unconditionally, because two boxes on the *same* row
  // have a vertical gap of zero or less - the paragraph rule alone would always merge them,
  // which is how `MISSION` and `40 MINUTES` end up translated as one phrase.
  if (horizontalGap(previous.rect, next.rect) / referenceHeight > columnGapRatio) return true;

  return verticalGap(previous.rect, next.rect) / referenceHeight > paragraphGapRatio;
}

/** Space between the bottom of the upper rect and the top of the lower one. 0 when they overlap. */
function verticalGap(a: LogicalRect, b: LogicalRect): number {
  const upper = a.y <= b.y ? a : b;
  const lower = upper === a ? b : a;
  return Math.max(0, lower.y - (upper.y + upper.height));
}

/** Space between the right edge of the left rect and the left edge of the right one. 0 when they overlap. */
function horizontalGap(a: LogicalRect, b: LogicalRect): number {
  const left = a.x <= b.x ? a : b;
  const right = left === a ? b : a;
  return Math.max(0, right.x - (left.x + left.width));
}

function buildBlock(lines: readonly PositionedLine[]): TextBlock {
  const bbox = unionRects(lines.map((line) => line.rect));
  // Unreachable: `groupLines` only calls this with a non-empty array. Narrowing rather than
  // asserting, so a future caller that breaks the precondition fails here and not later.
  if (bbox === undefined) throw new Error('cannot build a text block from zero lines');

  return {
    lines: [...lines],
    text: lines.map((line) => line.text).join(' '),
    bbox,
  };
}
