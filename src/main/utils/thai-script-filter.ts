/**
 * Layer 3 of feedback loop prevention (issue M3-04, feature F3, design doc section 6).
 *
 * The overlay draws Thai translations directly under the English they translate, close to or
 * inside the capture region. If the next capture reads our own output back, it gets translated
 * again, drawn again, read again - a loop that never settles and that the user experiences as
 * the screen filling with garbage.
 *
 * Three layers defend against that. Layer 1 is `setContentProtection` on the overlay window,
 * which spike S2 proved works on this machine - WGC genuinely sees the window *behind* the
 * overlay, on all three displays. Layer 2 is `RecentOutputs`. This is layer 3, and it is the
 * one the design doc calls the real defence, for a reason worth restating: **the source text
 * is English**, so a Thai code point cannot arrive from the captured application. The `en-US`
 * recognizer cannot even emit one. Any Thai character in OCR output came from us.
 *
 * That is what makes this filter near-100% here and unreliable in the reference project, whose
 * target language was Chinese - Chinese characters legitimately appear in Chinese source text,
 * so their equivalent test could not tell their own output from the game's. Do not generalise
 * this filter to other scripts; generalising it is exactly what breaks it.
 *
 * ## Why the default threshold is 0
 *
 * Issue #15 frames this as a ratio with a threshold, and design doc section 6 states the rule
 * as "find `U+0E00-0E7F`, discard immediately". Those disagree, and the design doc is right for
 * the reason above: with an English source there is no such thing as an acceptable amount of
 * Thai. So the ratio exists, is computed properly, and is configurable - and the default
 * `maxThaiRatio` is **0**, which makes the ratio rule equivalent to "contains any Thai".
 *
 * Keeping the ratio rather than hard-coding a `contains` test costs nothing and buys the one
 * thing that would otherwise need a rewrite: a future non-English source language, where a
 * stray Thai code point might be a misread rather than our own output.
 *
 * The two error directions are not symmetric, which is why the default sits at the strict end.
 * A false negative leaks a translation back into the pipeline and starts the loop. A false
 * positive would discard genuine source text - but genuine English source text scores exactly
 * 0.0, so at threshold 0 a false positive requires the text to actually contain Thai.
 */

import type { TextBlock } from './text-grouping.js';

/** The Thai block, U+0E00-0E7F. Includes the Thai digits at U+0E50-0E59. */
const THAI_RANGE = /[\u0E00-\u0E7F]/u;
/**
 * Characters that carry script identity: letters, plus combining marks. Marks matter here -
 * Thai vowels and tone marks (`ั`, `่`, `ู`) are `Mn`, not `L`, and they are unambiguously
 * Thai. Counting only letters would score a heavily-marked Thai string against a denominator
 * that excludes half of its own script.
 */
const SCRIPT_BEARING = /[\p{L}\p{M}]/u;

export interface ThaiScriptFilterOptions {
  /**
   * Discard when the Thai ratio is **strictly greater** than this. Default 0, i.e. any Thai
   * character at all. Range 0..1; 1 disables the filter, since no ratio exceeds 1.
   */
  readonly maxThaiRatio?: number;
}

export const DEFAULT_MAX_THAI_RATIO = 0;

/**
 * Fraction of the script-bearing characters that are Thai, in 0..1.
 *
 * Whitespace, punctuation, Western digits and emoji are in neither the numerator nor the
 * denominator - they belong to no script and would otherwise let a string's verdict swing on
 * how much punctuation it happens to contain.
 *
 * **Returns 0, never `NaN`, when there is nothing to count.** That is the case a naive
 * implementation gets wrong: `""`, `"5"`, `"%"` and `"🙂"` all have an empty denominator, and
 * `0/0` is `NaN`, which compares false against every threshold and so silently *passes* text
 * under `>` while silently *failing* it under `<`. One-character strings are where this shows
 * up, which is why the acceptance criteria call it out and why it is tested rather than
 * reasoned about.
 */
export function thaiScriptRatio(text: string): number {
  let counted = 0;
  let thai = 0;

  for (const character of text) {
    const isThai = THAI_RANGE.test(character);
    // Thai digits are `Nd`, not `L`, so they are admitted by the range test rather than by
    // `SCRIPT_BEARING`. They are still Thai and still ours.
    if (!isThai && !SCRIPT_BEARING.test(character)) continue;
    counted += 1;
    if (isThai) thai += 1;
  }

  return counted === 0 ? 0 : thai / counted;
}

/** True when the text is our own Thai output read back off the screen. */
export function isThaiScriptFeedback(text: string, options: ThaiScriptFilterOptions = {}): boolean {
  const maxThaiRatio = options.maxThaiRatio ?? DEFAULT_MAX_THAI_RATIO;
  return thaiScriptRatio(text) > maxThaiRatio;
}

export interface ThaiScriptFilterResult {
  readonly kept: readonly TextBlock[];
  /** Blocks recognised as our own translation. Kept so the caller can log rather than vanish. */
  readonly dropped: readonly TextBlock[];
}

/** Partition blocks, removing the ones that are our own translation coming back around. */
export function filterThaiScript(
  blocks: readonly TextBlock[],
  options: ThaiScriptFilterOptions = {},
): ThaiScriptFilterResult {
  const kept: TextBlock[] = [];
  const dropped: TextBlock[] = [];

  for (const block of blocks) {
    if (isThaiScriptFeedback(block.text, options)) dropped.push(block);
    else kept.push(block);
  }

  return { kept, dropped };
}
