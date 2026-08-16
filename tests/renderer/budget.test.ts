/**
 * M5-05 (#27), feature U4 - screen area budget and priority ordering.
 *
 * The bug this exists for is not "too many boxes". It is *which* boxes: a full-screen capture
 * produced `requested: 54` against a 48 pool, and the six that were discarded were discarded for
 * arriving late in the payload. On a screen whose top half is interface chrome and whose bottom
 * line is the subtitle, arrival order throws away exactly the thing the app is for.
 *
 * So almost every assertion here is about *identity*, not about counts. A test that only checked
 * "six were dropped" would have passed before this issue was fixed.
 */

import { describe, expect, it } from 'vitest';

import { selectWithinBudget, type BudgetCandidate } from '../../src/renderer/overlay/budget.js';
import type { Rect } from '../../src/renderer/overlay/placement.js';

const SCREEN = { width: 3440, height: 1440 };

function candidate(x: number, y: number, width: number, height: number): BudgetCandidate {
  return { anchor: { x, y, width, height } };
}

/** A rectangle of a given area, placed down the screen so reading order is unambiguous. */
function sized(area: number, y: number): BudgetCandidate {
  const height = 40;
  return candidate(0, y, area / height, height);
}

describe('selectWithinBudget: priority', () => {
  it('keeps the largest blocks and drops the smallest, not the last to arrive', () => {
    // Reading order puts the big subtitle LAST, which is the real layout: chrome at the top of
    // the screen, the line that matters along the bottom. Arrival-order truncation drops it.
    const entries = [
      sized(2_000, 0),
      sized(3_000, 100),
      sized(1_000, 200),
      sized(90_000, 1_300), // the subtitle
    ];

    const outcome = selectWithinBudget(entries, { capacity: 2, maxAreaRatio: 1, screen: SCREEN });

    expect(outcome.kept).toEqual([1, 3]);
    // Named explicitly: the subtitle survives, and the two smallest are what went.
    expect(outcome.dropped.map((drop) => drop.index)).toEqual([0, 2]);
    expect(outcome.dropped.every((drop) => drop.reason === 'over-capacity')).toBe(true);
  });

  it('reproduces the issue: 54 blocks, a 48 pool, and the 6 smallest are the ones that go', () => {
    // The run that filed #27, with the shape of its numbers. Areas increase with index, and the
    // payload is in reading order, so "drop the tail" and "drop the smallest" give opposite
    // answers - which is exactly what makes this discriminating.
    const entries = Array.from({ length: 54 }, (_, index) => sized(1_000 + index * 500, index * 20));

    const outcome = selectWithinBudget(entries, { capacity: 48, maxAreaRatio: 1, screen: SCREEN });

    expect(outcome.kept).toHaveLength(48);
    expect(outcome.dropped).toHaveLength(6);
    // The six smallest are indices 0..5. Under the old arrival-order truncation the answer
    // would have been 48..53 - the six largest, including whatever the subtitle was.
    expect(outcome.dropped.map((drop) => drop.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(outcome.kept[0]).toBe(6);
  });

  it('breaks ties by reading order, so equal blocks never trade places between frames', () => {
    const entries = [sized(5_000, 0), sized(5_000, 100), sized(5_000, 200)];

    const outcome = selectWithinBudget(entries, { capacity: 2, maxAreaRatio: 1, screen: SCREEN });

    expect(outcome.kept).toEqual([0, 1]);
    expect(outcome.dropped.map((drop) => drop.index)).toEqual([2]);
  });

  it('returns the kept set in reading order, never in area order', () => {
    // The load-bearing one for everything downstream. `layout.ts` disambiguates two entries that
    // land on the same anchor by their position in this list, so a list ordered by area would
    // make slot identity depend on relative sizes - which wobble frame to frame as the
    // recognizer's boxes breathe. A6 and A9 would both start missing, silently.
    const entries = [sized(1_000, 0), sized(90_000, 100), sized(5_000, 200), sized(40_000, 300)];

    const outcome = selectWithinBudget(entries, { capacity: 4, maxAreaRatio: 1, screen: SCREEN });

    expect(outcome.kept).toEqual([0, 1, 2, 3]);
  });
});

describe('selectWithinBudget: area quota', () => {
  it('stops once the quota is spent, and says the reason was the quota', () => {
    // 1% of 3440x1440 = 49,536px². Three 20,000px² blocks: two fit, the third does not.
    const entries = [sized(20_000, 0), sized(20_000, 100), sized(20_000, 200)];

    const outcome = selectWithinBudget(entries, { capacity: 48, maxAreaRatio: 0.01, screen: SCREEN });

    expect(outcome.kept).toEqual([0, 1]);
    expect(outcome.dropped).toEqual([{ index: 2, reason: 'over-budget', area: 20_000 }]);
    expect(outcome.keptArea).toBe(40_000);
    expect(outcome.budgetArea).toBeCloseTo(49_536, 6);
  });

  it('spends the quota on the largest blocks, not on whichever arrived first', () => {
    // Same quota, but now a big block arrives last. Two small ones would fit inside the budget
    // and the big one would not - so a first-come implementation keeps the noise and drops the
    // subtitle while staying comfortably under quota. That is the failure, and it passes any
    // test that only counts.
    const entries = [sized(20_000, 0), sized(20_000, 100), sized(45_000, 1_300)];

    const outcome = selectWithinBudget(entries, { capacity: 48, maxAreaRatio: 0.01, screen: SCREEN });

    expect(outcome.kept).toEqual([2]);
    expect(outcome.dropped.map((drop) => drop.index)).toEqual([0, 1]);
  });

  it('draws everything when the payload fits, and reports nothing dropped', () => {
    const entries = [sized(2_000, 0), sized(3_000, 100), sized(1_000, 200)];

    const outcome = selectWithinBudget(entries, { capacity: 48, maxAreaRatio: 0.25, screen: SCREEN });

    expect(outcome.kept).toEqual([0, 1, 2]);
    expect(outcome.dropped).toEqual([]);
  });

  it('always keeps the largest block, even when it alone exceeds the quota', () => {
    // A subtitle wider than the quota is the main use case, not an abuse of it. Dropping
    // everything would leave a blank overlay, which is indistinguishable from a translation
    // failure - the confidently-wrong outcome invariant 4 exists to prevent.
    const entries = [sized(500_000, 1_300), sized(1_000, 0)];

    const outcome = selectWithinBudget(entries, { capacity: 48, maxAreaRatio: 0.01, screen: SCREEN });

    expect(outcome.kept).toEqual([0]);
    // And the exemption is for one block only: the small one is still measured against the full
    // budget, which the oversized block has already consumed.
    expect(outcome.dropped.map((drop) => drop.reason)).toEqual(['over-budget']);
  });

  it('applies capacity and quota independently, and reports which one bit', () => {
    const entries = [sized(30_000, 0), sized(20_000, 100), sized(10_000, 200), sized(5_000, 300)];

    const outcome = selectWithinBudget(entries, { capacity: 2, maxAreaRatio: 0.01, screen: SCREEN });

    // In priority order: 30,000 is kept; 20,000 would take the total to 50,000 against a 49,536
    // quota, so the quota refuses it; 10,000 fits at 40,000 and is kept, which fills capacity;
    // 5,000 would have fitted the quota and is refused by capacity instead. Both limits bite, on
    // different blocks, and each drop names the one that stopped it.
    expect(outcome.kept).toEqual([0, 2]);
    expect(outcome.dropped).toEqual([
      { index: 1, reason: 'over-budget', area: 20_000 },
      { index: 3, reason: 'over-capacity', area: 5_000 },
    ]);
  });
});

describe('selectWithinBudget: determinism and degenerate input', () => {
  it('gives an identical answer for identical input, every time', () => {
    // #35's sticky anchors and A6's unchanged-payload skip both rest on this. Nothing here may
    // depend on a clock, on randomness, or on container iteration order.
    const entries = Array.from({ length: 30 }, (_, index) =>
      sized(1_000 + ((index * 7919) % 50_000), index * 40),
    );
    const options = { capacity: 12, maxAreaRatio: 0.05, screen: SCREEN };

    const first = selectWithinBudget(entries, options);
    for (let round = 0; round < 5; round += 1) {
      expect(selectWithinBudget(entries, options)).toEqual(first);
    }
  });

  it('treats a zero-area block as zero rather than letting it poison the total', () => {
    const entries = [sized(10_000, 0), candidate(0, 100, 0, 40), candidate(0, 200, 10, 0)];

    const outcome = selectWithinBudget(entries, { capacity: 48, maxAreaRatio: 0.25, screen: SCREEN });

    expect(outcome.kept).toEqual([0, 1, 2]);
    expect(outcome.keptArea).toBe(10_000);
  });

  it('survives a non-finite rectangle without dropping the whole frame', () => {
    const broken: Rect = { x: 0, y: 0, width: Number.NaN, height: 40 };
    const outcome = selectWithinBudget([{ anchor: broken }, sized(5_000, 100)], {
      capacity: 48,
      maxAreaRatio: 0.25,
      screen: SCREEN,
    });

    expect(outcome.kept).toEqual([0, 1]);
    expect(Number.isFinite(outcome.keptArea)).toBe(true);
  });

  it('drops everything when capacity is zero, rather than drawing one anyway', () => {
    const outcome = selectWithinBudget([sized(5_000, 0)], {
      capacity: 0,
      maxAreaRatio: 1,
      screen: SCREEN,
    });

    expect(outcome.kept).toEqual([]);
    expect(outcome.dropped.map((drop) => drop.reason)).toEqual(['over-capacity']);
  });

  it('a ratio of 1 disables the quota outright, leaving capacity as the only limit', () => {
    // Deliberately absurd: five blocks of 2,000,000px² total 10M against a 4.95M screen. Real
    // blocks do not overlap and so can never sum past the screen, which is exactly why a ratio
    // of 1 must mean *no* limit rather than *a limit of one screen* - otherwise this boundary is
    // unreachable in testing and reachable in production.
    const entries = Array.from({ length: 5 }, (_, index) => sized(2_000_000, index * 100));

    const outcome = selectWithinBudget(entries, { capacity: 48, maxAreaRatio: 1, screen: SCREEN });

    expect(outcome.kept).toHaveLength(5);
    expect(outcome.dropped).toEqual([]);
    expect(outcome.budgetArea).toBe(Number.POSITIVE_INFINITY);
  });
});
