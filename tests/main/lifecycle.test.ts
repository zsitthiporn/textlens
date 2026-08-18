/**
 * Issue #67 - the failures nobody was waiting for.
 *
 * ## What these tests reach, and what only a real Electron run can
 *
 * `src/main/index.ts` is the one module in `src/main/` that is allowed to import `electron`, so
 * the whole of this file's setup is a stand-in for that module. The stand-in is deliberately
 * dumb - it records `quit`, `exit` and `showErrorBox` and hands back a `whenReady` the test
 * controls - because everything worth proving here is about *which of those three is reached*,
 * not about what Electron does with them.
 *
 * Proved here: a `shutdown()` that rejects still quits, and still gets far enough to close the
 * windows and flush the log; a `bootstrap()` that fails before a logger exists still reports;
 * and the two policy decisions #67 asked to be made explicitly - a rejection is survived, an
 * uncaught exception is not - are pinned so that neither can be reverted by accident.
 *
 * **Not proved here, and it is the load-bearing caveat**: that Electron's own default is what the
 * decision was weighed against. That was measured out-of-band by running two probes under the real
 * `electron.exe` (43.4.0 / Node 24.18.1), and the numbers are recorded in the block comment at the
 * top of `index.ts` rather than in an assertion, because nothing in a vitest worker running Node
 * 22 can observe them. A future Electron that changes its unhandled-rejection mode would not fail
 * a single test in this file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LogFields, Logger } from '../../src/main/services/logger.js';

/**
 * The fake `electron`.
 *
 * Hoisted because `vi.mock`'s factory runs before the module body, and mutable because
 * `vi.resetModules()` re-imports `index.ts` for every test - each import registers its own
 * `app.on` listeners and its own `process.on` handlers, and a registry that carried over would
 * have test two firing test one's listeners.
 */
const harness = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: never[]) => void>>();
  const exitCodes: number[] = [];
  const errorBoxes: Array<{ title: string; content: string }> = [];
  let quitCalls = 0;
  let resolveReady: () => void = () => undefined;
  // Never settles until a test asks it to. That is what keeps `bootstrap` from running in the
  // tests that only care about shutdown.
  let ready: Promise<void> = new Promise<void>(() => undefined);

  const app = {
    on(event: string, listener: (...args: never[]) => void) {
      const registered = listeners.get(event) ?? [];
      registered.push(listener);
      listeners.set(event, registered);
      return app;
    },
    whenReady: () => ready,
    quit: () => {
      quitCalls += 1;
    },
    exit: (code = 0) => {
      exitCodes.push(code);
    },
    getPath: (name: string) => `C:\\fake\\${name}`,
    getVersion: () => '0.0.0-test',
    getAppPath: () => 'C:\\fake\\app',
    isPackaged: false,
  };

  // Everything `index.ts` and `window-manager.ts` name. Inert on purpose: a fake that did
  // something would be a second implementation nobody reviews.
  const electronModule = {
    app,
    dialog: {
      showErrorBox: (title: string, content: string) => {
        errorBoxes.push({ title, content });
      },
    },
    BrowserWindow: class {},
    Menu: { buildFromTemplate: () => ({}) },
    Tray: class {},
    globalShortcut: {
      register: () => false,
      unregister: () => undefined,
      unregisterAll: () => undefined,
      isRegistered: () => false,
    },
    ipcMain: { handle: () => undefined, removeHandler: () => undefined, on: () => undefined },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true }),
      createEmpty: () => ({ isEmpty: () => true }),
    },
    net: { fetch: () => Promise.reject(new Error('the transport is not exercised here')) },
    screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1 }), on: () => undefined },
  };

  return {
    electronModule,
    exitCodes,
    errorBoxes,
    get quitCalls() {
      return quitCalls;
    },
    /** Fire what `index.ts` registered, exactly as Electron would. */
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) {
        (listener as (...args: unknown[]) => void)(...args);
      }
    },
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length;
    },
    /** Settle `app.whenReady()`, which is the only thing that starts `bootstrap`. */
    becomeReady() {
      resolveReady();
    },
    reset() {
      listeners.clear();
      exitCodes.length = 0;
      errorBoxes.length = 0;
      quitCalls = 0;
      ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
    },
  };
});

vi.mock('electron', () => harness.electronModule);

/**
 * `createLogger` only. The rest of the module is kept real via `importOriginal`, both because
 * other exports of it are types the graph still needs and because a hand-written stand-in for a
 * module another issue is actively changing would rot without saying so.
 */
const loggerModule = vi.hoisted(() => ({ createLogger: vi.fn() }));

vi.mock('../../src/main/services/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/services/logger.js')>()),
  createLogger: loggerModule.createLogger,
}));

/**
 * Whatever vitest itself had registered before `index.ts` was ever imported.
 *
 * `index.ts` installs a `process.on('uncaughtException')` and a `process.on('unhandledRejection')`
 * at module scope - that is the fix - which means importing it inside a test worker attaches them
 * to *vitest's* process and suppresses vitest's own rejection detection for every later file.
 * These snapshots are how `afterEach` tells ours apart from theirs.
 */
const baselineUncaught = process.listeners('uncaughtException');
const baselineRejection = process.listeners('unhandledRejection');

interface RecordedLine {
  readonly message: string;
  readonly fields: LogFields | undefined;
}

interface LoggerRecorder {
  readonly logger: Logger;
  readonly errors: RecordedLine[];
  readonly infos: RecordedLine[];
}

function recordingLogger(): LoggerRecorder {
  const errors: RecordedLine[] = [];
  const infos: RecordedLine[] = [];
  const logger: Logger = {
    error: (message, fields) => {
      errors.push({ message, fields });
    },
    warn: () => undefined,
    info: (message, fields) => {
      infos.push({ message, fields });
    },
    debug: () => undefined,
    sensitive: () => undefined,
    isDebugEnabled: false,
    level: 'info',
    child: () => logger,
  };
  return { logger, errors, infos };
}

async function loadIndex(): Promise<typeof import('../../src/main/index.js')> {
  return await import('../../src/main/index.js');
}

/** The `uncaughtException` handler `index.ts` just installed, and only that one. */
function installedUncaughtHandlers(): NodeJS.UncaughtExceptionListener[] {
  return process.listeners('uncaughtException').filter((listener) => !baselineUncaught.includes(listener));
}

/** The `unhandledRejection` handler `index.ts` just installed, and only that one. */
function installedRejectionHandlers(): NodeJS.UnhandledRejectionListener[] {
  return process.listeners('unhandledRejection').filter((listener) => !baselineRejection.includes(listener));
}

beforeEach(() => {
  harness.reset();
  loggerModule.createLogger.mockReset();
  vi.resetModules();
});

afterEach(() => {
  for (const listener of installedUncaughtHandlers()) process.off('uncaughtException', listener);
  for (const listener of installedRejectionHandlers()) process.off('unhandledRejection', listener);
});

describe('quitting when shutdown itself fails (#67)', () => {
  it('reaches app.quit(), and the rest of shutdown, even when the sidecar refuses to stop', async () => {
    const index = await loadIndex();
    const recorder = recordingLogger();
    const closeAll = vi.fn();
    const destroy = vi.fn();
    const close = vi.fn(async () => undefined);

    index.lifecycleTestSeam.install({
      // The exact failure #67 names: the one `await` in `shutdown()` that has real work after it.
      sidecar: {
        stop: () => Promise.reject(new Error('the child ignored stdin')),
        isRunning: true,
      },
      logger: { child: () => recorder.logger, close, directory: 'C:\\fake\\logs' },
      windows: { closeAll },
      tray: { destroy },
    });

    const event = { preventDefault: vi.fn() };
    harness.emit('before-quit', event);
    await vi.waitFor(() => {
      expect(harness.quitCalls).toBe(1);
    });

    // The quit was cancelled first - which is what made the old bug permanent rather than a retry.
    expect(event.preventDefault).toHaveBeenCalledOnce();
    // The tray still goes before the awaits. #67 did not reorder shutdown; it made that order safe.
    expect(destroy).toHaveBeenCalledOnce();
    // Both of these sit *after* the rejecting await, and neither ran before this fix.
    expect(closeAll).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    // Untidy, but not silent (invariant 4).
    expect(recorder.errors.map((line) => line.message)).toContain(
      'the sidecar did not stop cleanly; shutting down anyway',
    );
    // Reported as a shutdown that went wrong, not as a crash: no dialog, no non-zero exit.
    expect(harness.errorBoxes).toHaveLength(0);
    expect(harness.exitCodes).toHaveLength(0);
  });

  it('quits even when flushing the log is what fails', async () => {
    const index = await loadIndex();
    const recorder = recordingLogger();
    const closeAll = vi.fn();

    index.lifecycleTestSeam.install({
      sidecar: { stop: async () => undefined, isRunning: false },
      logger: {
        child: () => recorder.logger,
        close: () => Promise.reject(new Error('the log file is gone')),
        directory: 'C:\\fake\\logs',
      },
      windows: { closeAll },
      tray: { destroy: () => undefined },
    });

    harness.emit('before-quit', { preventDefault: () => undefined });
    await vi.waitFor(() => {
      expect(harness.quitCalls).toBe(1);
    });

    // `logger.close()` is the last statement in `shutdown()`, so there is nothing for a local
    // `try` to protect and the rejection reaches the outer net instead. This is the case that
    // discriminates `.finally` from `.then`: with the sidecar step catching its own failure, the
    // test above would pass either way, and this one would not.
    expect(closeAll).toHaveBeenCalledOnce();
    expect(recorder.errors.map((line) => line.message)).toContain(
      'shutdown did not finish cleanly; quitting regardless',
    );
  });

  it('still quits on the ordinary path, where nothing rejects', async () => {
    const index = await loadIndex();
    const recorder = recordingLogger();
    const closeAll = vi.fn();

    index.lifecycleTestSeam.install({
      sidecar: { stop: async () => undefined, isRunning: false },
      logger: { child: () => recorder.logger, close: async () => undefined, directory: 'C:\\fake\\logs' },
      windows: { closeAll },
      tray: { destroy: () => undefined },
    });

    harness.emit('before-quit', { preventDefault: () => undefined });
    await vi.waitFor(() => {
      expect(harness.quitCalls).toBe(1);
    });

    expect(closeAll).toHaveBeenCalledOnce();
    // The failure line belongs to the failing path only; seeing it here would mean the assertion
    // in the test above proves nothing.
    expect(recorder.errors).toHaveLength(0);
  });
});

describe('a startup that fails before anything can report it (#67)', () => {
  it('shows the user an error box when createLogger rejects, instead of doing nothing at all', async () => {
    loggerModule.createLogger.mockRejectedValueOnce(
      new Error('EACCES: permission denied, mkdir C:\\fake\\userData\\logs'),
    );

    await loadIndex();
    harness.becomeReady();

    await vi.waitFor(() => {
      expect(harness.errorBoxes).toHaveLength(1);
    });

    const box = harness.errorBoxes[0];
    expect(box?.title).toBe('Textlens has to close');
    expect(box?.content).toContain('EACCES: permission denied');
    // With no logger there is no file to point at, so the stack has to travel in the box itself -
    // this is the branch that exists because the disk is the thing that just failed.
    expect(box?.content).toContain('at ');
    expect(box?.content).not.toContain('The details are in the log');

    await vi.waitFor(() => {
      expect(harness.exitCodes).toEqual([1]);
    });
    // Not a graceful quit: `before-quit` would await services this startup never built.
    expect(harness.quitCalls).toBe(0);
  });
});

describe('the policy #67 required to be chosen rather than inherited', () => {
  it('logs an unhandled rejection and leaves the app running', async () => {
    const index = await loadIndex();
    const recorder = recordingLogger();
    index.lifecycleTestSeam.install({
      logger: { child: () => recorder.logger, close: async () => undefined, directory: 'C:\\fake\\logs' },
    });

    const handlers = installedRejectionHandlers();
    expect(handlers).toHaveLength(1);
    handlers[0]?.(new Error('nobody awaited this'), Promise.resolve());

    expect(recorder.errors.map((line) => line.message)).toEqual([
      'unhandled promise rejection - the app is still running',
    ]);
    expect(recorder.errors[0]?.fields?.['message']).toBe('nobody awaited this');
    // The decision, pinned. Electron 43 survives these on its own; the fix adds the report and
    // deliberately does not take the survival away.
    expect(harness.exitCodes).toHaveLength(0);
    expect(harness.quitCalls).toBe(0);
    expect(harness.errorBoxes).toHaveLength(0);
  });

  it('holds a rejection raised before the logger existed, and writes it out once one does', async () => {
    const recorder = recordingLogger();
    loggerModule.createLogger.mockResolvedValueOnce({
      ...recorder.logger,
      child: () => recorder.logger,
      close: async () => undefined,
      directory: 'C:\\fake\\logs',
      currentFile: 'C:\\fake\\logs\\app.log',
    });

    // Stops `bootstrap` on its second await, which is the first one after the flush. Without it
    // the run would carry on into `WindowManager` and leave a metrics interval behind.
    const { ConfigService } = await import('../../src/main/services/config.js');
    vi.spyOn(ConfigService, 'load').mockRejectedValue(new Error('bootstrap stops here'));

    await loadIndex();

    // Nothing has resolved `whenReady`, so there is no logger and no window - the #62-shaped
    // window in which a report has nowhere to go. `src/main/` writes nothing to `console.*`, so
    // the alternative to holding this line is losing it.
    installedRejectionHandlers()[0]?.(new Error('too early to log'), Promise.resolve());
    expect(recorder.errors).toHaveLength(0);

    harness.becomeReady();
    await vi.waitFor(() => {
      expect(recorder.errors.map((line) => line.message)).toContain(
        'unhandled promise rejections happened before the logger existed',
      );
    });

    const flushed = recorder.errors.find(
      (line) => line.message === 'unhandled promise rejections happened before the logger existed',
    );
    expect(flushed?.fields?.['count']).toBe(1);
    expect(flushed?.fields?.['dropped']).toBe(0);
    expect(String(flushed?.fields?.['stacks'])).toContain('too early to log');
  });

  it('reports an uncaught exception on both surfaces and then exits non-zero', async () => {
    const index = await loadIndex();
    const recorder = recordingLogger();
    const close = vi.fn(async () => undefined);
    index.lifecycleTestSeam.install({
      logger: { child: () => recorder.logger, close, directory: 'C:\\fake\\logs' },
    });

    const handlers = installedUncaughtHandlers();
    expect(handlers).toHaveLength(1);
    handlers[0]?.(new Error('a handler threw halfway through'), 'uncaughtException');

    expect(recorder.errors.map((line) => line.message)).toEqual(['fatal: uncaught exception']);
    expect(harness.errorBoxes).toHaveLength(1);
    // A logger exists, so the box stays short and points at the file rather than carrying a stack.
    expect(harness.errorBoxes[0]?.content).toContain('C:\\fake\\logs');

    await vi.waitFor(() => {
      expect(harness.exitCodes).toEqual([1]);
    });
    // The log was flushed before the process left; that is the whole reason the exit is deferred.
    expect(close).toHaveBeenCalledOnce();
    expect(harness.quitCalls).toBe(0);
  });

  it('still reaches the user when the logger is the thing that broke, and does not loop', async () => {
    const index = await loadIndex();
    index.lifecycleTestSeam.install({
      logger: {
        // The likeliest single cause of a fatal in this app, and the reason a dialog fallback
        // exists at all. If this takes the report down with it, #67 is only half fixed: a throw
        // raised inside an `uncaughtException` handler is a hard exit, so the user would get
        // nothing at all - which is the silence the issue was filed about.
        child: () => {
          throw new Error('the logger is the thing that broke');
        },
        close: async () => undefined,
        directory: 'C:\\fake\\logs',
      },
    });

    const handler = installedUncaughtHandlers()[0];
    expect(handler).toBeDefined();
    expect(() => {
      handler?.(new Error('first'), 'uncaughtException');
    }).not.toThrow();
    expect(harness.errorBoxes).toHaveLength(1);

    // The re-entry a second fatal would produce. It must leave, not recurse and not re-report.
    handler?.(new Error('second'), 'uncaughtException');
    expect(harness.errorBoxes).toHaveLength(1);
    expect(harness.exitCodes).toContain(1);
  });
});

describe('the wiring itself', () => {
  it('registers exactly one handler on each lifecycle event it owns', async () => {
    await loadIndex();

    expect(harness.listenerCount('before-quit')).toBe(1);
    // #56. Present, and still doing nothing - deleting it would put that bug back.
    expect(harness.listenerCount('window-all-closed')).toBe(1);
    expect(installedUncaughtHandlers()).toHaveLength(1);
    expect(installedRejectionHandlers()).toHaveLength(1);
  });
});
