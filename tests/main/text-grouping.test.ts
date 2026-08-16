/**
 * M3-02, feature O5.
 *
 * The thresholds in `text-grouping.ts` came from measuring a real Helldivers 2 briefing
 * panel in spike S1, so the fixtures here are built to reproduce those measured ratios
 * exactly - 0.08 within a paragraph, 0.92 from heading to body, 1.16 across paragraphs -
 * rather than round numbers chosen to make the implementation look right.
 *
 * Every fixture re-derives its own ratio through `gapRatio` and asserts it, so a fixture
 * cannot drift away from the measurement it is supposed to encode without failing loudly.
 *
 * The 0.92 case is the one that matters. The reference project grouped at 1.0, which is
 * *above* 0.92, so it merged every heading into the paragraph below it. A suite that only
 * checked 0.08 and 1.16 would pass against that implementation.
 */

import { describe, expect, it } from 'vitest';

import type { LogicalRect } from '../../src/main/utils/coordinates.js';
import {
  DEFAULT_PARAGRAPH_GAP_RATIO,
  groupLines,
  type PositionedLine,
} from '../../src/main/utils/text-grouping.js';

function line(text: string, x: number, y: number, width: number, height: number): PositionedLine {
  return { text, rect: { x, y, width, height } };
}

/** The same quantity the implementation thresholds on: vertical gap over the shorter height. */
function gapRatio(upper: LogicalRect, lower: LogicalRect): number {
  const gap = lower.y - (upper.y + upper.height);
  return gap / Math.min(upper.height, lower.height);
}

const LINE_HEIGHT = 25;

describe('groupLines - the ratios measured in spike S1', () => {
  it('merges lines within one paragraph (ratio 0.08)', () => {
    // bottom of the first line is 125; the second starts at 127, so the gap is 2.
    const first = line('A group of Class-A citizens are stranded at a priority', 100, 100, 520, LINE_HEIGHT);
    const second = line('evacuation port. We cannot leave these patriots to', 100, 127, 495, LINE_HEIGHT);
    expect(gapRatio(first.rect, second.rect)).toBeCloseTo(0.08, 10);

    const blocks = groupLines([first, second]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lines).toHaveLength(2);
  });

  it('splits a heading from the body beneath it (ratio 0.92)', () => {
    // The case the reference project got wrong. The heading is taller than the body, so
    // the ratio divides by the body's 25 and not the heading's 34: gap 23 / 25 = 0.92.
    const heading = line('BRIEFING', 100, 100, 210, 34);
    const body = line('EMERGENCY EVACUATION', 100, 157, 430, LINE_HEIGHT);
    expect(gapRatio(heading.rect, body.rect)).toBeCloseTo(0.92, 10);

    const blocks = groupLines([heading, body]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.text).toBe('BRIEFING');
    expect(blocks[1]?.text).toBe('EMERGENCY EVACUATION');
  });

  it('splits across a paragraph break (ratio 1.16)', () => {
    // bottom of the first line is 125; the second starts at 154, so the gap is 29.
    const endOfParagraph = line('be slaughtered by the Terminids.', 100, 100, 330, LINE_HEIGHT);
    const startOfNext = line('Get to the port and secure the evacuation of as', 100, 154, 470, LINE_HEIGHT);
    expect(gapRatio(endOfParagraph.rect, startOfNext.rect)).toBeCloseTo(1.16, 10);

    const blocks = groupLines([endOfParagraph, startOfNext]);

    expect(blocks).toHaveLength(2);
  });

  it('sits far enough from every measured ratio to tolerate a font change', () => {
    // 0.08 and 0.92 are the two the default has to separate, and it is not near either.
    expect(DEFAULT_PARAGRAPH_GAP_RATIO).toBeGreaterThan(0.08 * 2);
    expect(DEFAULT_PARAGRAPH_GAP_RATIO).toBeLessThan(0.92 / 1.5);
  });
});

describe('groupLines - the reference project threshold', () => {
  it('merges the heading into the body at a paragraph ratio of 1.0, which is the bug', () => {
    // A permanent record of why the default is not 1.0: at 1.0 the measured 0.92 heading
    // gap is under threshold, so "BRIEFING" is translated as part of the sentence below it.
    const heading = line('BRIEFING', 100, 100, 210, 34);
    const body = line('EMERGENCY EVACUATION', 100, 157, 430, LINE_HEIGHT);

    const blocks = groupLines([heading, body], { paragraphGapRatio: 1.0 });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe('BRIEFING EMERGENCY EVACUATION');
  });

  it('still splits the 1.16 paragraph break at 1.0, which is why the bug survived review', () => {
    const endOfParagraph = line('be slaughtered by the Terminids.', 100, 100, 330, LINE_HEIGHT);
    const startOfNext = line('Get to the port and secure the evacuation of as', 100, 154, 470, LINE_HEIGHT);

    expect(groupLines([endOfParagraph, startOfNext], { paragraphGapRatio: 1.0 })).toHaveLength(2);
  });
});

describe('groupLines - column detection', () => {
  // Straight from spike S1: `MISSION` at x=187 and `40 MINUTES` at x=589 on the same row,
  // 299px apart. MISSION's right edge is therefore 589 - 299 = 290, so it is 103 wide.
  const mission = line('MISSION', 187, 100, 103, 30);
  const duration = line('40 MINUTES', 589, 100, 180, 30);

  it('splits two boxes on the same row that are far apart horizontally', () => {
    expect(duration.rect.x - (mission.rect.x + mission.rect.width)).toBe(299);

    const blocks = groupLines([mission, duration]);

    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => block.text)).toEqual(['MISSION', '40 MINUTES']);
  });

  it('is the horizontal rule doing that, not the vertical one', () => {
    // The two share a row exactly, so the vertical gap is 0 and the paragraph rule alone
    // would merge them into "MISSION 40 MINUTES". Raising only the column threshold shows
    // which rule is load-bearing.
    // Same row, so the raw vertical gap is negative (the implementation clamps it to 0).
    // Either way it can never exceed a positive paragraph threshold.
    expect(gapRatio(mission.rect, duration.rect)).toBeLessThanOrEqual(0);

    const merged = groupLines([mission, duration], { columnGapRatio: 100 });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe('MISSION 40 MINUTES');
  });

  it('does not split ordinary stacked lines, which overlap horizontally', () => {
    const first = line('A group of Class-A citizens are stranded at a priority', 100, 100, 520, LINE_HEIGHT);
    const second = line('evacuation port. We cannot leave these patriots to', 100, 127, 495, LINE_HEIGHT);

    expect(groupLines([first, second], { columnGapRatio: 0.1 })).toHaveLength(1);
  });
});

describe('groupLines - block contents', () => {
  it('joins a multi-line block with single spaces and encloses every line in the bbox', () => {
    const lines = [
      line('Get to the port and secure the evacuation of as', 100, 100, 470, LINE_HEIGHT),
      line('many civilians as can fit aboard the designated', 96, 127, 500, LINE_HEIGHT),
      line('transport shuttle.', 100, 154, 180, LINE_HEIGHT),
    ];

    const blocks = groupLines(lines);

    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block?.text).toBe(
      'Get to the port and secure the evacuation of as many civilians as can fit aboard the designated transport shuttle.',
    );
    // Left edge comes from the second line (96), right edge from the second line too
    // (96 + 500 = 596), top from the first and bottom from the third (154 + 25 = 179).
    expect(block?.bbox).toEqual({ x: 96, y: 100, width: 500, height: 79 });
    expect(block?.lines).toHaveLength(3);
  });

  it('puts lines into reading order regardless of the order they arrived in', () => {
    const lines = [
      line('third', 100, 154, 180, LINE_HEIGHT),
      line('first', 100, 100, 470, LINE_HEIGHT),
      line('second', 96, 127, 500, LINE_HEIGHT),
    ];

    expect(groupLines(lines)[0]?.text).toBe('first second third');
  });

  it('does not reorder the caller-supplied array', () => {
    const lines = [line('b', 100, 154, 180, LINE_HEIGHT), line('a', 100, 100, 470, LINE_HEIGHT)];

    groupLines(lines);

    expect(lines.map((entry) => entry.text)).toEqual(['b', 'a']);
  });
});

describe('groupLines - edge cases', () => {
  it('returns an empty array for empty input rather than throwing', () => {
    expect(groupLines([])).toEqual([]);
  });

  it('returns one block for one line', () => {
    const blocks = groupLines([line('PANDION-XXIV', 100, 100, 300, LINE_HEIGHT)]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe('PANDION-XXIV');
    expect(blocks[0]?.bbox).toEqual({ x: 100, y: 100, width: 300, height: LINE_HEIGHT });
  });

  it('keeps a zero-height line out of its neighbour rather than dividing by zero', () => {
    const degenerate = line('', 100, 100, 40, 0);
    const normal = line('TERMINID CONTROL', 100, 101, 340, LINE_HEIGHT);

    const blocks = groupLines([degenerate, normal]);

    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => Number.isFinite(block.bbox.width))).toBe(true);
  });

  it('drops no line - every input ends up in exactly one block', () => {
    const lines = [
      line('PANDION-XXIV', 100, 40, 300, LINE_HEIGHT),
      line('TERMINID CONTROL', 100, 100, 340, LINE_HEIGHT),
      line('MISSION', 187, 200, 103, 30),
      line('40 MINUTES', 589, 200, 180, 30),
      line('EMERGENCY EVACUATION', 100, 300, 430, LINE_HEIGHT),
    ];

    const blocks = groupLines(lines);

    expect(blocks.flatMap((block) => block.lines)).toHaveLength(lines.length);
  });
});
