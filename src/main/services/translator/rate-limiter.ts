/**
 * Per-engine pacing and backoff (issue M4-03, feature T9).
 *
 * Google's free endpoint has no published quota, and the reference project carries backoff
 * because it got throttled in practice. How hard it actually pushes back at subtitle cadence
 * is spike S3 (#44), which has not run - so **every default in this file is provisional and
 * should be replaced with the numbers that spike measures.**
 *
 * ## Two delays that behave in opposite ways
 *
 * This is the design decision in the file, and it follows from the use case: subtitles change
 * every 2-3 seconds, so a translation that arrives late is worth less than no translation at
 * all - the line it belonged to is already gone.
 *
 * - **Minimum interval — waits.** It is a small, bounded pause that keeps us from hammering the
 *   endpoint when several frames land together. Sleeping through it costs tens of milliseconds
 *   and still delivers the right text for the line on screen.
 *
 * - **Backoff — fails immediately.** After a 429 the engine is unusable for seconds. Waiting
 *   that out would hold the whole pipeline hostage to a subtitle that has already changed, so
 *   `acquire` throws `unavailable` the instant it is called inside a backoff window. The chain
 *   in `index.ts` sees a failed engine, falls through to the next one, and if they are all
 *   backing off it shows the English immediately. That is M4-03's "ระหว่าง backoff → คืนข้อความ
 *   ต้นฉบับทันที ไม่ค้างรอ", and it is why a backoff here is not implemented as a long sleep.
 *
 * ## State is per engine by construction, not by convention
 *
 * One {@link RateLimiter} holds the state of exactly one engine, and {@link withRateLimit}
 * gives each engine its own. There is no shared map keyed by name that a future caller could
 * accidentally collapse. Design doc section 7 requires that a throttled engine not affect
 * another one, and the cheapest way to guarantee that is to make sharing impossible to express.
 *
 * ## The clock is injected
 *
 * `now` and `sleep` are parameters, following `dedup.ts`, which takes `nowMs` explicitly. Timing
 * logic driven by an ambient `Date.now()` and a real `setTimeout` can only be tested by actually
 * waiting, and a test suite that waits out a 60-second backoff cap does not get written.
 */

import {
  classifyError,
  TranslationError,
  type HealthCheckResult,
  type TranslationEngine,
  type TranslationErrorKind,
} from './types.js';

/**
 * Provisional defaults - see the module comment; S3 (#44) supplies the real ones.
 *
 * The interval is well under one subtitle's lifetime, so ordinary use never touches it; it only
 * bites when frames bunch up. The first 429 pause is deliberately longer than the first network
 * pause because the two mean different things: a dropped connection is usually a blip, while a
 * 429 is the service explicitly asking for room.
 */
export const DEFAULT_MIN_INTERVAL_MS = 200;
export const DEFAULT_RATE_LIMIT_BACKOFF_MS = 2000;
export const DEFAULT_NETWORK_BACKOFF_MS = 500;
export const DEFAULT_BACKOFF_MULTIPLIER = 2;
/** One minute. Long enough to stop pestering a service, short enough that recovery is noticed. */
export const DEFAULT_MAX_BACKOFF_MS = 60_000;

export interface RateLimiterOptions {
  readonly minIntervalMs?: number;
  /** First pause after a 429. Doubles with each consecutive failure. */
  readonly rateLimitBackoffMs?: number;
  /** First pause after a transport or protocol failure. Shorter; these are usually transient. */
  readonly networkBackoffMs?: number;
  readonly backoffMultiplier?: number;
  readonly maxBackoffMs?: number;
  /** Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Defaults to a real `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RateLimiterStatus {
  readonly backingOff: boolean;
  /** Clock value at which the engine may be tried again. 0 when not backing off. */
  readonly retryAtMs: number;
  /** Remaining backoff in ms, 0 when not backing off. What M10-02 shows the user. */
  readonly remainingMs: number;
  readonly consecutiveFailures: number;
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number, got ${String(value)}`);
  }
  return value;
}

/** Pacing state for one engine. */
export class RateLimiter {
  readonly #minIntervalMs: number;
  readonly #rateLimitBackoffMs: number;
  readonly #networkBackoffMs: number;
  readonly #multiplier: number;
  readonly #maxBackoffMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  /** Clock value of the most recent dispatch (reserved, not necessarily completed yet).
   *  `-Infinity` so the first call never waits. */
  #lastDispatchAt = Number.NEGATIVE_INFINITY;
  #consecutiveFailures = 0;
  #backoffUntil = 0;
  /** Clock value at which the current backoff was opened. `-Infinity` when there has never been
   *  one, so a success always clears a limiter that has never failed. See `recordSuccess`. */
  #backoffOpenedAt = Number.NEGATIVE_INFINITY;

  constructor(options: RateLimiterOptions = {}) {
    const multiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    if (!Number.isFinite(multiplier) || multiplier < 1) {
      // Below 1 the "exponential backoff" would shrink with every failure, which reads as
      // working and behaves as the opposite.
      throw new RangeError(`backoffMultiplier must be >= 1, got ${String(multiplier)}`);
    }

    this.#minIntervalMs = positive('minIntervalMs', options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
    this.#rateLimitBackoffMs = positive(
      'rateLimitBackoffMs',
      options.rateLimitBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS,
    );
    this.#networkBackoffMs = positive(
      'networkBackoffMs',
      options.networkBackoffMs ?? DEFAULT_NETWORK_BACKOFF_MS,
    );
    this.#maxBackoffMs = positive('maxBackoffMs', options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
    this.#multiplier = multiplier;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep =
      options.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  get status(): RateLimiterStatus {
    const now = this.#now();
    const backingOff = this.#backoffUntil > now;
    return {
      backingOff,
      retryAtMs: backingOff ? this.#backoffUntil : 0,
      remainingMs: backingOff ? this.#backoffUntil - now : 0,
      consecutiveFailures: this.#consecutiveFailures,
    };
  }

  /**
   * Permission to dispatch. Resolves to the clock value this call was allowed to go out at -
   * pass it to {@link recordSuccess} so a success can be told apart from a stale one.
   *
   * Throws `unavailable` immediately if the engine is backing off; otherwise reserves the next
   * free slot and sleeps out whatever is left of the minimum interval. See the module comment
   * for why those two cases are not symmetrical.
   *
   * The slot is reserved *before* the sleep, synchronously, not after it. Two callers that both
   * read `#lastDispatchAt` before either had reserved would compute the same wait and dispatch
   * together - measured: three concurrent callers landed at [0, 200, 200] instead of
   * [0, 200, 400] with a 200ms interval. Reserving first means the second caller's `acquire`,
   * even one started microtasks later while the first is still asleep, sees the first's
   * reservation and is spaced from *that*, not from the clock value both happened to read.
   */
  async acquire(engineName: string): Promise<number> {
    const now = this.#now();

    if (this.#backoffUntil > now) {
      throw new TranslationError(
        `${engineName}: backing off for another ${String(Math.ceil(this.#backoffUntil - now))}ms`,
        { kind: 'unavailable', engine: engineName },
      );
    }

    const dispatchAt = Math.max(this.#lastDispatchAt + this.#minIntervalMs, now);
    this.#lastDispatchAt = dispatchAt;

    if (dispatchAt > now) await this.#sleep(dispatchAt - now);

    // The wait may have been long enough for a concurrent caller to fail and open a backoff
    // window in the meantime. A stale permission granted before that window opened must not be
    // honoured - the whole point of a backoff is that nothing goes out during it.
    const after = this.#now();
    if (this.#backoffUntil > after) {
      throw new TranslationError(
        `${engineName}: backing off for another ${String(Math.ceil(this.#backoffUntil - after))}ms`,
        { kind: 'unavailable', engine: engineName },
      );
    }

    return dispatchAt;
  }

  /**
   * The attempt worked. Clears the failure streak and any backoff - unless a backoff was opened
   * *after* this request was dispatched, in which case this success is stale and must not erase
   * information that is newer and worse than it: a slow success from a request sent before a
   * 429 must not cancel the backoff that 429 opened (measured: without this check, `backingOff`
   * flips true -> false and the failure streak resets to 0, so a 429 that keeps recurring never
   * escalates - each new backoff is wiped by a success that was already in flight).
   *
   * `dispatchedAt` is the value {@link acquire} resolved to for this request. It defaults to
   * the current clock so a caller that does not track it (tests, and any future direct use)
   * keeps the old always-clears behaviour, which is correct there is no concurrent request to
   * be stale relative to.
   */
  recordSuccess(dispatchedAt: number = this.#now()): void {
    if (dispatchedAt < this.#backoffOpenedAt) return;
    this.#consecutiveFailures = 0;
    this.#backoffUntil = 0;
  }

  /**
   * The attempt failed. Grows the streak and opens a backoff window.
   *
   * `unavailable` is ignored: it means `acquire` refused before anything was sent, so counting
   * it would let one real 429 compound itself every time a later frame bounced off the window
   * it created - the backoff would escalate to the cap without the service ever being asked again.
   */
  recordFailure(kind: TranslationErrorKind): void {
    if (kind === 'unavailable') return;

    this.#consecutiveFailures += 1;
    const base = kind === 'rate-limit' ? this.#rateLimitBackoffMs : this.#networkBackoffMs;
    const growth = Math.pow(this.#multiplier, this.#consecutiveFailures - 1);
    const delay = Math.min(base * growth, this.#maxBackoffMs);
    this.#backoffOpenedAt = this.#now();
    this.#backoffUntil = this.#backoffOpenedAt + delay;
  }

  /** Forget everything. For tests and for a settings change that rebuilds the chain. */
  reset(): void {
    this.#lastDispatchAt = Number.NEGATIVE_INFINITY;
    this.#consecutiveFailures = 0;
    this.#backoffUntil = 0;
    this.#backoffOpenedAt = Number.NEGATIVE_INFINITY;
  }
}

/** An engine with its pacing state exposed, so M10-02 can show the user why nothing is arriving. */
export interface RateLimitedEngine extends TranslationEngine {
  readonly limiter: RateLimiter;
  /** The engine underneath, unwrapped. */
  readonly inner: TranslationEngine;
}

/**
 * Wrap an engine so every call goes through its own {@link RateLimiter}.
 *
 * The result is still a plain {@link TranslationEngine}, so the fallback chain neither knows nor
 * cares that pacing is happening - which is what keeps `index.ts` free of retry logic.
 */
export function withRateLimit(
  engine: TranslationEngine,
  options: RateLimiterOptions | RateLimiter = {},
): RateLimitedEngine {
  const limiter = options instanceof RateLimiter ? options : new RateLimiter(options);

  return {
    name: engine.name,
    limiter,
    inner: engine,

    async translateBatch(texts: string[], src: string, tgt: string): Promise<string[]> {
      // Outside the try on purpose: a refusal here means the engine was never called, so it
      // must not be recorded as another failure by it. See `recordFailure`.
      const dispatchedAt = await limiter.acquire(engine.name);

      try {
        const results = await engine.translateBatch(texts, src, tgt);
        limiter.recordSuccess(dispatchedAt);
        return results;
      } catch (error) {
        limiter.recordFailure(classifyError(error));
        throw error;
      }
    },

    async healthCheck(): Promise<HealthCheckResult> {
      // Report the backoff rather than spending a request to rediscover it. This is the state
      // the user needs to see (design doc section 7: no failure is silent), and firing a probe
      // during a backoff window is exactly the traffic the backoff exists to prevent.
      const status = limiter.status;
      if (status.backingOff) {
        return {
          ok: false,
          detail: `backing off for another ${String(Math.ceil(status.remainingMs))}ms after ${String(status.consecutiveFailures)} consecutive failures`,
        };
      }
      return engine.healthCheck();
    },
  };
}
