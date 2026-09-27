/**
 * The one place a failure becomes something the user can read (issue M10-02 / #41, feature L5,
 * architecture invariant 4).
 *
 * Everything in this app already reports itself - into the log. A log file nobody opens is the
 * quiet half of "ไม่มีความล้มเหลวไหนที่เงียบ": the failure is recorded and the user still sees an
 * empty overlay and concludes the app is broken. This module is the other half. It collects every
 * condition worth interrupting somebody over, ranks them, and hands **one** of them to the two
 * surfaces that are actually on screen: the tray, and a banner on the overlay.
 *
 * ## Two rules the shape of this file comes from
 *
 * **A message names a cause and a remedy, never a stack trace.** {@link Alert} therefore has two
 * text fields rather than one, so neither half can be quietly dropped by a caller writing a
 * one-liner. "the translation engine could not be reached" is not actionable; adding "check your
 * connection - the original text is being shown meanwhile" is.
 *
 * **One at a time.** #41 is explicit: several conditions at once must show the worst one, not a
 * stack of them. So this is a map keyed by {@link AlertSource} - one slot per source of truth,
 * last writer for that source wins - and {@link ErrorReporter.top} picks the winner. A source
 * clears itself by writing `null`, which is what makes a transient failure disappear on its own
 * while a fatal one stays put.
 *
 * ## No alert expires. One *surface* does (#59)
 *
 * This used to say that nothing here expires an alert on a timer, because the condition and not
 * the clock decides whether it is still true. The first half is still exactly right and
 * {@link ErrorReporter.top} still obeys it: an alert leaves the map when its source says the
 * condition ended, and never because time passed. The tray tooltip, the tray menu row and the
 * settings window read that, so what the user can go and *look up* is unchanged.
 *
 * What the second half missed is that one of the two surfaces charges rent. The overlay banner
 * sits on top of whatever the user is reading, and the overlay is click-through, so there is no
 * gesture that dismisses it - #59 is a banner that stood for an entire session over a condition
 * whose remedy was impossible to follow. A message that cannot be acted on and cannot be closed
 * stops being information and becomes an obstruction.
 *
 * So {@link ErrorReporter.banner} is a second, *narrower* view of the same one alert:
 * `warning` and `info` stop being drawn after {@link DEFAULT_BANNER_TIMEOUT_MS}; `error` and
 * `fatal` are drawn until their source clears them, because those are the ones where continuing
 * to look at a working-looking screen is the actual harm. An alert may also opt out with
 * {@link Alert.sticky}. Nothing is forgotten in either case - invariant 4 is about the user being
 * able to find out, and the tray still says it.
 *
 * The clock is injected ({@link ErrorReporterOptions.schedule}) for the same reason it is
 * everywhere else in this codebase: a test that waits eight real seconds is a test nobody runs.
 *
 * ## The budget is cumulative per occurrence, not per turn on top (#88)
 *
 * This used to say a warning displaced by something worse "gets a full turn if it comes back" -
 * that was wrong, and a real run is why: a `region` edge warning flapping on and off every few
 * seconds displaced a standing `hotkeys` caution underneath it, and every single time the caution
 * came back on top it was granted a fresh {@link DEFAULT_BANNER_TIMEOUT_MS}, because it had never
 * been on screen long enough at a stretch to actually spend one. The result was a caution that
 * had, in effect, no budget at all - drawn for as long as the process ran - and a log line for it
 * repeating every time its flapping neighbour stepped aside, which is what a user actually saw as
 * the banner "not stopping".
 *
 * The fix is that {@link DEFAULT_BANNER_TIMEOUT_MS} is spent **in total across every stretch an
 * occurrence is drawn**, not reset by being covered up. Being displaced pauses the clock rather
 * than refunding it; returning to the top slot resumes with whatever is left, and once the total
 * is gone the message does not come back - {@link ErrorReporter.top} still has it, but
 * {@link ErrorReporter.banner} does not draw it again. What still resets the budget, unchanged
 * from before, is the message actually leaving {@link ErrorReporter.alerts} - a condition that
 * cleared and later came back is news again, exactly as #59 always intended, and gets a fresh
 * {@link DEFAULT_BANNER_TIMEOUT_MS} and a fresh log line.
 *
 * The same "once per occurrence, not once per turn on top" rule applies to the `user-facing
 * alert` log line, and it applies to **every severity**, `error` and `fatal` included: logged
 * when the occurrence starts (or genuinely restarts after clearing), not every time displacing it
 * ends. Gating that to only `warning`/`info` would leave an `error` standing under a flapping
 * higher-ranked alert relogging on every displacement - #88's bug by another name, just one
 * severity up.
 *
 * What *is* still different for `error`, `fatal` and a `sticky` alert - and only this - is the
 * banner: {@link #bannerFor} never times it out regardless of how long it has been drawn, because
 * those are the cases where continuing to look at a working-looking screen is the actual harm
 * (see "No alert expires" above). The budget and the log-dedup are the same mechanism
 * ({@link #occurrences}) for every severity; only the timeout check reads severity at all.
 *
 * ## A logger that arrives late does not lose what happened before it (#62)
 *
 * `index.ts` constructs this class at module scope, before `createLogger` has resolved - see
 * that file's own comment on why. Until now that meant every alert this class raised for the
 * rest of the process's life went to {@link nullLogger}, because the constructor's `logger`
 * option was never supplied: the two log lines {@link ErrorReporter.set} produces on a `top`
 * change - `'all clear'` and `'user-facing alert'` - simply never reached a file. The tray, the
 * banner and the settings window were all unaffected, because none of them read `#log`; only the
 * log file was the gap, and it was the entire gap #41 exists to close on the log's side.
 *
 * {@link ErrorReporter.attachLogger} closes it without moving the construction. Every log line
 * that would have been written before a logger exists is held in a small ring instead of being
 * dropped, and `attachLogger` replays it, in order, into the logger it is given. Two things that
 * makes safe: it is **idempotent** (a second call is a no-op, so nothing can double-flush or
 * re-buffer once a real logger is attached), and it is **bounded**
 * ({@link ERROR_REPORTER_LOG_BUFFER_LIMIT}) so that `bootstrap` throwing before it ever calls
 * `attachLogger` leaves a small, fixed amount of memory behind rather than an unbounded one.
 *
 * ## Pure, and Electron-free
 *
 * The `describe*` functions take plain data and return text. That is what lets #41's real
 * requirement - "does the user see the right message" - be tested without a tray, a window, or a
 * running sidecar, and it is why the wiring in `index.ts` stays declarative.
 */

import type { HotkeyCaution } from '../../shared/accelerator.js';
import { DISMISS_LABEL, MODE_NAMES } from '../../shared/mode-presentation.js';
import type { ConfigIssue } from './config.js';
import type { HotkeyRegistration } from './hotkey-service.js';
import { nullLogger, type LogFields, type Logger } from './logger.js';
import type { SupervisorStatus } from './sidecar-supervisor.js';
import type { EngineFailure } from './translator/index.js';

/**
 * How badly the user is being let down, and therefore what beats what.
 *
 *   - `fatal`   - the app cannot do its job and will not recover on its own. Stays until fixed.
 *   - `error`   - something is broken now; it may recover.
 *   - `warning` - it is working, and the result is probably not what the user wanted.
 *   - `info`    - a transient state worth naming so silence is not mistaken for a fault.
 */
export type AlertSeverity = 'fatal' | 'error' | 'warning' | 'info';

const SEVERITY_RANK: Record<AlertSeverity, number> = { fatal: 3, error: 2, warning: 1, info: 0 };

/**
 * Where an alert came from. One slot each, so a source that fires repeatedly replaces its own
 * message instead of piling up.
 *
 * The order is the tie-break for equal severities, and it ranks **how much of the app is broken**
 * rather than how alarming the wording is - the same principle `AppStatus.warning` uses for its
 * own three. Top to bottom: nothing can work (`ocr`), nothing is being captured (`sidecar`), every
 * frame is being dropped (`monitor`), the mode machine reported a failure (`capture`), text is on
 * screen but untranslated (`translation`), the region is wrong or finding nothing (`region`),
 * settings fell back to defaults (`config`), one shortcut does not work (`hotkeys`).
 *
 * `hotkeys` is last, and a real run is why it moved: it and the #50 idle warning are both
 * `warning`, and with `hotkeys` ranked first the banner spent the session saying a shortcut was
 * taken while nothing at all was reaching the screen.
 */
export const ALERT_SOURCES = [
  'ocr',
  'sidecar',
  'monitor',
  'capture',
  'translation',
  'region',
  'config',
  'hotkeys',
] as const;

export type AlertSource = (typeof ALERT_SOURCES)[number];

export interface Alert {
  readonly source: AlertSource;
  readonly severity: AlertSeverity;
  /** What went wrong, in the user's terms. No codes, no stack traces. */
  readonly cause: string;
  /** What to do about it. Required - an alert without one is a complaint. */
  readonly remedy: string;
  /**
   * Keep this on the overlay banner until its source clears it, whatever its severity (#59).
   *
   * Severity answers "how badly is the user being let down". This answers a different question:
   * "is this a condition that happened, or a state the app is resting in". A `warning` normally
   * stops being drawn after {@link DEFAULT_BANNER_TIMEOUT_MS} on the reasoning that the user has
   * read it and the tray still holds it - which is right for something that came and went, and
   * wrong for a setup step that has not been done. #51's "no capture region has been chosen" is
   * the second kind: the app is deliberately sitting still, the banner is the only thing on
   * screen saying why, and timing it out would restore the silence #51 was filed to end.
   *
   * **Opt-in, per alert, and defaulted off**, which is the point of it being a field rather than
   * a rule about severities or sources: nothing can inherit the exemption by resembling the alert
   * that has it, and the only way to acquire it is a caller writing `sticky: true` next to a
   * reason for doing so. There is one such caller today: `describeAppWarning` in
   * `app-orchestrator.ts`, which is also the file that owns the text it keys on.
   */
  readonly sticky?: boolean;
}

/**
 * Cause and remedy as one line, for the tray tooltip and the log.
 *
 * Takes the two text fields rather than a whole {@link Alert} so the `describe*` builders below -
 * which return an alert that has not been assigned a source yet - can be passed straight in.
 */
export function describeAlert(alert: Pick<Alert, 'cause' | 'remedy'>): string {
  return `${alert.cause} — ${alert.remedy}`;
}

/**
 * How long a `warning` or `info` covers the overlay before it stops being drawn (#59).
 *
 * Long enough to read twice - the banner carries two sentences, and a user whose eyes are on a
 * subtitle needs a moment to notice it arrived at all. Short enough that it is gone before the
 * next few lines of dialogue, which is the thing #59 is about: the alert is not urgent (it is a
 * `warning` by definition) and the screen belongs to what the user came here to read.
 */
export const DEFAULT_BANNER_TIMEOUT_MS = 8_000;

/**
 * How many pre-{@link ErrorReporter.attachLogger} log lines are held (#62).
 *
 * There are {@link ALERT_SOURCES.length} sources, each producing at most one buffered line per
 * distinct wording before the log exists - an ordinary boot does not come close to this. The
 * bound exists for the path where it matters, not the path where it is used: `bootstrap` throwing
 * before it ever calls `attachLogger` leaves this many lines in memory and not one more, rather
 * than an unbounded amount. Lines past the limit are dropped - the earliest ones are kept, not the
 * latest, because the earliest is the one a failure this early in the process most needs on
 * record.
 */
export const ERROR_REPORTER_LOG_BUFFER_LIMIT = 32;

/** Cancels a pending banner timeout. Calling it after the timeout fired must be harmless. */
export type CancelTimer = () => void;

/**
 * Runs `handler` after `delayMs`. Injected so the banner's lifecycle is testable in plain Node.
 */
export type ScheduleTimer = (handler: () => void, delayMs: number) => CancelTimer;

/**
 * Milliseconds since some fixed point, for measuring how long an occurrence has actually spent
 * drawn on the banner (#88). Injected for the same reason {@link ScheduleTimer} is: a test that
 * measures a cumulative budget by waiting for wall-clock time to pass is a test nobody runs.
 *
 * Deliberately never consulted on a timeout firing - see {@link ErrorReporter}'s `#expireBanner`
 * for why reading the clock there instead of marking the occurrence exhausted directly would give
 * the wrong answer under exactly the fake schedule this module's own tests use.
 */
export type Clock = () => number;

function scheduleWithTimeout(handler: () => void, delayMs: number): CancelTimer {
  const timer = setTimeout(handler, delayMs);
  // A banner that is about to hide itself must never be the reason the process is still alive:
  // this timer can be pending when the user quits, and `app.quit()` waiting eight seconds for a
  // cosmetic countdown would look like a hang.
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
}

export interface ErrorReporterOptions {
  readonly logger?: Logger;
  /** How long a non-severe alert stays on the overlay banner. See {@link DEFAULT_BANNER_TIMEOUT_MS}. */
  readonly bannerTimeoutMs?: number;
  /** Fires the banner timeout. Tests pass one they can fire by hand. */
  readonly schedule?: ScheduleTimer;
  /** Measures elapsed banner time for the cumulative budget (#88). Defaults to {@link Date.now}. */
  readonly now?: Clock;
}

/** One line {@link ErrorReporter} would have logged, held until {@link ErrorReporter.attachLogger}. */
interface BufferedLogLine {
  readonly level: 'info' | 'warn';
  readonly message: string;
  readonly fields?: LogFields;
}

export class ErrorReporter {
  #log: Logger;
  readonly #alerts = new Map<AlertSource, Alert>();
  readonly #listeners = new Set<(top: Alert | null) => void>();
  readonly #bannerTimeoutMs: number;
  readonly #schedule: ScheduleTimer;
  readonly #now: Clock;
  /**
   * Per-occurrence bookkeeping, keyed by severity+cause (#59, #88) - one entry for exactly as long
   * as a message stays asserted anywhere in {@link #alerts}, for every severity.
   *
   * Keyed by the *message* rather than by source, because that is the unit the user experiences:
   * a source re-asserting the same words is the same occurrence they already read, and a source
   * changing its wording is news, same as before #88. What #88 adds is two fields. `spentMs` is
   * the total time this occurrence has actually spent drawn on the banner, charged in
   * {@link #retime} whenever the banner stops showing it (displaced or exhausted) rather than
   * reset by the displacement - see the module doc for the bug this replaces. It is only ever
   * read for a non-sticky `warning`/`info`: `error`, `fatal` and `sticky` alerts never auto-hide,
   * so nothing consults it for them, even though an entry exists. `logged` is whether
   * `user-facing alert` has already been written for this occurrence - read for every severity, so
   * regaining the top slot after being displaced does not re-log any of them.
   *
   * Both fields die with the entry: pruned in {@link #recompute} the instant nothing asserts this
   * message any more, which is what makes "fixed and come back" a fresh entry - fresh budget,
   * fresh log line - rather than a resumption of the one that just ended.
   */
  readonly #occurrences = new Map<string, { spentMs: number; logged: boolean }>();
  /** The key the pending timeout belongs to, or `null` when nothing is being timed. */
  #timing: string | null = null;
  /** When `#timing` started being drawn, per {@link #now}. `null` exactly when `#timing` is. */
  #timingStartedAt: number | null = null;
  #cancelTimer: CancelTimer | null = null;
  #top: Alert | null = null;
  #banner: Alert | null = null;
  /**
   * Whether {@link #log} is a real logger. `true` from the constructor when one was supplied
   * there; flipped exactly once, by {@link attachLogger}. Gates {@link #logLine} between writing
   * immediately and buffering (#62).
   */
  #logAttached: boolean;
  /** Held log lines, oldest first. See {@link ERROR_REPORTER_LOG_BUFFER_LIMIT}. */
  readonly #logBuffer: BufferedLogLine[] = [];

  constructor(options: ErrorReporterOptions = {}) {
    this.#logAttached = options.logger !== undefined;
    this.#log = (options.logger ?? nullLogger()).child('alerts');
    this.#bannerTimeoutMs = options.bannerTimeoutMs ?? DEFAULT_BANNER_TIMEOUT_MS;
    this.#schedule = options.schedule ?? scheduleWithTimeout;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Give the reporter its real logger, and flush whatever it logged before it had one (#62).
   *
   * `index.ts` calls this the moment its own logger exists - see the module doc for what that
   * closes. Every line this class would have logged up to now was instead appended to
   * {@link #logBuffer}; this replays them, in order, into `logger.child('alerts')` before letting
   * any future line through directly.
   *
   * **Idempotent, by design rather than by accident.** There is exactly one `RootLogger` per
   * process, so a second call - whether from a caller invoking this twice or a test exercising
   * both the unattached and the attached path against one instance - is a no-op: the first logger
   * given keeps every line, both the buffered ones and everything since, and a second one supplied
   * later is simply never used. Never calling this at all is equally harmless: the reporter keeps
   * computing `top`, `banner` and `alerts` and keeps notifying subscribers exactly as before -
   * logging was always the one thing that depended on this, nothing else did.
   */
  attachLogger(logger: Logger): void {
    if (this.#logAttached) return;
    this.#logAttached = true;
    this.#log = logger.child('alerts');
    for (const line of this.#logBuffer) {
      if (line.level === 'info') this.#log.info(line.message, line.fields);
      else this.#log.warn(line.message, line.fields);
    }
    this.#logBuffer.length = 0;
  }

  /**
   * The single alert the user should be told about, or `null` when everything is fine.
   *
   * **Not affected by the banner timeout.** This is what the tray tooltip, the tray menu and the
   * settings window read, and it stands until its source clears it - see the module doc.
   */
  get top(): Alert | null {
    return this.#top;
  }

  /**
   * The same alert, filtered to what should currently be *drawn over the screen* (#59).
   *
   * `null` while {@link top} is not, once a `warning` or `info` has had its time on the banner.
   * That is not the alert ending; it is the alert giving the screen back.
   */
  get banner(): Alert | null {
    return this.#banner;
  }

  /** Everything currently standing, worst first. For the settings window (#39) when it exists. */
  get alerts(): readonly Alert[] {
    return [...this.#alerts.values()].sort(compareAlerts);
  }

  /**
   * Publish, or clear, one source's condition.
   *
   * Callers pass `null` the moment their condition stops being true; nothing here guesses. A
   * frame arriving is what clears a capture error, a non-degraded payload is what clears a
   * translation error, and a fatal alert is simply never cleared by anything short of the fix.
   */
  set(source: AlertSource, alert: Omit<Alert, 'source'> | null): void {
    const before = this.#alerts.get(source);
    if (alert === null) {
      if (before === undefined) return;
      this.#alerts.delete(source);
    } else {
      if (before !== undefined && before.severity === alert.severity && before.cause === alert.cause) {
        // Same condition, same wording. Re-notifying would rewrite the tray tooltip and re-log on
        // every frame of a sustained outage, which is exactly the noise that trains a user to stop
        // reading warnings.
        return;
      }
      this.#alerts.set(source, { ...alert, source });
    }
    this.#recompute();
  }

  subscribe(listener: (top: Alert | null) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------

  #recompute(): void {
    const standing = this.alerts;
    const next = standing[0] ?? null;
    const topChanged = !isSameMessage(next, this.#top);
    this.#top = next;

    // A message nobody is asserting any more has no occurrence worth keeping - neither a banner
    // budget nor a "have I logged this" flag. A condition that was fixed and has come back is
    // news again, and showing it (and logging it) again is the honest reading of "the clock does
    // not decide whether it is still true" (#59, #88).
    //
    // Tracked for every severity, not only the ones the banner ever times out: "logged when a
    // condition starts, not every time it regains the top slot" is one rule, and an `error` or
    // `fatal` standing under a flapping higher-ranked alert reproduces #88's log cadence exactly
    // as a `warning` does if this were gated to the auto-hiding population. `spentMs` still only
    // means anything for that population - `#bannerFor` and `#retime` never consult it for
    // anything else, since `error`/`fatal`/sticky never auto-hide regardless of what it holds.
    const live = new Set(standing.map(messageKey));
    for (const key of [...this.#occurrences.keys()]) {
      if (!live.has(key)) this.#occurrences.delete(key);
    }
    for (const alert of standing) {
      const key = messageKey(alert);
      if (!this.#occurrences.has(key)) this.#occurrences.set(key, { spentMs: 0, logged: false });
    }

    const banner = this.#bannerFor(next);
    const bannerChanged = !isSameMessage(banner, this.#banner);
    this.#banner = banner;
    this.#retime();

    // Logged on the alert changing, never on the banner hiding: a hide is not a new condition,
    // and a second line for it would read in the log exactly like the alert firing twice.
    //
    // "Changing" means the *occurrence* starting (or genuinely restarting after clearing), not
    // merely regaining the top slot - for every severity, `error` and `fatal` included. That is
    // one rule applied uniformly, not two: gating it to only `warning`/`info` would leave an
    // `error` standing under a flapping higher-ranked alert relogging on every displacement,
    // which is #88's bug by another name. The one thing that stays different for `error`,
    // `fatal` and a `sticky` alert is the banner itself - see `#bannerFor` - never this.
    if (topChanged) {
      if (next === null) {
        this.#logLine('info', 'all clear');
      } else {
        const occurrence = this.#occurrences.get(messageKey(next));
        if (occurrence === undefined || !occurrence.logged) {
          this.#logLine('warn', 'user-facing alert', {
            source: next.source,
            severity: next.severity,
            text: describeAlert(next),
          });
          if (occurrence !== undefined) occurrence.logged = true;
        }
      }
    }

    if (!topChanged && !bannerChanged) return;

    for (const listener of [...this.#listeners]) {
      try {
        listener(next);
      } catch (error) {
        this.#log.error('an alert listener threw', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Write one of the two lines {@link #recompute} produces on a `top` change - or hold it, when
   * nothing has called {@link attachLogger} yet (#62).
   *
   * The listener-threw line above does not go through this: it is not part of what an alert set
   * before the logger exists needs preserved, and buffering it would hold onto an `Error`'s
   * message for longer than the bound below can promise to keep it, for a condition (a subscriber
   * throwing) unrelated to what #62 is about.
   */
  #logLine(level: 'info' | 'warn', message: string, fields?: LogFields): void {
    if (this.#logAttached) {
      if (level === 'info') this.#log.info(message, fields);
      else this.#log.warn(message, fields);
      return;
    }
    if (this.#logBuffer.length < ERROR_REPORTER_LOG_BUFFER_LIMIT) this.#logBuffer.push({ level, message, fields });
  }

  /**
   * What should actually be drawn: `next`, unless it is a non-sticky `warning`/`info` occurrence
   * that has already spent its whole {@link DEFAULT_BANNER_TIMEOUT_MS} across every stretch it has
   * been drawn, displacements included (#59, #88).
   */
  #bannerFor(next: Alert | null): Alert | null {
    if (next === null || !autoHidesFromBanner(next)) return next;
    const spent = this.#occurrences.get(messageKey(next))?.spentMs ?? 0;
    return spent < this.#bannerTimeoutMs ? next : null;
  }

  /**
   * Keep the pending timeout pointed at whatever the banner is showing now, and charge the
   * occurrence that was showing before for the time it actually spent on screen (#59, #88).
   *
   * One timer at a time, owned by the displayed message. The case that forces that: a warning
   * appears, an `error` displaces it three seconds later, and the original timeout is still in
   * flight - left running, it would fire while a *different* message is on screen and blank a
   * banner that had been up for three seconds. What #88 changes is what happens to those three
   * seconds: they are added to the occurrence's `spentMs` rather than discarded, so a warning
   * displaced for twenty seconds and then uncovered resumes with five seconds left, not a fresh
   * eight - and a `region` warning that keeps flapping every few seconds no longer hands the
   * `hotkeys` caution underneath it an endless series of fresh turns, which is the bug #88 was
   * filed over. See the module doc for the full account.
   *
   * A banner that has not changed keeps its running timer untouched and nothing is charged - that
   * is what makes the budget mean "eight seconds actually drawn" rather than "eight seconds since
   * the last frame that re-asserted this" - and re-assertion is constant, since the condition
   * behind a warning is usually true on every frame. Two guards upstream already absorb most of it
   * ({@link set} returns early for an identical message from the same source, and
   * `AppOrchestrator` dedupes its warning text before that), and this is the one that has to hold
   * when they do not.
   */
  #retime(): void {
    const banner = this.#banner;
    const wanted = banner !== null && autoHidesFromBanner(banner) ? messageKey(banner) : null;
    if (wanted === this.#timing) return;

    if (this.#timing !== null && this.#timingStartedAt !== null) {
      const occurrence = this.#occurrences.get(this.#timing);
      if (occurrence !== undefined) occurrence.spentMs += Math.max(0, this.#now() - this.#timingStartedAt);
    }
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#timing = null;
    this.#timingStartedAt = null;
    if (wanted === null) return;

    const spent = this.#occurrences.get(wanted)?.spentMs ?? 0;
    const remaining = this.#bannerTimeoutMs - spent;
    // `#bannerFor` already turns an exhausted occurrence into a `null` banner before `wanted`
    // could ever be computed from it, so this is unreachable in practice - kept as a guard rather
    // than an assumption, because "schedule a non-positive timeout" is a worse failure than a
    // no-op.
    if (remaining <= 0) return;

    this.#timing = wanted;
    this.#timingStartedAt = this.#now();
    this.#cancelTimer = this.#schedule(() => {
      this.#expireBanner(wanted);
    }, remaining);
  }

  #expireBanner(key: string): void {
    // A timeout that fired after being superseded has nothing to say about what is on screen now.
    if (this.#timing !== key) return;
    this.#timing = null;
    this.#timingStartedAt = null;
    this.#cancelTimer = null;
    // Marked exhausted directly, not derived from `#now() - startedAt`: this timer already ran
    // for exactly this occurrence's remaining budget by construction (see `#retime`), and reading
    // the clock again here would read close to zero elapsed under a fake `schedule` that fires
    // handlers without ever advancing a clock - which is what most of this file's own tests do.
    const occurrence = this.#occurrences.get(key);
    if (occurrence !== undefined) occurrence.spentMs = this.#bannerTimeoutMs;
    // Recomputed rather than assigning `#banner = null` directly, so the hide travels the same
    // path and reaches the same listeners as every other change to what the user sees.
    this.#recompute();
  }
}

/**
 * Whether this alert gives the screen back on its own (#59).
 *
 * `error` and `fatal` never do. The harm they name is that the app looks like it is working when
 * it is not, and a banner the user has stopped seeing is how that starts.
 */
function autoHidesFromBanner(alert: Alert): boolean {
  if (alert.sticky === true) return false;
  return alert.severity === 'warning' || alert.severity === 'info';
}

/** Two alerts the user could not tell apart on screen. */
function isSameMessage(a: Alert | null, b: Alert | null): boolean {
  if (a === null || b === null) return a === b;
  return a.severity === b.severity && a.cause === b.cause;
}

/** {@link isSameMessage} as a string, for the timed-out set. */
function messageKey(alert: Alert): string {
  // Newline-separated because `severity` is one of four fixed words and cannot contain one, so
  // no cause can forge a different severity's key.
  return `${alert.severity}\n${alert.cause}`;
}

/**
 * What each surface should be showing right now (#41, #59).
 *
 * Pure, and separate from `index.ts`'s `renderStatus`, because the thing worth pinning in a test
 * is exactly this split: **the tray reads {@link ErrorReporter.top} and the overlay reads
 * {@link ErrorReporter.banner}**. Wired the other way round, or wired to one of them twice, the
 * app would either keep obstructing the screen or lose the message entirely once the banner
 * timed out - and the second is invariant 4 broken by the fix for #59.
 *
 * Takes the two views rather than the reporter itself so a test can hand it a pair of literals,
 * and so nothing here can accidentally reach for a third piece of state.
 */
export interface AlertSurfaces {
  /** The tray's `error` slot - the one that turns the icon red. */
  readonly trayError: string | null;
  /** The tray's `warning` slot - the tooltip and a disabled menu row. */
  readonly trayWarning: string | null;
  /** What the overlay banner draws, or `null` for nothing. */
  readonly overlayAlert: Pick<Alert, 'severity' | 'cause' | 'remedy'> | null;
}

export function alertSurfaces(views: {
  readonly top: Alert | null;
  readonly banner: Alert | null;
}): AlertSurfaces {
  const { top, banner } = views;
  const severe = top !== null && (top.severity === 'fatal' || top.severity === 'error');
  return {
    trayError: severe && top !== null ? describeAlert(top) : null,
    trayWarning: !severe && top !== null ? describeAlert(top) : null,
    overlayAlert:
      banner === null ? null : { severity: banner.severity, cause: banner.cause, remedy: banner.remedy },
  };
}

function compareAlerts(a: Alert, b: Alert): number {
  const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (bySeverity !== 0) return bySeverity;
  return ALERT_SOURCES.indexOf(a.source) - ALERT_SOURCES.indexOf(b.source);
}

// ---------------------------------------------------------------------------
// The messages
// ---------------------------------------------------------------------------

/**
 * The sidecar's supervision state, as something the user can act on (#40 + #41 row 2).
 *
 * `backoff` is deliberately `info` and not an error: the app is in the middle of fixing itself,
 * and the honest message is how long that will take. `gave-up` is `error` rather than `fatal`
 * because the tray offers a retry - a fatal alert claims there is nothing the user can do from
 * here, and here there is.
 */
export function describeSupervisor(
  status: SupervisorStatus,
  context: { readonly nowMs: number; readonly logDirectory: string | null },
): Omit<Alert, 'source'> | null {
  switch (status.state) {
    case 'backoff': {
      const seconds = Math.max(1, Math.ceil(((status.retryAtMs ?? context.nowMs) - context.nowMs) / 1000));
      return {
        severity: 'info',
        cause: 'the screen capture engine stopped and Textlens is restarting it',
        remedy: `retrying in about ${String(seconds)}s — the last translations stay on screen until it is back`,
      };
    }
    case 'gave-up':
      return {
        severity: 'error',
        cause: 'the screen capture engine keeps failing, so Textlens has stopped restarting it',
        // The action comes **first**, and the log path last. The overlay banner clips a long
        // remedy from the right, and a real run showed the old wording losing the only sentence
        // the user can act on to a `%APPDATA%` path that is nine tenths boilerplate.
        remedy:
          context.logDirectory === null
            ? 'use the tray menu → "Restart capture engine" once the cause is fixed'
            : `use the tray menu → "Restart capture engine", or see the log in ${context.logDirectory}`,
      };
    case 'stopped':
      // `not-wanted` is the paused case, which is exactly what the user asked for and needs no
      // message at all. Anything else stopped is worth naming, because nothing is capturing.
      if (status.reason === 'not-wanted' || status.reason === 'manual' || status.reason === 'initial') return null;
      return {
        severity: 'error',
        cause: 'the screen capture engine is not running',
        remedy: 'use the tray menu → "Restart capture engine"',
      };
    case 'starting':
    case 'running':
    case 'disposed':
      return null;
    default: {
      const unhandled: never = status.state;
      void unhandled;
      return null;
    }
  }
}

/**
 * Why the overlay is showing English (#41 row 3).
 *
 * The whole point of the row is that "ไม่มีเน็ต / โดน rate limit / config ผิด" are three different
 * situations with three different things for the user to do, and the difference is already in
 * `EngineFailure.kind` - it just never reached anybody. `rate-limit` outranks the rest because it
 * is the one that resolves by waiting rather than by acting.
 */
export function describeTranslationFailure(failures: readonly EngineFailure[]): Omit<Alert, 'source'> {
  const kinds = new Set(failures.map((failure) => failure.kind));

  if (kinds.has('rate-limit')) {
    return {
      severity: 'warning',
      cause: 'the translation service is rate-limiting Textlens, so the original text is showing',
      remedy: 'it backs off and retries by itself; translations resume once the limit clears',
    };
  }
  if (kinds.has('network')) {
    return {
      severity: 'error',
      cause: 'no translation service could be reached, so the original text is showing',
      remedy: 'check your internet connection or proxy — Textlens retries automatically',
    };
  }
  if (kinds.has('protocol')) {
    return {
      severity: 'error',
      cause: 'the translation service answered in a form Textlens does not understand',
      remedy: 'the service may have changed; check for an update and see the log for detail',
    };
  }
  if (kinds.has('unavailable')) {
    // `unavailable` means the chain did not even try, because an earlier failure put every engine
    // into backoff - so during a sustained outage this is the kind almost every frame reports.
    // The wording has to be true of that case as well as of a two-second blip, which is why it
    // does not promise this clears by itself.
    return {
      severity: 'warning',
      cause: 'every translation engine is backing off after a failure, so the original text is showing',
      remedy: 'Textlens retries by itself; if it does not clear, check your internet connection or proxy',
    };
  }
  return {
    severity: 'error',
    cause: 'the text could not be translated, so the original is showing',
    remedy: 'see the log for which engine failed and why',
  };
}

/** What one payload says about the translation alert. See {@link judgeTranslation}. */
export type TranslationVerdict =
  | { readonly kind: 'set'; readonly alert: Omit<Alert, 'source'> }
  | { readonly kind: 'clear' }
  | { readonly kind: 'keep' };

/**
 * Decide what a payload means for the translation alert, without touching the reporter.
 *
 * The subtlety, and a real bug before it was written down: **a payload that needed no engine is
 * not evidence the engine recovered.** Every frame whose text is already cached comes back
 * `complete`, `degraded: false`, `engine: null` - and clearing on that made the message flicker
 * on and off roughly once a second through a genuine outage, which is worse than not showing it.
 * Only a payload an engine actually answered clears it.
 *
 * The progressive first half (`complete: false`) is cache hits alone and can never be degraded,
 * so it says nothing either way.
 */
export function judgeTranslation(payload: {
  readonly complete: boolean;
  readonly degraded: boolean;
  readonly engine: string | null;
  readonly failures: readonly EngineFailure[];
}): TranslationVerdict {
  if (!payload.complete) return { kind: 'keep' };
  if (payload.degraded) return { kind: 'set', alert: describeTranslationFailure(payload.failures) };
  if (payload.engine === null) return { kind: 'keep' };
  return { kind: 'clear' };
}

/**
 * The OCR language pack (#41 row 1, feature O8, spike S1).
 *
 * Fatal, and the only alert here that is: without a recognizer for the source language nothing in
 * this app can produce a single word, and no amount of waiting changes that. The remedy is the
 * whole value of the message - "install the language pack" is useless without the path through
 * Settings, because the OCR pack is a *feature* of a language, not the language itself.
 */
export function describeMissingRecognizer(
  wanted: string,
  available: readonly string[],
): Omit<Alert, 'source'> | null {
  if (matchesLanguage(wanted, available)) return null;
  return {
    severity: 'fatal',
    cause: `Windows has no OCR recognizer for ${wanted}, so no text can be read from the screen`,
    remedy:
      'install it in Windows Settings → Time & language → Language & region → '
      + `${wanted} → Language options → Optional features → Add "Optional OCR"`
      + (available.length === 0 ? '' : ` (installed: ${available.join(', ')})`),
  };
}

/**
 * Whether one of the installed recognizers covers the requested tag.
 *
 * Prefix-matched on the primary subtag rather than compared exactly: Windows reports `en-US` on one
 * machine and `en-GB` on another, and refusing to read English because the pack is British would be
 * a fatal alert for a working configuration.
 */
function matchesLanguage(wanted: string, available: readonly string[]): boolean {
  const primary = wanted.split('-')[0]?.toLowerCase() ?? wanted.toLowerCase();
  return available.some((tag) => (tag.split('-')[0]?.toLowerCase() ?? tag.toLowerCase()) === primary);
}

/** {@link HotkeyRegistration.action} in the words the settings window already uses for it (#82). */
const HOTKEY_ACTION_LABELS: Record<HotkeyRegistration['action'], string> = {
  toggleAuto: `${MODE_NAMES.auto} on/off`,
  snapshot: MODE_NAMES.once,
  selectRegion: 'select a region',
  toggleOverlay: 'show/hide the boxes',
  dismiss: DISMISS_LABEL,
};

/**
 * Hotkeys that did not bind (#32's own criterion, surfaced at last).
 *
 * **`conflict` and `duplicate` must not share a message**, and that is the entire reason this
 * function is not a one-liner. Electron's `register` returns `false` both when another program
 * owns the key and when we asked for the same key twice, and `hotkey-service.ts` is what tells
 * them apart. Sending a user hunting for a nonexistent third-party program because they typed the
 * same accelerator into two fields of their own config file is a message that costs more time than
 * it saves.
 *
 * **Takes every registration, not only the failed ones (#82).** A real failure still wins the
 * single `hotkeys` alert slot outright - the branch below returns before {@link describeHotkeyCaution}
 * is ever reached - but a registration that *succeeded* can still carry a {@link HotkeyCaution}, and
 * this is the one place both are weighed against each other. Passing only the failed subset, as the
 * caller did before #82, makes every caution invisible: there is nothing to see it in.
 */
export function describeHotkeyFailures(
  registrations: readonly HotkeyRegistration[],
): Omit<Alert, 'source'> | null {
  const relevant = registrations.filter((registration) => !registration.ok && registration.reason !== 'disabled');
  if (relevant.length === 0) return describeHotkeyCaution(registrations);

  const first = relevant[0];
  if (first === undefined) return null;
  const more = relevant.length > 1 ? ` (and ${String(relevant.length - 1)} more)` : '';
  const key = first.accelerator ?? 'a shortcut';
  // **Not the config file path any more (#39).** Every one of these used to end in "under
  // "hotkeys" in C:\...\config.json", which was the only honest advice available while there was
  // no other way to rebind - and it walked the user straight into the two traps this app has
  // already been bitten by: Notepad and PowerShell 5.1 write a UTF-8 BOM that makes `JSON.parse`
  // reject a perfectly valid file, and a misspelled modifier is silently dropped by Electron so
  // `Contrl+Alt+A` binds `Alt+A` while reporting success. The settings window captures a real
  // keystroke and probes it before saving, so it cannot produce either. An alert that still
  // pointed at the file would be the app recommending the failure mode it just fixed.
  const where = 'the tray menu → "Settings…", under "Shortcuts"';

  switch (first.reason) {
    case 'duplicate':
      return {
        severity: 'warning',
        cause: `the "${first.action}" shortcut ${key} is bound to two Textlens actions at once${more}`,
        remedy: `give one of them a different key in ${where}`,
      };
    case 'conflict':
      return {
        severity: 'warning',
        cause: `another program already owns ${key}, so the "${first.action}" shortcut does nothing${more}`,
        remedy: `close that program, or pick a different key for "${first.action}" in ${where}`,
      };
    case 'invalid':
      return {
        severity: 'warning',
        cause: `"${key}" is not a shortcut Windows can register, so "${first.action}" is unbound${more}`,
        remedy: `press a new one in ${where}`,
      };
    default:
      return {
        severity: 'warning',
        cause: `the "${first.action}" shortcut could not be registered${more}`,
        remedy: `rebind it in ${where}`,
      };
  }
}

/**
 * A registration that worked exactly as configured, and also captures a key someone types every
 * day (#82). Only ever consulted by {@link describeHotkeyFailures} once it has confirmed there is
 * no real failure standing - a shortcut that does nothing is a worse problem than one that works
 * too well, and the single `hotkeys` alert slot can only hold one message at a time.
 *
 * Unlike a real failure's remedy, this one does not need to steer the user away from `config.json`
 * (see the comment above on why that file is avoided for #39's traps): the accelerator here is
 * already live and already valid, so pointing at the file this project's own README documents for
 * "hotkeys" is not recommending the failure mode this service exists to prevent - it is one more
 * legitimate way to change a binding that already works.
 */
function describeHotkeyCaution(registrations: readonly HotkeyRegistration[]): Omit<Alert, 'source'> | null {
  const cautioned = registrations.filter(
    (registration): registration is HotkeyRegistration & { readonly caution: HotkeyCaution } =>
      registration.ok && registration.caution !== undefined,
  );
  const first = cautioned[0];
  if (first === undefined) return null;

  const more = cautioned.length > 1 ? ` (and ${String(cautioned.length - 1)} more)` : '';
  const key = first.accelerator ?? 'a shortcut';
  const label = HOTKEY_ACTION_LABELS[first.action];
  const where = 'the tray menu → "Settings…", under "Shortcuts", '
    + 'or "hotkeys" in %APPDATA%\\textlens\\config.json (see the README)';

  return {
    severity: 'warning',
    cause: `typing ${key} anywhere in Windows will trigger "${label}" instead of typing `
      + `${first.caution.typedAs}${more}`,
    remedy: `pick a different key for it in ${where}`,
  };
}

/**
 * Config that was not fully applied (#38's stated reopen signal, #41 by inheritance).
 *
 * `ConfigService` already names the offending field by path and keeps the previous values. Until
 * now that reached the log and a getter and stopped there, which is the gap recorded when #38 was
 * closed - so the field paths are carried into the message rather than summarised away. A user who
 * is told "invalid config" checks the whole file; one who is told `capture.intervalActive` fixes a
 * line.
 */
export function describeConfigIssues(
  issues: readonly ConfigIssue[],
  configPath: string | null,
): Omit<Alert, 'source'> | null {
  if (issues.length === 0) return null;
  const where = configPath === null ? 'your config file' : configPath;

  const invalid = issues.find((issue) => issue.kind === 'invalid');
  if (invalid !== undefined) {
    const paths = invalid.fields.map((field) => field.path);
    // **The field paths lead**, and the file path is in the remedy. A real run put them the other
    // way round and the overlay clipped `capture.intervalActive` off the end of a `%APPDATA%`
    // path - losing the one word that turns "check your config" into a line to go and fix.
    const named =
      paths.length === 0
        ? 'a setting'
        : `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${String(paths.length - 3)} more` : ''}`;
    return {
      severity: 'warning',
      cause: `${named} ${paths.length === 1 || paths.length === 0 ? 'is' : 'are'} not valid, `
        + 'so Textlens is running on the default value instead',
      remedy: `fix it in ${where} and restart Textlens, or delete the file to start from defaults`,
    };
  }

  const malformed = issues.find((issue) => issue.kind === 'malformed' || issue.kind === 'unreadable');
  if (malformed !== undefined) {
    return {
      severity: 'warning',
      cause: `${where} could not be read, so Textlens is running on defaults`,
      remedy: 'fix or delete the file, then restart Textlens',
    };
  }

  const notPersisted = issues.find((issue) => issue.kind === 'not-persisted');
  if (notPersisted !== undefined) {
    return {
      severity: 'warning',
      cause: 'a setting was applied but could not be written to disk, so it will be forgotten on restart',
      remedy: `check that ${where} is writable`,
    };
  }
  return null;
}
