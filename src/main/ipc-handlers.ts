/**
 * The settings window's main-process half (issue M9-02 / #39, feature ST4).
 *
 * Everything this app does has worked for several milestones and none of it could be seen or
 * changed. This module is the seam where that stops: it assembles one {@link SettingsState} out of
 * the eight services that each own a piece of the answer, answers the four requests the window can
 * make, and pushes a fresh state whenever any of those services says something changed.
 *
 * ## Why the dependencies are structural
 *
 * No `electron` import, the same as everything under `services/`. The window's identity arrives as
 * {@link SettingsIpcOptions.isTrustedSender} and the channel plumbing as {@link IpcHost}, so
 * `index.ts` supplies the two Electron-shaped things and the decisions in here are testable in the
 * plain Node environment this project's tests run in. That matters more for this file than for
 * most: it is the only place in the app where a *renderer* can change what the main process does,
 * and the rules about which requests are honoured should not be reachable only through a live
 * window.
 *
 * ## Sender filtering is not optional
 *
 * Every window in this app loads one preload. `pickRegion` and `onOverlayDrawn` both already filter
 * by sender for that reason, and the reason is sharper here: these channels write config and open
 * windows. A capability on `window.textlensSettings` is not an authorisation - the check is.
 *
 * ## One state, one push
 *
 * The window never assembles a view from several messages. Config, hotkeys, monitors, mode, the
 * supervisor and the alert are not independent - choosing a monitor drops the region, dropping the
 * region raises a warning, a failed write adds an issue - and a panel-per-channel design lets the
 * window render a combination that was never true at any single instant. So there is one message
 * and everything that can change it calls {@link SettingsIpc.publish}.
 */

import type {
  SettingsAlert,
  SettingsCommand,
  SettingsCommandChannel,
  SettingsConfigChannel,
  SettingsHotkey,
  SettingsHotkeyChannel,
  SettingsHotkeyRequest,
  SettingsHotkeyResult,
  SettingsIssue,
  SettingsMonitor,
  SettingsRequestChannel,
  SettingsState,
  SettingsStateChannel,
  SettingsWriteResult,
} from '../renderer/settings/contract.js';
import { HOTKEY_ACTIONS, type Config, type ConfigOverride, type HotkeyAction } from '../shared/config-schema.js';
import type { AppStatus } from './services/app-orchestrator.js';
import type { ConfigIssue, ConfigSetResult } from './services/config.js';
import type { Alert } from './services/error-reporter.js';
import type { HotkeyProbe, HotkeyRegistration } from './services/hotkey-service.js';
import { nullLogger, type Logger } from './services/logger.js';
import type { MonitorChoice } from './services/monitor-service.js';

/**
 * The channel names, written out rather than imported as values.
 *
 * `contract.ts` lives in the renderer tree, which Vite bundles into `dist/renderer` with
 * `emptyOutDir: true`. A *value* import from here would have tsc emit a copy at
 * `dist/renderer/settings/contract.js` - which `vite build`, running second, then deletes. The
 * result is a main process that fails to resolve a module at launch, and it would pass every
 * typecheck on the way there. `window-manager.ts` and `src/preload/index.cts` carry the same
 * literals for the same reason.
 *
 * The **type** crosses fine, and annotating each literal with it means renaming a channel in
 * `contract.ts` is a compile error here rather than a handler nobody ever calls.
 */
const SETTINGS_STATE_CHANNEL: SettingsStateChannel = 'textlens:settings-state';
const SETTINGS_REQUEST_CHANNEL: SettingsRequestChannel = 'textlens:settings-request';
const SETTINGS_CONFIG_CHANNEL: SettingsConfigChannel = 'textlens:settings-config';
const SETTINGS_HOTKEY_CHANNEL: SettingsHotkeyChannel = 'textlens:settings-hotkey';
const SETTINGS_COMMAND_CHANNEL: SettingsCommandChannel = 'textlens:settings-command';

/**
 * The channel plumbing, as the two verbs this needs.
 *
 * `handle` is request/response (Electron's `ipcMain.handle`), `send` is the push to the window.
 * `send` returns whether there was a window to send to, so {@link SettingsIpc.publish} can be
 * called unconditionally by every subscriber without each of them having to know whether the
 * settings window is currently open.
 */
export interface IpcHost {
  handle(channel: string, handler: (senderId: number, payload: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
  send(channel: string, message: SettingsState): boolean;
}

/** The part of `ConfigService` this needs. */
export interface SettingsConfigSource {
  readonly current: Config;
  readonly filePath: string;
  readonly issues: readonly ConfigIssue[];
  set(change: ConfigOverride): Promise<ConfigSetResult>;
  reload(): Promise<void>;
}

/** The part of `AppOrchestrator` this needs. */
export interface SettingsModeSource {
  readonly status: AppStatus;
  selectRegion(): Promise<void>;
  toggleAuto(): void;
  pause(): void;
  resume(): void;
  snapshot(): void;
  toggleOverlay(): void;
}

/** The part of `HotkeyService` this needs - see {@link SettingsIpc.setHotkey}. */
export interface SettingsHotkeySource {
  readonly registrations: readonly HotkeyRegistration[];
  probe(accelerator: string): HotkeyProbe;
}

/** The part of `SidecarSupervisor` this needs. */
export interface SettingsSidecarSource {
  readonly status: { readonly state: string; readonly reason?: string; readonly retryAtMs?: number | null };
  retry(): void;
}

export interface SettingsIpcOptions {
  readonly host: IpcHost;
  readonly config: SettingsConfigSource;
  readonly modes: SettingsModeSource;
  readonly hotkeys: SettingsHotkeySource;
  readonly monitors: { readonly choices: readonly MonitorChoice[] };
  readonly sidecar: SettingsSidecarSource;
  /** The single worst standing condition, read at publish time - see `index.ts`'s `renderStatus`. */
  readonly alert: () => Alert | null;
  /** Engines in fallback order, as actually constructed by the registry. */
  readonly engines: readonly string[];
  readonly srcLang: string;
  readonly tgtLang: string;
  readonly versions: SettingsState['versions'];
  /**
   * Whether a message from this renderer may be honoured.
   *
   * Supplied by `index.ts` as an identity comparison against the settings window's own
   * `webContents.id`. A function rather than a value because the window can be closed and
   * reopened, and a captured id would authorise a window that no longer exists.
   */
  readonly isTrustedSender: (senderId: number) => boolean;
  readonly logger?: Logger;
}

export class SettingsIpc {
  readonly #options: SettingsIpcOptions;
  readonly #log: Logger;
  #registered = false;

  constructor(options: SettingsIpcOptions) {
    this.#options = options;
    this.#log = (options.logger ?? nullLogger()).child('settings');
  }

  /** Attach every handler. Idempotent, so a reopened window does not double-register. */
  register(): void {
    if (this.#registered) return;
    this.#registered = true;
    const host = this.#options.host;

    host.handle(SETTINGS_REQUEST_CHANNEL, async (senderId) => {
      if (!this.#trusted(senderId, SETTINGS_REQUEST_CHANNEL)) return null;
      return await Promise.resolve(this.state);
    });

    host.handle(SETTINGS_CONFIG_CHANNEL, async (senderId, payload) => {
      if (!this.#trusted(senderId, SETTINGS_CONFIG_CHANNEL)) {
        return { applied: false, persisted: false, errors: [] } satisfies SettingsWriteResult;
      }
      return await this.setConfig(payload as ConfigOverride);
    });

    host.handle(SETTINGS_HOTKEY_CHANNEL, async (senderId, payload) => {
      if (!this.#trusted(senderId, SETTINGS_HOTKEY_CHANNEL)) {
        return { ok: false, message: 'refused' } satisfies SettingsHotkeyResult;
      }
      return await this.setHotkey(payload as SettingsHotkeyRequest);
    });

    host.handle(SETTINGS_COMMAND_CHANNEL, async (senderId, payload) => {
      if (!this.#trusted(senderId, SETTINGS_COMMAND_CHANNEL)) return null;
      await this.command(payload as SettingsCommand);
      return null;
    });
  }

  dispose(): void {
    if (!this.#registered) return;
    this.#registered = false;
    for (const channel of [
      SETTINGS_REQUEST_CHANNEL,
      SETTINGS_CONFIG_CHANNEL,
      SETTINGS_HOTKEY_CHANNEL,
      SETTINGS_COMMAND_CHANNEL,
    ]) {
      this.#options.host.removeHandler(channel);
    }
  }

  /** Assemble the whole view. Pure with respect to everything it reads. */
  get state(): SettingsState {
    const options = this.#options;
    const config = options.config.current;
    const alert = options.alert();
    const status = options.modes.status;

    return {
      config,
      configPath: options.config.filePath,
      issues: options.config.issues.map(toSettingsIssue),
      monitors: options.monitors.choices.map(toSettingsMonitor),
      hotkeys: toSettingsHotkeys(options.hotkeys.registrations, config),
      mode: status.mode,
      overlayVisible: status.overlayVisible,
      alert: alert === null ? null : toSettingsAlert(alert),
      sidecar: {
        state: options.sidecar.status.state as SettingsState['sidecar']['state'],
        detail: options.sidecar.status.reason ?? null,
      },
      engines: [...options.engines],
      srcLang: options.srcLang,
      tgtLang: options.tgtLang,
      hasRegion: config.capture.region !== null,
      versions: options.versions,
    };
  }

  /** Push the current state to the window. Safe when there is no window. */
  publish(): void {
    this.#options.host.send(SETTINGS_STATE_CHANNEL, this.state);
  }

  /**
   * Apply a config change from the window.
   *
   * Validation is `ConfigService.set`'s, not a second copy here: it returns the offending field
   * paths, the window puts each message next to its own control, and there is one validator rather
   * than two that can disagree. The state push at the end is what makes `persisted: false` visible
   * as well - the write is live, the issue list now holds a `not-persisted` entry, and the window
   * renders it.
   */
  async setConfig(change: ConfigOverride): Promise<SettingsWriteResult> {
    const result = await this.#options.config.set(change);
    if (!result.applied) {
      this.#log.warn('a settings change was rejected', { fields: result.errors });
    } else {
      this.#log.info('settings changed', { persisted: result.persisted, keys: Object.keys(change) });
    }
    this.publish();
    return { applied: result.applied, persisted: result.persisted, errors: result.errors.map(toFieldError) };
  }

  /**
   * Rebind one hotkey to an accelerator that came from a captured keystroke.
   *
   * ## The accelerator is probed before it is written
   *
   * `Control+Alt+R` fails to register on the machine this app is developed on, every run, and
   * until now the only remedy was hand-editing JSON - which two traps make the wrong answer:
   * Notepad and PowerShell 5.1 write a UTF-8 BOM that `JSON.parse` rejects, and a misspelled
   * modifier is silently discarded by Electron so `Contrl+Alt+A` registers `Alt+A` while reporting
   * success. The capture side removes the second trap by construction (`shared/accelerator.ts` is
   * the only producer of these strings); this removes the first, by asking the real
   * `globalShortcut` whether the key can be taken *before* anything is persisted.
   *
   * So a key another program owns is reported into the field the user is looking at, and the
   * config file is left alone. Writing it and letting the failure surface afterwards would leave
   * the window agreeing with the user about a shortcut that does nothing.
   *
   * `null` unbinds, and is never probed: releasing a key cannot fail for a reason the user can act
   * on, and #32 requires unbinding to be available precisely as the way out of a conflict.
   *
   * The registration itself is **not** done here. `config.set` notifies, and `index.ts`'s config
   * subscriber re-registers the whole set and republishes the alert - one apply path, whether the
   * change came from this window or from the file on disk.
   */
  async setHotkey(request: SettingsHotkeyRequest): Promise<SettingsHotkeyResult> {
    if (!isHotkeyAction(request.action)) {
      return { ok: false, message: 'unknown action' };
    }

    const accelerator = request.accelerator;
    if (accelerator !== null) {
      const clash = this.#duplicateOf(request.action, accelerator);
      if (clash !== undefined) {
        // Reported before the probe, because Electron cannot tell these apart: it returns `false`
        // both for a foreign program and for a key this process already holds, and "another
        // program owns it" would send the user hunting for something that does not exist.
        return { ok: false, message: `already used by "${clash}" — pick a different key` };
      }

      const probe = this.#options.hotkeys.probe(accelerator);
      if (!probe.ok) {
        this.#log.warn('a rebind was refused', { action: request.action, accelerator, reason: probe.reason });
        return {
          ok: false,
          message:
            probe.reason === 'conflict'
              ? `another program already owns ${accelerator} — try a different key`
              : `${accelerator} is not a shortcut Windows can register${probe.detail === undefined ? '' : `: ${probe.detail}`}`,
        };
      }
    }

    const result = await this.#options.config.set({ hotkeys: { [request.action]: accelerator } });
    if (!result.applied) {
      return { ok: false, message: result.errors.map((error) => error.message).join('; ') || 'rejected' };
    }
    this.#log.info('hotkey rebound', { action: request.action, accelerator, persisted: result.persisted });
    // The config subscriber has already re-registered by now; publish the outcome it produced.
    this.publish();
    return { ok: true };
  }

  /** Which other action already holds this accelerator, if any. */
  #duplicateOf(action: HotkeyAction, accelerator: string): HotkeyAction | undefined {
    const hotkeys = this.#options.config.current.hotkeys;
    return HOTKEY_ACTIONS.find((other) => other !== action && hotkeys[other] === accelerator);
  }

  /**
   * Run one of the non-config actions.
   *
   * `clearMonitorRegion` is not in the list on purpose - changing the monitor is a config write and
   * goes through {@link setConfig}. What is here is everything that changes what the app is
   * *doing* rather than what it is set to.
   */
  async command(command: SettingsCommand): Promise<void> {
    const modes = this.#options.modes;
    switch (command) {
      case 'selectRegion':
        await modes.selectRegion();
        break;
      case 'clearRegion':
        // Deliberately a real config write rather than a mode action: with no region the app is in
        // its first-run state again (#51), and everything that depends on that - the standing
        // warning, `toggleAuto` routing to the picker - follows from the config rather than from
        // anything this command does directly.
        await this.setConfig({ capture: { region: null } });
        return;
      case 'toggleAuto':
        modes.toggleAuto();
        break;
      case 'pause':
        modes.pause();
        break;
      case 'resume':
        modes.resume();
        break;
      case 'snapshot':
        modes.snapshot();
        break;
      case 'toggleOverlay':
        modes.toggleOverlay();
        break;
      case 'restartSidecar':
        this.#options.sidecar.retry();
        break;
      case 'reloadConfig':
        await this.#options.config.reload();
        break;
      default: {
        const unhandled: never = command;
        void unhandled;
        this.#log.warn('ignored an unknown settings command', { command: String(command) });
        return;
      }
    }
    this.publish();
  }

  #trusted(senderId: number, channel: string): boolean {
    if (this.#options.isTrustedSender(senderId)) return true;
    // Invariant 4: a refused message is not a message to swallow. Every window in this app loads
    // one preload, so this firing means something other than the settings window tried to write
    // config - which is worth a line whether it is a bug or something worse.
    this.#log.warn('refused an IPC message from a window that is not the settings window', {
      channel,
      senderId,
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Mapping. Each of these is where a main-process type is assigned into the renderer's mirror of
// it, which is the point at which a drift between the two becomes a compile error.
// ---------------------------------------------------------------------------

function toSettingsIssue(issue: ConfigIssue): SettingsIssue {
  return { kind: issue.kind, message: issue.message, fields: issue.fields.map(toFieldError) };
}

function toFieldError(error: { readonly path: string; readonly message: string }): {
  readonly path: string;
  readonly message: string;
} {
  return { path: error.path, message: error.message };
}

function toSettingsMonitor(choice: MonitorChoice): SettingsMonitor {
  return {
    id: choice.id,
    label: choice.label,
    width: choice.width,
    height: choice.height,
    scaleFactor: choice.scaleFactor,
    primary: choice.primary,
  };
}

function toSettingsAlert(alert: Alert): SettingsAlert {
  return { severity: alert.severity, cause: alert.cause, remedy: alert.remedy };
}

/**
 * Every action's row, in `HOTKEY_ACTIONS` order, whether or not the service has an outcome for it.
 *
 * The fallback arm is what makes the window honest during the seconds before `startHotkeys` has
 * run, and after a config reload that has not been applied yet: an action with no registration is
 * shown with the accelerator config holds and `ok: false`, rather than being missing from the list
 * entirely. A row that disappears reads as a feature that does not exist.
 */
function toSettingsHotkeys(
  registrations: readonly HotkeyRegistration[],
  config: Config,
): readonly SettingsHotkey[] {
  return HOTKEY_ACTIONS.map((action) => {
    const found = registrations.find((registration) => registration.action === action);
    if (found !== undefined) {
      return {
        action,
        accelerator: found.accelerator,
        ok: found.ok,
        ...(found.reason === undefined ? {} : { reason: found.reason }),
        ...(found.detail === undefined ? {} : { detail: found.detail }),
      };
    }
    return { action, accelerator: config.hotkeys[action], ok: false };
  });
}

function isHotkeyAction(value: unknown): value is HotkeyAction {
  return typeof value === 'string' && (HOTKEY_ACTIONS as readonly string[]).includes(value);
}
