/**
 * M10-03. The criterion that matters here is the privacy one, and it is the easiest to
 * fake: a test asserting "we called logger.debug" proves nothing about what reached the
 * disk. So every privacy and rotation assertion in this file reads the actual files in
 * the actual directory, after the logger has actually flushed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOG_LEVEL,
  createLogger,
  isLogLevel,
  resolveLogLevel,
  type LoggerOptions,
  type RootLogger,
} from '../../src/main/services/logger.js';

/** Real text off a real screen - the string the golden frame fixture carries. */
const SCREEN_TEXT = 'You must find the key';

const opened: RootLogger[] = [];
const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textlens-log-'));
  dirs.push(dir);
  return dir;
}

async function open(options: LoggerOptions): Promise<RootLogger> {
  const logger = await createLogger({ console: false, ...options });
  opened.push(logger);
  return logger;
}

afterEach(async () => {
  while (opened.length > 0) {
    const logger = opened.pop();
    if (logger) await logger.close();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function filesIn(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

function readAll(dir: string): string {
  return filesIn(dir)
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
}

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 2));
};

describe('resolveLogLevel', () => {
  it('defaults to info, which is the level that must not leak screen text', () => {
    expect(DEFAULT_LOG_LEVEL).toBe('info');
    expect(resolveLogLevel({})).toEqual({ level: 'info' });
  });

  it('takes the configured level when the environment is silent', () => {
    expect(resolveLogLevel({}, 'warn')).toEqual({ level: 'warn' });
    expect(resolveLogLevel({ LOG_LEVEL: '' }, 'warn')).toEqual({ level: 'warn' });
  });

  it('lets LOG_LEVEL override config, case and padding insensitively', () => {
    expect(resolveLogLevel({ LOG_LEVEL: 'debug' }, 'info').level).toBe('debug');
    expect(resolveLogLevel({ LOG_LEVEL: '  DEBUG ' }, 'info').level).toBe('debug');
  });

  it('reports an unusable LOG_LEVEL instead of silently ignoring it', () => {
    const result = resolveLogLevel({ LOG_LEVEL: 'verbose' }, 'info');

    expect(result.level).toBe('info');
    expect(result.warning).toContain('verbose');
  });

  it('recognises exactly the four levels this app uses', () => {
    expect(['error', 'warn', 'info', 'debug'].every(isLogLevel)).toBe(true);
    expect(isLogLevel('trace')).toBe(false);
    expect(isLogLevel('silly')).toBe(false);
  });
});

describe('log files', () => {
  it('writes into the directory it was given, creating it if needed', async () => {
    const dir = path.join(tempDir(), 'nested', 'logs');
    const logger = await open({ directory: dir });

    logger.info('sidecar spawned', { pid: 1234 });
    await logger.close();

    expect(path.dirname(logger.currentFile)).toBe(dir);
    const contents = fs.readFileSync(logger.currentFile, 'utf8');
    expect(JSON.parse(contents.trim().split('\n')[0] ?? '{}')).toMatchObject({
      level: 30,
      msg: 'sidecar spawned',
      pid: 1234,
    });
  });

  it('does not write synchronously on the calling thread', async () => {
    const dir = tempDir();
    const logger = await open({ directory: dir, env: {} });

    // What this test guards: `logger.info(...)` must not perform a blocking write on the
    // calling thread. The main process also runs the Node half of the capture loop, and
    // the budget in design doc section 4 has no room for a disk write inside a frame.
    //
    // It used to assert `statSync(currentFile).size === 0` right after the call. That was
    // a race, not a proof (issue #63): sonic-boom dispatches `fs.write` to the libuv
    // threadpool from inside the calling stack, so the bytes can land before the very next
    // statement runs without anything having blocked. Measured under contention: 2 of 150
    // calls saw the full 66-byte line already on disk while zero synchronous fs calls had
    // been made. The old assertion failed ~1 full-suite run in 5 for that reason alone.
    //
    // So census the syscalls instead of racing them. `blocking` names every fs entry point
    // that would stall this thread; sonic-boom's sync mode reaches disk through `writeSync`,
    // and adds `fsyncSync` on top when `fsync: true`.
    //
    // The window is the log call itself, which is what "on the calling thread" means and all
    // this test has ever claimed. Verified boundary: `fsync: true` *without* sync mode is not
    // caught here, because sonic-boom then runs `fsyncSync` inside the `fs.write` completion
    // callback - it stalls the event loop later, not this stack. The old assertion did not
    // catch that either, so nothing was lost; it is simply a different test to write.
    const BLOCKING_FS_CALLS = [
      'writeSync',
      'writevSync',
      'appendFileSync',
      'writeFileSync',
      'fsyncSync',
      'fdatasyncSync',
    ] as const;

    // Spies go on after open() - the destination's own mkdir/open may legitimately be
    // synchronous - and come off before close(), whose final flush is allowed to be. They
    // call through, so this observes the real logger doing its real work.
    const spies = BLOCKING_FS_CALLS.map((name) => ({ name, spy: vi.spyOn(fs, name) }));
    const writeSpy = vi.spyOn(fs, 'write');

    let blocking: string[] = [];
    let asyncWrites = 0;
    try {
      logger.info('first line');

      blocking = spies.filter(({ spy }) => spy.mock.calls.length > 0).map(({ name }) => name);
      asyncWrites = writeSpy.mock.calls.length;
    } finally {
      vi.restoreAllMocks();
    }

    expect(blocking).toEqual([]);
    // The positive control, and the reason the assertion above cannot pass vacuously: if
    // the patching mechanism ever stops intercepting what the logger actually calls - a
    // destructured `fs` import inside sonic-boom, a move to `fs/promises` - this fails
    // loudly rather than letting the negative assertion succeed by seeing nothing at all.
    expect(asyncWrites).toBeGreaterThan(0);

    await logger.close();
    expect(fs.statSync(logger.currentFile).size).toBeGreaterThan(0);
  });

  it('tags lines with the scope of the service that emitted them', async () => {
    const dir = tempDir();
    const logger = await open({ directory: dir });

    logger.child('sidecar').child('stderr').warn('WARN: something from the sidecar');
    await logger.close();

    expect(JSON.parse(readAll(dir).trim())).toMatchObject({ scope: 'sidecar.stderr', level: 40 });
  });
});

describe('privacy at the default level (PR3)', () => {
  it('keeps screen text off the disk at info, and puts it there at debug', async () => {
    const infoDir = tempDir();
    const infoLogger = await open({ directory: infoDir, level: 'info' });

    expect(infoLogger.level).toBe('info');
    expect(infoLogger.isDebugEnabled).toBe(false);
    infoLogger.info('frame', { seq: 7, lines: 1 });
    infoLogger.sensitive('frame text', SCREEN_TEXT, { seq: 7 });
    infoLogger.debug('frame detail', { note: SCREEN_TEXT });
    await infoLogger.close();

    const atInfo = readAll(infoDir);
    expect(atInfo).toContain('"seq":7'); // the metrics did get logged
    expect(atInfo).not.toContain(SCREEN_TEXT); // the text did not

    const debugDir = tempDir();
    const debugLogger = await open({ directory: debugDir, level: 'debug' });
    debugLogger.sensitive('frame text', SCREEN_TEXT, { seq: 7 });
    await debugLogger.close();

    expect(readAll(debugDir)).toContain(SCREEN_TEXT);
  });

  it('honours LOG_LEVEL=debug for the sensitive channel too', async () => {
    const dir = tempDir();
    const logger = await open({ directory: dir, level: 'info', env: { LOG_LEVEL: 'debug' } });

    expect(logger.isDebugEnabled).toBe(true);
    logger.sensitive('frame text', SCREEN_TEXT);
    await logger.close();

    expect(readAll(dir)).toContain(SCREEN_TEXT);
  });

  it('drops sensitive payloads before the logging library sees them', async () => {
    const dir = tempDir();
    const logger = await open({ directory: dir, level: 'error' });

    logger.sensitive('frame text', SCREEN_TEXT, { seq: 1 });
    logger.error('sidecar reported an error', { code: 'CAPTURE_FAILED' });
    await logger.close();

    const contents = readAll(dir);
    expect(contents).toContain('CAPTURE_FAILED');
    expect(contents).not.toContain(SCREEN_TEXT);
    // Not even the message survives: nothing about the call reached a destination.
    expect(contents).not.toContain('frame text');
  });
});

describe('rotation', () => {
  it('rolls the file past the size cap and keeps a bounded number of them', async () => {
    const dir = tempDir();
    const maxFiles = 3;
    const maxSizeBytes = 4 * 1024;
    const logger = await open({ directory: dir, maxSizeBytes, maxFiles });

    // Paced like the pipeline logs: a few lines, then the event loop turns. Written all
    // in one tick the roll would be deferred, which is pino-roll's documented tradeoff
    // (defer the roll rather than drop the line) and not what this test is about.
    const filler = 'x'.repeat(200);
    for (let t = 0; t < 40; t += 1) {
      for (let i = 0; i < 5; i += 1) logger.info('filler line', { t, i, filler });
      await tick();
    }
    await logger.close();

    const files = filesIn(dir);
    // More than one file: the cap was enforced rather than one file growing forever.
    expect(files.length).toBeGreaterThan(1);
    // Bounded: the archives plus the active file, and nothing more.
    expect(files.length).toBeLessThanOrEqual(maxFiles + 1);

    const total = files.reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
    // Far less than the ~40 KiB written, so old data really was discarded.
    expect(total).toBeLessThan(maxSizeBytes * (maxFiles + 2));
  }, 15_000);
});
