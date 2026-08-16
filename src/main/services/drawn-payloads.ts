/**
 * What actually reached the screen, and therefore what F2 is allowed to remember (issue #52).
 *
 * `RecentOutputs` is layer 2 of the feedback-loop defence: every string the overlay puts on screen
 * goes in, so OCR reading it back is recognised as our own output instead of translated. The
 * module is explicit that only the stage which *displays* something may record it - and until now
 * the app recorded at **send** time, which is a different event with a different answer.
 *
 * Three things sit between a send and a picture, and all three are working as designed:
 *
 *   - `MinDisplayGate` (#37) holds a payload that arrived before the last one had been readable,
 *     and replaces the held one when a newer payload arrives. The replaced payload is never drawn.
 *   - `FrameScheduler` coalesces every payload that arrives inside one animation frame into the
 *     last one.
 *   - The overlay window can be hidden (#23/#34). Hiding is not pausing: the sidecar keeps
 *     capturing and payloads keep arriving, they simply land in a window nobody can see.
 *
 * `RecentOutputs` has **no TTL by design**, so each of those is not a missed beat but a permanent
 * one: a string recorded once is filtered out of translation for the rest of the session, with
 * nothing in the log and nothing on screen. That is the failure invariant 4 forbids, produced by
 * three features all behaving correctly.
 *
 * So the renderer says what it drew (`OverlayDrawnMessage`) and this pairs the answer back up with
 * the entries that were sent under that id. The renderer reports an id and nothing else; every
 * rule about what may be remembered stays here.
 *
 * ## Two exclusions, both of which look like omissions and are not
 *
 * **Only `entry.text`, never `entry.sourceText`.** `sourceText` is the *English on the user's
 * screen* - the thing we are here to translate. Remembering it means that line is dropped by F2
 * for the rest of the session and never translated again. Only the Thai we painted is our output.
 *
 * **Never a `degraded` entry.** Its text *is* the original English, so remembering it is the same
 * bug by another route: the English echoed during an engine outage would be suppressed
 * permanently once the engine recovered. Recorded on issue #23, and the reason #53's displayed set
 * and this one hold opposite rules about degraded entries - that one must keep them so the box
 * stays on screen, this one must never learn about them.
 */

import type { OverlayEntry } from './text-pipeline.js';

/**
 * How many sent-but-unanswered payloads to hold.
 *
 * Small on purpose. Acks arrive within a frame of the send in a healthy session, and the only way
 * to accumulate is a renderer that has stopped answering - in which case holding its backlog helps
 * nobody and the oldest entries are the least likely to ever be confirmed.
 */
export const DEFAULT_PENDING_CAPACITY = 32;

/** Just enough of `RecentOutputs` to record with. */
export interface DisplayRecorder {
  remember(text: string): void;
}

export interface DrawnPayloadsOptions {
  readonly recentOutputs: DisplayRecorder;
  /**
   * Whether the overlay window is on screen **right now**, asked at ack time rather than at send.
   *
   * A function rather than a flag because the two events are seconds apart in the case that
   * matters: the user presses the toggle hotkey while a payload is in flight.
   */
  readonly isVisible: () => boolean;
  readonly capacity?: number;
}

/** One payload, waiting to hear whether it became a picture. */
interface Pending {
  readonly id: number;
  readonly entries: readonly OverlayEntry[];
}

export class DrawnPayloads {
  readonly #recentOutputs: DisplayRecorder;
  readonly #isVisible: () => boolean;
  readonly #capacity: number;
  /** Insertion-ordered, which is id order, which is send order. */
  readonly #pending = new Map<number, Pending>();
  #remembered = 0;
  #discarded = 0;

  constructor(options: DrawnPayloadsOptions) {
    const capacity = options.capacity ?? DEFAULT_PENDING_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, got ${String(capacity)}`);
    }
    this.#recentOutputs = options.recentOutputs;
    this.#isVisible = options.isVisible;
    this.#capacity = capacity;
  }

  /** Strings recorded as displayed. A count, so a log line can carry it (PR3). */
  get remembered(): number {
    return this.#remembered;
  }

  /** Payloads that were sent and never drawn: superseded, coalesced, or never answered for. */
  get discarded(): number {
    return this.#discarded;
  }

  get pending(): number {
    return this.#pending.size;
  }

  /** Note that a payload is on its way to the renderer. Records nothing by itself. */
  sent(id: number, entries: readonly OverlayEntry[]): void {
    this.#pending.set(id, { id, entries });

    while (this.#pending.size > this.#capacity) {
      const oldest = this.#pending.keys().next();
      if (oldest.done === true) break;
      this.#pending.delete(oldest.value);
      this.#discarded += 1;
    }
  }

  /**
   * The renderer drew the payload sent under `id`.
   *
   * Everything sent before it is dropped unrecorded. That is not housekeeping, it is the rule: the
   * gate and the scheduler only ever move forwards, so an older payload that has not been drawn by
   * the time a newer one has is a payload that never will be - and it is precisely those that must
   * not be remembered.
   */
  drawn(id: number): void {
    const payload = this.#pending.get(id);

    for (const key of [...this.#pending.keys()]) {
      if (key > id) continue;
      this.#pending.delete(key);
      if (key !== id) this.#discarded += 1;
    }

    // An id nobody sent, or one already answered for. Both are ignorable rather than errors: the
    // channel is fire-and-forget and a duplicate ack must not record anything twice.
    if (payload === undefined) return;

    // The window is hidden, so this payload was laid out into something nobody can see (#23).
    if (!this.#isVisible()) {
      this.#discarded += 1;
      return;
    }

    for (const entry of payload.entries) {
      if (entry.origin === 'degraded') continue;
      this.#recentOutputs.remember(entry.text);
      this.#remembered += 1;
    }
  }

  /** Forget everything in flight. For a renderer that went away and cannot answer any of it. */
  reset(): void {
    this.#discarded += this.#pending.size;
    this.#pending.clear();
  }
}
