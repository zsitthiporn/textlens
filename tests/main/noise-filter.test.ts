/**
 * M3-03, feature O4.
 *
 * The junk in this file is, with three labelled exceptions, **real recognizer output**. Every
 * string and every box marked `S1` was read off `spikes/s1-ocr/results/win-ocr-results.json`
 * (425 lines across 92 game screenshots) or off the Helldivers 2 briefing transcript in
 * `docs/spikes/2026-08-15-s1-ocr-engine.md`. That matters more than it looks: junk invented by
 * the person writing the filter is junk the filter was already designed to catch, so a suite
 * built from it proves nothing except that the author is self-consistent.
 *
 * The three exceptions are `"12:34"`, `"85%"` and `"..."`, which the acceptance criteria name
 * literally. Each is asserted next to the real string of the same shape that S1 actually
 * produced - `"16:36"`, `"86%"` and `"1),"` - so the rule is pinned to measured data and to
 * the issue at once.
 *
 * The one synthesized *box* is the one for `"Ö"`. The Helldivers run was a separate webp pass
 * that recorded no coordinates, so the text is real and the rectangle is a plausible icon-sized
 * stand-in, chosen large enough to clear the size gate - the point of that case is that the
 * letter-count rule is what removes it.
 */

import { describe, expect, it } from 'vitest';

import { unionRects, type LogicalRect } from '../../src/main/utils/coordinates.js';
import {
  classifyCandidate,
  DEFAULT_MIN_HEIGHT,
  DEFAULT_MIN_LETTERS,
  DEFAULT_MIN_WIDTH,
  filterNoise,
  type NoiseReason,
} from '../../src/main/utils/noise-filter.js';
import type { PositionedLine, TextBlock } from '../../src/main/utils/text-grouping.js';

function rect(x: number, y: number, width: number, height: number): LogicalRect {
  return { x, y, width, height };
}

function line(text: string, x: number, y: number, width: number, height: number): PositionedLine {
  return { text, rect: rect(x, y, width, height) };
}

/** A block from lines, with the same union-bbox and space-joined text `groupLines` produces. */
function blockOf(lines: readonly PositionedLine[]): TextBlock {
  const bbox = unionRects(lines.map((entry) => entry.rect));
  if (bbox === undefined) throw new Error('a block needs at least one line');
  return { lines: [...lines], text: lines.map((entry) => entry.text).join(' '), bbox };
}

/** A single-line block, which is what most of these cases are. */
function single(text: string, width: number, height: number): TextBlock {
  return blockOf([line(text, 0, 0, width, height)]);
}

function reasonFor(text: string, width: number, height: number): NoiseReason | 'kept' {
  const verdict = classifyCandidate(single(text, width, height));
  return verdict.noise ? verdict.reason : 'kept';
}

describe('classifyCandidate - junk the recognizer actually produced', () => {
  // file, text and box straight out of win-ocr-results.json.
  const realJunk: readonly [file: string, text: string, width: number, height: number, reason: NoiseReason][] = [
    ['discoelysium_5', '16:36', 104, 34, 'pattern-time'],
    ['discoelysium_3', '86%', 29, 12, 'pattern-percentage'],
    ['discoelysium_1', '000000', 116, 16, 'pattern-numeric'],
    ['discoelysium_3', '+1', 16, 11, 'pattern-numeric'],
    ['lifeisstrange_0', '9/10', 113, 65, 'pattern-numeric'],
    ['bg3_0', '1),', 40, 37, 'pattern-numeric'],
    ['discoelysium_1', '•0080&', 134, 34, 'pattern-numeric'],
    ['discoelysium_0', '500 12:00', 154, 34, 'pattern-numeric'],
    ['discoelysium_3', '0', 23, 23, 'pattern-numeric'],
    ['discoelysium_3', 'ooo', 46, 20, 'pattern-repeated-character'],
    ['cyberpunk_2', 'lhe', 15, 7, 'bbox-too-short'],
    ['cyberpunk_2', 'data', 20, 8, 'bbox-too-short'],
    ['discoelysium_2', 'GLOVES', 38, 8, 'bbox-too-short'],
    ['discoelysium_3', 's', 9, 13, 'bbox-too-narrow'],
  ];

  it.each(realJunk)('cuts %s %j as %s', (_file, text, width, height, reason) => {
    expect(reasonFor(text, width, height)).toBe(reason);
  });

  it('cuts the clock icon the recognizer read as a letter', () => {
    // Real text (S1 Helldivers briefing: "MISSION | Ö 40 MINUTES"), synthesized icon-sized box.
    // The box clears both size gates deliberately, so this asserts the letter rule and only it.
    expect(reasonFor('Ö', 24, 24)).toBe('too-few-letters');
  });
});

describe('classifyCandidate - the literal strings the acceptance criteria name', () => {
  // Invented, but each sits beside the real S1 string of the same shape so neither the rule nor
  // the measurement can drift without the other noticing.
  it('cuts "12:34", like the real "16:36"', () => {
    expect(reasonFor('12:34', 104, 34)).toBe('pattern-time');
    expect(reasonFor('16:36', 104, 34)).toBe('pattern-time');
  });

  it('cuts "85%", like the real "86%"', () => {
    expect(reasonFor('85%', 29, 12)).toBe('pattern-percentage');
    expect(reasonFor('86%', 29, 12)).toBe('pattern-percentage');
  });

  it('cuts "...", which has neither letters nor digits', () => {
    expect(reasonFor('...', 40, 20)).toBe('pattern-symbolic');
    // The real S1 near-neighbour has digits, so it lands on the numeric rule instead.
    expect(reasonFor('/1/11//$', 69, 29)).toBe('pattern-numeric');
  });
});

describe('classifyCandidate - text that must survive', () => {
  // Every string here is real S1 output except "OK", which the acceptance criteria name; "OK"
  // borrows the box of the real two-letter line "PC" (helldivers2_5, w=23 h=16).
  const keeps: readonly [text: string, width: number, height: number][] = [
    ['Get to the port and secure the evacuation of as', 430, 25],
    ['many civilians as can fit aboard the designated', 430, 25],
    ["Reveals extra special collector's edition tare bottles on the map", 373, 15],
    ['Captured on PC', 138, 20],
    ['INVENTORY', 209, 31],
    ['Night City', 63, 13],
    ['OK', 23, 16],
  ];

  it.each(keeps)('keeps %j', (text, width, height) => {
    expect(reasonFor(text, width, height)).toBe('kept');
  });

  it('keeps "OK" because two letters is the floor, and cuts it if the floor is raised', () => {
    expect(classifyCandidate(single('OK', 23, 16), { minLetters: 3 })).toEqual({
      noise: true,
      reason: 'too-few-letters',
    });
  });
});

describe('classifyCandidate - thresholds are exercised at their edges, not asserted', () => {
  it('accepts a box exactly at the minimum and rejects one just under it', () => {
    expect(reasonFor('Captured on PC', DEFAULT_MIN_WIDTH, DEFAULT_MIN_HEIGHT)).toBe('kept');
    expect(reasonFor('Captured on PC', DEFAULT_MIN_WIDTH - 0.01, DEFAULT_MIN_HEIGHT)).toBe('bbox-too-narrow');
    expect(reasonFor('Captured on PC', DEFAULT_MIN_WIDTH, DEFAULT_MIN_HEIGHT - 0.01)).toBe('bbox-too-short');
  });

  it('separates the two measured populations: S1 UI chrome at h<=9, S1 body text at h>=12', () => {
    // The whole justification for minHeight 10. If the default drifted to 12, the second line
    // here - a real recognised sentence - would start being deleted.
    expect(reasonFor('data', 20, 9)).toBe('bbox-too-short');
    expect(reasonFor("Reveals extra special collector's edition tare bottles on the map", 373, 12)).toBe('kept');
  });

  it('lets the size floors be lowered for a display that draws smaller text', () => {
    expect(classifyCandidate(single('data', 20, 8), { minWidth: 4, minHeight: 4 })).toEqual({ noise: false });
  });

  it('lets the letter floor be lowered to one', () => {
    expect(classifyCandidate(single('Ö', 24, 24), { minLetters: 1 })).toEqual({ noise: false });
    expect(DEFAULT_MIN_LETTERS).toBe(2);
  });

  it('lets the repeated-character run length be raised past a real case', () => {
    expect(reasonFor('ooo', 46, 20)).toBe('pattern-repeated-character');
    expect(classifyCandidate(single('ooo', 46, 20), { repeatedCharacterMinLength: 4 })).toEqual({ noise: false });
  });
});

describe('filterNoise - the unit of decision is the block, not the line', () => {
  it('keeps a paragraph that contains a junk line, intact', () => {
    // The exact shape the acceptance criterion is about: S1 read the mission clock icon as "Ö"
    // on the same panel as the briefing text. Deciding per line would delete a line out of the
    // middle of a paragraph; deciding per block leaves the paragraph alone.
    const paragraph = blockOf([
      line('Ö', 589, 100, 24, 24),
      line('Get to the port and secure the evacuation of as', 187, 130, 430, 25),
      line('many civilians as can fit aboard the designated', 187, 158, 430, 25),
      line('transport shuttle.', 187, 186, 170, 25),
    ]);

    const result = filterNoise([paragraph]);

    expect(result.kept).toEqual([paragraph]);
    expect(result.dropped).toEqual([]);
    // The junk line is still in there. Nothing was rewritten - only whole blocks are decided.
    expect(result.kept[0]?.lines).toHaveLength(4);
  });

  it('drops a block that is junk in its entirety, and says which rule did it', () => {
    const good = single('Captured on PC', 138, 20);
    const clock = single('16:36', 104, 34);
    const dots = single('ooo', 46, 20);

    const result = filterNoise([good, clock, dots]);

    expect(result.kept).toEqual([good]);
    expect(result.dropped).toEqual([
      { block: clock, reason: 'pattern-time' },
      { block: dots, reason: 'pattern-repeated-character' },
    ]);
  });

  it('reports every dropped block, so nothing disappears without a record', () => {
    const blocks = [single('16:36', 104, 34), single('86%', 29, 12), single('Ö', 24, 24)];

    const result = filterNoise(blocks);

    expect(result.kept).toEqual([]);
    expect(result.dropped.map((entry) => entry.block)).toEqual(blocks);
  });

  it('returns [] for [] rather than throwing', () => {
    expect(filterNoise([])).toEqual({ kept: [], dropped: [] });
  });
});
