/**
 * Coalescing (issue M5-01, feature U5, issue #81 F4).
 *
 * `frame-scheduler.ts` had no test of its own before this file - its own module comment names the
 * exact claim worth pinning: "three updates in one frame produce one render". `requestFrame` is
 * faked as a queue this file drains by hand, so nothing here waits on a real animation frame.
 */

import { describe, expect, it } from 'vitest';

import { createFrameScheduler } from '../../src/renderer/overlay/frame-scheduler.js';

/** A `requestAnimationFrame` fake: callbacks queue up and only run when the test drains them. */
function fakeFrame(): { requestFrame: (callback: () => void) => void; flush: () => void; queued: number } {
  const callbacks: Array<() => void> = [];
  return {
    requestFrame: (callback: () => void) => {
      callbacks.push(callback);
    },
    flush: () => {
      const pending = callbacks.splice(0, callbacks.length);
      for (const callback of pending) callback();
    },
    get queued() {
      return callbacks.length;
    },
  };
}

describe('createFrameScheduler', () => {
  it('three submits in one frame produce exactly one render, of the last value', () => {
    const frame = fakeFrame();
    const rendered: number[] = [];
    const scheduler = createFrameScheduler<number>(frame.requestFrame, (value) => {
      rendered.push(value);
    });

    scheduler.submit(1);
    scheduler.submit(2);
    scheduler.submit(3);
    expect(rendered).toEqual([]); // nothing renders before the frame fires

    frame.flush();

    expect(rendered).toEqual([3]);
    expect(scheduler.renders).toBe(1);
  });

  it('never renders the values that were superseded within the same frame', () => {
    const frame = fakeFrame();
    const rendered: number[] = [];
    const scheduler = createFrameScheduler<number>(frame.requestFrame, (value) => {
      rendered.push(value);
    });

    scheduler.submit(1);
    scheduler.submit(2);
    frame.flush();

    expect(rendered).not.toContain(1);
  });

  it('books exactly one frame across several submits, not one per submit', () => {
    const frame = fakeFrame();
    const scheduler = createFrameScheduler<number>(frame.requestFrame, () => {});

    scheduler.submit(1);
    scheduler.submit(2);
    scheduler.submit(3);

    expect(frame.queued).toBe(1);
  });

  it('pending is true once booked and false again once the frame has rendered', () => {
    const frame = fakeFrame();
    const scheduler = createFrameScheduler<number>(frame.requestFrame, () => {});

    expect(scheduler.pending).toBe(false);
    scheduler.submit(1);
    expect(scheduler.pending).toBe(true);
    frame.flush();
    expect(scheduler.pending).toBe(false);
  });

  it('books a new frame for a submit that arrives after the previous frame rendered', () => {
    const frame = fakeFrame();
    const scheduler = createFrameScheduler<number>(frame.requestFrame, () => {});

    scheduler.submit(1);
    frame.flush();
    expect(scheduler.renders).toBe(1);

    scheduler.submit(2);
    expect(scheduler.pending).toBe(true);
    frame.flush();
    expect(scheduler.renders).toBe(2);
  });

  it('renders counts renders, not submissions - many submits per frame still count as one', () => {
    const frame = fakeFrame();
    const scheduler = createFrameScheduler<number>(frame.requestFrame, () => {});

    for (let i = 0; i < 10; i += 1) scheduler.submit(i);
    frame.flush();

    expect(scheduler.renders).toBe(1);
  });

  it('a submit made from inside render() books a new frame rather than being dropped', () => {
    // The scheduler clears `booked` before invoking `render`, specifically so a render that
    // itself calls `submit` (as `overlay.ts`'s font-load recovery and #81's F1 fix both do) is
    // not silently swallowed by "a frame is already booked".
    const frame = fakeFrame();
    let reentered = false;
    const scheduler = createFrameScheduler<number>(frame.requestFrame, (value) => {
      if (value === 1 && !reentered) {
        reentered = true;
        scheduler.submit(99);
      }
    });

    scheduler.submit(1);
    frame.flush(); // renders 1, which submits 99 - queuing a second frame
    expect(scheduler.renders).toBe(1);
    expect(frame.queued).toBe(1);

    frame.flush();
    expect(scheduler.renders).toBe(2);
  });

  it('a frame that fires with nothing queued renders nothing and does not count', () => {
    // Defensive: `requestFrame` is a real rAF in production, and nothing here guarantees the
    // callback cannot fire more than once for one `submit` - `flush` firing twice must be inert
    // the second time.
    const frame = fakeFrame();
    const rendered: number[] = [];
    const scheduler = createFrameScheduler<number>(frame.requestFrame, (value) => {
      rendered.push(value);
    });

    scheduler.submit(1);
    frame.flush();
    expect(rendered).toEqual([1]);
    expect(scheduler.renders).toBe(1);
  });
});
