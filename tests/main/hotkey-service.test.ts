/**
 * Issue M7-01 / #32, feature G1 - global hotkeys.
 *
 * The fake registrar below models the three behaviours of Electron's `globalShortcut` that the
 * service actually depends on, and it is worth being explicit that they are not the same shape:
 * a **conflict returns `false`**, while a **malformed accelerator throws**. A fake that only
 * returned booleans would let a service that never catches anything pass this whole file, and
 * accelerators come from the user's config now, so the throwing path is a typo away.
 *
 * What these tests cannot reach, and the brief is clear it belongs to a human: whether the key
 * actually fires over a borderless-fullscreen game. `register` returning `true` against a fake
 * proves the wiring, not the OS.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  HOTKEY_REPEAT_GUARD_MS,
  HotkeyService,
  type HotkeyHandlers,
  type ShortcutRegistrar,
} from '../../src/main/services/hotkey-service.js';
import type { LogFields, Logger } from '../../src/main/services/logger.js';
import { DEFAULT_CONFIG, type HotkeyConfig } from '../../src/shared/config-schema.js';

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

interface FakeRegistrar extends ShortcutRegistrar {
  /** Fire the callback bound to `accelerator`, as the OS would. */
  press(accelerator: string): void;
  readonly live: Map<string, () => void>;
  readonly unregistered: string[];
}

/**
 * @param taken       accelerators another program owns - `register` returns false, as Electron does
 * @param malformed   accelerators Electron cannot parse - `register` throws, as Electron does
 */
function fakeRegistrar(taken: readonly string[] = [], malformed: readonly string[] = []): FakeRegistrar {
  const live = new Map<string, () => void>();
  const unregistered: string[] = [];
  return {
    live,
    unregistered,
    register(accelerator, callback) {
      if (malformed.includes(accelerator)) throw new Error(`Invalid accelerator: ${accelerator}`);
      if (taken.includes(accelerator)) return false;
      live.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      unregistered.push(accelerator);
      live.delete(accelerator);
    },
    unregisterAll() {
      for (const accelerator of [...live.keys()]) unregistered.push(accelerator);
      live.clear();
    },
    isRegistered(accelerator) {
      return live.has(accelerator);
    },
    press(accelerator) {
      const callback = live.get(accelerator);
      if (callback === undefined) throw new Error(`nothing is bound to ${accelerator}`);
      callback();
    },
  };
}

function noopHandlers(): HotkeyHandlers {
  return {
    toggleAuto: () => {},
    snapshot: () => {},
    selectRegion: () => {},
    toggleOverlay: () => {},
    dismiss: () => {},
  };
}

const DEFAULT_HOTKEYS = DEFAULT_CONFIG.hotkeys;

describe('HotkeyService.register', () => {
  it('binds all five actions and reports no failure', () => {
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });

    const results = service.register(DEFAULT_HOTKEYS, noopHandlers());

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => result.action)).toEqual([
      'toggleAuto',
      'snapshot',
      'selectRegion',
      'toggleOverlay',
      'dismiss',
    ]);
    expect(service.failures).toEqual([]);
    expect([...shortcuts.live.keys()]).toHaveLength(5);
  });

  it('routes each accelerator to its own handler', () => {
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });
    const calls: string[] = [];
    service.register(DEFAULT_HOTKEYS, {
      toggleAuto: () => {
        calls.push('toggleAuto');
      },
      snapshot: () => {
        calls.push('snapshot');
      },
      selectRegion: () => {
        calls.push('selectRegion');
      },
      toggleOverlay: () => {
        calls.push('toggleOverlay');
      },
      dismiss: () => {
        calls.push('dismiss');
      },
    });

    shortcuts.press(DEFAULT_HOTKEYS.snapshot ?? '');
    shortcuts.press(DEFAULT_HOTKEYS.toggleOverlay ?? '');
    shortcuts.press(DEFAULT_HOTKEYS.dismiss ?? '');

    // Order and identity both matter: a service that bound every key to the last handler in
    // the loop would still fire something for each press.
    expect(calls).toEqual(['snapshot', 'toggleOverlay', 'dismiss']);
  });

  it('names the clashing hotkey when another program owns the key, and keeps the rest', () => {
    const taken = DEFAULT_HOTKEYS.snapshot ?? '';
    const shortcuts = fakeRegistrar([taken]);
    const { logger, lines } = collectingLogger();
    const service = new HotkeyService({ shortcuts, logger });

    const results = service.register(DEFAULT_HOTKEYS, noopHandlers());

    const failure = service.failures[0];
    expect(service.failures).toHaveLength(1);
    expect(failure?.action).toBe('snapshot');
    expect(failure?.accelerator).toBe(taken);
    expect(failure?.reason).toBe('conflict');
    // Losing one key must not cost the user the other four.
    expect(results.filter((result) => result.ok)).toHaveLength(4);

    // #32: "แจ้งผู้ใช้ระบุตัวที่ชน ไม่ล้มเงียบ" - the log must name it, not just count it.
    const logged = lines.find((line) => line.level === 'error');
    expect(logged?.fields).toMatchObject({ action: 'snapshot', accelerator: taken, reason: 'conflict' });
  });

  it('survives an accelerator Electron cannot parse, which user config makes reachable', () => {
    // Measured: Electron 43 throws for an unknown *key* token (`Control+Alt+NotAKey`).
    const shortcuts = fakeRegistrar([], ['Control+Alt+NotAKey']);
    const hotkeys: HotkeyConfig = { ...DEFAULT_HOTKEYS, toggleAuto: 'Control+Alt+NotAKey' };
    const service = new HotkeyService({ shortcuts });

    // The throw must be caught: a typo in config.json cannot be allowed to take down startup.
    const results = service.register(hotkeys, noopHandlers());

    expect(results[0]).toMatchObject({ action: 'toggleAuto', reason: 'invalid' });
    expect(results[0]?.detail).toContain('Invalid accelerator');
    expect(results.filter((result) => result.ok)).toHaveLength(4);
  });

  it('refuses a misspelled modifier instead of letting Electron silently rebind it', () => {
    // Measured against real Electron 43: `register('Contrl+Alt+A')` returns **true** and binds
    // `Alt+A` - the unknown token is discarded, not rejected. The fake registrar accepts it for
    // the same reason, so this test fails unless the service checks before handing it over.
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });

    const results = service.register({ ...DEFAULT_HOTKEYS, toggleAuto: 'Contrl+Alt+A' }, noopHandlers());

    expect(results[0]).toMatchObject({ action: 'toggleAuto', reason: 'invalid' });
    expect(results[0]?.detail).toContain('Contrl');
    // Nothing was bound: not the key the user asked for, and not the one Electron would
    // have substituted for it either.
    expect(shortcuts.isRegistered('Contrl+Alt+A')).toBe(false);
    expect(shortcuts.isRegistered('Alt+A')).toBe(false);
  });

  it('refuses an accelerator that would leave a bare key bound globally', () => {
    // Measured: `register('Foo+Bar+A')` returns true and binds the bare `A` key process-wide,
    // so every `A` typed anywhere in Windows is swallowed. The worst outcome available here,
    // and it is one character away in a hand-edited config file.
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });

    const results = service.register({ ...DEFAULT_HOTKEYS, snapshot: 'Foo+Bar+A' }, noopHandlers());

    expect(results[1]).toMatchObject({ action: 'snapshot', reason: 'invalid' });
    expect(shortcuts.live.size).toBe(4);
  });

  it('accepts every modifier Electron documents, in any case, and a bare key on purpose', () => {
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });

    const results = service.register(
      {
        toggleAuto: 'CommandOrControl+Alt+A',
        snapshot: 'control+shift+s',
        selectRegion: 'Super+AltGr+Meta+Option+R',
        // A deliberate single-key binding is the user's call - what the check above catches is
        // a bare key the user did not ask for.
        toggleOverlay: 'F9',
        dismiss: 'Control+Alt+D',
      },
      noopHandlers(),
    );

    expect(results.every((result) => result.ok)).toBe(true);
  });

  it('reports a key bound to two actions instead of letting the second silently win', () => {
    const shared = 'Control+Alt+A';
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });
    const calls: string[] = [];

    const results = service.register(
      { ...DEFAULT_HOTKEYS, toggleAuto: shared, snapshot: shared },
      {
        ...noopHandlers(),
        toggleAuto: () => {
          calls.push('toggleAuto');
        },
        snapshot: () => {
          calls.push('snapshot');
        },
      },
    );

    expect(results[1]).toMatchObject({ action: 'snapshot', reason: 'duplicate' });
    expect(results[1]?.detail).toContain('toggleAuto');
    // The first binding is the one that survives, and it still works.
    shortcuts.press(shared);
    expect(calls).toEqual(['toggleAuto']);
  });

  it('treats a null accelerator as a deliberate choice, not a failure', () => {
    const shortcuts = fakeRegistrar();
    const { logger, lines } = collectingLogger();
    const service = new HotkeyService({ shortcuts, logger });

    const results = service.register({ ...DEFAULT_HOTKEYS, selectRegion: null }, noopHandlers());

    expect(results[2]).toMatchObject({ action: 'selectRegion', accelerator: null, reason: 'disabled' });
    // Unbinding is the documented escape hatch from a conflict, so it must not be reported
    // back to the user as a problem they need to fix.
    expect(service.failures).toEqual([]);
    expect(lines.some((line) => line.level === 'error')).toBe(false);
    expect([...shortcuts.live.keys()]).toHaveLength(4);
  });

  it('releases the previous accelerators when called again', () => {
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });
    service.register(DEFAULT_HOTKEYS, noopHandlers());

    service.register({ ...DEFAULT_HOTKEYS, toggleAuto: 'Control+Alt+Z' }, noopHandlers());

    // Re-registering is how a config change is applied; the old key must not stay live, or the
    // user ends up with both the key they changed and the one they changed it to.
    expect(shortcuts.unregistered).toContain('Control+Alt+A');
    expect(shortcuts.isRegistered('Control+Alt+A')).toBe(false);
    expect(shortcuts.isRegistered('Control+Alt+Z')).toBe(true);
    expect([...shortcuts.live.keys()]).toHaveLength(5);
  });
});

/**
 * Registering a `caution` accelerator - one whose only modifier is Shift, or none at all, and
 * whose key types a character (issue #82). Registration itself is untouched: `ok` is exactly what
 * it would have been without this, on every path below.
 */
describe('HotkeyService.register: hotkey caution (#82)', () => {
  it('flags a successfully-registered Shift+Space, and still reports ok', () => {
    const shortcuts = fakeRegistrar();
    const { logger, lines } = collectingLogger();
    const service = new HotkeyService({ shortcuts, logger });

    const results = service.register({ ...DEFAULT_HOTKEYS, snapshot: 'Shift+Space' }, noopHandlers());

    expect(results[1]).toMatchObject({
      action: 'snapshot',
      accelerator: 'Shift+Space',
      ok: true,
      caution: { reason: 'typing-key', typedAs: 'a space' },
    });
    expect(shortcuts.isRegistered('Shift+Space')).toBe(true);
    // #82: logged, not just returned - the log must not be the only place this is visible, but it
    // must still be there for anyone who does look.
    const warned = lines.find((line) => line.level === 'warn');
    expect(warned?.fields).toMatchObject({ action: 'snapshot', accelerator: 'Shift+Space', typedAs: 'a space' });
  });

  it('does not flag an ordinary accelerator', () => {
    const shortcuts = fakeRegistrar();
    const { lines } = collectingLogger();
    const service = new HotkeyService({ shortcuts });

    const results = service.register(DEFAULT_HOTKEYS, noopHandlers());

    for (const result of results) expect(result.caution).toBeUndefined();
    expect(lines.some((line) => line.level === 'warn')).toBe(false);
  });

  it('does not flag a registration that failed - nothing is live to swallow a key', () => {
    const taken = 'Shift+Space';
    const shortcuts = fakeRegistrar([taken]);
    const service = new HotkeyService({ shortcuts });

    const results = service.register({ ...DEFAULT_HOTKEYS, snapshot: taken }, noopHandlers());

    expect(results[1]).toMatchObject({ action: 'snapshot', ok: false, reason: 'conflict' });
    expect(results[1]?.caution).toBeUndefined();
  });

  it('computes the same caution regardless of source - config default, rebind, or an older build', () => {
    // #82 asked for one code path that every source funnels through. There is only one call site
    // (`#registerOne`), so a config-sourced accelerator and one from `acceleratorFromKeyStroke`
    // land on the same result as long as the string is the same.
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });

    const results = service.register({ ...DEFAULT_HOTKEYS, toggleOverlay: 'Shift+.' }, noopHandlers());

    expect(results[3]).toMatchObject({
      action: 'toggleOverlay',
      caution: { reason: 'typing-key', typedAs: 'a period' },
    });
  });
});

describe('HotkeyService.unregisterAll', () => {
  it('releases every key it took, so nothing is left registered after quit', () => {
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });
    service.register(DEFAULT_HOTKEYS, noopHandlers());

    service.unregisterAll();

    expect(shortcuts.live.size).toBe(0);
    expect(shortcuts.unregistered).toHaveLength(5);
    expect(service.registrations).toEqual([]);
  });

  it('releases only its own keys, never everything in the process', () => {
    const shortcuts = fakeRegistrar();
    // Something else in this process holds a shortcut - `globalShortcut` is process-wide.
    shortcuts.register('Control+Alt+Q', () => {});
    const service = new HotkeyService({ shortcuts });
    service.register(DEFAULT_HOTKEYS, noopHandlers());

    service.unregisterAll();

    // A service that reached for `unregisterAll()` on the registrar would have dropped this.
    expect(shortcuts.isRegistered('Control+Alt+Q')).toBe(true);
  });

  it('keeps going when releasing one key throws', () => {
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });
    service.register(DEFAULT_HOTKEYS, noopHandlers());
    const failing = vi.spyOn(shortcuts, 'unregister').mockImplementationOnce(() => {
      throw new Error('nope');
    });

    expect(() => service.unregisterAll()).not.toThrow();

    expect(failing).toHaveBeenCalledTimes(5);
  });
});

describe('HotkeyService key repeat', () => {
  it('lets synchronous presses through every time, spaced at human speed', () => {
    const shortcuts = fakeRegistrar();
    let now = 0;
    const service = new HotkeyService({ shortcuts, now: () => now });
    let calls = 0;
    service.register(DEFAULT_HOTKEYS, {
      ...noopHandlers(),
      toggleAuto: () => {
        calls += 1;
      },
    });

    // Three deliberate presses, each a clear guard interval apart - not the ~31ms auto-repeat
    // #82 measured live. Two toggles are a toggle back, not corruption - suppressing these would
    // swallow a deliberate double-tap.
    const accelerator = DEFAULT_HOTKEYS.toggleAuto ?? '';
    shortcuts.press(accelerator);
    now += HOTKEY_REPEAT_GUARD_MS;
    shortcuts.press(accelerator);
    now += HOTKEY_REPEAT_GUARD_MS;
    shortcuts.press(accelerator);

    expect(calls).toBe(3);
  });

  it('drops a repeat press while an async handler is still running', async () => {
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });
    let started = 0;
    let release: (() => void) | undefined;
    service.register(DEFAULT_HOTKEYS, {
      ...noopHandlers(),
      snapshot: async () => {
        started += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    const accelerator = DEFAULT_HOTKEYS.snapshot ?? '';
    shortcuts.press(accelerator);
    shortcuts.press(accelerator);
    expect(started).toBe(1);

    // Once it finishes, the next press is accepted again - this is a guard, not a latch.
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    shortcuts.press(accelerator);
    expect(started).toBe(2);
  });

  it('does not wedge the action when an async handler rejects', async () => {
    const shortcuts = fakeRegistrar();
    const { logger, lines } = collectingLogger();
    const service = new HotkeyService({ shortcuts, logger });
    let calls = 0;
    service.register(DEFAULT_HOTKEYS, {
      ...noopHandlers(),
      snapshot: async () => {
        calls += 1;
        await Promise.reject(new Error('handler blew up'));
      },
    });

    const accelerator = DEFAULT_HOTKEYS.snapshot ?? '';
    shortcuts.press(accelerator);
    await Promise.resolve();
    await Promise.resolve();
    shortcuts.press(accelerator);

    // A guard that only cleared on success would leave the hotkey dead for the whole session
    // after one failure.
    expect(calls).toBe(2);
    expect(lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('does not let a throwing handler escape into the shortcut callback', () => {
    const shortcuts = fakeRegistrar();
    const { logger, lines } = collectingLogger();
    let now = 0;
    const service = new HotkeyService({ shortcuts, logger, now: () => now });
    service.register(DEFAULT_HOTKEYS, {
      ...noopHandlers(),
      toggleAuto: () => {
        throw new Error('handler blew up');
      },
    });

    const accelerator = DEFAULT_HOTKEYS.toggleAuto ?? '';
    // Unhandled here would be an uncaught exception in the main process. Spaced past the repeat
    // guard, so this is testing the throw path, not the guard added for #82 (that has its own
    // describe block below).
    expect(() => shortcuts.press(accelerator)).not.toThrow();
    now += HOTKEY_REPEAT_GUARD_MS;
    expect(() => shortcuts.press(accelerator)).not.toThrow();
    expect(lines.filter((line) => line.level === 'error')).toHaveLength(2);
  });
});

/**
 * The auto-repeat guard itself (issue #82).
 *
 * `index.ts` wires every action's handler as `() => { modes.snapshot(); }` - a block statement
 * that discards whatever `modes.snapshot()` returns, so `#invoke` never sees a Promise for any of
 * the five real actions and the pre-existing `#inFlight` guard (tested above) never engages for
 * them. This is the guard that actually stops a held key from firing dozens of times.
 */
describe('HotkeyService key repeat: the auto-repeat guard (#82)', () => {
  it('drops a repeat press of a synchronous action inside the guard interval', () => {
    const shortcuts = fakeRegistrar();
    let now = 0;
    const service = new HotkeyService({ shortcuts, now: () => now });
    let calls = 0;
    service.register(DEFAULT_HOTKEYS, {
      ...noopHandlers(),
      toggleOverlay: () => {
        calls += 1;
      },
    });

    // 31ms apart, matching what a held key was measured to produce live.
    const accelerator = DEFAULT_HOTKEYS.toggleOverlay ?? '';
    shortcuts.press(accelerator);
    now += 31;
    shortcuts.press(accelerator);
    now += 31;
    shortcuts.press(accelerator);

    expect(calls).toBe(1);
  });

  it('treats a key held for seconds as one press, not one per guard interval', () => {
    const shortcuts = fakeRegistrar();
    let now = 0;
    const service = new HotkeyService({ shortcuts, now: () => now });
    let calls = 0;
    service.register(DEFAULT_HOTKEYS, {
      ...noopHandlers(),
      toggleOverlay: () => {
        calls += 1;
      },
    });

    // The live measurement: 46 repeats about 31ms apart over ~2.6s. Measuring only from the last
    // press that fired would let one through every HOTKEY_REPEAT_GUARD_MS of the hold.
    const accelerator = DEFAULT_HOTKEYS.toggleOverlay ?? '';
    for (let i = 0; i < 46; i += 1) {
      shortcuts.press(accelerator);
      now += 31;
    }
    expect(calls).toBe(1);

    // Released, then pressed again deliberately: that one still counts.
    now += HOTKEY_REPEAT_GUARD_MS;
    shortcuts.press(accelerator);
    expect(calls).toBe(2);
  });

  it('accepts the next press once the guard interval has fully passed', () => {
    const shortcuts = fakeRegistrar();
    let now = 0;
    const service = new HotkeyService({ shortcuts, now: () => now });
    let calls = 0;
    service.register(DEFAULT_HOTKEYS, {
      ...noopHandlers(),
      toggleOverlay: () => {
        calls += 1;
      },
    });

    const accelerator = DEFAULT_HOTKEYS.toggleOverlay ?? '';
    shortcuts.press(accelerator);
    now += HOTKEY_REPEAT_GUARD_MS;
    shortcuts.press(accelerator);

    expect(calls).toBe(2);
  });

  it('does not apply the synchronous guard to an async action, which #inFlight already covers', async () => {
    const shortcuts = fakeRegistrar();
    // No `now` injected: real time between these two calls, in the same tick, is far less than
    // HOTKEY_REPEAT_GUARD_MS. If the guard applied here too, the second press would be dropped.
    const service = new HotkeyService({ shortcuts });
    let calls = 0;
    service.register(DEFAULT_HOTKEYS, {
      ...noopHandlers(),
      snapshot: async () => {
        calls += 1;
      },
    });

    const accelerator = DEFAULT_HOTKEYS.snapshot ?? '';
    shortcuts.press(accelerator);
    await Promise.resolve();
    await Promise.resolve();
    shortcuts.press(accelerator);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toBe(2);
  });
});

/**
 * Asking whether a key can be taken, without taking it (issue M9-02 / #39).
 *
 * The rebind flow needs an answer before it persists anything. `Control+Alt+R` has failed to
 * register on this project's development machine every run since hotkeys shipped, and the only
 * remedy was hand-editing JSON - which the settings window exists to replace. A window that wrote
 * the key first and surfaced the failure afterwards would agree with the user about a shortcut
 * that does nothing.
 */
describe('HotkeyService.probe', () => {
  it('reports a free accelerator as available and does not keep it', () => {
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });

    expect(service.probe('Control+Alt+G')).toEqual({ ok: true });
    // Nothing is left behind: a key held by a probe is a key nothing will ever route to a handler.
    expect(shortcuts.live.has('Control+Alt+G')).toBe(false);
    expect(shortcuts.unregistered).toContain('Control+Alt+G');
  });

  it('reports a key another program owns as a conflict', () => {
    const shortcuts = fakeRegistrar(['Control+Alt+R']);
    const service = new HotkeyService({ shortcuts });

    expect(service.probe('Control+Alt+R')).toEqual({ ok: false, reason: 'conflict' });
  });

  it('does not call our own binding a foreign conflict', () => {
    // Electron returns `false` both for a foreign program and for a key this process already
    // holds. Probing an action's current key would otherwise report that another program owns it -
    // and the other program would be us.
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });
    service.register(DEFAULT_HOTKEYS, noopHandlers());

    expect(service.probe(DEFAULT_HOTKEYS.snapshot ?? '')).toEqual({ ok: true });
    // And the real binding is still live - the probe did not release it on the way past.
    expect(shortcuts.live.has(DEFAULT_HOTKEYS.snapshot ?? '')).toBe(true);
  });

  it('rejects a misspelled modifier without letting Electron see it', () => {
    // The trap this service exists for: `register('Contrl+Alt+A')` returns **true** against real
    // Electron 43 and binds `Alt+A` instead. A probe that handed the string over would answer
    // "yes, that works" about a binding the user did not ask for.
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });

    const result = service.probe('Contrl+Alt+A');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('invalid');
    expect(shortcuts.live.size).toBe(0);
  });

  it('rejects an accelerator Electron cannot parse, rather than throwing', () => {
    const shortcuts = fakeRegistrar([], ['Control+Alt+NotAKey']);
    const service = new HotkeyService({ shortcuts });

    const result = service.probe('Control+Alt+NotAKey');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('invalid');
    expect(result.detail).toContain('Invalid accelerator');
  });

  it('never fires an action while the user is still choosing a key', () => {
    // The callback registered during a probe is a no-op on purpose: a keypress landing inside the
    // probe window must not run an action the user has not finished picking.
    const shortcuts = fakeRegistrar();
    const service = new HotkeyService({ shortcuts });
    let fired = 0;
    service.register(DEFAULT_HOTKEYS, { ...noopHandlers(), snapshot: () => { fired += 1; } });

    let pressedDuringProbe: (() => void) | undefined;
    const originalRegister = shortcuts.register.bind(shortcuts);
    shortcuts.register = (accelerator, callback) => {
      if (accelerator === 'Control+Alt+G') pressedDuringProbe = callback;
      return originalRegister(accelerator, callback);
    };

    service.probe('Control+Alt+G');
    pressedDuringProbe?.();

    expect(fired).toBe(0);
  });
});
