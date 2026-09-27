/**
 * Global hotkeys (issue M7-01 / #32, feature G1).
 *
 * The main use case is a game running borderless fullscreen, where the user cannot alt-tab to
 * click anything - so a shortcut that works while another window has focus is not a
 * convenience here, it is the only way in. `docs/reference-analysis.md` records that the
 * reference project has no global shortcut at all (`grep globalShortcut` returns nothing),
 * which is the gap this closes.
 *
 * ## Four ways registration fails, and all four are reported
 *
 *   1. **Another program already owns the key.** Electron's `register` returns `false`. This is
 *      the case #32 names explicitly: the user must be told *which* hotkey clashed, because
 *      "hotkeys don't work" is unactionable and "Control+Alt+S is taken" is a thing they can fix.
 *   2. **A misspelled modifier.** Checked here, before Electron sees it - see below. This is the
 *      dangerous one.
 *   3. **An unparseable accelerator.** Electron *throws* rather than returning false. That
 *      matters much more now that accelerators come from user config (#38): a typo in
 *      `config.json` must not take the app down with it.
 *   4. **Two actions bound to the same key.** Electron returns `false` for the second, exactly
 *      as it does for a foreign conflict - so without the check here, "you bound two actions to
 *      one key" would be reported as "another program has taken it", sending the user hunting
 *      for a program that does not exist.
 *
 * A failure of any kind never stops the others being registered. Losing one hotkey to a
 * conflict must not cost the user the other three.
 *
 * ## Why modifiers are validated before Electron is asked
 *
 * Measured against Electron 43's real `globalShortcut`, not assumed:
 *
 * | accelerator            | `register` returns |
 * |------------------------|--------------------|
 * | `Control+Alt+A`        | `true`             |
 * | `Control+Alt+NotAKey`  | **throws**         |
 * | `Contrl+Alt+A`         | **`true`**         |
 * | `Foo+Bar+A`            | **`true`**         |
 *
 * An unknown *key* throws, but an unknown *modifier* is silently discarded and the remaining
 * tokens are bound instead. `Contrl+Alt+A` does not fail - it registers `Alt+A`, which the
 * probe confirmed by then finding `Alt+A` already taken. `Foo+Bar+A` registers the **bare `A`
 * key**, globally, so every `A` the user types anywhere on Windows is swallowed by this app.
 *
 * A one-character slip in a config file that silently captures a letter system-wide is the
 * worst failure this service could have, and it is invisible from Electron's return value. So
 * the modifier tokens are checked against the documented set first, and a bad one is reported
 * as `invalid` rather than handed over.
 *
 * ## Not here
 *
 * What the hotkeys *do*. Handlers are injected, and the mode machine that owns the app's state
 * is #34. This service maps keys to callbacks and reports on the mapping - nothing else.
 *
 * No `electron` import: `ShortcutRegistrar` is the structural slice of `globalShortcut` this
 * needs, so Electron's real object satisfies it as-is and the tests run in plain Node. Same
 * technique, and the same reason, as `DisplayGeometry` in `utils/coordinates.ts`.
 */

import { classifyHotkeyCaution, type HotkeyCaution } from '../../shared/accelerator.js';
import { HOTKEY_ACTIONS, type HotkeyAction, type HotkeyConfig } from '../../shared/config-schema.js';
import { nullLogger, type Logger } from './logger.js';

/**
 * The part of Electron's `globalShortcut` this service uses.
 *
 * `register` returns `false` when another application holds the accelerator, and **throws** on
 * a malformed one - both are in the contract here because both are handled.
 */
export interface ShortcutRegistrar {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  unregisterAll(): void;
  isRegistered(accelerator: string): boolean;
}

/** Why an action ended up without a working key. */
export type HotkeyFailureReason =
  /** `hotkeys.<action>` is `null` - the user turned it off. Not an error. */
  | 'disabled'
  /** Another running program owns the accelerator. */
  | 'conflict'
  /** The accelerator string is not one Electron can parse. */
  | 'invalid'
  /** Another Textlens action is already bound to the same accelerator. */
  | 'duplicate';

export interface HotkeyRegistration {
  readonly action: HotkeyAction;
  /** `null` when the action is unbound in config. */
  readonly accelerator: string | null;
  readonly ok: boolean;
  /** Absent when `ok`. */
  readonly reason?: HotkeyFailureReason;
  /** Human-readable detail: the thrown message, or the action that took the key first. */
  readonly detail?: string;
  /**
   * Set only when `ok` is `true` (issue #82). A registration that failed is not live, so it
   * cannot be the thing swallowing a key from the rest of Windows - only a binding that actually
   * took effect can, which is why this is computed after `register` succeeds and never before.
   */
  readonly caution?: HotkeyCaution;
}

export type HotkeyHandlers = Readonly<Record<HotkeyAction, () => void | Promise<void>>>;

/**
 * Whether an accelerator could be taken right now. See {@link HotkeyService.probe}.
 *
 * `duplicate` is not among the reasons: this asks Windows a question, and Windows has no opinion
 * about which of *our* actions wants the key. That comparison is config's, and `ipc-handlers.ts`
 * makes it before asking this.
 */
export type HotkeyProbe =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'conflict' | 'invalid'; readonly detail?: string };

export interface HotkeyServiceOptions {
  /** Electron's `globalShortcut`, or a fake in tests. */
  readonly shortcuts: ShortcutRegistrar;
  readonly logger?: Logger;
  /** Injected clock for {@link HOTKEY_REPEAT_GUARD_MS}. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Minimum time between two presses of the same action that both run *synchronously*, before the
 * second is treated as OS auto-repeat rather than a second deliberate press (issue #82).
 *
 * Measured live: holding a bound key down produced 46 presses in 2.6s, about 31ms apart. An async
 * handler already cannot be re-entered inside a gap that small - {@link HotkeyService.#inFlight}
 * covers the whole time it is awaited - but every handler `index.ts` wires up today is a
 * synchronous wrapper (`() => { modes.snapshot(); }` discards whatever `modes.snapshot()` itself
 * returns), so `#inFlight` never sees a pending promise for any of the five real actions, and a
 * key held down fires the handler on every one of those 31ms repeats.
 *
 * 300ms is about ten times that measured interval - clear of it even on a keyboard set to a slower
 * repeat rate - while sitting below the ~500ms Windows default for how far apart two clicks must
 * be to *not* register as one double-click. A user tapping a toggle twice on purpose is not
 * usually trying to beat that clock, so this only ever discards the presses a human did not make.
 */
export const HOTKEY_REPEAT_GUARD_MS = 300;

export class HotkeyService {
  readonly #shortcuts: ShortcutRegistrar;
  readonly #log: Logger;
  readonly #now: () => number;

  /** Accelerators this service registered, so `unregisterAll` only removes its own. */
  #registered = new Map<HotkeyAction, string>();
  #results: HotkeyRegistration[] = [];
  /** Actions whose handler is still running, so a repeat press cannot overlap it. */
  #inFlight = new Set<HotkeyAction>();
  /**
   * When an action last completed *synchronously*, for {@link HOTKEY_REPEAT_GUARD_MS}. An action
   * whose handler returns a Promise never appears here - see that constant's comment - so this
   * guard only ever engages for the actions it can actually engage safely for.
   */
  #lastSyncFired = new Map<HotkeyAction, number>();

  constructor(options: HotkeyServiceOptions) {
    this.#shortcuts = options.shortcuts;
    this.#log = (options.logger ?? nullLogger()).child('hotkeys');
    this.#now = options.now ?? Date.now;
  }

  /** Every action's outcome from the last {@link register}, in `HOTKEY_ACTIONS` order. */
  get registrations(): readonly HotkeyRegistration[] {
    return this.#results;
  }

  /** Just the ones the user needs to do something about. Empty is the healthy state. */
  get failures(): readonly HotkeyRegistration[] {
    // `disabled` is a choice, not a failure, so it is not something to warn about.
    return this.#results.filter((result) => !result.ok && result.reason !== 'disabled');
  }

  /**
   * Bind every action. Replaces any previous binding, so this is also how a config change is
   * applied - registering twice must not leave the old accelerators live.
   */
  register(hotkeys: HotkeyConfig, handlers: HotkeyHandlers): readonly HotkeyRegistration[] {
    this.unregisterAll();

    const results: HotkeyRegistration[] = [];
    const claimed = new Map<string, HotkeyAction>();

    for (const action of HOTKEY_ACTIONS) {
      const accelerator = hotkeys[action];

      if (accelerator === null) {
        results.push({ action, accelerator: null, ok: false, reason: 'disabled' });
        continue;
      }

      const owner = claimed.get(accelerator);
      if (owner !== undefined) {
        // Electron would return `false` here, which is indistinguishable from a foreign
        // program holding the key - so the more useful message is only available at this level.
        results.push({
          action,
          accelerator,
          ok: false,
          reason: 'duplicate',
          detail: `already bound to "${owner}"`,
        });
        continue;
      }

      results.push(this.#registerOne(action, accelerator, handlers[action]));
      claimed.set(accelerator, action);
    }

    this.#results = results;
    this.#report(results);
    return results;
  }

  /**
   * Release every accelerator this service holds.
   *
   * Deliberately not `globalShortcut.unregisterAll()`: that would also drop shortcuts
   * registered by anything else in this process. #32's criterion is that quitting leaves
   * nothing stuck in the system, and unregistering exactly what we took satisfies it without
   * reaching past our own bookkeeping.
   */
  /**
   * Ask whether an accelerator can be taken, without keeping it (issue #39).
   *
   * The rebind flow needs an answer *before* it writes anything to disk. `Control+Alt+R` has failed
   * to register on this project's development machine every run since the hotkeys shipped, and the
   * only remedy was hand-editing JSON; a settings window that persists a key and lets the failure
   * surface afterwards would be a window that agrees with the user about a shortcut that does
   * nothing. So this registers a no-op, reads the answer, and releases it again.
   *
   * **A key this service already holds is not a conflict with a foreign program.** Electron returns
   * `false` for both, so probing `Control+Alt+S` while `snapshot` is bound to it would report that
   * another program owns it - and the other program would be us. The bookkeeping is consulted
   * first, which is the same distinction {@link register} draws for duplicates and for the same
   * reason `error-reporter.ts` gives them different messages.
   *
   * The modifier check runs first here too, so a probe can never be the thing that hands Electron
   * a string it would silently truncate.
   */
  probe(accelerator: string): HotkeyProbe {
    const badModifier = findUnknownModifier(accelerator);
    if (badModifier !== undefined) {
      return {
        ok: false,
        reason: 'invalid',
        detail: `"${badModifier}" is not a modifier; expected one of ${[...ACCELERATOR_MODIFIERS].join(', ')}`,
      };
    }

    // Ours already. Re-taking it would return `false` and read as a foreign conflict.
    for (const held of this.#registered.values()) {
      if (held === accelerator) return { ok: true };
    }

    let taken: boolean;
    try {
      taken = this.#shortcuts.register(accelerator, () => {
        // Never invoked: the accelerator is released on the next line. A no-op rather than a
        // handler, so that a keypress landing inside the probe window cannot run an action the
        // user has not finished choosing.
      });
    } catch (error) {
      return { ok: false, reason: 'invalid', detail: describeError(error) };
    }

    if (!taken) return { ok: false, reason: 'conflict' };

    try {
      this.#shortcuts.unregister(accelerator);
    } catch (error) {
      // The probe succeeded; failing to let go is still worth a line, because a key held by a
      // probe is a key nothing will ever route to a handler.
      this.#log.error('failed to release a probed hotkey', { accelerator, message: describeError(error) });
    }
    return { ok: true };
  }

  unregisterAll(): void {
    for (const [action, accelerator] of this.#registered) {
      try {
        this.#shortcuts.unregister(accelerator);
      } catch (error) {
        // Nothing to salvage, but a shortcut left registered after quit is exactly what the
        // acceptance criteria forbid, so it does not get to happen quietly.
        this.#log.error('failed to release a hotkey', { action, accelerator, message: describeError(error) });
      }
    }
    this.#registered.clear();
    this.#results = [];
    this.#inFlight.clear();
    this.#lastSyncFired.clear();
  }

  // -------------------------------------------------------------------------

  #registerOne(action: HotkeyAction, accelerator: string, handler: () => void | Promise<void>): HotkeyRegistration {
    const badModifier = findUnknownModifier(accelerator);
    if (badModifier !== undefined) {
      // Never passed to Electron: it would accept it, drop the token, and bind something else.
      return {
        action,
        accelerator,
        ok: false,
        reason: 'invalid',
        detail: `"${badModifier}" is not a modifier; expected one of ${[...ACCELERATOR_MODIFIERS].join(', ')}`,
      };
    }

    let ok: boolean;
    try {
      ok = this.#shortcuts.register(accelerator, () => {
        this.#invoke(action, handler);
      });
    } catch (error) {
      // Electron throws on an accelerator it cannot parse. Since #38 these strings come from
      // the user's config file, so this is a typo away and must not reach the top level.
      return { action, accelerator, ok: false, reason: 'invalid', detail: describeError(error) };
    }

    if (!ok) return { action, accelerator, ok: false, reason: 'conflict' };

    this.#registered.set(action, accelerator);

    // Computed for every source that reaches this point - a fresh capture, a rebind from the
    // settings window, or a string an older build already had in config.json - because this is
    // the one place all three funnel through before a key goes live (#82).
    const caution = classifyHotkeyCaution(accelerator);
    if (caution !== undefined) {
      this.#log.warn('hotkey binds a key that types normally while only Shift is held', {
        action,
        accelerator,
        typedAs: caution.typedAs,
      });
      return { action, accelerator, ok: true, caution };
    }
    return { action, accelerator, ok: true };
  }

  /**
   * Run one handler, guarding the two ways a keypress can damage something.
   *
   * **Re-entrancy.** #32 requires that hammering a hotkey does not corrupt state. A synchronous
   * handler cannot overlap itself, but an async one can - press `snapshot` twice while the
   * first is still awaiting the sidecar and two capture cycles interleave. The second press is
   * dropped rather than queued: this is a key the user is leaning on, and replaying every one
   * of those presses after the fact is not what they meant by it.
   *
   * **A throwing handler.** It must not escape into Electron's shortcut callback, where it
   * becomes an unhandled exception in the main process.
   */
  #invoke(action: HotkeyAction, handler: () => void | Promise<void>): void {
    if (this.#inFlight.has(action)) {
      this.#log.debug('ignored a hotkey press; the previous one is still running', { action });
      return;
    }

    // Auto-repeat guard (#82). Only an action that has already completed synchronously once can
    // have an entry here - see HOTKEY_REPEAT_GUARD_MS - so this never engages the first time an
    // action fires, and never engages at all for an action whose handler returns a Promise.
    const lastSyncFired = this.#lastSyncFired.get(action);
    if (lastSyncFired !== undefined && this.#now() - lastSyncFired < HOTKEY_REPEAT_GUARD_MS) {
      // A dropped press moves the window forward too. Measuring only from the last press that
      // *fired* let a key held down fire again every HOTKEY_REPEAT_GUARD_MS - about nine toggles
      // in the 2.6s hold measured live, instead of 46 but still not one. A held key keeps
      // repeating well inside the guard, so sliding the window makes the whole hold one press.
      this.#lastSyncFired.set(action, this.#now());
      this.#log.debug('ignored a hotkey press; too soon after the last one to be deliberate', { action });
      return;
    }

    this.#inFlight.add(action);
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      this.#inFlight.delete(action);
    };

    try {
      const result = handler();
      if (result instanceof Promise) {
        void result.then(done, (error: unknown) => {
          done();
          this.#log.error('a hotkey handler failed', { action, message: describeError(error) });
        });
      } else {
        this.#lastSyncFired.set(action, this.#now());
        done();
      }
    } catch (error) {
      // Still a synchronous completion, and still worth guarding against a repeat of the same
      // throw - a key held down over a handler that always throws must not spam the log forever.
      this.#lastSyncFired.set(action, this.#now());
      done();
      this.#log.error('a hotkey handler threw', { action, message: describeError(error) });
    }
  }

  #report(results: readonly HotkeyRegistration[]): void {
    for (const result of results) {
      if (result.ok) {
        this.#log.info('hotkey registered', { action: result.action, accelerator: result.accelerator });
      } else if (result.reason === 'disabled') {
        this.#log.info('hotkey is disabled in config', { action: result.action });
      } else {
        // Invariant 4, and #32's own criterion: name the one that clashed, never fail silently.
        this.#log.error('hotkey could not be registered', {
          action: result.action,
          accelerator: result.accelerator,
          reason: result.reason,
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        });
      }
    }
  }
}

/**
 * Every modifier token Electron documents for an accelerator, lowercased for comparison.
 * Electron itself is case-insensitive here (`control+alt+a` registers fine), so this is too.
 */
const ACCELERATOR_MODIFIERS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta',
]);

/**
 * The first token before the final key that is not a known modifier, or `undefined` if they
 * are all fine.
 *
 * Only the leading tokens are checked. The last token is the key itself, and Electron already
 * throws for one it does not recognise - re-implementing its key table here would be a second
 * list to keep in sync with a moving target, and it would reject valid keys the day Electron
 * adds one. The modifier set is small, stable and documented, which is why this half is worth
 * owning and the other half is not.
 *
 * A single-token accelerator (`F9`) has no modifiers and is left alone: binding a bare key is
 * a legitimate, if aggressive, choice. What this catches is a bare key the user did **not**
 * ask for, arrived at by dropping a token they misspelled.
 */
function findUnknownModifier(accelerator: string): string | undefined {
  const parts = accelerator.split('+');
  for (const part of parts.slice(0, -1)) {
    if (!ACCELERATOR_MODIFIERS.has(part.trim().toLowerCase())) return part;
  }
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
