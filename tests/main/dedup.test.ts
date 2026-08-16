/**
 * M3-05, feature A5.
 *
 * Dedup's two errors cost wildly different amounts, and this suite is weighted accordingly.
 *
 * A missed duplicate costs one redundant translation. A **false** duplicate means real text is
 * never translated, never drawn, and never mentioned in any log the user would look at - the
 * silent failure CLAUDE.md invariant 4 exists to forbid. So the largest block below is the
 * false-positive battery, and it is built from the cases that a plausible implementation gets
 * wrong: text that differs by a word, text that differs only in a number, and a sentence that
 * grows a fragment at a time.
 *
 * Several of those cases are one or two edits apart and would be accepted by the ~0.85
 * similarity threshold that reads as a natural default. `similarity` is asserted directly next
 * to them so the margin is visible in the test output rather than implied.
 *
 * The clock is a plain counter. Nothing here sleeps.
 */

import { describe, expect, it } from 'vitest';

import type { LogicalRect } from '../../src/main/utils/coordinates.js';
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_WINDOW_MS,
  Deduplicator,
  dedupeBlocks,
  digitSignature,
  levenshteinDistance,
  similarity,
  type DedupCandidate,
} from '../../src/main/services/dedup.js';
import { normalizeForComparison } from '../../src/main/services/recent-outputs.js';
import type { TextBlock } from '../../src/main/utils/text-grouping.js';

/** A subtitle-sized box. Only the top-left corner participates in matching. */
function at(text: string, x = 400, y = 900): DedupCandidate {
  return { text, bbox: { x, y, width: 430, height: 25 } };
}

function block(text: string, x = 400, y = 900): TextBlock {
  const bbox: LogicalRect = { x, y, width: 430, height: 25 };
  return { lines: [{ text, rect: bbox }], text, bbox };
}

/** Similarity of two strings as the matcher sees them: after normalization. */
function normalizedSimilarity(a: string, b: string): number {
  return similarity(normalizeForComparison(a), normalizeForComparison(b));
}

const T0 = 1_000_000;

describe('levenshteinDistance / similarity / digitSignature', () => {
  it('measures edit distance', () => {
    expect(levenshteinDistance('', '')).toBe(0);
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('hello world', 'hello world')).toBe(0);
    expect(levenshteinDistance('hello world', 'hello wor')).toBe(2);
  });

  it('scores similarity against the longer string, and 1 for two empty strings', () => {
    expect(similarity('', '')).toBe(1);
    expect(similarity('abcd', 'abcd')).toBe(1);
    expect(similarity('abcd', 'abce')).toBe(0.75);
  });

  it('extracts digit runs without letting adjacent runs merge', () => {
    expect(digitSignature('40 minutes')).toBe('40');
    expect(digitSignature('hello world')).toBe('');
    expect(digitSignature('level 100')).toBe('100');
    expect(digitSignature('1 2')).toBe('1.2');
    expect(digitSignature('12')).toBe('12');
  });
});

describe('duplicates that must be caught', () => {
  it('catches the same text at the same place', () => {
    const dedup = new Deduplicator();
    expect(dedup.admit(at('Get to the port and secure the evacuation'), T0).duplicate).toBe(false);
    expect(dedup.admit(at('Get to the port and secure the evacuation'), T0 + 100)).toEqual({
      duplicate: true,
      reason: 'exact',
      matchedText: 'get to the port and secure the evacuation',
      similarity: 1,
    });
  });

  it('catches a partial read: "Hello World" then "Hello Wor"', () => {
    const dedup = new Deduplicator();
    dedup.admit(at('Hello World'), T0);

    const decision = dedup.admit(at('Hello Wor'), T0 + 100);

    expect(decision.duplicate).toBe(true);
    expect(decision).toMatchObject({ reason: 'prefix', matchedText: 'hello world' });
    // Similarity alone would not have caught this one - the prefix rule is doing the work.
    expect(normalizedSimilarity('Hello World', 'Hello Wor')).toBeLessThan(DEFAULT_SIMILARITY_THRESHOLD);
  });

  it('catches a box that moved 3px, which is the jitter design doc section 5 describes', () => {
    const dedup = new Deduplicator();
    dedup.admit(at('Get to the port and secure the evacuation', 400, 900), T0);

    expect(dedup.admit(at('Get to the port and secure the evacuation', 403, 897), T0 + 100).duplicate).toBe(true);
  });

  it('catches text whose punctuation and case changed between frames', () => {
    const dedup = new Deduplicator();
    dedup.admit(at('transport shuttle.'), T0);

    expect(dedup.admit(at('Transport Shuttle'), T0 + 100)).toMatchObject({ reason: 'exact' });
  });

  it('catches a one-character misread inside a long real S1 line', () => {
    // "many civilians" / "many civillans" - the i/l confusion S1 measured. 1 edit in 47.
    const dedup = new Deduplicator();
    dedup.admit(at('many civilians as can fit aboard the designated'), T0);

    const decision = dedup.admit(at('many civillans as can fit aboard the designated'), T0 + 100);

    expect(decision.duplicate).toBe(true);
    expect(decision).toMatchObject({ reason: 'similar' });
  });

  it('accepts a similarity of exactly the threshold', () => {
    // 20 normalized characters, one substitution: 1 - 1/20 = 0.95 exactly. The comparison is
    // `>=`, and this is the only test that says which side of it the boundary falls on.
    const seen = 'the door is unlocked';
    const jittered = 'the door ls unlocked';
    expect(normalizeForComparison(seen)).toHaveLength(20);
    expect(normalizedSimilarity(seen, jittered)).toBe(DEFAULT_SIMILARITY_THRESHOLD);

    const dedup = new Deduplicator();
    dedup.admit(at(seen), T0);
    expect(dedup.admit(at(jittered), T0 + 100).duplicate).toBe(true);
  });

  it('rejects a similarity just under the threshold', () => {
    const seen = 'the door is unlocked';
    const twoEdits = 'tha door ls unlocked';
    expect(normalizedSimilarity(seen, twoEdits)).toBeLessThan(DEFAULT_SIMILARITY_THRESHOLD);

    const dedup = new Deduplicator();
    dedup.admit(at(seen), T0);
    expect(dedup.admit(at(twoEdits), T0 + 100).duplicate).toBe(false);
  });
});

describe('false positives - the expensive direction', () => {
  it('treats a changed word as new, where 0.85 would have swallowed it', () => {
    const seen = 'Get to the port and secure the evacuation';
    const different = 'Get to the port and secure the extraction';

    // The number that decides the threshold: comfortably above 0.85, comfortably below 0.95.
    const score = normalizedSimilarity(seen, different);
    expect(score).toBeGreaterThan(0.85);
    expect(score).toBeLessThan(DEFAULT_SIMILARITY_THRESHOLD);

    const dedup = new Deduplicator();
    dedup.admit(at(seen), T0);
    expect(dedup.admit(at(different), T0 + 100).duplicate).toBe(false);
  });

  it('treats a counting-down timer as new, where no similarity threshold could', () => {
    // A mission clock ticking down. One edit in twenty characters scores *exactly* the
    // threshold, so tightening the threshold would not have saved this case - only the digit
    // guard does. Two edits still score 0.90, which a 0.85 threshold would have swallowed too.
    expect(normalizedSimilarity('49 MINUTES remaining', '48 MINUTES remaining')).toBe(DEFAULT_SIMILARITY_THRESHOLD);
    expect(normalizedSimilarity('40 MINUTES remaining', '39 MINUTES remaining')).toBeGreaterThan(0.85);

    const oneEdit = new Deduplicator();
    oneEdit.admit(at('49 MINUTES remaining'), T0);
    expect(oneEdit.admit(at('48 MINUTES remaining'), T0 + 100).duplicate).toBe(false);

    const twoEdits = new Deduplicator();
    twoEdits.admit(at('40 MINUTES remaining'), T0);
    expect(twoEdits.admit(at('39 MINUTES remaining'), T0 + 100).duplicate).toBe(false);
  });

  it('treats a ticking score as new', () => {
    const dedup = new Deduplicator();
    dedup.admit(at('Current score 1200 points'), T0);

    expect(dedup.admit(at('Current score 1300 points'), T0 + 100).duplicate).toBe(false);
  });

  it('lets the digit guard beat the prefix rule when they disagree', () => {
    // "level 10" IS a string-prefix of "level 100", long enough and covering 8/9 of it, so the
    // prefix rule would call it a duplicate. The digits differ, so it is new. Without the digit
    // guard this exact case silently loses a real change.
    const dedup = new Deduplicator();
    dedup.admit(at('Level 100'), T0);

    expect(normalizeForComparison('Level 100').startsWith(normalizeForComparison('Level 10'))).toBe(true);
    expect(dedup.admit(at('Level 10'), T0 + 100).duplicate).toBe(false);
  });

  it('treats a sentence that grew as new - the prefix rule only works downwards', () => {
    // A subtitle typing itself out. Suppressing the complete sentence because a fragment of it
    // was already translated would leave the user reading half a line, permanently.
    const dedup = new Deduplicator();
    dedup.admit(at('Do not shoot'), T0);

    expect(dedup.admit(at('Do not shoot the hostage'), T0 + 100).duplicate).toBe(false);
  });

  it('still catches the same pair in the other order', () => {
    const dedup = new Deduplicator();
    dedup.admit(at('Do not shoot the hostage'), T0);

    expect(dedup.admit(at('Do not shoot'), T0 + 100)).toMatchObject({ reason: 'prefix' });
  });

  it('compares very short strings exactly, never fuzzily', () => {
    const pairs: readonly [string, string][] = [
      ['yes', 'yep'],
      ['OK', 'No'],
      ['reload', 'reboot'],
      ['Open', 'Oper'],
    ];

    for (const [first, second] of pairs) {
      const dedup = new Deduplicator();
      dedup.admit(at(first), T0);
      expect(dedup.admit(at(second), T0 + 100).duplicate).toBe(false);
    }
  });

  it('treats genuinely different text at the same place as new', () => {
    const dedup = new Deduplicator();
    dedup.admit(at('PANDION-XXIV'), T0);

    expect(dedup.admit(at('TERMINID CONTROL'), T0 + 100).duplicate).toBe(false);
  });

  it('treats the same text somewhere else on screen as new', () => {
    const dedup = new Deduplicator();
    dedup.admit(at('Get to the port and secure the evacuation', 400, 900), T0);

    expect(dedup.admit(at('Get to the port and secure the evacuation', 1200, 300), T0 + 100).duplicate).toBe(false);
  });
});

describe('the text thresholds are exercised, not just declared', () => {
  it('raising fuzzyMinLength past the candidate forces exact comparison, closing the prefix path', () => {
    // "hello wor" is 9 normalized characters, so at the default 8 the prefix rule may speak.
    const dedup = new Deduplicator({ fuzzyMinLength: 12 });
    dedup.admit(at('Hello World'), T0);

    expect(dedup.admit(at('Hello Wor'), T0 + 100).duplicate).toBe(false);
  });

  it('raising similarityThreshold past a one-edit jitter turns it into new text', () => {
    const seen = 'many civilians as can fit aboard the designated';
    const jittered = 'many civillans as can fit aboard the designated';
    expect(normalizedSimilarity(seen, jittered)).toBeLessThan(0.99);

    const dedup = new Deduplicator({ similarityThreshold: 0.99 });
    dedup.admit(at(seen), T0);
    expect(dedup.admit(at(jittered), T0 + 100).duplicate).toBe(false);
  });

  it('raising prefixMinLength past the candidate closes the prefix rule on its own', () => {
    // Similarity cannot rescue this one - "hello wor" scores 0.82 - so the verdict flips.
    const dedup = new Deduplicator({ prefixMinLength: 10 });
    dedup.admit(at('Hello World'), T0);

    expect(dedup.admit(at('Hello Wor'), T0 + 100).duplicate).toBe(false);
  });

  it('raising prefixMinRatio past the covered fraction closes it too', () => {
    // "hello wor" covers 9/11 = 0.818 of "hello world".
    const permissive = new Deduplicator({ prefixMinRatio: 0.8 });
    permissive.admit(at('Hello World'), T0);
    expect(permissive.admit(at('Hello Wor'), T0 + 100)).toMatchObject({ reason: 'prefix' });

    const strict = new Deduplicator({ prefixMinRatio: 0.9 });
    strict.admit(at('Hello World'), T0);
    expect(strict.admit(at('Hello Wor'), T0 + 100).duplicate).toBe(false);
  });
});

describe('position', () => {
  it('matches at exactly the tolerance and not one px past it', () => {
    const inside = new Deduplicator({ positionTolerance: 12 });
    inside.admit(at('Get to the port and secure the evacuation', 400, 900), T0);
    expect(inside.admit(at('Get to the port and secure the evacuation', 412, 912), T0 + 1).duplicate).toBe(true);

    const outside = new Deduplicator({ positionTolerance: 12 });
    outside.admit(at('Get to the port and secure the evacuation', 400, 900), T0);
    expect(outside.admit(at('Get to the port and secure the evacuation', 413, 900), T0 + 1).duplicate).toBe(false);
  });

  it('is per-axis: far on one axis is far, however close the other one is', () => {
    const dedup = new Deduplicator({ positionTolerance: 12 });
    dedup.admit(at('Get to the port and secure the evacuation', 400, 900), T0);

    expect(dedup.admit(at('Get to the port and secure the evacuation', 400, 960), T0 + 1).duplicate).toBe(false);
  });

  it('still matches when a 3px move crosses a grid cell boundary', () => {
    // x=11 is in cell 0 and x=14 is in cell 1 at gridSize 12, so this only passes because the
    // lookup searches neighbouring cells rather than just the one the point lands in.
    const dedup = new Deduplicator({ gridSize: 12, positionTolerance: 12 });
    dedup.admit(at('Get to the port and secure the evacuation', 11, 11), T0);

    expect(dedup.admit(at('Get to the port and secure the evacuation', 14, 14), T0 + 1).duplicate).toBe(true);
  });

  it('searches far enough when the grid is much finer than the tolerance', () => {
    // radius = ceil(12 / 2) = 6 cells. A hard-coded 3x3 neighbourhood would reach 6px and miss.
    const dedup = new Deduplicator({ gridSize: 2, positionTolerance: 12 });
    dedup.admit(at('Get to the port and secure the evacuation', 400, 900), T0);

    expect(dedup.admit(at('Get to the port and secure the evacuation', 412, 900), T0 + 1).duplicate).toBe(true);
    expect(dedup.admit(at('Get to the port and secure the evacuation', 900, 900), T0 + 1).duplicate).toBe(false);
  });

  it('handles a negative origin, which a display left of primary produces', () => {
    const dedup = new Deduplicator();
    dedup.admit(at('Get to the port and secure the evacuation', -1520, -300), T0);

    expect(dedup.admit(at('Get to the port and secure the evacuation', -1517, -300), T0 + 1).duplicate).toBe(true);
  });

  it('rejects a grid size that cannot index anything', () => {
    expect(() => new Deduplicator({ gridSize: 0 })).toThrow(RangeError);
    expect(() => new Deduplicator({ gridSize: -1 })).toThrow(RangeError);
  });
});

describe('the time window', () => {
  it('suppresses inside the window and retranslates once past it', () => {
    const dedup = new Deduplicator();
    dedup.admit(at('Get to the port and secure the evacuation'), T0);

    expect(dedup.admit(at('Get to the port and secure the evacuation'), T0 + DEFAULT_WINDOW_MS - 1).duplicate).toBe(
      true,
    );

    const later = new Deduplicator();
    later.admit(at('Get to the port and secure the evacuation'), T0);
    expect(later.admit(at('Get to the port and secure the evacuation'), T0 + DEFAULT_WINDOW_MS).duplicate).toBe(false);
  });

  it('does not let a match push the expiry out', () => {
    // The entry was recorded at T0 and matched at T0+2000. If matching refreshed it, it would
    // survive to T0+5000 - and a chain of drifting reads could suppress one spot indefinitely.
    const dedup = new Deduplicator({ windowMs: 3000 });
    dedup.admit(at('Get to the port and secure the evacuation'), T0);
    expect(dedup.admit(at('Get to the port and secure the evacuation'), T0 + 2000).duplicate).toBe(true);

    expect(dedup.admit(at('Get to the port and secure the evacuation'), T0 + 3500).duplicate).toBe(false);
  });

  it('takes the window from config', () => {
    const dedup = new Deduplicator({ windowMs: 500 });
    dedup.admit(at('Get to the port and secure the evacuation'), T0);

    expect(dedup.admit(at('Get to the port and secure the evacuation'), T0 + 600).duplicate).toBe(false);
  });

  it('drops expired entries rather than holding them', () => {
    const dedup = new Deduplicator({ windowMs: 500 });
    dedup.admit(at('one line of subtitle', 100, 100), T0);
    dedup.admit(at('another line of text', 900, 100), T0);
    expect(dedup.size).toBe(2);

    dedup.admit(at('a third line here now', 100, 900), T0 + 600);
    expect(dedup.size).toBe(1);
  });
});

describe('bookkeeping', () => {
  it('holds at most maxEntries even when nothing ever expires', () => {
    const dedup = new Deduplicator({ maxEntries: 2, windowMs: Number.MAX_SAFE_INTEGER });
    dedup.admit(at('first line of subtitle', 100, 100), T0);
    dedup.admit(at('second line of subtitle', 100, 400), T0);
    dedup.admit(at('third line of subtitle', 100, 800), T0);

    expect(dedup.size).toBe(2);
    // The oldest was evicted, so it no longer suppresses anything.
    expect(dedup.admit(at('first line of subtitle', 100, 100), T0).duplicate).toBe(false);
  });

  it('resets', () => {
    const dedup = new Deduplicator();
    dedup.admit(at('Get to the port and secure the evacuation'), T0);
    dedup.reset();

    expect(dedup.size).toBe(0);
    expect(dedup.admit(at('Get to the port and secure the evacuation'), T0 + 1).duplicate).toBe(false);
  });

  it('passes text that normalizes to nothing straight through', () => {
    // The noise filter owns that decision; overruling it here would be a second, hidden filter.
    const dedup = new Deduplicator();
    expect(dedup.admit(at('•••'), T0).duplicate).toBe(false);
    expect(dedup.admit(at('•••'), T0 + 1).duplicate).toBe(false);
    expect(dedup.size).toBe(0);
  });
});

describe('dedupeBlocks', () => {
  it('partitions a batch and records why each block went', () => {
    const dedup = new Deduplicator();
    const first = block('Get to the port and secure the evacuation', 400, 900);
    const second = block('many civilians as can fit aboard the designated', 400, 930);

    const initial = dedupeBlocks([first, second], dedup, T0);
    expect(initial.kept).toEqual([first, second]);
    expect(initial.dropped).toEqual([]);

    const repeat = dedupeBlocks([first, second], dedup, T0 + 500);
    expect(repeat.kept).toEqual([]);
    expect(repeat.dropped.map((entry) => entry.block)).toEqual([first, second]);
    expect(repeat.dropped[0]?.decision).toMatchObject({ reason: 'exact' });
  });

  it('treats the second of two identical blocks in one frame as a duplicate', () => {
    const dedup = new Deduplicator();
    const one = block('Get to the port and secure the evacuation', 400, 900);
    const other = block('Get to the port and secure the evacuation', 402, 901);

    const result = dedupeBlocks([one, other], dedup, T0);

    expect(result.kept).toEqual([one]);
    expect(result.dropped.map((entry) => entry.block)).toEqual([other]);
  });

  it('returns [] for [] rather than throwing', () => {
    expect(dedupeBlocks([], new Deduplicator(), T0)).toEqual({ kept: [], dropped: [], verdicts: [] });
  });

  it('reports one verdict per block, in input order (#53)', () => {
    // `kept` and `dropped` both lose the position each verdict belongs to, and #53's displayed set
    // is rebuilt in observation order - so a compacted answer would have to be re-paired with the
    // input by the caller, which is the row-shift class of bug `text-pipeline.ts` is built around.
    const dedup = new Deduplicator();
    const first = block('the northern gate is open', 0, 0);
    const second = block('do not shoot until you see it', 0, 100);
    const repeat = block('the northern gate is open', 0, 0);

    const result = dedupeBlocks([first, second, repeat], dedup, T0);

    expect(result.verdicts).toHaveLength(3);
    expect(result.verdicts.map((decision) => decision.duplicate)).toEqual([false, false, true]);
    const third = result.verdicts[2];
    expect(third?.duplicate === true ? third.matchedText : null).toBe('the northern gate is open');
  });
});
