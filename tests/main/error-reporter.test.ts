/**
 * Tests for the user-facing error surface (issue M10-02 / #41).
 *
 * The claim these support is narrow and it is the one the issue actually makes: **for every row of
 * #41's table, a user reads a cause and a remedy**, the worst of several conditions wins, and a
 * transient one disappears by itself. What they cannot prove is that the string reached a screen -
 * that is `renderStatus` in `index.ts`, the tray, and the overlay banner, and it is proved by
 * running the app.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ConfigIssue } from '../../src/main/services/config.js';
import {
  DEFAULT_BANNER_TIMEOUT_MS,
  ERROR_REPORTER_LOG_BUFFER_LIMIT,
  ErrorReporter,
  alertSurfaces,
  describeAlert,
  describeConfigIssues,
  describeHotkeyFailures,
  describeMissingRecognizer,
  describeSupervisor,
  describeTranslationFailure,
  judgeTranslation,
  type ScheduleTimer,
} from '../../src/main/services/error-reporter.js';
import type { HotkeyRegistration } from '../../src/main/services/hotkey-service.js';
import type { LogFields, Logger } from '../../src/main/services/logger.js';
import type { SupervisorStatus } from '../../src/main/services/sidecar-supervisor.js';
import type { EngineFailure } from '../../src/main/services/translator/index.js';

/** A recorded call to `.info`/`.warn`/etc, with the `child()` scope it was made through. */
interface RecordedLine {
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly scope: string;
  readonly message: string;
  readonly fields?: LogFields;
}

/**
 * A {@link Logger} that records instead of discarding, so #62's claim - that a buffered line is
 * written through `logger.child('alerts')`, the scope `index.ts`'s comment says to grep for - is
 * something a test can check rather than something only a real log file proves.
 */
function recordingLogger(): { readonly lines: RecordedLine[]; readonly logger: Logger } {
  const lines: RecordedLine[] = [];
  const make = (scope: string): Logger => ({
    error: (message, fields) => lines.push({ level: 'error', scope, message, fields }),
    warn: (message, fields) => lines.push({ level: 'warn', scope, message, fields }),
    info: (message, fields) => lines.push({ level: 'info', scope, message, fields }),
    debug: (message, fields) => lines.push({ level: 'debug', scope, message, fields }),
    sensitive: () => {},
    isDebugEnabled: false,
    level: 'info',
    child: (childScope) => make(scope === '' ? childScope : `${scope}.${childScope}`),
  });
  return { lines, logger: make('') };
}

/** `text` off a buffered/flushed line's fields, the way `#recompute` writes it. */
function fieldText(line: RecordedLine | undefined): string | undefined {
  return (line?.fields as { text?: string } | undefined)?.text;
}

function supervisorStatus(over: Partial<SupervisorStatus>): SupervisorStatus {
  return {
    state: 'running',
    reason: 'initial',
    deaths: 0,
    remaining: 3,
    retryAtMs: null,
    detail: null,
    ...over,
  };
}

describe('ErrorReporter: only the worst one shows', () => {
  it('shows the most severe condition when several are true at once', () => {
    const reporter = new ErrorReporter();
    reporter.set('hotkeys', { severity: 'warning', cause: 'a key clashed', remedy: 'pick another' });
    reporter.set('ocr', { severity: 'fatal', cause: 'no recognizer', remedy: 'install the pack' });
    reporter.set('region', { severity: 'warning', cause: 'text is clipped', remedy: 'widen it' });

    // #41: "error หลายตัวพร้อมกัน → แสดงตัวที่ร้ายแรงที่สุด ไม่ซ้อนกันรก".
    expect(reporter.top?.cause).toBe('no recognizer');
    expect(reporter.alerts).toHaveLength(3);
  });

  it('breaks a severity tie by how much of the app is broken, not by arrival order', () => {
    const reporter = new ErrorReporter();
    reporter.set('region', { severity: 'error', cause: 'region', remedy: 'r' });
    reporter.set('sidecar', { severity: 'error', cause: 'sidecar', remedy: 'r' });

    expect(reporter.top?.cause).toBe('sidecar');
  });

  /**
   * Caught on a real run. Both are `warning`, and with `hotkeys` ranked first the overlay spent a
   * whole session reporting that `Control+Alt+R` was taken while the #50 idle warning - nothing at
   * all is reaching the screen - sat underneath it unseen.
   */
  it('puts "nothing is reaching the screen" ahead of "a shortcut is taken"', () => {
    const reporter = new ErrorReporter();
    reporter.set('hotkeys', { severity: 'warning', cause: 'Control+Alt+R is taken', remedy: 'r' });
    reporter.set('region', { severity: 'warning', cause: 'no change detected for over 25s', remedy: 'r' });

    expect(reporter.top?.cause).toContain('no change detected');
  });

  it('falls back to the next condition when the worst one clears', () => {
    const reporter = new ErrorReporter();
    reporter.set('hotkeys', { severity: 'warning', cause: 'a key clashed', remedy: 'pick another' });
    reporter.set('sidecar', { severity: 'error', cause: 'engine died', remedy: 'retry' });
    expect(reporter.top?.cause).toBe('engine died');

    reporter.set('sidecar', null);

    // The transient one going away must not take the standing one with it.
    expect(reporter.top?.cause).toBe('a key clashed');
  });

  it('goes quiet when the last condition clears', () => {
    const reporter = new ErrorReporter();
    const seen: (string | null)[] = [];
    reporter.subscribe((alert) => seen.push(alert?.cause ?? null));

    reporter.set('translation', { severity: 'error', cause: 'no engine', remedy: 'check the net' });
    reporter.set('translation', null);

    expect(seen).toEqual(['no engine', null]);
    expect(reporter.top).toBeNull();
  });

  it('does not re-notify while the same condition keeps being true', () => {
    const reporter = new ErrorReporter();
    const listener = vi.fn();
    reporter.subscribe(listener);

    for (let i = 0; i < 20; i += 1) {
      reporter.set('translation', { severity: 'error', cause: 'no engine', remedy: 'check the net' });
    }

    // A sustained outage re-reports on every frame. Re-notifying would rewrite the tray tooltip
    // and re-log 20 times, which is the noise that trains a user to stop reading warnings.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  /**
   * The trap behind a real bug in the wiring: this is correct and quiet, and a consumer that
   * cached the notified value rather than reading {@link ErrorReporter.top} showed nothing at all
   * for a whole session when the first alert was published before it subscribed.
   */
  it('stays silent when a lesser condition arrives underneath a standing one', () => {
    const reporter = new ErrorReporter();
    reporter.set('ocr', { severity: 'fatal', cause: 'no recognizer', remedy: 'install it' });
    const listener = vi.fn();
    reporter.subscribe(listener);

    reporter.set('hotkeys', { severity: 'warning', cause: 'a key clashed', remedy: 'pick another' });

    expect(listener).not.toHaveBeenCalled();
    // ...and `top` is still the authority, which is what a renderer must read.
    expect(reporter.top?.cause).toBe('no recognizer');
  });

  it('survives a listener that throws', () => {
    const reporter = new ErrorReporter();
    const good = vi.fn();
    reporter.subscribe(() => {
      throw new Error('boom');
    });
    reporter.subscribe(good);

    reporter.set('config', { severity: 'warning', cause: 'bad field', remedy: 'fix it' });

    expect(good).toHaveBeenCalledTimes(1);
  });
});

/**
 * #59: the banner gives the screen back, and nothing is forgotten when it does.
 *
 * The bug was a banner that stood for an entire session over a condition the user could not act
 * on and could not dismiss - the overlay is click-through, so there is no gesture that closes it.
 * The fix has to be narrow in a specific way: what stops is the *drawing*, not the alert. If the
 * message were dropped from the tray too, this would be invariant 4 broken by the fix for #59,
 * which is why almost every test here asserts both halves at once.
 *
 * The timer is injected, so nothing here waits eight real seconds.
 */
describe('ErrorReporter: the overlay banner hands the screen back (#59)', () => {
  function fakeTimers() {
    const scheduled: { handler: () => void; delayMs: number; cancelled: boolean }[] = [];
    const schedule: ScheduleTimer = (handler, delayMs) => {
      const entry = { handler, delayMs, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    };
    return {
      schedule,
      /** Timers still waiting to fire. */
      get live() {
        return scheduled.filter((entry) => !entry.cancelled);
      },
      /** Let every waiting timer's delay elapse. */
      elapse() {
        for (const entry of [...scheduled]) {
          if (entry.cancelled) continue;
          entry.cancelled = true;
          entry.handler();
        }
      },
    };
  }

  const EDGE = {
    severity: 'warning',
    cause: 'text is touching the right edge of the region; widen it',
    remedy: 'use the tray menu → "Select Region…"',
  } as const;

  it('stops drawing a warning after its time, while the tray still says it', () => {
    const timers = fakeTimers();
    const reporter = new ErrorReporter({ schedule: timers.schedule });
    reporter.set('region', EDGE);
    expect(alertSurfaces(reporter).overlayAlert?.cause).toBe(EDGE.cause);

    timers.elapse();

    // The screen is clear...
    expect(reporter.banner).toBeNull();
    expect(alertSurfaces(reporter).overlayAlert).toBeNull();
    // ...and the user can still find out what happened, which is the whole of invariant 4 here.
    expect(reporter.top?.cause).toBe(EDGE.cause);
    expect(alertSurfaces(reporter).trayWarning).toContain('touching the right edge');
    expect(reporter.alerts).toHaveLength(1);
  });

  it('uses the default eight seconds, not some other number', () => {
    const timers = fakeTimers();
    const reporter = new ErrorReporter({ schedule: timers.schedule });

    reporter.set('region', EDGE);

    expect(timers.live[0]?.delayMs).toBe(DEFAULT_BANNER_TIMEOUT_MS);
    expect(DEFAULT_BANNER_TIMEOUT_MS).toBe(8_000);
  });

  it('tells subscribers when the banner goes, so the overlay is actually repainted', () => {
    const timers = fakeTimers();
    const reporter = new ErrorReporter({ schedule: timers.schedule });
    reporter.set('region', EDGE);
    const listener = vi.fn();
    reporter.subscribe(listener);

    timers.elapse();

    // Without this the banner would stay drawn until some unrelated thing happened to change.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'fatal'] as const)('never takes a %s off the screen', (severity) => {
    const timers = fakeTimers();
    const reporter = new ErrorReporter({ schedule: timers.schedule });

    reporter.set('sidecar', { severity, cause: 'the capture engine is not running', remedy: 'restart it' });
    timers.elapse();

    // Nothing was even scheduled: the harm these name is that the app looks like it is working
    // when it is not, and a banner the user has stopped seeing is how that starts.
    expect(timers.live).toHaveLength(0);
    expect(reporter.banner?.cause).toBe('the capture engine is not running');
    expect(alertSurfaces(reporter).trayError).toContain('not running');
  });

  it('does not come back when the same condition is asserted again in the same words', () => {
    const timers = fakeTimers();
    const reporter = new ErrorReporter({ schedule: timers.schedule });
    reporter.set('region', EDGE);
    timers.elapse();

    // What the frame handler does on every single frame for as long as the region is wrong. If
    // this re-showed the banner, or even restarted the timer, auto-hide would never be observed
    // in practice - which is the failure mode this whole test exists for.
    for (let i = 0; i < 50; i += 1) reporter.set('region', EDGE);

    expect(reporter.banner).toBeNull();
    expect(timers.live).toHaveLength(0);
  });

  it('shows the new message, with a fresh turn, when the same source changes its wording', () => {
    const timers = fakeTimers();
    const reporter = new ErrorReporter({ schedule: timers.schedule });
    reporter.set('region', EDGE);
    timers.elapse();

    reporter.set('region', { ...EDGE, cause: 'text is touching the bottom edge of the region; widen it' });

    // Different edge, different fix. Text spilling off the bottom is not the thing the user just
    // read about, and suppressing it because it arrived from the same source would hide it for
    // as long as the first one keeps recurring.
    expect(reporter.banner?.cause).toContain('bottom edge');
    expect(timers.live).toHaveLength(1);
  });

  it('shows a condition again if it is fixed and then comes back', () => {
    const timers = fakeTimers();
    const reporter = new ErrorReporter({ schedule: timers.schedule });
    reporter.set('region', EDGE);
    timers.elapse();
    expect(reporter.banner).toBeNull();

    reporter.set('region', null);
    reporter.set('region', EDGE);

    // "The condition, not the clock, decides whether it is still true" still holds: having gone
    // away and returned, this is news, not the message the user already dismissed by waiting.
    expect(reporter.banner?.cause).toBe(EDGE.cause);
  });

  it('does not let a displaced warning’s timer blank the message that displaced it', () => {
    const timers = fakeTimers();
    const reporter = new ErrorReporter({ schedule: timers.schedule });
    reporter.set('region', EDGE);

    // An error arrives three seconds in and takes the banner. The warning's timer is still in
    // flight, and firing it here would blank a banner that has only just gone up.
    reporter.set('sidecar', { severity: 'error', cause: 'the capture engine died', remedy: 'restart it' });
    timers.elapse();

    expect(reporter.banner?.cause).toBe('the capture engine died');
  });

  it('gives a warning that was covered up a full turn of its own once the error clears', () => {
    const timers = fakeTimers();
    const reporter = new ErrorReporter({ schedule: timers.schedule });
    reporter.set('region', EDGE);
    reporter.set('sidecar', { severity: 'error', cause: 'the capture engine died', remedy: 'restart it' });
    timers.elapse();

    reporter.set('sidecar', null);

    expect(reporter.banner?.cause).toBe(EDGE.cause);
    expect(timers.live).toHaveLength(1);
  });

  it('sends the tray the standing alert and the overlay the drawn one, never the other way round', () => {
    const timers = fakeTimers();
    const reporter = new ErrorReporter({ schedule: timers.schedule });
    reporter.set('region', EDGE);
    reporter.set('config', { severity: 'warning', cause: 'capture.intervalActive is not valid', remedy: 'fix it' });
    timers.elapse();

    const surfaces = alertSurfaces(reporter);

    // `region` outranks `config`, so one message is on both surfaces - and after the timeout the
    // tray has it and the overlay does not. Wiring both to the same view is the mistake this
    // pins: to `top` and the banner never leaves, to `banner` and the tray goes blank.
    expect(surfaces.trayWarning).toContain('touching the right edge');
    expect(surfaces.trayError).toBeNull();
    expect(surfaces.overlayAlert).toBeNull();
  });
});

/**
 * #62: a logger that arrives after the reporter does must not lose what happened before it.
 *
 * `index.ts` constructs `ErrorReporter` at module scope, before `createLogger` has resolved, so
 * for however long that takes every alert raised went to `nullLogger()` for good - the tray, the
 * banner and the settings window were all fine, because none of them read the reporter's own log,
 * but the log file itself never said what the user was looking at. These pin the fix: nothing is
 * dropped, nothing is duplicated, and attaching twice or never is equally harmless.
 */
describe('ErrorReporter: a logger that arrives late does not lose what happened before it (#62)', () => {
  it('buffers nothing observable while no logger has ever been given - `top`, `banner` and `alerts` still work', () => {
    // The baseline this replaces: before #62, a reporter built the way `index.ts` builds one -
    // `new ErrorReporter()`, no logger - had no seam at all through which a test, or `bootstrap`,
    // could ever recover what it had logged; there was no `attachLogger` to call. This is the
    // closest an automated test can get to that version without hand-editing the class back out
    // for the run - the tautology check does the rest, by removing the flush itself.
    const reporter = new ErrorReporter();
    const seen: (string | null)[] = [];
    reporter.subscribe((alert) => seen.push(alert?.cause ?? null));

    reporter.set('sidecar', { severity: 'error', cause: 'no logger ever arrives', remedy: 'r' });
    reporter.set('sidecar', null);

    // Everything except the log line kept working with no logger at all - it always did.
    expect(seen).toEqual(['no logger ever arrives', null]);
    expect(reporter.top).toBeNull();
  });

  it('flushes the line a config-parse failure would have logged, the instant a logger is attached', () => {
    // The case #62 names by name: a config file that will not parse, reported before `bootstrap`
    // has a logger to give the reporter.
    const reporter = new ErrorReporter();
    reporter.set('config', {
      severity: 'warning',
      cause: 'config.json is not valid JSON, so Textlens is running on defaults',
      remedy: 'fix or delete the file, then restart Textlens',
    });
    // The condition itself needed no logger - this was never the bug.
    expect(reporter.top?.cause).toContain('not valid JSON');

    const rec = recordingLogger();
    reporter.attachLogger(rec.logger);

    expect(rec.lines).toHaveLength(1);
    expect(rec.lines[0]).toMatchObject({ level: 'warn', scope: 'alerts', message: 'user-facing alert' });
    expect(fieldText(rec.lines[0])).toContain('not valid JSON');
  });

  it('flushes several buffered transitions in the order they happened, not just the last one', () => {
    const reporter = new ErrorReporter();
    reporter.set('config', { severity: 'warning', cause: 'first', remedy: 'r' });
    // `fatal` outranks `warning`, so this is a second `top` change, not a replacement of the first.
    reporter.set('ocr', { severity: 'fatal', cause: 'second', remedy: 'r' });
    // Clearing the fatal one hands `top` back to the still-standing warning - a third change.
    reporter.set('ocr', null);
    // And clearing that is the fourth: silence.
    reporter.set('config', null);

    const rec = recordingLogger();
    reporter.attachLogger(rec.logger);

    expect(rec.lines.map((line) => line.message)).toEqual([
      'user-facing alert',
      'user-facing alert',
      'user-facing alert',
      'all clear',
    ]);
    expect(rec.lines.map((line) => fieldText(line))).toEqual([
      expect.stringContaining('first'),
      expect.stringContaining('second'),
      expect.stringContaining('first'),
      undefined,
    ]);
  });

  it('logs immediately, with no buffering, once attached', () => {
    const reporter = new ErrorReporter();
    const rec = recordingLogger();
    reporter.attachLogger(rec.logger);

    reporter.set('config', { severity: 'warning', cause: 'after attach', remedy: 'r' });

    expect(rec.lines).toHaveLength(1);
    expect(fieldText(rec.lines[0])).toContain('after attach');
  });

  it('logs immediately when the constructor is given a logger directly, same as before #62', () => {
    const rec = recordingLogger();
    const reporter = new ErrorReporter({ logger: rec.logger });

    reporter.set('config', { severity: 'warning', cause: 'straight through', remedy: 'r' });

    expect(rec.lines).toHaveLength(1);
    expect(rec.lines[0]?.scope).toBe('alerts');
  });

  it('is harmless to attach twice: the second logger gets nothing, the first keeps receiving', () => {
    const reporter = new ErrorReporter();
    reporter.set('config', { severity: 'warning', cause: 'buffered before either attach', remedy: 'r' });

    const first = recordingLogger();
    reporter.attachLogger(first.logger);
    expect(first.lines).toHaveLength(1);

    const second = recordingLogger();
    reporter.attachLogger(second.logger);
    expect(second.lines).toHaveLength(0);

    // A transition after both attach attempts must still reach the logger that actually won.
    reporter.set('config', null);

    expect(second.lines).toHaveLength(0);
    expect(first.lines).toHaveLength(2);
    expect(first.lines[1]?.message).toBe('all clear');
  });

  it('is harmless to never attach at all: the reporter keeps working and keeps notifying subscribers', () => {
    const reporter = new ErrorReporter();
    const seen: (string | null)[] = [];
    reporter.subscribe((alert) => seen.push(alert?.cause ?? null));

    reporter.set('sidecar', { severity: 'error', cause: 'nothing ever attaches', remedy: 'r' });
    reporter.set('sidecar', null);

    expect(seen).toEqual(['nothing ever attaches', null]);
    expect(reporter.top).toBeNull();
  });

  it('bounds the buffer: transitions past the limit are dropped, and the earliest ones survive', () => {
    const reporter = new ErrorReporter();
    const total = ERROR_REPORTER_LOG_BUFFER_LIMIT + 10;
    for (let i = 0; i < total; i += 1) {
      // A distinct cause every time - `set` returns early for a source repeating the same message,
      // and this test needs every one of these to actually be a buffered line.
      reporter.set('config', { severity: 'warning', cause: `distinct cause ${String(i)}`, remedy: 'r' });
    }

    const rec = recordingLogger();
    reporter.attachLogger(rec.logger);

    // Bounded, not merely "smaller than it would otherwise be": exactly the limit, never the total.
    expect(rec.lines).toHaveLength(ERROR_REPORTER_LOG_BUFFER_LIMIT);
    expect(fieldText(rec.lines[0])).toContain('distinct cause 0');
    expect(fieldText(rec.lines[ERROR_REPORTER_LOG_BUFFER_LIMIT - 1])).toContain(
      `distinct cause ${String(ERROR_REPORTER_LOG_BUFFER_LIMIT - 1)}`,
    );
  });
});

describe('the messages name a cause and a remedy', () => {
  it('tells the user which OCR pack to install, and where', () => {
    const alert = describeMissingRecognizer('en-US', ['th-TH']);

    expect(alert?.severity).toBe('fatal');
    expect(alert?.cause).toContain('en-US');
    // Useless without the path: the OCR pack is an optional *feature* of a language, not the
    // language itself, and a user who installs only the language still has nothing.
    expect(alert?.remedy).toContain('Optional');
    expect(alert?.remedy).toContain('Language options');
  });

  it('accepts a recognizer for the same language in another region', () => {
    // en-GB reads English. Refusing it would be a fatal alert for a working configuration.
    expect(describeMissingRecognizer('en-US', ['en-GB'])).toBeNull();
  });

  it.each([
    ['network', 'connection'],
    ['rate-limit', 'retries by itself'],
    ['protocol', 'update'],
  ] as const)('separates a %s failure from the others', (kind, expected) => {
    const failures: EngineFailure[] = [{ engine: 'google', kind, detail: 'x' }];

    const alert = describeTranslationFailure(failures);

    // #41's row 3 is exactly this: "แยกว่าไม่มีเน็ต / โดน rate limit / config ผิด".
    expect(describeAlert(alert)).toContain(expected);
  });

  it('ranks a rate limit above a network failure, because waiting is the whole remedy', () => {
    const alert = describeTranslationFailure([
      { engine: 'a', kind: 'network', detail: 'x' },
      { engine: 'b', kind: 'rate-limit', status: 429, detail: 'x' },
    ]);

    expect(alert.severity).toBe('warning');
    expect(alert.cause).toContain('rate-limiting');
  });

  it('still says something useful when a degraded payload carries no failures at all', () => {
    const alert = describeTranslationFailure([]);

    expect(alert.cause).not.toBe('');
    expect(alert.remedy).not.toBe('');
  });
});

/**
 * Which payloads move the translation alert (#41).
 *
 * Written after watching the banner flicker on and off about once a second through a real outage
 * behind a dead proxy: every cached frame was being read as "the engine is back".
 */
describe('judgeTranslation', () => {
  const base = { complete: true, degraded: false, engine: 'google', failures: [] as EngineFailure[] };

  it('raises the alert on a degraded payload', () => {
    const verdict = judgeTranslation({
      ...base,
      degraded: true,
      engine: null,
      failures: [{ engine: 'google', kind: 'network', detail: 'x' }],
    });

    expect(verdict.kind).toBe('set');
  });

  it('clears it only when an engine actually answered', () => {
    expect(judgeTranslation(base).kind).toBe('clear');
  });

  it('does not treat a frame that needed no engine as a recovery', () => {
    // Every cached frame looks like this. Clearing here is what made the message flicker.
    expect(judgeTranslation({ ...base, engine: null }).kind).toBe('keep');
  });

  it('ignores the progressive first half, which is cache hits and can never be degraded', () => {
    expect(judgeTranslation({ ...base, complete: false }).kind).toBe('keep');
  });
});

describe('translation failure wording', () => {
  it('does not promise a sustained backoff will clear by itself', () => {
    const alert = describeTranslationFailure([{ engine: 'google', kind: 'unavailable', detail: 'x' }]);

    // `unavailable` is what almost every frame reports once an outage has put the engine into
    // backoff, so "this clears on its own within a few seconds" was a lie for the common case.
    expect(alert.remedy).toContain('internet connection');
  });

  it('still says something useful when a degraded payload carries no failures at all', () => {
    const alert = describeTranslationFailure([]);

    expect(alert.cause).not.toBe('');
    expect(alert.remedy).not.toBe('');
  });
});

/**
 * The trap the lead named: Electron's `register` returns `false` both for a foreign conflict and
 * for our own duplicate, and sending a user hunting for a program that does not exist costs more
 * time than the message saves.
 */
describe('hotkey failures: a duplicate is not a conflict', () => {
  const duplicate: HotkeyRegistration = {
    action: 'selectRegion',
    accelerator: 'Control+Alt+R',
    ok: false,
    reason: 'duplicate',
    detail: 'already bound to "snapshot"',
  };
  const conflict: HotkeyRegistration = {
    action: 'selectRegion',
    accelerator: 'Control+Alt+R',
    ok: false,
    reason: 'conflict',
  };

  it('does not send the user looking for another program when the clash is our own', () => {
    const alert = describeHotkeyFailures([duplicate]);

    expect(alert?.cause).toContain('two Textlens actions');
    expect(describeAlert(alert!)).not.toContain('another program');
  });

  it('does name another program when that is genuinely what happened', () => {
    const alert = describeHotkeyFailures([conflict]);

    expect(alert?.cause).toContain('another program');
  });

  it.each([
    ['duplicate', duplicate],
    ['conflict', conflict],
    ['invalid', { action: 'snapshot', accelerator: 'Contrl+Alt+S', ok: false, reason: 'invalid' } as const],
  ])('sends a %s to the settings window, never to the config file (#39)', (_reason, failure) => {
    // Until #39 every one of these ended in "under \"hotkeys\" in C:\\...\\config.json", which was
    // the only honest advice while there was no other way to rebind - and it is the exact route
    // into the two traps this project has already been bitten by: Notepad and PowerShell 5.1 write
    // a UTF-8 BOM that makes `JSON.parse` reject a valid file, and Electron silently drops a
    // misspelled modifier and binds what is left. The settings window captures a real keystroke
    // and probes it before saving, so it can produce neither.
    const alert = describeHotkeyFailures([failure]);

    expect(alert?.remedy).toContain('Shortcuts');
    expect(alert?.remedy).not.toContain('config.json');
    expect(alert?.remedy).not.toContain('hotkeys" in');
  });

  it('says which shortcut is unparseable rather than reporting it as taken', () => {
    const alert = describeHotkeyFailures([
      { action: 'snapshot', accelerator: 'Contrl+Alt+S', ok: false, reason: 'invalid' },
    ]);

    expect(alert?.cause).toContain('Contrl+Alt+S');
  });

  it('ignores a hotkey the user turned off on purpose', () => {
    expect(
      describeHotkeyFailures([{ action: 'snapshot', accelerator: null, ok: false, reason: 'disabled' }]),
    ).toBeNull();
  });

  it('says nothing when every key bound', () => {
    expect(describeHotkeyFailures([{ action: 'snapshot', accelerator: 'Control+Alt+S', ok: true }])).toBeNull();
  });
});

describe('config issues reach the user, not just the log (#38 reopen signal)', () => {
  it('names the fields that were rejected', () => {
    const issues: ConfigIssue[] = [
      {
        kind: 'invalid',
        message: 'config file has invalid values',
        fields: [{ path: 'capture.intervalActive', message: 'expected a positive integer' }],
      },
    ];

    const alert = describeConfigIssues(issues, 'C:\\config.json');

    // A user told "invalid config" checks the whole file; one told the path fixes a line.
    expect(alert?.cause).toContain('capture.intervalActive');
    expect(alert?.cause).toContain('default');
    expect(alert?.remedy).toContain('C:\\config.json');
    expect(alert?.remedy).toContain('restart');
    // The overlay clips from the right, and the field path must survive that. A real run lost it
    // to a `%APPDATA%` path that used to sit in front of it.
    expect(alert?.cause.indexOf('capture.intervalActive')).toBeLessThan(20);
  });

  it('says the file could not be read at all when that is what happened', () => {
    const alert = describeConfigIssues(
      [{ kind: 'malformed', message: 'not JSON', fields: [] }],
      'C:\\config.json',
    );

    expect(alert?.cause).toContain('could not be read');
  });

  it('warns that a setting will be forgotten when the disk refused it', () => {
    const alert = describeConfigIssues([{ kind: 'not-persisted', message: 'EACCES', fields: [] }], null);

    expect(alert?.cause).toContain('forgotten');
  });

  it('says nothing on a healthy config', () => {
    expect(describeConfigIssues([], null)).toBeNull();
  });
});

describe('supervisor state as something a user can act on', () => {
  it('counts down rather than reporting a failure while it is fixing itself', () => {
    const alert = describeSupervisor(
      supervisorStatus({ state: 'backoff', reason: 'crash', retryAtMs: 12_400, deaths: 1 }),
      { nowMs: 10_000, logDirectory: 'C:\\logs' },
    );

    expect(alert?.severity).toBe('info');
    expect(alert?.remedy).toContain('3s');
    // #40's "ระหว่าง restart overlay ไม่หายวูบ" is a promise the message has to keep too.
    expect(alert?.remedy).toContain('stay on screen');
  });

  it('names the log and the way back once it has given up', () => {
    const alert = describeSupervisor(supervisorStatus({ state: 'gave-up', reason: 'crash', deaths: 4 }), {
      nowMs: 0,
      logDirectory: 'C:\\logs',
    });

    expect(alert?.severity).toBe('error');
    expect(alert?.remedy).toContain('C:\\logs');
    expect(alert?.remedy).toContain('Restart capture engine');
  });

  it('says nothing at all about a healthy sidecar, or one the user paused', () => {
    expect(describeSupervisor(supervisorStatus({ state: 'running' }), { nowMs: 0, logDirectory: null })).toBeNull();
    expect(
      describeSupervisor(supervisorStatus({ state: 'stopped', reason: 'not-wanted' }), {
        nowMs: 0,
        logDirectory: null,
      }),
    ).toBeNull();
  });
});
