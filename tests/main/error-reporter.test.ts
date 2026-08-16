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
  ErrorReporter,
  describeAlert,
  describeConfigIssues,
  describeHotkeyFailures,
  describeMissingRecognizer,
  describeSupervisor,
  describeTranslationFailure,
  judgeTranslation,
} from '../../src/main/services/error-reporter.js';
import type { HotkeyRegistration } from '../../src/main/services/hotkey-service.js';
import type { SupervisorStatus } from '../../src/main/services/sidecar-supervisor.js';
import type { EngineFailure } from '../../src/main/services/translator/index.js';

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
    const alert = describeHotkeyFailures([duplicate], 'C:\\config.json');

    expect(alert?.cause).toContain('two Textlens actions');
    expect(describeAlert(alert!)).not.toContain('another program');
  });

  it('does name another program when that is genuinely what happened', () => {
    const alert = describeHotkeyFailures([conflict], 'C:\\config.json');

    expect(alert?.cause).toContain('another program');
    expect(alert?.remedy).toContain('C:\\config.json');
  });

  it('says which shortcut is unparseable rather than reporting it as taken', () => {
    const alert = describeHotkeyFailures(
      [{ action: 'snapshot', accelerator: 'Contrl+Alt+S', ok: false, reason: 'invalid' }],
      null,
    );

    expect(alert?.cause).toContain('Contrl+Alt+S');
  });

  it('ignores a hotkey the user turned off on purpose', () => {
    expect(
      describeHotkeyFailures([{ action: 'snapshot', accelerator: null, ok: false, reason: 'disabled' }], null),
    ).toBeNull();
  });

  it('says nothing when every key bound', () => {
    expect(describeHotkeyFailures([{ action: 'snapshot', accelerator: 'Control+Alt+S', ok: true }], null)).toBeNull();
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
