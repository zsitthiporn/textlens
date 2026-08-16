/**
 * M5-01 (#23), feature U5 - the node pool.
 *
 * The acceptance criterion is "no DOM nodes created after init, checked by counting children".
 * Counting children of a real container is done against Chromium in `chromium.test.ts`; what is
 * checked here is the stronger, cheaper form of the same claim - the element **factory** is
 * called exactly `capacity` times and never again, across as many renders as you like.
 *
 * That is not the same assertion dressed differently. A container's child count would stay
 * constant in an implementation that created a node and dropped it on the floor; the factory
 * counter would not.
 */

import { describe, expect, it } from 'vitest';

import { BoxPool, DEFAULT_POOL_CAPACITY } from '../../../src/renderer/overlay/node-pool.js';
import { fakeFactory } from './fakes.js';

const flat = (): number => 20;

describe('BoxPool - construction', () => {
  it('creates every box up front, exactly capacity of them', () => {
    const factory = fakeFactory(flat);
    const pool = new BoxPool({ capacity: 8, create: factory.create, attach: factory.attach });

    expect(factory.createCalls()).toBe(8);
    expect(factory.attachCalls()).toBe(8);
    expect(pool.capacity).toBe(8);
    expect(pool.created).toBe(8);
  });

  it('starts every box retired, so nothing paints before the first render', () => {
    const factory = fakeFactory(flat);
    new BoxPool({ capacity: 3, create: factory.create, attach: factory.attach });

    for (const box of factory.boxes) {
      expect(box.style.display).toBe('none');
      expect(box.style.visibility).toBe('hidden');
    }
  });

  it('refuses a capacity that would make every render silently draw nothing', () => {
    const factory = fakeFactory(flat);
    const build = (capacity: number): BoxPool<never> =>
      new BoxPool({ capacity, create: factory.create, attach: factory.attach }) as never;

    expect(() => build(0)).toThrow(RangeError);
    expect(() => build(-1)).toThrow(RangeError);
    expect(() => build(2.5)).toThrow(RangeError);
    expect(factory.createCalls()).toBe(0);
  });
});

describe('BoxPool - the no-new-nodes guarantee', () => {
  it('never calls the element factory again, however many times it is used', () => {
    const factory = fakeFactory(flat);
    const pool = new BoxPool({ capacity: 6, create: factory.create, attach: factory.attach });
    const afterInit = factory.createCalls();

    for (let round = 0; round < 50; round += 1) {
      // Deliberately varied: growing past capacity, shrinking, and back to nothing. An
      // implementation that grew the pool on demand would be caught by the round that asks for
      // more than it has.
      pool.take(round % 11);
    }

    expect(afterInit).toBe(6);
    expect(factory.createCalls()).toBe(6);
    expect(pool.created).toBe(6);
    expect(factory.boxes).toHaveLength(6);
  });
});

describe('BoxPool - exhaustion', () => {
  it('hands out what it has when asked for more, rather than throwing', () => {
    const factory = fakeFactory(flat);
    const pool = new BoxPool({ capacity: 4, create: factory.create, attach: factory.attach });

    const taken = pool.take(30);

    expect(taken).toHaveLength(4);
    expect(pool.activeCount).toBe(4);
  });

  it('truncates from the end, leaving the payload order alone', () => {
    const factory = fakeFactory(flat);
    const pool = new BoxPool({ capacity: 3, create: factory.create, attach: factory.attach });

    const taken = pool.take(3);

    // The first three boxes in pool order, not a reordered selection: which translations lose
    // out when the screen is full is issue #27's decision, not this module's.
    expect(taken[0]).toBe(factory.boxes[0]);
    expect(taken[1]).toBe(factory.boxes[1]);
    expect(taken[2]).toBe(factory.boxes[2]);
  });
});

describe('BoxPool - retirement', () => {
  it('takes unused boxes out of layout entirely, not merely out of sight', () => {
    const factory = fakeFactory(flat);
    const pool = new BoxPool({ capacity: 5, create: factory.create, attach: factory.attach });

    pool.take(2);

    const retired = factory.boxes.slice(2);
    for (const box of retired) {
      // `display: none` rather than `visibility: hidden`: a hidden box still takes part in
      // layout, so 46 unused boxes would be measured on every one of M5-03's passes.
      expect(box.style.display).toBe('none');
      expect(box.textContent).toBe('');
    }
  });

  it('hideAll retires the lot', () => {
    const factory = fakeFactory(flat);
    const pool = new BoxPool({ capacity: 5, create: factory.create, attach: factory.attach });

    pool.take(5);
    pool.hideAll();

    expect(pool.activeCount).toBe(0);
    for (const box of factory.boxes) expect(box.style.display).toBe('none');
  });

  it('clamps nonsense counts instead of propagating them into a slice', () => {
    const factory = fakeFactory(flat);
    const pool = new BoxPool({ capacity: 4, create: factory.create, attach: factory.attach });

    expect(pool.take(-3)).toHaveLength(0);
    expect(pool.take(Number.NaN)).toHaveLength(0);
    expect(pool.take(2.9)).toHaveLength(2);
  });
});

describe('BoxPool - the shipped capacity', () => {
  it('is large enough for the 30-box case the issues size everything against', () => {
    expect(DEFAULT_POOL_CAPACITY).toBeGreaterThanOrEqual(30);
  });
});
