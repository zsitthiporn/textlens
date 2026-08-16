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
}

export type HotkeyHandlers = Readonly<Record<HotkeyAction, () => void | Promise<void>>>;

export interface HotkeyServiceOptions {
  /** Electron's `globalShortcut`, or a fake in tests. */
  readonly shortcuts: ShortcutRegistrar;
  readonly logger?: Logger;
}

export class HotkeyService {
  readonly #shortcuts: ShortcutRegistrar;
  readonly #log: Logger;

  /** Accelerators this service registered, so `unregisterAll` only removes its own. */
  #registered = new Map<HotkeyAction, string>();
  #results: HotkeyRegistration[] = [];
  /** Actions whose handler is still running, so a repeat press cannot overlap it. */
  #inFlight = new Set<HotkeyAction>();

  constructor(options: HotkeyServiceOptions) {
    this.#shortcuts = options.shortcuts;
    this.#log = (options.logger ?? nullLogger()).child('hotkeys');
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
        done();
      }
    } catch (error) {
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
