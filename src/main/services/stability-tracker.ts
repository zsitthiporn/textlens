/**
 * Content stability tracking and dynamic suppression (issue M8-02 / #36, features A1, A3).
 *
 * `dedup.ts` already answers "have we translated this line before", per line, inside a 3s window.
 * This answers a different question, about the whole screen and with no time limit: **is what is
 * on the screen right now the same thing that was on it when we last drew?**
 *
 * The gap between the two is real and is the reason this exists. A subtitle that stays up for six
 * seconds outlives dedup's window, gets readmitted, gets retranslated (a cache hit, so cheap) and
 * is re-emitted - and the renderer redraws a picture the user is already reading. #35 and #37 make
 * that redraw cheap and invisible; this stops it from being sent at all, and with it the round
 * trip, the IPC and the wakeup.
 *
 * ## The baseline is what was *seen*, not what was *sent*
 *
 * The obvious implementation compares this frame against the previous frame. It has a hole that
 * only shows up under load, so it is worth stating why this does not do that: if the previous
 * frame produced no payload - the engine failed, every entry was identical to its source, a newer
 * frame overtook it - then the next frame looks "unchanged" and is suppressed, and the text that
 * failed to reach the screen never gets another chance. Nothing logs an error. The user sees one
 * subtitle that "sometimes doesn't work".
 *
 * So the baseline advances **only when a payload actually reached the renderer**
 * ({@link StabilityTracker.markEmitted}). A frame that failed to emit leaves the baseline where it
 * was, so the retry still reads as different and still goes through.
 *
 * The baseline is also the frame's **whole observed set**, not the entries the payload happened to
 * carry. Those two differ constantly: on a two-line subtitle where only the second line changes,
 * dedup removes the first and the payload contains one entry, while the screen holds two. Keyed on
 * the payload, the baseline would be `{B'}`, the next frame would observe `{A, B'}`, the two would
 * never match, and the tracker would never engage - on precisely the multi-line subtitle it was
 * written for.
 *
 * ## Degraded output is never suppressed away
 *
 * Design doc section 7 exempts `degraded` entries from identical-suppression, because when every
 * engine is down the box holds the untranslated original and suppressing it means a blank screen
 * during an outage. That exemption has a second edge here, and it is the one that bites: if the
 * last emit was degraded, the English on screen is *waiting to be replaced* by Thai as soon as an
 * engine recovers. Recovery arrives through dedup's window expiring and the line being
 * retranslated - and a tracker that called that unchanged frame "stable" would suppress the
 * retry and strand the user on English until the subtitle changed.
 *
 * So: **a degraded baseline never suppresses anything.**
 *
 * ## Every threshold is set to fail towards emitting
 *
 * Same asymmetry `dedup.ts` is built around, one step more severe. A false negative here costs
 * one redundant render, which #37 then skips for free. A false positive is a sentence that is
 * never shown. The per-line threshold is therefore 0.95 (dedup's, for dedup's reasons), the set
 * threshold is 0.9, and `frames` is 2 so that no single mis-scored frame can start a suppression.
 */

import { similarity } from './dedup.js';
import { normalizeForComparison } from './recent-outputs.js';

export interface StabilityOptions {
  /** Whether suppression may happen at all. `false` still tracks, so the counters stay honest. */
  readonly enabled?: boolean;
  /** Minimum per-line similarity for two strings to be the same line, 0..1. Default 0.95. */
  readonly similarityThreshold?: number;
  /** Minimum set similarity for a frame to count as unchanged, 0..1. Default 0.9. */
  readonly setThreshold?: number;
  /**
   * Lines the baseline does not contain that a frame may still hold and count as unchanged.
   *
   * **Default 0, and the ratio above cannot do this job on its own** - measured on a real run,
   * not reasoned about. On a full-screen capture the pipeline saw 70 blocks; one line changing
   * out of 70 scores 0.97, which clears any sane ratio threshold. Because the baseline only
   * advances on an emit, that frame would be suppressed, and so would every frame after it: the
   * changed line would never be translated and never drawn, permanently, with the app reporting
   * nothing. That is invariant 4's failure, reached by arithmetic.
   *
   * This is the same shape of bug as #50 and takes the same shape of fix: a fraction means
   * different things at different set sizes, so the rule needs an absolute floor beside it. A
   * frame is unchanged when the sets are similar **and** it contains nothing new.
   *
   * The ratio is still needed for the other direction - lines *vanishing* produce no new line at
   * all, and only the ratio notices.
   */
  readonly maxNewLines?: number;
  /** Consecutive unchanged frames before suppression starts. Default 2. */
  readonly frames?: number;
}

export const DEFAULT_SIMILARITY_THRESHOLD = 0.95;
export const DEFAULT_SET_THRESHOLD = 0.9;
export const DEFAULT_MAX_NEW_LINES = 0;
export const DEFAULT_FRAMES = 2;

export interface StabilityVerdict {
  /** Whether this frame should be dropped before it costs anything further. */
  readonly suppress: boolean;
  /** Set similarity against the baseline, 0..1. 0 when there is no baseline yet. */
  readonly similarity: number;
  /** Lines in this frame that matched nothing in the baseline. */
  readonly newLines: number;
  /** Consecutive frames that matched the baseline, this one included. */
  readonly streak: number;
  /** Why nothing was suppressed. `null` when it was. Exists so a log line can say. */
  readonly reason: 'suppressed' | 'disabled' | 'no-baseline' | 'changed' | 'warming' | 'degraded';
}

/**
 * Remembers what the screen looked like when something was last drawn on it.
 *
 * No clock. Frames are counted, not timed, because the capture loop's interval is configurable
 * and adaptive - a rule expressed in milliseconds would mean a different number of frames at
 * `intervalActive` than at `intervalIdle`, and the thing being counted is *observations*.
 */
export class StabilityTracker {
  readonly #enabled: boolean;
  readonly #similarityThreshold: number;
  readonly #setThreshold: number;
  readonly #maxNewLines: number;
  readonly #frames: number;

  /** The observed set behind the last payload that reached the renderer. */
  #baseline: readonly string[] | null = null;
  /** Whether that payload was the untranslated original. See the module comment. */
  #baselineDegraded = false;
  #streak = 0;

  constructor(options: StabilityOptions = {}) {
    const frames = options.frames ?? DEFAULT_FRAMES;
    if (!Number.isInteger(frames) || frames < 1) {
      throw new RangeError(`frames must be a positive integer, got ${String(frames)}`);
    }
    this.#enabled = options.enabled ?? true;
    this.#similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.#setThreshold = options.setThreshold ?? DEFAULT_SET_THRESHOLD;
    this.#maxNewLines = options.maxNewLines ?? DEFAULT_MAX_NEW_LINES;
    this.#frames = frames;
  }

  get streak(): number {
    return this.#streak;
  }

  /** Whether a baseline exists. False before the first payload and after every {@link reset}. */
  get hasBaseline(): boolean {
    return this.#baseline !== null;
  }

  /**
   * Judge one frame's worth of on-screen text.
   *
   * Called for **every** frame, including ones that will be suppressed, because the streak is a
   * count of consecutive observations and skipping the call would break it. Pass the text as it
   * was after the noise and feedback filters and **before** dedup - dedup removes exactly the
   * lines that make a frame look unchanged, so a post-dedup set describes the delta rather than
   * the screen.
   */
  observe(texts: readonly string[]): StabilityVerdict {
    const baseline = this.#baseline;
    if (baseline === null) {
      this.#streak = 0;
      return { suppress: false, similarity: 0, newLines: texts.length, streak: 0, reason: 'no-baseline' };
    }

    const { score, newLines } = compareSets(texts, baseline, this.#similarityThreshold);

    // Two rules, and the second is not redundant: see `maxNewLines`. The ratio catches lines
    // disappearing; the count catches one line changing on a screen with seventy of them, which
    // no ratio can be tuned to notice without also suppressing nothing.
    if (score < this.#setThreshold || newLines > this.#maxNewLines) {
      this.#streak = 0;
      return { suppress: false, similarity: score, newLines, streak: 0, reason: 'changed' };
    }

    this.#streak += 1;
    const streak = this.#streak;
    const base = { similarity: score, newLines, streak };

    if (!this.#enabled) return { suppress: false, ...base, reason: 'disabled' };
    if (this.#baselineDegraded) {
      // The screen is holding untranslated English. Suppressing here would stop the retry that
      // replaces it the moment an engine comes back. Design doc section 7's exemption.
      return { suppress: false, ...base, reason: 'degraded' };
    }
    if (streak < this.#frames) return { suppress: false, ...base, reason: 'warming' };

    return { suppress: true, ...base, reason: 'suppressed' };
  }

  /**
   * Record that a payload built from `texts` actually reached the renderer.
   *
   * @param texts The frame's **observed** set - the same one handed to {@link observe} - not the
   *              payload's entries. See the module comment.
   * @param degraded Whether that payload carried untranslated originals.
   */
  markEmitted(texts: readonly string[], degraded: boolean): void {
    this.#baseline = [...texts];
    this.#baselineDegraded = degraded;
    // A fresh baseline is a fresh count. Carrying the old streak across would let a frame that
    // *changed* the screen immediately be followed by a suppression on the strength of
    // similarities scored against a set that is no longer the baseline.
    this.#streak = 0;
  }

  /** Forget everything. The region or the mode changed and the old screen is not coming back. */
  reset(): void {
    this.#baseline = null;
    this.#baselineDegraded = false;
    this.#streak = 0;
  }
}

export interface SetComparison {
  /** Jaccard index over the fuzzy matching, 0..1. */
  readonly score: number;
  /** Lines in `current` that matched nothing in `baseline` - text that was not there before. */
  readonly newLines: number;
  readonly matched: number;
}

/** {@link compareSets}, reduced to its ratio. */
export function setSimilarity(
  current: readonly string[],
  baseline: readonly string[],
  threshold: number,
): number {
  return compareSets(current, baseline, threshold).score;
}

/**
 * How much two sets of lines have in common, 0..1.
 *
 * A Jaccard index over a **fuzzy** matching rather than over string equality, because the input is
 * OCR: spike S1 measured `o`/`O`, `I`/`1` and dropped spaces on text that had not changed at all,
 * and an exact-match Jaccard would score two readings of the same unchanged subtitle at 0.
 *
 * The matching is greedy and one-to-one: each baseline line can be claimed by at most one current
 * line. Without that, three near-identical lines against one baseline line would all match it and
 * the intersection could exceed either set. Greedy rather than optimal because the alternative is
 * an assignment problem solved inside a 5ms stage budget, and the cases where greedy and optimal
 * differ are sets of lines that are all near-duplicates of each other - a screen on which the
 * verdict is the same either way.
 *
 * Two empty sets score 1: nothing on screen, still nothing on screen, genuinely unchanged.
 */
export function compareSets(
  current: readonly string[],
  baseline: readonly string[],
  threshold: number,
): SetComparison {
  const a = current.map(normalizeForComparison).filter((text) => text.length > 0);
  const b = baseline.map(normalizeForComparison).filter((text) => text.length > 0);

  if (a.length === 0 && b.length === 0) return { score: 1, newLines: 0, matched: 0 };
  if (b.length === 0) return { score: 0, newLines: a.length, matched: 0 };
  if (a.length === 0) return { score: 0, newLines: 0, matched: 0 };

  const claimed = new Array<boolean>(b.length).fill(false);
  let matched = 0;

  for (const text of a) {
    let bestIndex = -1;
    let bestScore = threshold;
    for (let index = 0; index < b.length; index += 1) {
      if (claimed[index] === true) continue;
      const other = b[index];
      if (other === undefined) continue;
      const score = text === other ? 1 : similarity(text, other);
      // `>=` so a score exactly at the threshold counts, and so the first of several equal
      // candidates wins - which keeps this a pure function of the input order.
      if (score >= bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      claimed[bestIndex] = true;
      matched += 1;
    }
  }

  return { score: matched / (a.length + b.length - matched), newLines: a.length - matched, matched };
}
