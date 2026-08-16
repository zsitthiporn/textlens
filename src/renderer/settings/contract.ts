/**
 * The main <-> settings-window message contract (issue M9-02 / #39, feature ST4).
 *
 * Same arrangement, and the same reasons, as `overlay/contract.ts` and `region-picker/contract.ts`:
 * the renderer bundle is built by Vite with no Node types and no `electron`, so the shapes that
 * cross the bridge are declared here and the main process is type-checked *against* them at the
 * call site. A field renamed on one side stops the other side compiling rather than producing a
 * window that reads `undefined`.
 *
 * ## What this window is for
 *
 * Everything in this app already works and, until now, none of it could be seen or changed. Four
 * gaps were each accepted on the promise that this issue would close them, and each one is a
 * field or a panel below:
 *
 *   - config schema errors reached the log and a getter ({@link SettingsState.issues});
 *   - a hotkey that will not register had no remedy but hand-editing JSON
 *     ({@link SettingsHotkeyRequest});
 *   - there was no way to choose a display ({@link SettingsState.monitors});
 *   - a failed config write was only ever logged ({@link SettingsState.issues} again, now
 *     republished after every write rather than read once at boot).
 *
 * ## Types are mirrored, not imported
 *
 * `ConfigIssue` lives beside `node:fs` in `main/services/config.ts`, `MonitorChoice` beside
 * Electron's `screen`, and `Alert` beside the tray. None of those may be pulled into a bundle
 * that runs with `nodeIntegration: false`. The shapes are restated here and the main process
 * assigns its own values into these types, which is where the drift becomes a compile error.
 *
 * `Config` and `ConfigOverride` are the exception: they are `import type` from
 * `shared/config-schema.ts`, which is a **type-only** import on purpose. The module has a
 * value-level `zod` import, and taking the types alone keeps zod out of the renderer bundle.
 * Validation is not duplicated here either - the main process validates every write and returns
 * {@link SettingsFieldError}s with the offending path, so there is one validator and the window
 * shows what it said.
 */

import type { Config, ConfigOverride, HotkeyAction } from '../../shared/config-schema.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Mirrors `ConfigIssueKind` in `src/main/services/config.ts`. */
export type SettingsIssueKind = 'unreadable' | 'malformed' | 'invalid' | 'not-persisted';

/** Mirrors `ConfigFieldError` in `src/shared/config-schema.ts`. */
export interface SettingsFieldError {
  readonly path: string;
  readonly message: string;
}

/** Mirrors `ConfigIssue` in `src/main/services/config.ts`. */
export interface SettingsIssue {
  readonly kind: SettingsIssueKind;
  readonly message: string;
  readonly fields: readonly SettingsFieldError[];
}

/** Mirrors `MonitorChoice` in `src/main/services/monitor-service.ts` (#28's picker rows). */
export interface SettingsMonitor {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
  readonly primary: boolean;
}

/** Mirrors `HotkeyRegistration` in `src/main/services/hotkey-service.ts`. */
export interface SettingsHotkey {
  readonly action: HotkeyAction;
  readonly accelerator: string | null;
  readonly ok: boolean;
  readonly reason?: 'disabled' | 'conflict' | 'invalid' | 'duplicate';
  readonly detail?: string;
}

/** Mirrors `AppMode` in `src/main/services/app-orchestrator.ts`. */
export type SettingsMode = 'idle' | 'auto' | 'paused' | 'snapshot';

/** Mirrors `AlertSeverity` in `src/main/services/error-reporter.ts`. */
export type SettingsAlertSeverity = 'fatal' | 'error' | 'warning' | 'info';

/** Mirrors `Alert`, minus the source key, which the window has no use for. */
export interface SettingsAlert {
  readonly severity: SettingsAlertSeverity;
  readonly cause: string;
  readonly remedy: string;
}

/**
 * The capture engine's supervision state (#40), as something to put next to a light.
 *
 * `detail` carries the retry countdown or the exit reason - whatever `SupervisorStatus` had to say
 * that a single word cannot. Mirrors the `state` union in `sidecar-supervisor.ts`.
 */
export interface SettingsSidecar {
  readonly state: 'initial' | 'starting' | 'running' | 'backoff' | 'gave-up' | 'stopped' | 'disposed';
  readonly detail: string | null;
}

/**
 * Everything the window draws, in one message.
 *
 * One object rather than a channel per panel: the panels are not independent - a monitor change
 * moves the region, a region change clears a warning, a failed write adds an issue - and separate
 * messages would let the window render a combination that was never true at any instant.
 */
export interface SettingsState {
  /** The effective config: bundled defaults with the user's overrides on top. */
  readonly config: Config;
  /** Absolute path of the user override file, shown so a user can find it. */
  readonly configPath: string;
  /** Everything that stopped the config being fully applied. Empty is the healthy state. */
  readonly issues: readonly SettingsIssue[];
  /** Paired monitors, in left-to-right order. Empty until `listMonitors` has answered. */
  readonly monitors: readonly SettingsMonitor[];
  /** Every hotkey's real registration outcome, in `HOTKEY_ACTIONS` order. */
  readonly hotkeys: readonly SettingsHotkey[];
  readonly mode: SettingsMode;
  readonly overlayVisible: boolean;
  /** The single worst standing condition, or `null`. The same one the overlay banner shows. */
  readonly alert: SettingsAlert | null;
  readonly sidecar: SettingsSidecar;
  /**
   * Translation engines in fallback order, as actually constructed.
   *
   * Read-only in the UI, and that is a statement about the app rather than about this window:
   * `translator/registry.ts` has exactly one engine registered (`google`), because T4 - the
   * OpenAI-compatible adapter that would be the second - is P1 and not built. A dropdown with one
   * option that claims to be a choice is worse than a line of text that says what is in use.
   */
  readonly engines: readonly string[];
  /** Source and target language tags actually in force. See {@link SettingsState.engines}. */
  readonly srcLang: string;
  readonly tgtLang: string;
  /** True once a capture region has been chosen. Drives the first-run prompt (#51). */
  readonly hasRegion: boolean;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** What `ConfigService.set` said. Mirrors `ConfigSetResult`. */
export interface SettingsWriteResult {
  /** False when the change failed validation, in which case nothing changed at all. */
  readonly applied: boolean;
  /** False when the change is live for this session but could not be written to disk. */
  readonly persisted: boolean;
  /** Populated when `applied` is false. `path` is dotted, e.g. `capture.intervalActive`. */
  readonly errors: readonly SettingsFieldError[];
}

/**
 * A rebind, carrying an accelerator that came from a **captured keystroke**.
 *
 * `null` unbinds the action, which `hotkeyConfigSchema` models explicitly and #32 requires: a user
 * whose key collides with another program needs somewhere to go, and "accept a key that does not
 * work" is not it.
 *
 * The string is never typed by hand. `shared/accelerator.ts` is the only thing that produces it,
 * from `KeyboardEvent.code` plus the modifier flags, because Electron silently discards a
 * misspelled modifier and binds what is left - `Contrl+Alt+A` registers `Alt+A`, and `Foo+Bar+A`
 * registers the bare `A` key process-wide while `register` reports success.
 */
export interface SettingsHotkeyRequest {
  readonly action: HotkeyAction;
  readonly accelerator: string | null;
}

/**
 * Whether the rebind took, and why not.
 *
 * A rebind that cannot register is **not persisted**. Writing a dead key to disk would leave the
 * user with a settings window that agrees with them and a shortcut that does nothing, which is the
 * shape of failure invariant 4 exists to forbid.
 */
export interface SettingsHotkeyResult {
  readonly ok: boolean;
  /** Absent when `ok`. Names the conflict in the user's terms. */
  readonly message?: string;
}

/**
 * The actions the window can ask for that are not a config write.
 *
 * One channel with a union rather than a channel each: every one of these is a fire-and-forget
 * request to something that already exists, and the state that comes back is the same push every
 * other change produces.
 */
export type SettingsCommand =
  | 'selectRegion'
  | 'clearRegion'
  | 'toggleAuto'
  | 'pause'
  | 'resume'
  | 'snapshot'
  | 'toggleOverlay'
  | 'restartSidecar'
  | 'reloadConfig';

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const SETTINGS_STATE_CHANNEL = 'textlens:settings-state';
export const SETTINGS_REQUEST_CHANNEL = 'textlens:settings-request';
export const SETTINGS_CONFIG_CHANNEL = 'textlens:settings-config';
export const SETTINGS_HOTKEY_CHANNEL = 'textlens:settings-hotkey';
export const SETTINGS_COMMAND_CHANNEL = 'textlens:settings-command';

/** Same compile-time drift guard as the overlay's channels; see `overlay/contract.ts`. */
export type SettingsStateChannel = typeof SETTINGS_STATE_CHANNEL;
export type SettingsRequestChannel = typeof SETTINGS_REQUEST_CHANNEL;
export type SettingsConfigChannel = typeof SETTINGS_CONFIG_CHANNEL;
export type SettingsHotkeyChannel = typeof SETTINGS_HOTKEY_CHANNEL;
export type SettingsCommandChannel = typeof SETTINGS_COMMAND_CHANNEL;

/**
 * The settings half of the preload bridge, exposed as `window.textlensSettings`.
 *
 * A fourth `exposeInMainWorld` key rather than a field on `textlens`, for the reason the overlay
 * and picker bridges each got their own: every window in this app loads one preload, and the
 * overlay must never hold a capability that writes config. The main process filters by sender as
 * well - a key on `window` is not an authorisation.
 */
export interface SettingsBridge {
  /** Subscribe to state pushes. Returns an unsubscribe. */
  onState(listener: (state: SettingsState) => void): () => void;
  /** Ask for the state now, at boot. */
  request(): Promise<SettingsState>;
  /** Write a config change. Validation happens in the main process; errors name the field. */
  setConfig(change: ConfigOverride): Promise<SettingsWriteResult>;
  /** Rebind one hotkey from a captured keystroke. */
  setHotkey(request: SettingsHotkeyRequest): Promise<SettingsHotkeyResult>;
  /** Run one of the non-config actions. */
  command(command: SettingsCommand): Promise<void>;
}
