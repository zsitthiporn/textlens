/**
 * The system tray (issue M7-02 / #33, feature G6).
 *
 * This app has no main window in the ordinary sense - the overlay is frameless,
 * click-through and skips the taskbar - so the tray is the only thing on screen a user can
 * point at. Two consequences drive everything here:
 *
 *   1. **It is the only graceful quit path.** Until this existed, ending a session meant
 *      `taskkill`, which never runs `before-quit` and therefore never ran `shutdown()`. So
 *      #32's criterion ("quit แล้ว hotkey ถูกปลดหมด") was being met by Windows reclaiming
 *      process-wide shortcuts on kill, not by our code. The Quit item is what makes that
 *      criterion provable, and it does nothing except call back into `app.quit()` - the
 *      shutdown sequence stays in one place (`before-quit`), because a second one would be
 *      a second thing to keep correct.
 *   2. **It has to survive its own icons being missing.** `docs/reference-analysis.md`
 *      records the reference project crashing when its tray image failed to load, and a
 *      crash here costs the user the only way to quit. Every image failure is logged and
 *      falls back; the tray is constructed even when every single icon is unreadable.
 *
 * ## No `electron` import
 *
 * {@link TrayPlatform} is the structural slice of `Tray`, `Menu` and `nativeImage` this
 * needs, so Electron's real objects satisfy it unchanged and these tests run in plain Node -
 * the same technique as `ShortcutRegistrar` in `hotkey-service.ts`. Be clear about what that
 * buys: it proves the menu template, the state-to-icon mapping and the fallbacks. It does
 * **not** prove that Windows draws anything, which only a real run can.
 */

import path from 'node:path';

import { DISMISS_LABEL, describeMode } from '../../shared/mode-presentation.js';

import type { AppMode } from './app-orchestrator.js';
import { nullLogger, type Logger } from './logger.js';

// ---------------------------------------------------------------------------
// The slice of Electron this needs
// ---------------------------------------------------------------------------

/**
 * The part of `NativeImage` that matters here.
 *
 * `isEmpty()` is the whole reason this is in the interface: `nativeImage.createFromPath`
 * does **not** throw for a missing or corrupt file - it returns an empty image, and an
 * empty image passed to `Tray` yields a tray entry the user cannot see. Silent, and exactly
 * the failure invariant 4 forbids.
 */
export interface TrayImage {
  isEmpty(): boolean;
}

/** One entry in the context menu. A structural subset of Electron's `MenuItemConstructorOptions`. */
export interface TrayMenuItem {
  readonly label?: string;
  readonly type?: 'normal' | 'separator' | 'checkbox';
  readonly checked?: boolean;
  readonly enabled?: boolean;
  readonly click?: () => void;
}

/** Whatever `Menu.buildFromTemplate` returned. Opaque: nothing here reads it. */
export type TrayMenu = object;

export interface TrayHandle {
  setToolTip(tooltip: string): void;
  setContextMenu(menu: TrayMenu | null): void;
  setImage(image: TrayImage): void;
  on(event: 'click', listener: () => void): void;
  destroy(): void;
  isDestroyed(): boolean;
}

/** Electron's tray/menu/image constructors, injected so this module never imports Electron. */
export interface TrayPlatform {
  /** `nativeImage.createFromPath`. Returns an *empty* image for a file it cannot read. */
  createImage(filePath: string): TrayImage;
  /** `nativeImage.createEmpty`. The last-resort icon. */
  createEmptyImage(): TrayImage;
  /** `Menu.buildFromTemplate`. */
  buildMenu(template: readonly TrayMenuItem[]): TrayMenu;
  /** `new Tray(image)`. */
  createTray(image: TrayImage): TrayHandle;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/**
 * Which icon file each tray state uses. Filenames, not paths, so the directory can move
 * between a dev tree and a packaged one without touching this table.
 */
export const TRAY_ICON_FILES = {
  idle: 'idle.png',
  auto: 'auto.png',
  paused: 'paused.png',
  snapshot: 'snapshot.png',
  error: 'error.png',
} as const satisfies Record<AppMode | 'error', string>;

/** What the icon is showing: the current mode, or `error`, which outranks all of them. */
export type TrayIconState = keyof typeof TRAY_ICON_FILES;

export interface TrayIconPathInputs {
  /** `app.isPackaged`. */
  readonly isPackaged: boolean;
  /** `process.resourcesPath`. */
  readonly resourcesPath: string;
  /** `app.getAppPath()` - the repo root in development. */
  readonly appPath: string;
}

/**
 * Where the icons live. Pure, like {@link import('./sidecar-client.js').resolveSidecarPath}
 * and for the same reason: this is the policy, and the load is the enforcement.
 *
 * `build/` in a dev tree, because these are assets a packager copies rather than sources a
 * compiler reads - putting them under `src/` would mean `tsc` and Vite both had to be told
 * to ignore them.
 */
export function resolveTrayIconDir(inputs: TrayIconPathInputs): string {
  return inputs.isPackaged
    ? path.join(inputs.resourcesPath, 'icons')
    : path.join(inputs.appPath, 'build', 'icons');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Everything the tray shows. One object so an update cannot apply half a change. */
export interface TrayState {
  readonly mode: AppMode;
  /** Whether the overlay is currently drawn. Not the same thing as `mode` - see #34. */
  readonly overlayVisible: boolean;
  /** The last thing that went wrong, or `null`. Non-null takes over the icon. */
  readonly error: string | null;
  /**
   * Something the user should act on that is not a failure - currently only "text is touching
   * the edge of your region" (#30).
   *
   * Optional so that a caller which has no warning to give need not say so, and separate from
   * `error` because the two behave differently: an error takes over the icon and is cleared by
   * the next successful frame, while this is a standing condition that persists precisely
   * *because* frames keep arriving with clipped text in them.
   */
  readonly warning?: string | null;
}

/**
 * What each menu item does. Every one is injected: this service owns the menu's *shape*,
 * and the mode machine (#34) owns what the entries mean.
 */
export interface TrayActions {
  readonly onSelectRegion: () => void;
  /**
   * "Translate once" - one frame, held (G4).
   *
   * Named for the wire command rather than the label, like every other internal identifier here:
   * the config key `hotkeys.snapshot` cannot move (renaming it rejects the user's whole file), so
   * the internal name and the shown name are deliberately allowed to differ, in exactly one
   * direction and in exactly one place - {@link import('../../shared/mode-presentation.js')}.
   */
  readonly onSnapshot: () => void;
  /**
   * Switch Auto on, or off again (#60).
   *
   * There is no separate `onPause` any more. Pausing is Auto switched off - the same click, the
   * same item - and a menu that offered both made two names for one thing, which is the shape of
   * the confusion #60 was filed about. `AppOrchestrator.pause()` still exists for the settings
   * window's `pause` command; it is only the tray that stopped needing two entries.
   */
  readonly onToggleAuto: () => void;
  readonly onToggleOverlay: () => void;
  /**
   * Clear the boxes on screen without changing mode (#61). Not `onToggleOverlay`: that hides the
   * window and leaves the pipeline running, so unhiding shows whatever arrived while it was gone.
   */
  readonly onDismiss: () => void;
  readonly onOpenSettings: () => void;
  readonly onQuit: () => void;
  /**
   * Start the capture sidecar again, clearing the restart quota (#40/#41).
   *
   * Optional so that a caller with no supervisor - every existing test - need not invent one, and
   * the item simply does not appear. It exists because {@link SidecarSupervisor} deliberately
   * stops trying: an automatic restarter with no give-up point is a restart storm, and a give-up
   * point with no way back is an app the user has to relaunch. This is the way back, and it is in
   * the tray because the tray is the only surface this app is guaranteed to have.
   */
  readonly onRestartSidecar?: () => void;
}

export interface TrayServiceOptions {
  readonly platform: TrayPlatform;
  /** Directory holding the PNGs named in {@link TRAY_ICON_FILES}. */
  readonly iconDir: string;
  readonly actions: TrayActions;
  readonly logger?: Logger;
}

const INITIAL_STATE: TrayState = { mode: 'idle', overlayVisible: true, error: null };

export class TrayService {
  readonly #platform: TrayPlatform;
  readonly #iconDir: string;
  readonly #actions: TrayActions;
  readonly #log: Logger;

  /** Loaded once each, then reused: `createFromPath` hits the disk every call. */
  readonly #icons = new Map<TrayIconState, TrayImage>();

  #tray: TrayHandle | null = null;
  #state: TrayState = INITIAL_STATE;
  /** What {@link #applyIcon} last pushed, so an unchanged icon is not re-set every update. */
  #iconState: TrayIconState | null = null;

  constructor(options: TrayServiceOptions) {
    this.#platform = options.platform;
    this.#iconDir = options.iconDir;
    this.#actions = options.actions;
    this.#log = (options.logger ?? nullLogger()).child('tray');
  }

  get state(): TrayState {
    return this.#state;
  }

  /** The handle, or null before {@link create} or after {@link destroy}. Exposed for tests. */
  get handle(): TrayHandle | null {
    return this.#tray;
  }

  /**
   * Build the tray icon and its menu.
   *
   * @returns whether a tray now exists. `false` means Windows refused to create one, which
   *          is reported and is not fatal - the hotkeys are still bound, and the settings
   *          window is still a way out. Returning it rather than throwing keeps "the tray
   *          failed" a fact the caller can log alongside everything else about the session.
   */
  create(): boolean {
    if (this.#tray !== null && !this.#tray.isDestroyed()) return true;

    const image = this.#icon(this.#iconStateFor(this.#state));

    let tray: TrayHandle;
    try {
      tray = this.#platform.createTray(image);
    } catch (error) {
      // The reference project's tray crash, refused. Everything above this point already
      // survives a missing icon, so reaching here means the OS itself said no.
      this.#log.error('could not create the tray icon; the app has no tray this session', {
        message: describeError(error),
      });
      return false;
    }

    this.#tray = tray;
    this.#iconState = this.#iconStateFor(this.#state);

    // Left click shows/hides the overlay (#33). Deliberately not "open settings": the
    // overlay toggle is the thing a user reaches for mid-game, and it is the one action
    // that is safe to trigger by accident.
    tray.on('click', () => {
      this.#run('click', this.#actions.onToggleOverlay);
    });

    this.#applyTooltip();
    this.#applyMenu();

    this.#log.info('tray created', { iconDir: this.#iconDir, mode: this.#state.mode });
    return true;
  }

  /**
   * Push a new state. Cheap to call on every mode change: the icon and the tooltip are only
   * touched when they actually differ.
   *
   * The menu *is* rebuilt every time, because `checked` and `enabled` are baked into the
   * template Electron already turned into a menu - there is no mutating it in place.
   */
  update(state: TrayState): void {
    const previous = this.#state;
    this.#state = state;

    if (this.#tray === null || this.#tray.isDestroyed()) return;

    this.#applyIcon();
    if (
      previous.mode !== state.mode ||
      previous.overlayVisible !== state.overlayVisible ||
      previous.error !== state.error ||
      // `warning` joined this list when the menu started showing it (#41). Left out, a warning
      // would reach the tooltip - which is rebuilt from the same call - and never the menu.
      (previous.warning ?? null) !== (state.warning ?? null)
    ) {
      this.#applyTooltip();
      this.#applyMenu();
    }
  }

  destroy(): void {
    const tray = this.#tray;
    this.#tray = null;
    this.#iconState = null;
    if (tray === null || tray.isDestroyed()) return;
    try {
      tray.destroy();
    } catch (error) {
      this.#log.warn('destroying the tray threw', { message: describeError(error) });
    }
  }

  // -------------------------------------------------------------------------

  /** `error` outranks the mode: a broken engine matters more than which mode it broke in. */
  #iconStateFor(state: TrayState): TrayIconState {
    return state.error === null ? state.mode : 'error';
  }

  #applyIcon(): void {
    const wanted = this.#iconStateFor(this.#state);
    if (wanted === this.#iconState) return;
    this.#iconState = wanted;
    try {
      this.#tray?.setImage(this.#icon(wanted));
    } catch (error) {
      this.#log.warn('could not change the tray icon', { state: wanted, message: describeError(error) });
    }
  }

  #applyTooltip(): void {
    try {
      this.#tray?.setToolTip(describeState(this.#state));
    } catch (error) {
      this.#log.warn('could not set the tray tooltip', { message: describeError(error) });
    }
  }

  #applyMenu(): void {
    try {
      this.#tray?.setContextMenu(this.#platform.buildMenu(this.menuTemplate()));
    } catch (error) {
      // A tray whose menu failed to build still has a left click and is still visible, so
      // this is reported rather than escalated.
      this.#log.error('could not build the tray menu', { message: describeError(error) });
    }
  }

  /**
   * The menu, as a template. Public so a test can assert its shape and fire an item without
   * needing Electron to have built anything.
   *
   * ## Two mode items, not a checkbox and a scattering of buttons (#60)
   *
   * This used to offer `Snapshot`, an `Auto` checkbox and a separate `Pause` button, which is
   * three entries for two ideas and one of them under a name no other surface used. Now the top
   * of the menu is the choice itself: **Auto** and **Translate once**, checked to show which one
   * the app is resting in, either reachable in one click. Pausing is Auto switched off, so it is
   * the same item clicked again and the label says `Auto (paused)` - the only thing that tells
   * `paused` apart from `idle` in a menu, since both have a stopped loop.
   *
   * Checkboxes rather than radio items because {@link TrayMenuItem} does not model `'radio'` and
   * Electron manages a radio group's checked state itself, which nothing in these tests could
   * verify. `checked` here means "this is the mode you are in", which is a fact this file knows.
   *
   * Every `click` goes through {@link #run}. Electron invokes these from its own menu
   * machinery, which has nowhere to put a throw except the main process's uncaught handler.
   */
  menuTemplate(): readonly TrayMenuItem[] {
    const { mode, overlayVisible, error } = this.#state;
    const items: TrayMenuItem[] = [];

    const guard =
      (name: string, action: () => void) =>
      (): void => {
        this.#run(name, action);
      };

    if (error !== null) {
      // Not clickable, and first: the tray icon says "something is wrong" and this is the
      // only place the user can find out what (invariant 4).
      items.push({ label: truncate(`! ${error}`, 60), enabled: false }, { type: 'separator' });
    } else if (this.#state.warning !== null && this.#state.warning !== undefined) {
      // The same treatment, one rank down. #30's edge report, #31's stale region and #50's idle
      // detection all published onto `AppStatus.warning` and reached the tooltip only - and a
      // tooltip requires the user to already suspect something and go hovering. This is the
      // menu they open when they do.
      items.push({ label: truncate(`· ${this.#state.warning}`, 60), enabled: false }, { type: 'separator' });
    }

    const presentation = describeMode(mode);
    const clicks = { toggleAuto: this.#actions.onToggleAuto, snapshot: this.#actions.onSnapshot };

    items.push(
      // First, because this is the question the user opened the tray to answer.
      ...presentation.choices.map(
        (choice): TrayMenuItem => ({
          label: choice.label,
          type: 'checkbox',
          checked: choice.active,
          click: guard(choice.command, clicks[choice.command]),
        }),
      ),
      // Directly under the choice it belongs to (#61): this clears a held Translate once without
      // leaving it, so it reads as part of that choice rather than as an unrelated action further
      // down the menu. Disabled outside `snapshot` - there is nothing a dismiss could clear in
      // Auto (the loop keeps redrawing) or before a region is configured, and `mode` is a fact this
      // service already carries in `TrayState`, so no new plumbing was needed to know it.
      { label: DISMISS_LABEL, enabled: mode === 'snapshot', click: guard('dismiss', this.#actions.onDismiss) },
      { type: 'separator' },
      { label: 'Select Region…', click: guard('selectRegion', this.#actions.onSelectRegion) },
      { type: 'separator' },
      {
        label: 'Show overlay',
        type: 'checkbox',
        checked: overlayVisible,
        click: guard('toggleOverlay', this.#actions.onToggleOverlay),
      },
      { type: 'separator' },
    );

    const restart = this.#actions.onRestartSidecar;
    if (restart !== undefined) {
      items.push(
        { label: 'Restart capture engine', click: guard('restartSidecar', restart) },
        { type: 'separator' },
      );
    }

    items.push(
      { label: 'Settings…', click: guard('openSettings', this.#actions.onOpenSettings) },
      { label: 'Quit', click: guard('quit', this.#actions.onQuit) },
    );

    return items;
  }

  /**
   * Load one icon, remembering it.
   *
   * Three outcomes and all three are survivable: the file loads, the file is missing or
   * corrupt (`createFromPath` returns an empty image - it does not throw), or the call
   * itself throws. The last two both yield an empty image, which produces a blank tray
   * entry rather than no tray at all. #33 is explicit that this must not crash, and it
   * matters more than usual because the tray is the only quit path.
   */
  #icon(state: TrayIconState): TrayImage {
    const cached = this.#icons.get(state);
    if (cached !== undefined) return cached;

    const filePath = path.join(this.#iconDir, TRAY_ICON_FILES[state]);
    let image: TrayImage;
    try {
      image = this.#platform.createImage(filePath);
    } catch (error) {
      this.#log.error('tray icon could not be read; using a blank one', {
        state,
        filePath,
        message: describeError(error),
      });
      image = this.#platform.createEmptyImage();
      this.#icons.set(state, image);
      return image;
    }

    if (image.isEmpty()) {
      this.#log.error('tray icon is missing or unreadable; using a blank one', { state, filePath });
    }

    this.#icons.set(state, image);
    return image;
  }

  /** A menu callback must never take the process down; Electron has nowhere to put the throw. */
  #run(name: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.#log.error('a tray action threw', { action: name, message: describeError(error) });
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * The tooltip text. Exported so the test asserts the same string the tray shows rather than
 * a copy of it.
 *
 * Mode and overlay visibility are both in there because they are the pair users confuse:
 * #34 is emphatic that hiding the overlay is not pausing, and a tooltip that only reported
 * one of them would make a hidden overlay in `auto` look identical to `paused`.
 *
 * The mode is named the way the menu names it (#60), not by its internal word: a tooltip reading
 * `snapshot` next to a menu item reading `Translate once` is the mismatch this issue is about, and
 * the tooltip is the surface a user hovers precisely when they are unsure what state they are in.
 */
export function describeState(state: TrayState): string {
  if (state.error !== null) return truncate(`Textlens — error: ${state.error}`, 127);
  const hidden = state.overlayVisible ? '' : ', overlay hidden';
  // Ranked below `error` rather than merged with it: an error means nothing is working, a
  // warning means everything is working and the result is probably wrong. Showing the second
  // in place of the first would hide the more urgent of the two.
  const warning = state.warning === null || state.warning === undefined ? '' : ` — ${state.warning}`;
  return truncate(`Textlens — ${describeMode(state.mode).label}${hidden}${warning}`, 127);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
