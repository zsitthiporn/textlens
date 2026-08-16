/**
 * M3-04, feature F3 - layer 3 of feedback loop prevention.
 *
 * Two things this suite has to prove rather than assume.
 *
 * **The ratio does not misjudge short strings.** A one-character string is where a naive
 * implementation divides badly: `""`, `"5"`, `"%"` and `"🙂"` all have an empty denominator,
 * and `0 / 0` is `NaN`. `NaN > threshold` is false and `NaN < threshold` is also false, so a
 * `NaN` ratio silently passes text under one comparison and silently fails it under the other.
 * That is tested here as a value, with an explicit `Number.isNaN` assertion, not argued for.
 *
 * **The ratio is load-bearing.** The default threshold is 0, which means every mixed-script
 * case would be discarded whatever the ratio said - a suite that only ran at the default would
 * pass against an implementation that ignored the numerator entirely. So the mixed cases are
 * run at a non-default threshold with strings on both sides of it, and the strict-greater
 * boundary is pinned at a string whose ratio is exactly 0.5.
 */

import { describe, expect, it } from 'vitest';

import { unionRects, type LogicalRect } from '../../src/main/utils/coordinates.js';
import type { TextBlock } from '../../src/main/utils/text-grouping.js';
import {
  DEFAULT_MAX_THAI_RATIO,
  filterThaiScript,
  isThaiScriptFeedback,
  thaiScriptRatio,
} from '../../src/main/utils/thai-script-filter.js';

function rect(x: number, y: number, width: number, height: number): LogicalRect {
  return { x, y, width, height };
}

function single(text: string): TextBlock {
  const box = rect(0, 0, 400, 25);
  const bbox = unionRects([box]);
  if (bbox === undefined) throw new Error('unreachable');
  return { lines: [{ text, rect: box }], text, bbox };
}

/** A translation of the S1 Helldivers briefing line - the exact thing that could loop back. */
const THAI_TRANSLATION = 'เจ้าต้องตามหากุญแจโบราณ';
const ENGLISH_SOURCE = 'You must find the ancient key';

describe('thaiScriptRatio', () => {
  it('scores pure Thai at 1 and pure English at 0', () => {
    expect(thaiScriptRatio(THAI_TRANSLATION)).toBe(1);
    expect(thaiScriptRatio(ENGLISH_SOURCE)).toBe(0);
  });

  it('counts Thai vowels and tone marks as Thai, not as denominator padding', () => {
    // The marks in this string are Mn, not L. Counting only letters would score it below 1.
    expect(thaiScriptRatio('พลังชีวิต')).toBe(1);
  });

  it('counts Thai digits, which are inside the block but are Nd rather than L', () => {
    expect(thaiScriptRatio('๕')).toBe(1);
  });

  it('ignores whitespace, punctuation, Western digits and emoji on both sides of the fraction', () => {
    expect(thaiScriptRatio('a b')).toBe(0);
    expect(thaiScriptRatio('ก!!!!!!!!')).toBe(1);
    expect(thaiScriptRatio('ก 1234567890')).toBe(1);
  });

  describe('short and empty strings - the case a naive ratio gets wrong', () => {
    const nothingToCount = ['', ' ', '5', '%', '...', '12:34', '🙂', '+1'];

    it.each(nothingToCount)('scores %j as 0, not NaN', (text) => {
      const ratio = thaiScriptRatio(text);
      expect(Number.isNaN(ratio)).toBe(false);
      expect(ratio).toBe(0);
    });

    it('scores a single Thai character as 1 and a single Latin one as 0', () => {
      expect(thaiScriptRatio('ก')).toBe(1);
      expect(thaiScriptRatio('A')).toBe(0);
    });

    it('does not let a one-character string be discarded by accident at any threshold', () => {
      for (const text of ['A', '5', '%', '', '🙂']) {
        expect(isThaiScriptFeedback(text)).toBe(false);
        expect(isThaiScriptFeedback(text, { maxThaiRatio: 0.5 })).toBe(false);
      }
    });
  });
});

describe('isThaiScriptFeedback at the default threshold', () => {
  it('is 0, i.e. any Thai character at all - design doc section 6, not the issue text', () => {
    expect(DEFAULT_MAX_THAI_RATIO).toBe(0);
  });

  it('discards our own translation and passes the English it came from', () => {
    expect(isThaiScriptFeedback(THAI_TRANSLATION)).toBe(true);
    expect(isThaiScriptFeedback(ENGLISH_SOURCE)).toBe(false);
  });

  it('discards mostly-English text carrying a single Thai character', () => {
    // A partial read of an overlay box overlapping source text. One Thai code point is proof
    // enough, because an en-US recognizer reading English source cannot produce one.
    expect(thaiScriptRatio('Press ก to continue')).toBeCloseTo(1 / 16, 10);
    expect(isThaiScriptFeedback('Press ก to continue')).toBe(true);
  });

  it('passes every real S1 recognizer line it was given', () => {
    const realOcrOutput = [
      'Get to the port and secure the evacuation of as',
      'Captured from PC. 02020 Sony Interactive Entertainment Inc.',
      "Reveals extra special collector's edition tare bottles on the map",
      'INVENTORY',
      'Ö',
      '16:36',
    ];
    for (const text of realOcrOutput) expect(isThaiScriptFeedback(text)).toBe(false);
  });
});

describe('isThaiScriptFeedback with the threshold moved off its default', () => {
  // These are the cases that would pass trivially at threshold 0. Run at 0.5 they force the
  // numerator and denominator to actually be right.
  const mostlyThai = 'HP 50 พลังชีวิต';
  const mostlyEnglish = 'Press ก to continue';

  it('computes a mixed ratio the fraction can be checked against', () => {
    // 2 Latin letters + 9 Thai code points; the digits are in neither.
    expect(thaiScriptRatio(mostlyThai)).toBeCloseTo(9 / 11, 10);
  });

  it('discards above the threshold and keeps below it', () => {
    expect(isThaiScriptFeedback(mostlyThai, { maxThaiRatio: 0.5 })).toBe(true);
    expect(isThaiScriptFeedback(mostlyEnglish, { maxThaiRatio: 0.5 })).toBe(false);
  });

  it('keeps the mostly-Thai string once the threshold is raised above its ratio', () => {
    expect(isThaiScriptFeedback(mostlyThai, { maxThaiRatio: 0.9 })).toBe(false);
  });

  it('is strictly greater than, checked at a ratio of exactly 0.5', () => {
    const half = 'abกข';
    expect(thaiScriptRatio(half)).toBe(0.5);
    expect(isThaiScriptFeedback(half, { maxThaiRatio: 0.5 })).toBe(false);
    expect(isThaiScriptFeedback(half, { maxThaiRatio: 0.49 })).toBe(true);
  });

  it('is switched off entirely at 1, since no ratio exceeds 1', () => {
    expect(isThaiScriptFeedback(THAI_TRANSLATION, { maxThaiRatio: 1 })).toBe(false);
  });
});

describe('filterThaiScript', () => {
  it('partitions blocks and keeps the dropped ones for the caller to log', () => {
    const source = single(ENGLISH_SOURCE);
    const ownOutput = single(THAI_TRANSLATION);

    const result = filterThaiScript([source, ownOutput]);

    expect(result.kept).toEqual([source]);
    expect(result.dropped).toEqual([ownOutput]);
  });

  it('returns [] for [] rather than throwing', () => {
    expect(filterThaiScript([])).toEqual({ kept: [], dropped: [] });
  });
});
