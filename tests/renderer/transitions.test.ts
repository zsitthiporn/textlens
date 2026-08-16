/**
 * Minimum display time, layout stability and crossfade (issue M8-03 / #37).
 *
 * ## The metrics
 *
 * "No flicker" is not falsifiable as written, so each of the three rules is measured as a number
 * that can come out wrong:
 *
 * | rule            | metric                                                              | target |
 * |-----------------|---------------------------------------------------------------------|--------|
 * | A4 min display  | the **sequence** of applies and the clock time of each               | order + deadline |
 * | A4 never drops  | every submitted payload is applied or superseded by a *newer* one    | 0 lost |
 * | A6 stability    | DOM operations performed while the picture is unchanged              | 0 |
 * | A9 crossfade    | frames in which a persisting box paints neither string               | 0 |
 * | A9 fade out     | frames in which a departing box is `display: none` before the fade ends | 0 |
 *
 * Nothing here sleeps. Every clock is a counter and every timer is a queue this file drains, so a
 * rule that stopped discriminating cannot be rescued by a test that waited long enough.
 */

import { describe, expect, it } from 'vitest';

import {
  MinDisplayGate,
  SlotAllocator,
  renderSignature,
  slotKey,
} from '../../src/renderer/overlay/transitions.js';
import {
  RenderSession,
  renderEntries,
  type LayoutEntry,
  type RenderStats,
} from '../../src/renderer/overlay/layout.js';
import { BoxPool } from '../../src/renderer/overlay/node-pool.js';
import { fakeFactory, type FakeBox, type Op } from '../main/overlay/fakes.js';

// ---------------------------------------------------------------------------
// A clock and a timer queue, both driven by hand
// ---------------------------------------------------------------------------

class FakeClock {
  now = 0;
  #next = 1;
  #timers = new Map<number, { at: number; run: () => void }>();

  schedule = (run: () => void, delayMs: number): number => {
    const id = this.#next;
    this.#next += 1;
    this.#timers.set(id, { at: this.now + delayMs, run });
    return id;
  };

  cancel = (handle: unknown): void => {
    this.#timers.delete(handle as number);
  };

  /** Move time forward, firing whatever comes due, in due order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueAt = timer.at;
          dueId = id;
        }
      }
      if (dueId === null) break;
      const timer = this.#timers.get(dueId);
      this.#timers.delete(dueId);
      if (timer === undefined) break;
      this.now = timer.at;
      timer.run();
    }
    this.now = target;
  }
}

interface GateHarness {
  readonly clock: FakeClock;
  readonly gate: MinDisplayGate<string>;
  /** Every value applied, in order, with the clock time it was applied at. */
  readonly applied: { value: string; at: number }[];
  /** Simulate a draw that repainted. A skipped render deliberately does not call this. */
  shown(): void;
}

function gateHarness(minDisplayMs: number): GateHarness {
  const clock = new FakeClock();
  const applied: { value: string; at: number }[] = [];
  const gate = new MinDisplayGate<string>({
    minDisplayMs: () => minDisplayMs,
    now: () => clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    apply: (value) => {
      applied.push({ value, at: clock.now });
    },
  });
  return {
    clock,
    gate,
    applied,
    shown: () => {
      gate.markShown();
    },
  };
}

describe('MinDisplayGate - A4', () => {
  it('draws the first payload with no delay', () => {
    const h = gateHarness(400);
    h.gate.submit('A');

    expect(h.applied).toEqual([{ value: 'A', at: 0 }]);
  });

  it('holds a payload that arrives too early and applies it at the deadline', () => {
    const h = gateHarness(400);
    h.gate.submit('A');
    h.shown();

    h.clock.advance(200);
    h.gate.submit('B');
    // The criterion is "รอจนครบแล้วค่อยเปลี่ยน (ไม่ทิ้ง)" - so at 200ms it must not be on screen,
    // and asserting only the end state would not tell those two apart.
    expect(h.applied.map((entry) => entry.value)).toEqual(['A']);
    expect(h.gate.stats.pending).toBe(true);

    h.clock.advance(200);
    expect(h.applied).toEqual([
      { value: 'A', at: 0 },
      { value: 'B', at: 400 },
    ]);
    expect(h.gate.stats.deferred).toBe(1);
  });

  it('applies a payload that arrives after the minimum immediately', () => {
    const h = gateHarness(400);
    h.gate.submit('A');
    h.shown();

    h.clock.advance(401);
    h.gate.submit('B');

    expect(h.applied[1]).toEqual({ value: 'B', at: 401 });
    expect(h.gate.stats.deferred).toBe(0);
  });

  it('keeps the newest of several payloads that arrive during one hold', () => {
    const h = gateHarness(400);
    h.gate.submit('A');
    h.shown();

    h.clock.advance(100);
    h.gate.submit('B');
    h.clock.advance(100);
    h.gate.submit('C');
    h.clock.advance(100);
    h.gate.submit('D');

    h.clock.advance(200);
    // D, not B: every payload carries the whole set, so drawing B first would be painting a
    // picture that is already known to be wrong. Nothing is lost - it is superseded.
    expect(h.applied.map((entry) => entry.value)).toEqual(['A', 'D']);
    expect(h.gate.stats.superseded).toBe(2);
  });

  it('never leaves the last submission undrawn, whatever the arrival pattern', () => {
    // The guarantee #36 depends on. If a payload can be dropped here, an unchanged next frame is
    // suppressed on the other side of the IPC boundary and the caption is simply never seen.
    const h = gateHarness(400);
    const gaps = [0, 37, 5, 411, 12, 3, 190, 802, 1, 1, 1, 250, 60];
    let last = '';

    for (let index = 0; index < gaps.length; index += 1) {
      h.clock.advance(gaps[index] ?? 0);
      last = `payload-${String(index)}`;
      h.gate.submit(last);
      // The renderer reports back only when something actually repainted.
      if (h.applied[h.applied.length - 1]?.value === last) h.shown();
    }

    h.clock.advance(1000);
    expect(h.applied[h.applied.length - 1]?.value).toBe(last);
    expect(h.gate.stats.pending).toBe(false);
  });

  it('starts the clock when the screen changed, not when a payload arrived', () => {
    // The distinction the design turns on: a payload A6 skipped painted nothing, so it cannot
    // have restarted the time the user has had to read what is on screen. Driven from arrival
    // instead, a stream of identical frames would extend the hold without limit.
    const h = gateHarness(400);
    h.gate.submit('A');
    h.shown();

    h.clock.advance(390);
    h.gate.submit('A-again'); // deferred to t=400
    h.clock.advance(10); // fires; the renderer skips it, so no `shown()`

    h.clock.advance(1);
    h.gate.submit('B');
    // shownAt is still 0, so 400ms have long passed and B goes straight through.
    expect(h.applied[h.applied.length - 1]).toEqual({ value: 'B', at: 401 });
  });

  it('draws immediately again after a reset', () => {
    const h = gateHarness(400);
    h.gate.submit('A');
    h.shown();
    h.gate.reset();

    h.gate.submit('B');
    expect(h.applied.map((entry) => entry.value)).toEqual(['A', 'B']);
  });

  it('is off at 0', () => {
    const h = gateHarness(0);
    h.gate.submit('A');
    h.shown();
    h.gate.submit('B');
    h.shown();

    expect(h.applied.map((entry) => entry.value)).toEqual(['A', 'B']);
    expect(h.gate.stats.deferred).toBe(0);
  });
});

describe('renderSignature - A6', () => {
  const entry = {
    text: 'ไปที่ท่าเรือ',
    anchor: { x: 100, y: 200, width: 400, height: 40 },
    degraded: false,
  };
  const screen = { width: 1920, height: 1080 };

  it('is equal for two frames that would paint the same picture', () => {
    expect(renderSignature([entry], screen)).toBe(renderSignature([{ ...entry }], screen));
  });

  it('differs on text, on position, on size and on degraded', () => {
    const base = renderSignature([entry], screen);
    expect(renderSignature([{ ...entry, text: 'อื่น' }], screen)).not.toBe(base);
    expect(renderSignature([{ ...entry, anchor: { ...entry.anchor, y: 201 } }], screen)).not.toBe(base);
    expect(renderSignature([{ ...entry, anchor: { ...entry.anchor, width: 401 } }], screen)).not.toBe(base);
    expect(renderSignature([{ ...entry, degraded: true }], screen)).not.toBe(base);
  });

  it('differs when the viewport changed', () => {
    // Placement is a function of the viewport, so a resized window with identical text must not
    // be skipped - and there is no other signal that would catch it.
    expect(renderSignature([entry], { width: 1280, height: 720 })).not.toBe(
      renderSignature([entry], screen),
    );
  });

  it('differs when the same entries arrive in a different order', () => {
    const other = { ...entry, text: 'สอง', anchor: { ...entry.anchor, y: 400 } };
    expect(renderSignature([entry, other], screen)).not.toBe(renderSignature([other, entry], screen));
  });
});

describe('SlotAllocator', () => {
  it('gives the same anchor the same box across frames', () => {
    const slots = new SlotAllocator(8);
    const key = slotKey({ x: 100, y: 900 });

    const first = slots.assign([key], 0);
    const second = slots.assign([key], 100);

    expect(second.indices[0]).toBe(first.indices[0]);
    expect(second.states[0]).toBe('holding');
  });

  it('keeps a departed box alive until its fade has run', () => {
    const slots = new SlotAllocator(8);
    const a = slotKey({ x: 0, y: 0 });
    const b = slotKey({ x: 0, y: 500 });

    slots.assign([a, b], 0);
    const dropped = slots.assign([a], 100);

    expect(dropped.leaving).toHaveLength(1);
    expect(slots.fading).toBe(true);
    expect(slots.sweep(150, 120)).toEqual([]); // 50ms into a 120ms fade
    expect(slots.sweep(220, 120)).toHaveLength(1);
    expect(slots.fading).toBe(false);
  });

  it('does not restart a fade that is already running', () => {
    const slots = new SlotAllocator(8);
    const a = slotKey({ x: 0, y: 0 });
    const b = slotKey({ x: 0, y: 500 });

    slots.assign([a, b], 0);
    slots.assign([a], 100);
    slots.assign([a], 150);
    slots.assign([a], 200);

    // Still measured from 100, not from 200. Otherwise a box would hang half-faded forever while
    // payloads kept arriving.
    expect(slots.sweep(221, 120)).toHaveLength(1);
  });

  it('re-enters a box caught mid-fade rather than leaving it faded', () => {
    const slots = new SlotAllocator(8);
    const a = slotKey({ x: 0, y: 0 });

    const first = slots.assign([a], 0);
    slots.assign([], 100);
    const back = slots.assign([a], 150);

    expect(back.indices[0]).toBe(first.indices[0]);
    expect(back.states[0]).toBe('entering');
    expect(slots.fading).toBe(false);
  });

  it('takes the longest-fading box when the pool is full rather than dropping an entry', () => {
    const slots = new SlotAllocator(2);
    const a = slotKey({ x: 0, y: 0 });
    const b = slotKey({ x: 0, y: 100 });
    const c = slotKey({ x: 0, y: 200 });

    slots.assign([a, b], 0);
    slots.assign([], 10); // both start fading
    const next = slots.assign([c], 20);

    expect(next.indices[0]).not.toBeNull();
    expect(next.exhausted).toBe(0);
  });

  it('reports exhaustion rather than reusing a live box', () => {
    const slots = new SlotAllocator(2);
    const keys = [0, 1, 2].map((y) => slotKey({ x: 0, y: y * 100 }));

    const assignment = slots.assign(keys, 0);

    expect(assignment.exhausted).toBe(1);
    expect(assignment.indices[2]).toBeNull();
    // The two that did get a box must not share one.
    expect(assignment.indices[0]).not.toBe(assignment.indices[1]);
  });

  it('returns every index to the free list on clear', () => {
    const slots = new SlotAllocator(2);
    slots.assign([slotKey({ x: 0, y: 0 }), slotKey({ x: 0, y: 100 })], 0);
    slots.clear();

    expect(slots.size).toBe(0);
    expect(slots.assign([slotKey({ x: 9, y: 9 })], 0).indices[0]).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The three rules as the renderer actually runs them
// ---------------------------------------------------------------------------

interface RenderHarness {
  readonly boxes: FakeBox[];
  readonly log: Op[];
  readonly session: RenderSession;
  render(entries: readonly LayoutEntry[], nowMs?: number): RenderStats;
}

/** Two lines per 300px of text, so a height depends on the text and cannot be a constant. */
const heightOf = (text: string, width: number): number =>
  width === 0 ? 0 : 24 * Math.max(Math.ceil((text.length * 10) / width), 1);

function renderHarness(options: { capacity?: number; fadeMs?: number } = {}): RenderHarness {
  const factory = fakeFactory(heightOf);
  const capacity = options.capacity ?? 8;
  const pool = new BoxPool({ capacity, create: factory.create, attach: factory.attach });
  const session = new RenderSession({ capacity });
  let clock = 0;

  return {
    boxes: factory.boxes,
    log: factory.log,
    session,
    render(entries, nowMs) {
      clock = nowMs ?? clock + 16;
      return renderEntries(
        entries,
        pool,
        {
          screen: { width: 1920, height: 1080 },
          fadeMs: options.fadeMs ?? 120,
          now: () => clock,
        },
        session,
      );
    },
  };
}

function entry(text: string, y: number, source = text): LayoutEntry {
  return {
    text,
    sourceText: source,
    anchor: { x: 400, y, width: 640, height: 40 },
    degraded: false,
  };
}

describe('layout stability - A6', () => {
  it('does no DOM work at all for a payload that would paint the same picture', () => {
    const h = renderHarness();
    const payload = [entry('ไปที่ท่าเรือ', 900, 'get to the port')];

    h.render(payload);
    const after = h.log.length;

    for (let round = 0; round < 9; round += 1) {
      const stats = h.render([...payload]);
      expect(stats.unchanged).toBe(true);
      // An empty phase log is the discriminating part: a render that did the work and wrote the
      // same values back would report `['write', 'read', 'write']` and pass any end-state check.
      expect(stats.phaseLog).toEqual([]);
    }

    // The metric: zero operations across nine redundant payloads.
    expect(h.log.length - after).toBe(0);
  });

  it('skips a jittered repeat too, because #35 has already stabilized the anchor', () => {
    // The ordering dependency between the two issues. Signed from the raw rectangles, the
    // signature would churn on every frame and this skip would never once fire in real use.
    const h = renderHarness();
    h.render([entry('ไปที่ท่าเรือ', 900, 'get to the port')]);
    const after = h.log.length;

    for (const dy of [1, -2, 3, -1, 2]) {
      const stats = h.render([
        { ...entry('ไปที่ท่าเรือ', 900 + dy, 'get to the port') },
      ]);
      expect(stats.unchanged).toBe(true);
    }

    expect(h.log.length - after).toBe(0);
  });

  it('renders when the text really changed', () => {
    const h = renderHarness();
    h.render([entry('ไปที่ท่าเรือ', 900, 'get to the port')]);
    const stats = h.render([entry('อย่ายิง', 900, 'do not shoot')]);

    expect(stats.unchanged).toBe(false);
    expect(stats.phaseLog).toEqual(['write', 'read', 'write']);
  });

  it('renders again after the session is reset', () => {
    const h = renderHarness();
    const payload = [entry('ไปที่ท่าเรือ', 900, 'get to the port')];
    h.render(payload);
    h.session.reset();

    expect(h.render([...payload]).unchanged).toBe(false);
  });
});

describe('crossfade - A9', () => {
  it('paints both strings at once when the text in a box changes', () => {
    const h = renderHarness({ fadeMs: 120 });
    h.render([entry('ไปที่ท่าเรือ', 900, 'get to the port')]);
    const box = h.boxes[0];
    if (box === undefined) throw new Error('no box');

    const stats = h.render([entry('อย่ายิง', 900, 'do not shoot')]);

    expect(stats.crossfaded).toBe(1);
    // The metric for "fade, not disappear then appear": at no point does the box hold neither
    // string. The outgoing one is still painted while the incoming one arrives.
    expect(box.text).toBe('อย่ายิง');
    expect(box.outgoing).toBe('ไปที่ท่าเรือ');
    expect(box.style.display).toBe('block');
  });

  it('keeps the same element, so the plate does not move under the words', () => {
    const h = renderHarness();
    h.render([entry('หนึ่ง', 900, 'one')]);
    const first = h.boxes.findIndex((box) => box.text === 'หนึ่ง');

    h.render([entry('สอง', 900, 'two')]);
    const second = h.boxes.findIndex((box) => box.text === 'สอง');

    expect(second).toBe(first);
  });

  it('does not fade a box that is appearing for the first time', () => {
    // Nothing to fade *from*. A transition here would show an empty plate dissolving into text.
    const h = renderHarness();
    const stats = h.render([entry('ไปที่ท่าเรือ', 900, 'get to the port')]);

    expect(stats.entering).toBe(1);
    expect(stats.crossfaded).toBe(0);
    expect(h.boxes[0]?.outgoing).toBeNull();
  });

  it('fades a departing box out where it stands instead of blinking it off', () => {
    const h = renderHarness({ fadeMs: 120 });
    h.render([entry('หนึ่ง', 300, 'one'), entry('สอง', 900, 'two')], 0);
    const departing = h.boxes.findIndex((box) => box.text === 'สอง');

    const stats = h.render([entry('หนึ่ง', 300, 'one')], 100);
    const box = h.boxes[departing];
    if (box === undefined) throw new Error('no box');

    expect(stats.leaving).toBe(1);
    // The metric: still drawn, still where it was, still holding its text - just transparent.
    expect(box.style.display).toBe('block');
    expect(box.style.opacity).toBe('0');
    expect(box.text).toBe('สอง');

    // ...and gone once the fade has had its time.
    h.render([entry('หนึ่ง', 300, 'one'), entry('สาม', 600, 'three')], 400);
    expect(box.style.display).toBe('none');
    expect(box.text).toBe('');
  });

  it('swaps instantly when the fade is turned off', () => {
    const h = renderHarness({ fadeMs: 0 });
    h.render([entry('หนึ่ง', 300, 'one'), entry('สอง', 900, 'two')], 0);
    const departing = h.boxes.findIndex((box) => box.text === 'สอง');

    const stats = h.render([entry('สาม', 300, 'one')], 100);

    expect(stats.crossfaded).toBe(0);
    expect(h.boxes[departing]?.style.display).toBe('none');
  });
});

describe('renderEntries - the parts M5 already guaranteed', () => {
  it('still measures in exactly one read phase', () => {
    const h = renderHarness();
    const stats = h.render([entry('หนึ่ง', 100, 'one'), entry('สอง', 400, 'two'), entry('สาม', 700, 'three')]);

    expect(stats.phaseLog).toEqual(['write', 'read', 'write']);
  });

  it('still creates no nodes after construction, across many renders', () => {
    const h = renderHarness();
    for (let round = 0; round < 30; round += 1) {
      h.render([entry(`บรรทัด ${String(round)}`, 100 + (round % 5) * 200, `line ${String(round)}`)]);
    }
    expect(h.boxes).toHaveLength(8);
  });

  it('truncates rather than overwriting when there are more entries than boxes', () => {
    const h = renderHarness({ capacity: 3 });
    const stats = h.render([0, 1, 2, 3, 4].map((index) => entry(`ก${String(index)}`, index * 150, `t${String(index)}`)));

    // Since #27 the overflow is decided before slot assignment, by priority rather than by
    // arrival, so it is reported as `overCapacity` and the slot allocator never runs short -
    // `truncated` now means only "the pool had nothing left", which on this render is nothing.
    // The count is unchanged, and so is the guarantee #23 asked for.
    expect(stats.overCapacity).toBe(2);
    expect(stats.truncated).toBe(0);
    expect(stats.claimed).toBe(3);
    // The three that were drawn must be three different boxes, not one box written five times.
    expect(new Set(h.boxes.filter((box) => box.text !== '').map((box) => box.text)).size).toBe(3);
  });

  it('treats a payload that changed only in a dropped block as unchanged (#27 x A6)', () => {
    // The budget runs *before* the signature is computed, so "the same picture" means the same
    // drawn picture. Get that order wrong and every frame in which some tiny block the user
    // cannot see flickers between two readings forces a full repaint of everything they can -
    // which is A6 dying quietly, with no test failing and no symptom but CPU.
    //
    // Found by a mutation check: moving the signature back onto the full entry list broke nothing
    // in the suite, because every other unchanged-payload test sends a payload that is identical
    // all the way through. This is the case that separates the two.
    const h = renderHarness({ capacity: 2 });
    const big = {
      text: 'บรรทัดใหญ่',
      sourceText: 'the big one',
      anchor: { x: 0, y: 900, width: 800, height: 40 },
      degraded: false,
    };
    const medium = {
      text: 'บรรทัดกลาง',
      sourceText: 'the medium one',
      anchor: { x: 0, y: 500, width: 400, height: 40 },
      degraded: false,
    };
    const tiny = {
      text: 'เล็ก',
      sourceText: 'the tiny one',
      anchor: { x: 0, y: 100, width: 40, height: 16 },
      degraded: false,
    };

    const first = h.render([tiny, medium, big]);
    expect(first.overCapacity).toBe(1);
    // Evidence the tiny one is the block that lost, so the rest of this test is about the case
    // it claims to be about.
    expect(first.budgetDrops.map((drop) => drop.index)).toEqual([0]);

    // Only the dropped block differs. Nothing on screen can change.
    const second = h.render([{ ...tiny, text: 'เล็กมาก', sourceText: 'a different tiny one' }, medium, big]);

    expect(second.unchanged).toBe(true);
    expect(second.phaseLog).toEqual([]);
  });

  it('gives two entries that stabilize onto one point two different boxes', () => {
    // Two OCR reads a few px apart snap into the same grid cell, so their slot keys collide.
    // Unhandled, the second would claim the first's box and one translation would vanish.
    const h = renderHarness();
    const stats = h.render([
      { text: 'หนึ่ง', sourceText: 'one', anchor: { x: 400, y: 900, width: 640, height: 40 }, degraded: false },
      { text: 'สอง', sourceText: 'two', anchor: { x: 402, y: 901, width: 640, height: 40 }, degraded: false },
    ]);

    expect(stats.claimed).toBe(2);
    expect(h.boxes.filter((box) => box.text !== '')).toHaveLength(2);
  });

  it('tags a degraded entry as English so the Thai breaker is not asked to segment it', () => {
    const h = renderHarness();
    h.render([{ ...entry('untranslated', 900, 'untranslated'), degraded: true }]);

    expect(h.boxes[0]?.attributes.get('lang')).toBe('en');
    expect(h.boxes[0]?.attributes.get('data-origin')).toBe('degraded');
  });
});
