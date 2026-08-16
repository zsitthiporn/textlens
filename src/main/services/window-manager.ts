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
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrowserWindow, screen, type Display, type Rectangle } from 'electron';

import { windowKindQuery, type WindowKind } from '../../shared/types.js';
import { nullLogger, type Logger } from './logger.js';

/**
 * `WDA_EXCLUDEFROMCAPTURE` - the only `GetWindowDisplayAffinity` value that means "this
 * window is actually invisible to Windows Graphics Capture". Requires Windows 10 2004+
 * (build 19041); older builds accept `setContentProtection(true)` without error and
 * simply do not honour it (spike S2, docs/spikes/2026-08-16-s2-content-protection.md
 * section 6) - which is exactly the silent failure invariant 4 forbids.
 */
const WDA_EXCLUDEFROMCAPTURE = 0x11;

/**
 * `setContentProtection` returns `void`, so this is how S2 told "Electron never set the
 * flag" apart from "set it, but this Windows build ignores it": read
 * `GetWindowDisplayAffinity` straight back off the HWND rather than trust Electron's
 * return value. A `.ps1` file on disk, not an inline `-Command` string - the P/Invoke
 * signature is full of quotes that Win32 argv quoting mangles, and a temp file sidesteps
 * that instead of fighting it (this is the same shape S2's harness used and proved out).
 */
const AFFINITY_SCRIPT = `param([long]$Hwnd)
Add-Type -Namespace Textlens -Name DisplayAffinity -MemberDefinition @'
[DllImport("user32.dll", SetLastError=true)]
public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);
'@
$value = [uint32]0
$ok = [Textlens.DisplayAffinity]::GetWindowDisplayAffinity([IntPtr]$Hwnd, [ref]$value)
if (-not $ok) { Write-Output 'ERROR' } else { Write-Output $value }
`;

let affinityScriptPath: string | null = null;

/** Writes the P/Invoke script once per process and reuses the path after that. */
function getAffinityScriptPath(): string {
  if (affinityScriptPath !== null) return affinityScriptPath;
  const file = path.join(os.tmpdir(), 'textlens-display-affinity.ps1');
  fs.writeFileSync(file, AFFINITY_SCRIPT, 'utf8');
  affinityScriptPath = file;
  return file;
}

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

    // Feature F1, layer 1 of the feedback-loop defence (design doc section 6). Electron
    // maps this to SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE), which spike S2
    // verified our own WGC path honours: with it set, the sidecar sees the window
    // *behind* the overlay, not the overlay.
    //
    // Set here, before the window is ever shown, and never toggled afterwards. S2 also
    // measured the other ordering - the overlay is capturable for as long as it is
    // visible without the flag, and "as long as" is not bounded by anything we control.
    overlay.setContentProtection(true);

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
      // Read the flag back now that it has had a real window to attach to (issue #46).
      this.#verifyContentProtection(overlay, display);
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
   * Feature F1's other half (issue #46). `setContentProtection(true)` cannot fail loudly
   * - it returns `void` - so this reads `GetWindowDisplayAffinity` back off the real HWND
   * and warns if it is not `WDA_EXCLUDEFROMCAPTURE`. Deliberately does nothing else: no
   * retry, no fallback flag, no attempt to compensate. F3 (the Thai-script output filter)
   * is the backstop by design; the entire job here is making a silent layer-1 failure
   * loud, per invariant 4.
   *
   * Fire-and-forget: the check runs once, off the capture hot path, and has nothing
   * useful to block on.
   */
  #verifyContentProtection(overlay: BrowserWindow, display: Display): void {
    let hwnd: string;
    try {
      hwnd = overlay.getNativeWindowHandle().readBigUInt64LE(0).toString();
    } catch (error) {
      this.#log.warn('could not read the overlay window handle to verify content protection', {
        displayId: display.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', getAffinityScriptPath(), '-Hwnd', hwnd],
      { timeout: 5000, encoding: 'utf8', windowsHide: true },
      (error, stdout) => {
        // The overlay may have been closed while the readback was in flight; nothing to
        // warn the user about at that point.
        if (overlay.isDestroyed()) return;

        if (error !== null) {
          this.#log.warn('could not verify content protection took effect', {
            displayId: display.id,
            error: error.message,
          });
          return;
        }

        const raw = stdout.trim();
        const affinity = raw === 'ERROR' ? NaN : Number(raw);
        if (affinity === WDA_EXCLUDEFROMCAPTURE) return; // the happy path stays silent

        this.#log.warn(
          'content protection did not take effect on the overlay; it is not excluded from '
            + 'screen capture, so layer 1 of the feedback-loop defence (design doc section 6) '
            + 'is unavailable on this machine and the app is relying on layers 2/3 instead. '
            + 'WDA_EXCLUDEFROMCAPTURE requires Windows 10 build 19041 (2004) or newer',
          {
            displayId: display.id,
            expectedAffinity: `0x${WDA_EXCLUDEFROMCAPTURE.toString(16)}`,
            actualAffinity: Number.isNaN(affinity) ? `unexpected readback: "${raw}"` : `0x${affinity.toString(16)}`,
            windowsBuild: os.release(),
          },
        );
      },
    );
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
