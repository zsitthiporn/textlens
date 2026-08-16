/**
 * Dropping OCR output that is not translatable text (issue M3-03, feature O4).
 *
 * OCR reads whatever is inside the region, and a game region contains clocks, ammo counters,
 * stat dots and decorative glyphs as well as sentences. Translating those wastes quota on the
 * way in and clutters the overlay on the way out, so they are removed before anything else
 * looks at them - third stage of the data flow in design doc section 4, after grouping and
 * before the feedback filters.
 *
 * ## There is no confidence criterion, and there will not be one
 *
 * `Windows.Media.Ocr` reports no confidence at all: `OcrWord` exposes only `Text` and
 * `BoundingRect`, verified by reflection (decision #47). `OcrLine.conf` is optional on the
 * wire and this engine never populates it, so a threshold on it would be a threshold on
 * `undefined`. Inventing a proxy for it would be the same mistake spike S1 warned against
 * when it said not to "correct" `o` to `O`: a guess dressed as a measurement.
 *
 * What makes the remaining criteria sufficient is also from S1 - the errors this engine makes
 * routinely (`o`/`O`, `I`/`1`, a dropped space) do not change meaning. The junk that actually
 * needs removing is *whole junk lines*, not slightly misread ones, and whole junk lines are
 * short, small, or made of digits and symbols. That is what this module tests for.
 *
 * ## Where the size thresholds come from
 *
 * Measured off spike S1's 425 recognised lines (`spikes/s1-ocr/results/win-ocr-results.json`).
 * Sorted by box height, the set separates cleanly:
 *
 * | what                                                  | height   |
 * |-------------------------------------------------------|----------|
 * | micro UI labels - `lhe`, `data`, `NECK`, `GLOVES`      | 7-9 px   |
 * | body text and subtitles - the lines worth translating  | 12-66 px |
 *
 * So the default `minHeight` is 10: above every measured piece of UI chrome, below every
 * measured sentence. `minWidth` 12 is the same idea on the other axis and is weaker evidence -
 * width correlates with length, which the letter rule already covers.
 *
 * Those images are 1920x1080 screenshots, i.e. physical px at scale 1.0, while this module
 * runs on **logical px** from `coordinates.ts`. The numbers transfer because that is exactly
 * the case where the two spaces coincide, and because DIP is the space where "how big does
 * this look" is constant across displays: a 4K panel at 200% renders 12px body text at 12
 * logical px too. A user whose game draws genuinely tiny subtitles is why `minHeight` is an
 * option and not a constant.
 *
 * ## Block level, and never silent
 *
 * The unit of decision is the `TextBlock`, not the line. A briefing panel where OCR turns a
 * clock icon into `Ö` produces a block whose text begins with junk and continues into a real
 * paragraph; deciding per line would either delete the paragraph or require re-grouping what
 * is left. Deciding per block leaves the paragraph intact and drops only blocks that are junk
 * in their entirety.
 *
 * Every rejection carries a `NoiseReason` rather than being a bare boolean, because a filter
 * that removes text the user can see is precisely the kind of thing CLAUDE.md invariant 4
 * forbids doing silently. `filterNoise` returns what it dropped and why, so the caller can log
 * it and a user asking "why is that line not translated" has an answer.
 */

import type { LogicalRect } from './coordinates.js';
import type { TextBlock } from './text-grouping.js';

/** Why a candidate was rejected. One value per rule, so a log line names the rule. */
export type NoiseReason =
  /** The box is narrower than `minWidth` logical px. */
  | 'bbox-too-narrow'
  /** The box is shorter than `minHeight` logical px. */
  | 'bbox-too-short'
  /** A clock: `16:36`, `12:34`, `1:02:03`. */
  | 'pattern-time'
  /** A percentage: `86%`. */
  | 'pattern-percentage'
  /** Digits and separators only: `000000`, `+1`, `9/10`, `500 12:00`, `1),`. */
  | 'pattern-numeric'
  /** Neither letters nor digits: `...`, `•`, `/////`. */
  | 'pattern-symbolic'
  /** One character repeated: `ooo`, `00`. Stat dots, never a word. */
  | 'pattern-repeated-character'
  /** Fewer than `minLetters` letters once everything else is stripped: `Ö`, `s`. */
  | 'too-few-letters';

/** What `classifyCandidate` needs: the text and the box it came from. `TextBlock` satisfies it. */
export interface NoiseCandidate {
  readonly text: string;
  readonly bbox: LogicalRect;
}

export type NoiseVerdict = { readonly noise: false } | { readonly noise: true; readonly reason: NoiseReason };

export interface NoiseFilterOptions {
  /**
   * Minimum number of letters, counted after every non-letter is discarded. Default 2.
   *
   * 2 is the value that separates the two cases the acceptance criteria name: `Ö` - a clock
   * icon that S1 saw the recognizer read as a letter - has one letter and goes; `OK` has two
   * and stays. A single letter standing alone as its own block is not something a translator
   * can do anything useful with even when it is genuine.
   */
  readonly minLetters?: number;
  /** Minimum box width in logical px. Default 12. */
  readonly minWidth?: number;
  /** Minimum box height in logical px. Default 10; see the module comment for the measurement. */
  readonly minHeight?: number;
  /**
   * Shortest run of one repeated character that counts as junk. Default 2, i.e. `oo` and up.
   * No English word is a run of one letter, so this is safe at 2 and exists as an option only
   * because every threshold here is one.
   */
  readonly repeatedCharacterMinLength?: number;
}

export const DEFAULT_MIN_LETTERS = 2;
export const DEFAULT_MIN_WIDTH = 12;
export const DEFAULT_MIN_HEIGHT = 10;
export const DEFAULT_REPEATED_CHARACTER_MIN_LENGTH = 2;

const TIME_PATTERN = /^\d{1,2}[:.]\d{2}(?:[:.]\d{2})?$/u;
const PERCENTAGE_PATTERN = /^[+-]?\d+(?:[.,]\d+)?\s*%$/u;
const LETTER_PATTERN = /\p{L}/u;
const DIGIT_PATTERN = /\p{Nd}/u;

/**
 * Decide whether one candidate is noise.
 *
 * Rules are evaluated most-structural-first - box, then shape of the characters, then how
 * many letters survive - so the reason returned is the most specific true statement about
 * why the candidate is not translatable text.
 */
export function classifyCandidate(candidate: NoiseCandidate, options: NoiseFilterOptions = {}): NoiseVerdict {
  const minLetters = options.minLetters ?? DEFAULT_MIN_LETTERS;
  const minWidth = options.minWidth ?? DEFAULT_MIN_WIDTH;
  const minHeight = options.minHeight ?? DEFAULT_MIN_HEIGHT;
  const repeatedMin = options.repeatedCharacterMinLength ?? DEFAULT_REPEATED_CHARACTER_MIN_LENGTH;

  if (candidate.bbox.width < minWidth) return { noise: true, reason: 'bbox-too-narrow' };
  if (candidate.bbox.height < minHeight) return { noise: true, reason: 'bbox-too-short' };

  const collapsed = candidate.text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) return { noise: true, reason: 'too-few-letters' };

  if (!LETTER_PATTERN.test(collapsed)) {
    // No letters at all. Nothing in this branch can be translated - the output of translating
    // "86%" is "86%" - so the only question left is which name to put in the log.
    if (TIME_PATTERN.test(collapsed)) return { noise: true, reason: 'pattern-time' };
    if (PERCENTAGE_PATTERN.test(collapsed)) return { noise: true, reason: 'pattern-percentage' };
    if (DIGIT_PATTERN.test(collapsed)) return { noise: true, reason: 'pattern-numeric' };
    return { noise: true, reason: 'pattern-symbolic' };
  }

  if (isRepeatedCharacter(collapsed, repeatedMin)) {
    return { noise: true, reason: 'pattern-repeated-character' };
  }

  if (countLetters(collapsed) < minLetters) return { noise: true, reason: 'too-few-letters' };

  return { noise: false };
}

/** One `TextBlock` and the rule that removed it. */
export interface DroppedBlock {
  readonly block: TextBlock;
  readonly reason: NoiseReason;
}

export interface NoiseFilterResult {
  readonly kept: readonly TextBlock[];
  /** Never discard this - it is the only record that the text existed (invariant 4). */
  readonly dropped: readonly DroppedBlock[];
}

/** Partition blocks into the ones worth translating and the ones that are junk. */
export function filterNoise(
  blocks: readonly TextBlock[],
  options: NoiseFilterOptions = {},
): NoiseFilterResult {
  const kept: TextBlock[] = [];
  const dropped: DroppedBlock[] = [];

  for (const block of blocks) {
    const verdict = classifyCandidate(block, options);
    if (verdict.noise) dropped.push({ block, reason: verdict.reason });
    else kept.push(block);
  }

  return { kept, dropped };
}

/** Count of `\p{L}` code points - what survives stripping digits, spaces and symbols. */
function countLetters(text: string): number {
  let letters = 0;
  for (const character of text) {
    if (LETTER_PATTERN.test(character)) letters += 1;
  }
  return letters;
}

/** True when the text is one character repeated, ignoring spaces: `ooo`, `0 00`, `-----`. */
function isRepeatedCharacter(text: string, minLength: number): boolean {
  const characters = [...text.replace(/\s+/gu, '')];
  const first = characters[0];
  if (first === undefined || characters.length < minLength) return false;
  return characters.every((character) => character === first);
}
