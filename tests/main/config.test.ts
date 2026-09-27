/**
 * Issue M9-01 / #38, features ST1 (two layers), ST2 (schema validation), ST3 (hot reload).
 *
 * Every failure path here uses a **real filesystem failure**, not a mocked `fs`:
 *
 *   - unreadable  -> the config path is a directory, so `readFile` returns EISDIR
 *   - not-persisted -> the config path's parent is a regular file, so `mkdir` returns ENOTDIR
 *
 * A stubbed `fs.writeFile` that rejects proves the `catch` block runs; it does not prove the
 * real call fails the way the code assumes, and this service exists precisely to survive the
 * real ones. The only thing stubbed anywhere below is the logger, which is an injected
 * parameter rather than a module.
 *
 * The two assertions worth stating outright, because a weaker suite would pass without them:
 *
 *   - the file on disk holds **only the override**, never the merged config. A test that reads
 *     back `current` cannot tell the two apart; one that reads the file's own text can, and
 *     that difference is what lets a later release change a default the user never touched.
 *   - a rejected change leaves `current` byte-identical, proving "ไม่ apply ทั้งก้อน" rather
 *     than "the bad field was dropped and the good ones went in".
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigService } from '../../src/main/services/config.js';
import type { LogFields, Logger } from '../../src/main/services/logger.js';
import { DEFAULT_CONFIG } from '../../src/shared/config-schema.js';

function collectingLogger(): {
  logger: Logger;
  lines: Array<{ level: string; message: string; fields?: LogFields }>;
} {
  const lines: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    };
  const logger: Logger = {
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    sensitive() {},
    isDebugEnabled: false,
    level: 'info',
    child: () => logger,
  };
  return { logger, lines };
}

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textlens-config-'));
  dirs.push(dir);
  return dir;
}

/** A config path that does not exist yet, inside a fresh directory. */
function tempConfigPath(): string {
  return path.join(tempDir(), 'config.json');
}

function writeConfig(filePath: string, text: string): void {
  fs.writeFileSync(filePath, text, 'utf8');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ConfigService.load', () => {
  it('uses every default and reports no issue when there is no file at all', async () => {
    const service = await ConfigService.load({ filePath: tempConfigPath() });

    expect(service.current).toEqual(DEFAULT_CONFIG);
    // A first run is not a problem, so it must not show up as one in the settings window.
    expect(service.issues).toEqual([]);
    expect(service.override).toEqual({});
  });

  it('merges only the fields the user set, leaving the rest at their defaults', async () => {
    const filePath = tempConfigPath();
    writeConfig(filePath, JSON.stringify({ capture: { intervalActive: 1234 } }));

    const service = await ConfigService.load({ filePath });

    expect(service.current.capture.intervalActive).toBe(1234);
    expect(service.current.capture.intervalIdle).toBe(DEFAULT_CONFIG.capture.intervalIdle);
    expect(service.current.capture.diffThreshold).toBe(DEFAULT_CONFIG.capture.diffThreshold);
    expect(service.current.capture.ocrLanguage).toBe(DEFAULT_CONFIG.capture.ocrLanguage);
    expect(service.issues).toEqual([]);
  });

  /**
   * #61's own acceptance criterion, and the single most important check this issue adds: every
   * config already on disk was written before the `modes` section existed, so it has no `modes`
   * key at all. `configOverrideSchema` is partial per section precisely so that is fine - but the
   * claim is worth a real file and a real load rather than trust, because the trap right next to
   * it (CLAUDE.md's "renaming a config key is a migration, not a rename") is exactly this schema
   * rejecting a whole file over one missing or misnamed section.
   */
  it('loads a config with no "modes" section at all, and defaults snapshotHoldMs to 0', async () => {
    const filePath = tempConfigPath();
    writeConfig(filePath, JSON.stringify({ capture: { intervalActive: 1234 } }));

    const service = await ConfigService.load({ filePath });

    expect(service.issues).toEqual([]);
    expect(service.current.modes.snapshotHoldMs).toBe(0);
    // The rest of the file still applied - a new section did not somehow reject the old ones.
    expect(service.current.capture.intervalActive).toBe(1234);
  });

  it('keeps the whole default config and names the bad field when a value fails the schema', async () => {
    const filePath = tempConfigPath();
    // One good field and one bad one: the good one must NOT be applied either.
    writeConfig(filePath, JSON.stringify({ capture: { intervalActive: 1234, diffThreshold: 9 } }));
    const { logger, lines } = collectingLogger();

    const service = await ConfigService.load({ filePath, logger });

    expect(service.current).toEqual(DEFAULT_CONFIG);
    expect(service.current.capture.intervalActive).toBe(DEFAULT_CONFIG.capture.intervalActive);

    const issue = service.issues[0];
    expect(service.issues).toHaveLength(1);
    expect(issue?.kind).toBe('invalid');
    expect(issue?.fields.map((field) => field.path)).toEqual(['capture.diffThreshold']);
    expect(lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('names a misspelled field rather than silently ignoring it', async () => {
    const filePath = tempConfigPath();
    writeConfig(filePath, JSON.stringify({ capture: { intervalActiveMs: 1234 } }));

    const service = await ConfigService.load({ filePath });

    // The whole point of ST2: a typo the app cannot honour is reported, not dropped.
    expect(service.issues[0]?.fields).toEqual([
      { path: 'capture.intervalActiveMs', message: 'unrecognized field' },
    ]);
    expect(service.current).toEqual(DEFAULT_CONFIG);
  });

  it('accepts a file saved with a UTF-8 BOM, which is what Windows editors write', async () => {
    const filePath = tempConfigPath();
    // Exactly what `Out-File -Encoding utf8` and Notepad produce. Found by hitting it in a
    // real run: the file looks perfect in an editor and JSON.parse calls it malformed.
    writeConfig(filePath, `﻿${JSON.stringify({ capture: { intervalActive: 1234 } })}`);

    const service = await ConfigService.load({ filePath });

    expect(service.current.capture.intervalActive).toBe(1234);
    expect(service.issues).toEqual([]);
  });

  it('falls back to defaults and logs when the file is not parseable JSON', async () => {
    const filePath = tempConfigPath();
    writeConfig(filePath, '{ "capture": { "intervalActive": 800,,, }');
    const { logger, lines } = collectingLogger();

    const service = await ConfigService.load({ filePath, logger });

    expect(service.current).toEqual(DEFAULT_CONFIG);
    expect(service.issues[0]?.kind).toBe('malformed');
    expect(lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('rejects valid JSON that is not an object, which the schema alone would report obscurely', async () => {
    const filePath = tempConfigPath();
    writeConfig(filePath, '[1, 2, 3]');

    const service = await ConfigService.load({ filePath });

    expect(service.current).toEqual(DEFAULT_CONFIG);
    expect(service.issues[0]?.kind).toBe('malformed');
  });

  it('reports a real read failure instead of throwing', async () => {
    // A directory where a file should be: `readFile` fails with EISDIR for real.
    const filePath = path.join(tempDir(), 'config.json');
    fs.mkdirSync(filePath);
    const { logger, lines } = collectingLogger();

    const service = await ConfigService.load({ filePath, logger });

    expect(service.current).toEqual(DEFAULT_CONFIG);
    expect(service.issues[0]?.kind).toBe('unreadable');
    expect(lines.some((line) => line.level === 'error')).toBe(true);
  });

  /**
   * The half of #60 that is easiest to break and hardest to notice.
   *
   * #60 renamed what the user *reads* - the tray said `Snapshot`, the settings window said
   * `Translate once`, and the two are now one word everywhere. The key on disk deliberately did
   * **not** move, and this is why: every schema here is a `strictObject`, so a config file holding
   * a key the schema no longer knows is rejected **in full**. Not the one field - the file. A user
   * who had ever bound this shortcut would lose their region, their intervals, their font size and
   * everything else, at the moment they installed a release whose only change was a label.
   *
   * So this test is not about hotkeys. It is the assertion that a labelling change stayed a
   * labelling change, and it fails the instant somebody "finishes the rename" in the schema.
   */
  it('still loads a config that binds hotkeys.snapshot, which #60 did not rename', async () => {
    const filePath = tempConfigPath();
    writeConfig(
      filePath,
      JSON.stringify({
        hotkeys: { snapshot: 'Control+Alt+S' },
        capture: { intervalActive: 1234 },
      }),
    );

    const service = await ConfigService.load({ filePath });

    expect(service.current.hotkeys.snapshot).toBe('Control+Alt+S');
    // And the rest of the file came with it, which is the thing a rejection would have taken away.
    expect(service.current.capture.intervalActive).toBe(1234);
    expect(service.issues).toEqual([]);
  });
});

describe('ConfigService.set', () => {
  it('applies the change, tells subscribers, and writes only the override to disk', async () => {
    const filePath = tempConfigPath();
    const service = await ConfigService.load({ filePath });

    const seen: Array<{ current: number; previous: number }> = [];
    service.subscribe((current, previous) => {
      seen.push({ current: current.capture.intervalActive, previous: previous.capture.intervalActive });
    });

    const result = await service.set({ capture: { intervalActive: 1500 } });

    expect(result).toEqual({ applied: true, persisted: true, errors: [] });
    expect(service.current.capture.intervalActive).toBe(1500);
    expect(seen).toEqual([{ current: 1500, previous: DEFAULT_CONFIG.capture.intervalActive }]);

    // The file holds the diff, not the merged config. If this ever becomes the whole config,
    // every default is frozen for this user at the version that wrote it.
    const onDisk: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(onDisk).toEqual({ capture: { intervalActive: 1500 } });
  });

  it('round-trips through a second load', async () => {
    const filePath = tempConfigPath();
    const first = await ConfigService.load({ filePath });
    await first.set({
      capture: {
        // Since #31 a region carries the monitor it was drawn on and that monitor's size, so
        // that a region restored onto a different layout can be recognised as stale rather
        // than applied to whatever is attached now.
        region: { rect: [10, 20, 640, 480], monitorId: '\\\\.\\DISPLAY2', monitorSize: [1920, 1080] },
        monitorId: '\\\\.\\DISPLAY2',
      },
    });

    const second = await ConfigService.load({ filePath });

    expect(second.current.capture.region).toEqual({
      rect: [10, 20, 640, 480],
      monitorId: '\\\\.\\DISPLAY2',
      monitorSize: [1920, 1080],
    });
    expect(second.current.capture.monitorId).toBe('\\\\.\\DISPLAY2');
    expect(second.current.capture.intervalActive).toBe(DEFAULT_CONFIG.capture.intervalActive);
    expect(second.issues).toEqual([]);
  });

  it('accumulates successive changes rather than replacing the whole override', async () => {
    const filePath = tempConfigPath();
    const service = await ConfigService.load({ filePath });

    await service.set({ capture: { intervalActive: 1500 } });
    await service.set({ capture: { intervalIdle: 4000 } });

    expect(service.current.capture.intervalActive).toBe(1500);
    expect(service.current.capture.intervalIdle).toBe(4000);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({
      capture: { intervalActive: 1500, intervalIdle: 4000 },
    });
  });

  it('replaces a region wholesale instead of merging it element by element', async () => {
    const service = await ConfigService.load({ filePath: tempConfigPath() });
    await service.set({
      capture: { region: { rect: [0, 0, 1920, 1080], monitorId: '\\\\.\\DISPLAY1', monitorSize: [1920, 1080] } },
    });

    await service.set({
      capture: { region: { rect: [100, 200, 640, 480], monitorId: '\\\\.\\DISPLAY1', monitorSize: [1920, 1080] } },
    });

    // A naive deep merge over arrays would leave [100, 200, 640, 480] here by luck, so the
    // shrinking case is the one that discriminates: a 4-element tuple must not inherit
    // trailing elements from the one it replaces.
    expect(service.current.capture.region?.rect).toEqual([100, 200, 640, 480]);
  });

  it('changes nothing at all when one field of the change is invalid', async () => {
    const service = await ConfigService.load({ filePath: tempConfigPath() });
    await service.set({ capture: { intervalActive: 1500 } });
    const before = service.current;

    const result = await service.set({ capture: { intervalIdle: 4000, diffThreshold: 42 } });

    expect(result.applied).toBe(false);
    expect(result.errors.map((error) => error.path)).toEqual(['capture.diffThreshold']);
    // Not "the bad field was skipped" - nothing moved, including the good field beside it.
    expect(service.current).toBe(before);
    expect(service.current.capture.intervalIdle).toBe(DEFAULT_CONFIG.capture.intervalIdle);
  });

  it('does not notify subscribers when the value did not actually change', async () => {
    const service = await ConfigService.load({ filePath: tempConfigPath() });
    let calls = 0;
    service.subscribe(() => {
      calls += 1;
    });

    await service.set({ capture: { intervalActive: DEFAULT_CONFIG.capture.intervalActive } });

    // A subscriber that pushes `configure` to the sidecar would otherwise restart the
    // capture loop every time the settings window saved an unchanged form.
    expect(calls).toBe(0);
  });

  it('keeps the change live for the session when it cannot be written to disk', async () => {
    // The config's parent is a regular file, so the real `mkdir`/`writeFile` fail with ENOTDIR.
    const blocker = path.join(tempDir(), 'not-a-directory');
    fs.writeFileSync(blocker, 'this is a file', 'utf8');
    const filePath = path.join(blocker, 'config.json');
    const { logger, lines } = collectingLogger();

    const service = await ConfigService.load({ filePath, logger });
    const result = await service.set({ capture: { intervalActive: 1500 } });

    expect(result.applied).toBe(true);
    expect(result.persisted).toBe(false);
    // Applied despite the failure - the session gets the value it asked for.
    expect(service.current.capture.intervalActive).toBe(1500);
    // ...and the user is told it will not survive a restart.
    expect(service.issues.some((issue) => issue.kind === 'not-persisted')).toBe(true);
    expect(lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('leaves no temp file behind on a successful write', async () => {
    const filePath = tempConfigPath();
    const service = await ConfigService.load({ filePath });

    await service.set({ capture: { intervalActive: 1500 } });

    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
  });

  it('survives a listener that throws, and still notifies the others', async () => {
    const service = await ConfigService.load({ filePath: tempConfigPath() });
    let reached = false;
    service.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    service.subscribe(() => {
      reached = true;
    });

    await expect(service.set({ capture: { intervalActive: 1500 } })).resolves.toMatchObject({ applied: true });
    expect(reached).toBe(true);
  });

  it('stops notifying after unsubscribe', async () => {
    const service = await ConfigService.load({ filePath: tempConfigPath() });
    let calls = 0;
    const unsubscribe = service.subscribe(() => {
      calls += 1;
    });

    await service.set({ capture: { intervalActive: 1500 } });
    unsubscribe();
    await service.set({ capture: { intervalActive: 1600 } });

    expect(calls).toBe(1);
  });
});

/**
 * Issue #75: a config file that failed to load was one unrelated `set()` away from being
 * destroyed, because `#override` stays `{}` on a failed load (by design, #38) and the next write
 * overwrites the file with an override containing only that one change.
 *
 * Every fixture below uses a real file and a real filesystem failure, matching the rest of this
 * suite's own stated policy (see the file header) - `set()` here always runs against the real
 * `fs.copyFile`. The one scenario that needs to force `fs.copyFile` itself to fail while the
 * directory otherwise stays fully writable is not reachable that way and lives in
 * `config-preserve.test.ts` instead, with its own note about why it stubs `fs`.
 */
describe('ConfigService: preserving a config it could not load (#75)', () => {
  it('preserves an invalid file byte-for-byte in a sibling copy, and writes only the new override', async () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'config.json');
    // The issue's own repro: two good fields and one out of range (render.fontSize max is 48).
    const original = JSON.stringify({
      capture: { intervalActive: 1234 },
      hotkeys: { snapshot: 'Shift+Space' },
      render: { fontSize: 999 },
    });
    writeConfig(filePath, original);
    const originalBytes = fs.readFileSync(filePath);

    const service = await ConfigService.load({ filePath });
    expect(service.issues[0]?.kind).toBe('invalid');
    const fieldsBefore = service.issues[0]?.fields;

    const result = await service.set({ render: { opacity: 0.5 } });

    expect(result).toMatchObject({ applied: true, persisted: true });

    const siblings = fs.readdirSync(dir).filter((name) => /^config\.rejected-.*\.json$/.test(name));
    expect(siblings).toHaveLength(1);
    const preservedPath = path.join(dir, siblings[0]!);
    expect(fs.readFileSync(preservedPath).equals(originalBytes)).toBe(true);

    // config.json itself holds only the new override - #38's own requirement - not a merge with
    // whatever was rejected, and not the file that was there before.
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ render: { opacity: 0.5 } });

    // The user is told where the original went, through the same issue that already named the
    // bad field - `fields` is untouched (it feeds a different sentence in error-reporter.ts and
    // must not gain a filesystem path), `message` gains the location.
    expect(service.issues[0]?.kind).toBe('invalid');
    expect(service.issues[0]?.fields).toEqual(fieldsBefore);
    expect(service.issues[0]?.message).toContain(preservedPath);
  });

  it('preserves a malformed file (BOM + trailing comma + CRLF) byte-for-byte before overwriting it', async () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'config.json');
    const original = `﻿{\r\n  "capture": { "intervalActive": 1234, },\r\n}`;
    writeConfig(filePath, original);
    const originalBytes = fs.readFileSync(filePath);

    const service = await ConfigService.load({ filePath });
    expect(service.issues[0]?.kind).toBe('malformed');

    const result = await service.set({ render: { opacity: 0.25 } });
    expect(result).toMatchObject({ applied: true, persisted: true });

    const siblings = fs.readdirSync(dir).filter((name) => /^config\.rejected-.*\.json$/.test(name));
    expect(siblings).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, siblings[0]!)).equals(originalBytes)).toBe(true);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ render: { opacity: 0.25 } });
    expect(service.issues[0]?.message).toContain(path.join(dir, siblings[0]!));
  });

  it('does not copy again on a second set() in the same session', async () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'config.json');
    writeConfig(filePath, JSON.stringify({ render: { fontSize: 999 } }));

    const service = await ConfigService.load({ filePath });
    await service.set({ render: { opacity: 0.5 } });
    await service.set({ render: { opacity: 0.75 } });

    const siblings = fs.readdirSync(dir).filter((name) => /^config\.rejected-.*\.json$/.test(name));
    expect(siblings).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ render: { opacity: 0.75 } });
  });

  it('preserves the file when a later reload - not the first load - is what failed', async () => {
    // Rule 1 is "the most recent load failed", not "the first load failed": a config that loaded
    // fine, was then corrupted by something else, and is now about to be `set()` deserves the
    // same protection as one that was bad from the start.
    const dir = tempDir();
    const filePath = path.join(dir, 'config.json');
    writeConfig(filePath, JSON.stringify({ capture: { intervalActive: 1750 } }));

    const service = await ConfigService.load({ filePath });
    expect(service.issues).toEqual([]);

    writeConfig(filePath, 'not json at all');
    const corruptedBytes = fs.readFileSync(filePath);
    await service.reload();
    expect(service.issues[0]?.kind).toBe('malformed');

    await service.set({ render: { opacity: 0.5 } });

    const siblings = fs.readdirSync(dir).filter((name) => /^config\.rejected-.*\.json$/.test(name));
    expect(siblings).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, siblings[0]!)).equals(corruptedBytes)).toBe(true);
  });

  it('makes no sibling copy once a later reload succeeds (a good load resets the guard)', async () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'config.json');
    writeConfig(filePath, 'not json at all');

    const service = await ConfigService.load({ filePath });
    expect(service.issues[0]?.kind).toBe('malformed');

    writeConfig(filePath, JSON.stringify({ capture: { intervalActive: 900 } }));
    await service.reload();
    expect(service.issues).toEqual([]);

    await service.set({ render: { opacity: 0.5 } });

    expect(fs.readdirSync(dir).some((name) => name.includes('rejected'))).toBe(false);
  });

  it('makes no sibling copy when the file loaded cleanly (no regression on the common case)', async () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'config.json');
    const service = await ConfigService.load({ filePath });

    await service.set({ capture: { intervalActive: 1500 } });

    expect(fs.readdirSync(dir).some((name) => name.includes('rejected'))).toBe(false);
  });

  it('refuses to overwrite a config path that cannot even be copied, and reports why instead of writing', async () => {
    // The config path is itself a directory: the existing `unreadable` fixture. `fs.copyFile`
    // fails on it exactly as `fs.readFile` did, so this is also the one case where the failure
    // that blocks the copy and the failure that would have blocked the write are the same
    // failure - the message text is what tells a preserve-first write apart from the old
    // behaviour, not the fact that persisted ends up false (old code reached false here too).
    const dir = tempDir();
    const filePath = path.join(dir, 'config.json');
    fs.mkdirSync(filePath);
    const { logger, lines } = collectingLogger();

    const service = await ConfigService.load({ filePath, logger });
    expect(service.issues[0]?.kind).toBe('unreadable');

    const result = await service.set({ render: { opacity: 0.5 } });

    expect(result.applied).toBe(true);
    expect(result.persisted).toBe(false);
    expect(
      service.issues.some(
        (issue) => issue.kind === 'not-persisted' && issue.message.includes('backed up'),
      ),
    ).toBe(true);
    // Still a directory: nothing was created or renamed over it, and no partial sibling either.
    expect(fs.statSync(filePath).isDirectory()).toBe(true);
    expect(fs.readdirSync(dir).some((name) => name.includes('rejected'))).toBe(false);
    expect(lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('proceeds with a normal write when the file that failed to load has since been deleted', async () => {
    // e.g. the user followed the tray's own remedy - "delete the file to start from defaults"
    // (error-reporter.ts) - before touching a setting. Refusing to write from here on would trap
    // that user in a permanent, unexplained "not saved".
    const dir = tempDir();
    const filePath = path.join(dir, 'config.json');
    writeConfig(filePath, JSON.stringify({ render: { fontSize: 999 } }));

    const service = await ConfigService.load({ filePath });
    expect(service.issues[0]?.kind).toBe('invalid');

    fs.rmSync(filePath);

    const result = await service.set({ render: { opacity: 0.5 } });

    expect(result).toMatchObject({ applied: true, persisted: true });
    expect(fs.readdirSync(dir).some((name) => name.includes('rejected'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ render: { opacity: 0.5 } });
  });
});

describe('ConfigService.reload', () => {
  it('picks up a change written by someone else and notifies subscribers', async () => {
    const filePath = tempConfigPath();
    const service = await ConfigService.load({ filePath });
    const seen: number[] = [];
    service.subscribe((current) => seen.push(current.capture.intervalActive));

    await fsp.writeFile(filePath, JSON.stringify({ capture: { intervalActive: 1750 } }), 'utf8');
    await service.reload();

    expect(service.current.capture.intervalActive).toBe(1750);
    expect(seen).toEqual([1750]);
  });

  it('keeps the last good config when the file is later corrupted', async () => {
    const filePath = tempConfigPath();
    await fsp.writeFile(filePath, JSON.stringify({ capture: { intervalActive: 1750 } }), 'utf8');
    const service = await ConfigService.load({ filePath });
    expect(service.current.capture.intervalActive).toBe(1750);

    await fsp.writeFile(filePath, 'not json at all', 'utf8');
    await service.reload();

    // Last-known-good, not the compiled defaults: the user's working config outlives one bad write.
    expect(service.current.capture.intervalActive).toBe(1750);
    expect(service.issues[0]?.kind).toBe('malformed');
  });

  it('clears a stale issue once the file is fixed', async () => {
    const filePath = tempConfigPath();
    await fsp.writeFile(filePath, 'not json at all', 'utf8');
    const service = await ConfigService.load({ filePath });
    expect(service.issues).toHaveLength(1);

    await fsp.writeFile(filePath, JSON.stringify({ capture: { intervalActive: 900 } }), 'utf8');
    await service.reload();

    expect(service.issues).toEqual([]);
    expect(service.current.capture.intervalActive).toBe(900);
  });
});

/**
 * Issues become something a running app can react to (issue #39).
 *
 * The gap this closes was recorded when #38 was closed and again when #29 shipped: `index.ts` read
 * `issues` exactly once, at boot, so a write that failed later - from the region picker, or from a
 * settings control - reached the log and stopped there. `not-persisted` was therefore the one issue
 * kind that could never be shown to anybody, because it is the only one that cannot exist at boot.
 *
 * A read-only config directory is the real condition, produced the same way the existing
 * `not-persisted` test produces it: the config's parent is a regular file, so `mkdir` fails with a
 * genuine ENOTDIR.
 */
describe('ConfigService: announcing its own issues (#39)', () => {
  /** A config path whose parent is a file, so every write fails for real. */
  function unwritablePath(): string {
    const blocker = path.join(tempDir(), 'not-a-directory');
    fs.writeFileSync(blocker, 'this is a file', 'utf8');
    return path.join(blocker, 'config.json');
  }

  it('tells subscribers when a write fails, so the alert is reachable after boot', async () => {
    const service = await ConfigService.load({ filePath: unwritablePath() });
    const seen: Array<readonly { kind: string }[]> = [];
    service.subscribeIssues((issues) => {
      seen.push(issues.map((issue) => ({ kind: issue.kind })));
    });

    const result = await service.set({ capture: { intervalActive: 1500 } });

    expect(result).toMatchObject({ applied: true, persisted: false });
    // The notification is the whole point: without it this is a getter nobody re-reads.
    expect(seen).toEqual([[{ kind: 'not-persisted' }]]);
  });

  it('replaces the not-persisted entry instead of appending one per failed save', async () => {
    // The mutation this guards, and it was the shipped behaviour: `#write` did
    // `[...this.#issues, ...]`, so a read-only directory grew this list by one identical entry per
    // save for the life of the process - and every one of them is now rendered by a settings window
    // that reads it.
    const service = await ConfigService.load({ filePath: unwritablePath() });

    await service.set({ capture: { intervalActive: 1500 } });
    await service.set({ capture: { intervalActive: 1600 } });
    await service.set({ capture: { intervalActive: 1700 } });

    expect(service.issues.filter((issue) => issue.kind === 'not-persisted')).toHaveLength(1);
  });

  it('clears the report once a write succeeds again', async () => {
    // A user who fixes the permissions and saves again must stop being told their settings are not
    // being remembered - while they are being remembered.
    const dir = tempDir();
    const blocker = path.join(dir, 'blocked');
    fs.writeFileSync(blocker, 'this is a file', 'utf8');
    const service = await ConfigService.load({ filePath: path.join(blocker, 'config.json') });
    await service.set({ capture: { intervalActive: 1500 } });
    expect(service.issues.some((issue) => issue.kind === 'not-persisted')).toBe(true);

    // The same service, now pointed at somewhere writable - which is what fixing the permission
    // amounts to from this object's point of view.
    const writable = await ConfigService.load({ filePath: path.join(dir, 'config.json') });
    const seen: string[][] = [];
    writable.subscribeIssues((issues) => {
      seen.push(issues.map((issue) => issue.kind));
    });
    await writable.set({ capture: { intervalActive: 1500 } });

    expect(writable.issues).toEqual([]);
    // And it does not notify on "no issues" replacing "no issues", which would rewrite the tray
    // tooltip on every keystroke of a settings form.
    expect(seen).toEqual([]);
  });

  it('does not notify when a reload produces the same issues', async () => {
    const filePath = tempConfigPath();
    await fsp.writeFile(filePath, 'not json at all', 'utf8');
    const service = await ConfigService.load({ filePath });
    const seen: number[] = [];
    service.subscribeIssues((issues) => {
      seen.push(issues.length);
    });

    await service.reload();
    await service.reload();

    expect(seen).toEqual([]);
  });

  it('survives an issue listener that throws, and still notifies the others', async () => {
    const service = await ConfigService.load({ filePath: unwritablePath() });
    let reached = false;
    service.subscribeIssues(() => {
      throw new Error('issue listener exploded');
    });
    service.subscribeIssues(() => {
      reached = true;
    });

    await service.set({ capture: { intervalActive: 1500 } });

    expect(reached).toBe(true);
  });

  it('stops notifying once unsubscribed', async () => {
    const service = await ConfigService.load({ filePath: unwritablePath() });
    let calls = 0;
    const off = service.subscribeIssues(() => {
      calls += 1;
    });
    off();

    await service.set({ capture: { intervalActive: 1500 } });

    expect(calls).toBe(0);
  });
});
