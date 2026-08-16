/**
 * A real Chromium, showing the real overlay, and nothing else (issues #24, #25).
 *
 * The two acceptance criteria those issues turn on - "Thai text wraps without cutting a word in
 * half" and "the height used for placement is the height that rendered" - cannot be checked
 * without a layout engine that has ICU's Thai dictionary breaker and real font metrics. `jsdom`
 * has neither: it never breaks a line and `getBoundingClientRect` returns zeroes, so every
 * assertion about either would pass while checking nothing. That is why `jsdom` was removed in
 * `f911f26` and why this exists instead.
 *
 * This entry deliberately starts **only** the overlay window: no sidecar, no config file, no
 * translation engine, no tray. Payloads are pushed straight into the renderer through
 * `window.__textlensOverlay`, so the harness measures the renderer and cannot be made to pass or
 * fail by anything upstream of it.
 *
 * Not run directly - `scripts/overlay-layout-check.mjs` spawns it. See that file for how.
 *
 * **No top-level `await`.** Electron does not start its message loop until the ESM entry module
 * finishes evaluating, so a top-level await here hangs the process forever with no error.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, screen } from 'electron';

import { WindowManager } from '../../dist/main/services/window-manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, '..', '..', 'dist');

/** Hard stop, so a harness that wedges cannot be left running on someone's machine. */
const LIFETIME_MS = Number(process.env['HARNESS_SECONDS'] ?? '120') * 1000;
setTimeout(() => {
  app.exit(0);
}, LIFETIME_MS).unref?.();

app.whenReady().then(() => {
  const windows = new WindowManager({ distDir });
  // The primary display on purpose: this harness is about typography and box heights, which are
  // display-independent. Multi-monitor bounds behaviour is `window-manager.ts`'s own problem and
  // is covered where it lives.
  windows.openOverlay(screen.getPrimaryDisplay().id);
});

// An overlay-only session has exactly one window, and closing it is how the driver ends the run.
app.on('window-all-closed', () => {
  app.quit();
});
