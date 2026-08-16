/**
 * Issue #52: F2 may only remember what actually reached the screen.
 *
 * Every test here is about something *not* being recorded, and that asymmetry is the point.
 * `RecentOutputs` has no TTL by design, so a string recorded once is filtered out of translation
 * for the rest of the session - one wrong record is permanent, silent, and looks exactly like a
 * line that "sometimes doesn't work".
 *
 * The pairs that matter are driven from both sides: a payload that was drawn, and the same
 * payload that was superseded first. A test that only checked the happy path would pass for the
 * old code, which remembered at send time and therefore remembered both.
 */

import { describe, expect, it } from 'vitest';

import { DrawnPayloads, type DisplayRecorder } from '../../src/main/services/drawn-payloads.js';
import { RecentOutputs } from '../../src/main/services/recent-outputs.js';
import type { OverlayEntry } from '../../src/main/services/text-pipeline.js';

function entry(text: string, origin: OverlayEntry['origin'] = 'engine'): OverlayEntry {
  return { text, sourceText: `source of ${text}`, bbox: { x: 0, y: 0, width: 100, height: 20 }, origin };
}

interface Harness {
  readonly drawn: DrawnPayloads;
  readonly recent: RecentOutputs;
  visible: boolean;
}

function harness(capacity?: number): Harness {
  const recent = new RecentOutputs();
  const state = { visible: true };
  const drawn = new DrawnPayloads({
    recentOutputs: recent,
    isVisible: () => state.visible,
    ...(capacity === undefined ? {} : { capacity }),
  });
  return {
    drawn,
    recent,
    get visible() {
      return state.visible;
    },
    set visible(value: boolean) {
      state.visible = value;
    },
  };
}

describe('acceptance: nothing is remembered until the renderer says it was drawn', () => {
  it('sending a payload records nothing', () => {
    const h = harness();

    h.drawn.sent(1, [entry('ประตูทางทิศเหนือเปิดอยู่')]);

    // The test the issue asks for by name: this fails the moment `remember` moves back to the
    // send path, whatever else changes around it.
    expect(h.recent.size).toBe(0);
    expect(h.recent.has('ประตูทางทิศเหนือเปิดอยู่')).toBe(false);
  });

  it('the ack is what records it', () => {
    const h = harness();

    h.drawn.sent(1, [entry('ประตูทางทิศเหนือเปิดอยู่'), entry('อย่ายิงจนกว่าจะเห็นสัญญาณ')]);
    h.drawn.drawn(1);

    expect(h.recent.has('ประตูทางทิศเหนือเปิดอยู่')).toBe(true);
    expect(h.recent.has('อย่ายิงจนกว่าจะเห็นสัญญาณ')).toBe(true);
    expect(h.drawn.remembered).toBe(2);
  });

  it('a payload the minimum-display gate superseded is never remembered', () => {
    // #37's gate holds a payload that arrived too soon and replaces the held one when a newer
    // payload arrives. The replaced payload is never drawn - and the renderer therefore only ever
    // acks the newer id.
    const h = harness();

    h.drawn.sent(1, [entry('ข้อความที่ถูกแทนที่')]);
    h.drawn.sent(2, [entry('ข้อความที่ได้ขึ้นจอ')]);
    h.drawn.drawn(2);

    expect(h.recent.has('ข้อความที่ถูกแทนที่')).toBe(false);
    expect(h.recent.has('ข้อความที่ได้ขึ้นจอ')).toBe(true);
    expect(h.drawn.discarded).toBe(1);
  });

  it('an ack for an older payload arriving late cannot resurrect it', () => {
    const h = harness();

    h.drawn.sent(1, [entry('เก่า')]);
    h.drawn.sent(2, [entry('ใหม่')]);
    h.drawn.drawn(2);
    h.drawn.drawn(1);

    expect(h.recent.snapshot()).toEqual(['ใหม่']);
  });

  it('a repeated ack does not record twice', () => {
    const h = harness();
    h.drawn.sent(1, [entry('หนึ่ง')]);

    h.drawn.drawn(1);
    h.drawn.drawn(1);

    expect(h.drawn.remembered).toBe(1);
  });

  it('an id nobody sent is ignored', () => {
    const h = harness();

    expect(() => {
      h.drawn.drawn(99);
    }).not.toThrow();
    expect(h.recent.size).toBe(0);
  });
});

describe('acceptance: a hidden overlay draws nothing the user can see (#23)', () => {
  it('a payload drawn while the overlay is hidden is not remembered', () => {
    const h = harness();
    h.drawn.sent(1, [entry('ข้อความที่ไม่มีใครเห็น')]);

    h.visible = false;
    h.drawn.drawn(1);

    expect(h.recent.size).toBe(0);
    expect(h.drawn.discarded).toBe(1);
  });

  it('visibility is read when the ack lands, not when the payload was sent', () => {
    // The case a boolean captured at send time gets wrong: the user presses the toggle hotkey
    // while a payload is in flight.
    const h = harness();
    h.visible = false;
    h.drawn.sent(1, [entry('ข้อความที่ขึ้นจอทีหลัง')]);

    h.visible = true;
    h.drawn.drawn(1);

    expect(h.recent.has('ข้อความที่ขึ้นจอทีหลัง')).toBe(true);
  });
});

describe('acceptance: the degraded exemption survives (design doc section 7)', () => {
  it('an untranslated original is never recorded, even when it was drawn', () => {
    // Its text *is* the English on the user's screen. Recording it means that line is filtered by
    // F2 for the rest of the session and never translated again once the engine recovers - which
    // is the failure #23 recorded and #53's displayed set deliberately does the opposite about.
    const h = harness();
    h.drawn.sent(1, [entry('the northern gate is open', 'degraded'), entry('อย่ายิง')]);

    h.drawn.drawn(1);

    expect(h.recent.has('the northern gate is open')).toBe(false);
    expect(h.recent.has('อย่ายิง')).toBe(true);
  });

  it('the source text of a translated entry is never recorded either', () => {
    const h = harness();
    h.drawn.sent(1, [entry('คำแปล')]);

    h.drawn.drawn(1);

    expect(h.recent.has('source of คำแปล')).toBe(false);
  });
});

describe('the pending set is bounded and droppable', () => {
  it('a renderer that stops answering cannot grow the map without limit', () => {
    const h = harness(2);

    h.drawn.sent(1, [entry('หนึ่ง')]);
    h.drawn.sent(2, [entry('สอง')]);
    h.drawn.sent(3, [entry('สาม')]);

    expect(h.drawn.pending).toBe(2);
    // The oldest is dropped unrecorded rather than remembered on the way out.
    h.drawn.drawn(1);
    expect(h.recent.size).toBe(0);
  });

  it('reset drops everything in flight without recording it', () => {
    const h = harness();
    h.drawn.sent(1, [entry('หนึ่ง')]);

    h.drawn.reset();
    h.drawn.drawn(1);

    expect(h.recent.size).toBe(0);
    expect(h.drawn.pending).toBe(0);
  });

  it('rejects a capacity that would silently switch the record off', () => {
    const recorder: DisplayRecorder = { remember: () => {} };
    expect(() => new DrawnPayloads({ recentOutputs: recorder, isVisible: () => true, capacity: 0 })).toThrow(
      RangeError,
    );
  });
});
