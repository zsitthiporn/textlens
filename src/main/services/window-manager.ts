/**
 * Owns every BrowserWindow this app creates (design doc section 2).
 *
 * One owner rather than a `createWindow` helper per surface, because the overlay's
 * requirements are the opposite of the settings window's in almost every respect - it
 * must not be focusable, must not appear in the taskbar, must not have a background, and
 * must not receive a single mouse event. Sharing one constructor between them is how you
 * end up with an overlay that has an opaque background because somebody set a sensible
 * `backgroundColor` for the settings window.
 *
 * The overlay is issue M1-05, feature U1. Two of its settings look like details and are
 * not:
 *
 *   - **`display.bounds`, never `display.workArea`.** `workArea` excludes the taskbar,
 *     so an overlay sized to it silently squeezes everything near the bottom of the
 *     screen upward - and subtitles live at the bottom of the screen.
 *   - **`setAlwaysOnTop(true, 'screen-saver')`.** The constructor's `alwaysOnTop: true`
 *     only gets the `floating` level, which a borderless-fullscreen game will sit above.
 *
 * No coordinate arithmetic happens here: `display.bounds` is handed to `setBounds`
 * unchanged. Conversion has exactly one owner and it is not this file (invariant 3).
 *
 * Deliberately not here: `setContentProtection`. Excluding the overlay from capture is
 * issue M10-04 and depends on spike S2.
 */

import path from 'node:path';

import { BrowserWindow, screen, type Display, type Rectangle } from 'electron';

import { windowKindQuery, type WindowKind } from '../../shared/types.js';
import { nullLogger, type Logger } from './logger.js';

/**
 * Security baseline for every BrowserWindow in this app. Spread this into
 * `webPreferences` instead of hand-rolling per window, so the guarantee holds everywhere
 * by construction:
 *   contextIsolation on  - renderer cannot touch Electron internals
 *   nodeIntegration off  - renderer cannot touch Node
 *   sandbox on           - preload runs sandboxed, which is why it is CommonJS
 */
export const BASE_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} as const;

export interface WindowManagerOptions {
  /** `dist/` - where the compiled preload and renderer bundles live. */
  readonly distDir: string;
  readonly logger?: Logger;
}

export class WindowManager {
  readonly #distDir: string;
  readonly #log: Logger;

  #overlay: BrowserWindow | null = null;
  /** Which display the overlay is pinned to, so metric changes for others are ignored. */
  #overlayDisplayId: number | null = null;
  #settings: BrowserWindow | null = null;
  #metricsListener: ((event: Electron.Event, display: Display) => void) | null = null;

  constructor(options: WindowManagerOptions) {
    this.#distDir = options.distDir;
    this.#log = (options.logger ?? nullLogger()).child('windows');
  }

  get overlay(): BrowserWindow | null {
    return this.#overlay;
  }

  get settings(): BrowserWindow | null {
    return this.#settings;
  }

  /**
   * Create the transparent click-through overlay covering one whole display.
   *
   * `displayId` selects the monitor; the primary display is used when it is omitted or
   * no longer exists (a display can be unplugged between config being written and the
   * overlay opening, and falling back beats failing to draw anything).
   */
  openOverlay(displayId?: number): BrowserWindow {
    if (this.#overlay !== null && !this.#overlay.isDestroyed()) return this.#overlay;

    const display = this.#resolveDisplay(displayId);
    const bounds = display.bounds;

    const overlay = new BrowserWindow({
      ...bounds,
      transparent: true,
      frame: false,
      // The constructor flag alone yields the 'floating' level; raised below.
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      // Never take the keyboard away from whatever the user is actually using.
      focusable: false,
      // No `backgroundColor`: any value here, including a transparent one, is one more
      // thing that can make the window opaque on a compositor that ignores the alpha.
      show: false,
      title: 'Textlens overlay',
      webPreferences: {
        ...BASE_WEB_PREFERENCES,
        preload: path.join(this.#distDir, 'preload', 'index.cjs'),
      },
    });

    // Clicks, drags and hovers all pass through to whatever is underneath. `forward`
    // keeps mousemove events coming to the renderer so hover effects remain possible
    // later without giving up click-through.
    overlay.setIgnoreMouseEvents(true, { forward: true });
    // Above borderless-fullscreen games, which sit above the 'floating' level.
    overlay.setAlwaysOnTop(true, 'screen-saver');
    // Belt and braces: a window that is never in the taskbar is never alt-tabbed to.
    overlay.setSkipTaskbar(true);

    // Measured on this machine (Electron 43, Windows 11): the bounds handed to the
    // constructor come back clamped to the display's *work area* on a secondary monitor
    // - a 1080x1920 portrait display produced a 1080x1872 window, 48px short, exactly
    // the taskbar. The primary display was unaffected, which is what makes this the kind
    // of bug you ship. Re-applying the bounds after the window exists takes correctly.
    this.#applyBounds(overlay, bounds);

    overlay.once('ready-to-show', () => {
      // And again after the window is realised, for the same reason.
      this.#applyBounds(overlay, bounds);
      // showInactive, not show: `show()` would raise and focus it, which is exactly what
      // "never steals focus from the game" forbids.
      overlay.showInactive();
      this.#log.info('overlay shown', { displayId: display.id, bounds: overlay.getBounds() });
    });

    overlay.webContents.setWindowOpenHandler(({ url }) => {
      this.#log.warn('blocked window.open from the overlay', { url });
      return { action: 'deny' };
    });

    overlay.webContents.on('render-process-gone', (_event, details) => {
      this.#log.error('overlay renderer gone', { reason: details.reason });
    });

    overlay.on('closed', () => {
      this.#overlay = null;
      this.#overlayDisplayId = null;
    });

    void overlay.loadFile(path.join(this.#distDir, 'renderer', 'overlay', 'index.html'));

    this.#overlay = overlay;
    this.#overlayDisplayId = display.id;
    this.#watchDisplayMetrics();

    return overlay;
  }

  /** The ordinary, framed window. Nothing exotic - it is here so one class owns them all. */
  openSettings(kind: WindowKind = 'settings'): BrowserWindow {
    if (this.#settings !== null && !this.#settings.isDestroyed()) {
      this.#settings.focus();
      return this.#settings;
    }

    const window = new BrowserWindow({
      width: 960,
      height: 640,
      show: false,
      backgroundColor: '#101014',
      title: 'Textlens',
      webPreferences: {
        ...BASE_WEB_PREFERENCES,
        preload: path.join(this.#distDir, 'preload', 'index.cjs'),
      },
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      this.#log.warn('blocked window.open', { url, kind });
      return { action: 'deny' };
    });

    window.webContents.on('render-process-gone', (_event, details) => {
      this.#log.error('renderer gone', { kind, reason: details.reason });
    });

    window.once('ready-to-show', () => {
      window.show();
      this.#log.info('window shown', { kind });
    });

    window.on('closed', () => {
      this.#settings = null;
    });

    void window.loadFile(path.join(this.#distDir, 'renderer', 'index.html'), {
      query: windowKindQuery(kind),
    });

    this.#settings = window;
    return window;
  }

  /** Move the overlay to a different display, keeping it full-bleed on the new one. */
  moveOverlayTo(displayId: number): void {
    const overlay = this.#overlay;
    if (overlay === null || overlay.isDestroyed()) return;

    const display = this.#resolveDisplay(displayId);
    this.#overlayDisplayId = display.id;
    this.#applyBounds(overlay, display.bounds);
  }

  closeAll(): void {
    if (this.#metricsListener !== null) {
      screen.removeListener('display-metrics-changed', this.#metricsListener);
      this.#metricsListener = null;
    }
    for (const window of [this.#overlay, this.#settings]) {
      if (window !== null && !window.isDestroyed()) window.destroy();
    }
    this.#overlay = null;
    this.#settings = null;
    this.#overlayDisplayId = null;
  }

  // -------------------------------------------------------------------------

  #resolveDisplay(displayId: number | undefined): Display {
    if (displayId === undefined) return screen.getPrimaryDisplay();

    const match = screen.getAllDisplays().find((display) => display.id === displayId);
    if (match !== undefined) return match;

    this.#log.warn('requested display is gone; falling back to primary', { displayId });
    return screen.getPrimaryDisplay();
  }

  /**
   * Follow resolution and scale changes on the display the overlay is pinned to.
   *
   * Registered once, not once per window: `screen` outlives every BrowserWindow, and a
   * listener added per overlay is a listener leaked per overlay.
   */
  #watchDisplayMetrics(): void {
    if (this.#metricsListener !== null) return;

    this.#metricsListener = (_event: Electron.Event, display: Display) => {
      const overlay = this.#overlay;
      if (overlay === null || overlay.isDestroyed()) return;
      if (display.id !== this.#overlayDisplayId) return;

      this.#log.info('display metrics changed; resizing overlay', {
        displayId: display.id,
        bounds: display.bounds,
        scaleFactor: display.scaleFactor,
      });
      this.#applyBounds(overlay, display.bounds);
    };

    screen.on('display-metrics-changed', this.#metricsListener);
  }

  /**
   * `bounds`, not `workArea` - see the file header. Passed straight through with no
   * arithmetic of any kind.
   *
   * The result is checked rather than assumed: Windows silently shrinks a window it
   * dislikes, and an overlay that is 48px short does not look broken, it just stops
   * translating the bottom line of subtitles (invariant 4 - no silent failures).
   */
  #applyBounds(overlay: BrowserWindow, bounds: Rectangle): void {
    overlay.setBounds(bounds);
    // Resizing can drop a window out of the topmost band on Windows; reassert it.
    overlay.setAlwaysOnTop(true, 'screen-saver');

    const actual = overlay.getBounds();
    if (
      actual.x !== bounds.x ||
      actual.y !== bounds.y ||
      actual.width !== bounds.width ||
      actual.height !== bounds.height
    ) {
      this.#log.warn('the window manager did not accept the overlay bounds', { wanted: bounds, actual });
    }
  }
}
