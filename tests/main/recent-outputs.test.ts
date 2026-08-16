/**
 * M3-04, feature F2 - layer 2 of feedback loop prevention.
 *
 * Two behaviours here are decisions rather than obvious consequences, so both are pinned:
 * `remember` moves an existing entry to the newest position, and `has` does **not**. The
 * eviction tests are written so that they fail if either of those flips - a suite that only
 * checked "the oldest goes when it overflows" would pass against both.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RECENT_OUTPUTS_CAPACITY,
  normalizeForComparison,
  RecentOutputs,
} from '../../src/main/services/recent-outputs.js';

describe('normalizeForComparison', () => {
  it('folds case, punctuation and whitespace, which is what OCR varies between frames', () => {
    expect(normalizeForComparison('Hello,  World!')).toBe('hello world');
    expect(normalizeForComparison('transport shuttle.')).toBe('transport shuttle');
    expect(normalizeForComparison('  Transport   Shuttle  ')).toBe('transport shuttle');
  });

  it('deletes rather than spaces out punctuation, so an apostrophe can come and go', () => {
    expect(normalizeForComparison("don't")).toBe('dont');
    expect(normalizeForComparison('dont')).toBe('dont');
  });

  it('keeps digits, because they carry meaning that dedup has to see', () => {
    expect(normalizeForComparison('40 MINUTES')).toBe('40 minutes');
  });

  it('reduces a string with nothing but marks to the empty string', () => {
    expect(normalizeForComparison('•••')).toBe('');
    expect(normalizeForComparison('   ')).toBe('');
  });
});

describe('RecentOutputs - F2 matching', () => {
  it('recognises a string it was told was displayed last round', () => {
    const recent = new RecentOutputs();
    recent.remember('เจ้าต้องตามหากุญแจโบราณ');

    expect(recent.has('เจ้าต้องตามหากุญแจโบราณ')).toBe(true);
    expect(recent.has('You must find the ancient key')).toBe(false);
  });

  it('matches through the normalization both stages share', () => {
    const recent = new RecentOutputs();
    recent.remember('Get to the port, and secure the evacuation.');

    expect(recent.has('get to the port and secure the evacuation')).toBe(true);
  });

  it('stores both halves of what was displayed - the source and its translation', () => {
    const recent = new RecentOutputs();
    recent.remember('Captured on PC');
    recent.remember('บันทึกภาพบน PC');

    expect(recent.has('Captured on PC')).toBe(true);
    expect(recent.has('บันทึกภาพบน PC')).toBe(true);
  });

  it('ignores strings that normalize to nothing, so they cannot match everything', () => {
    const recent = new RecentOutputs();
    recent.remember('');
    recent.remember('   ');
    recent.remember('•••');

    expect(recent.size).toBe(0);
    expect(recent.has('')).toBe(false);
    expect(recent.has('...')).toBe(false);
  });
});

describe('RecentOutputs - the cap', () => {
  it('evicts the oldest entry and never exceeds its capacity', () => {
    const recent = new RecentOutputs(3);
    recent.remember('one');
    recent.remember('two');
    recent.remember('three');
    recent.remember('four');

    expect(recent.size).toBe(3);
    expect(recent.capacity).toBe(3);
    expect(recent.snapshot()).toEqual(['two', 'three', 'four']);
    expect(recent.has('one')).toBe(false);
  });

  it('stays at capacity under sustained load rather than growing', () => {
    const recent = new RecentOutputs(8);
    for (let i = 0; i < 500; i += 1) recent.remember(`subtitle line ${String(i)}`);

    expect(recent.size).toBe(8);
    expect(recent.has('subtitle line 499')).toBe(true);
    expect(recent.has('subtitle line 491')).toBe(false);
  });

  it('moves a re-displayed string to the newest position', () => {
    const recent = new RecentOutputs(3);
    recent.remember('one');
    recent.remember('two');
    recent.remember('three');
    recent.remember('one');
    recent.remember('four');

    // "two" goes, not "one" - "one" was displayed again and is therefore the more recent.
    expect(recent.snapshot()).toEqual(['three', 'one', 'four']);
    expect(recent.has('two')).toBe(false);
  });

  it('does not let a lookup refresh recency', () => {
    const recent = new RecentOutputs(3);
    recent.remember('one');
    recent.remember('two');
    recent.remember('three');

    expect(recent.has('one')).toBe(true);
    recent.remember('four');

    // If `has` refreshed, "two" would have gone instead.
    expect(recent.has('one')).toBe(false);
    expect(recent.snapshot()).toEqual(['two', 'three', 'four']);
  });

  it('clears', () => {
    const recent = new RecentOutputs(3);
    recent.remember('one');
    recent.clear();

    expect(recent.size).toBe(0);
    expect(recent.has('one')).toBe(false);
  });

  it('refuses a capacity that would silently switch the filter off', () => {
    expect(() => new RecentOutputs(0)).toThrow(RangeError);
    expect(() => new RecentOutputs(-1)).toThrow(RangeError);
    expect(() => new RecentOutputs(1.5)).toThrow(RangeError);
    expect(new RecentOutputs().capacity).toBe(DEFAULT_RECENT_OUTPUTS_CAPACITY);
  });
});
