import path from 'node:path';

import { app, BrowserWindow } from 'electron';

import { windowKindQuery, type WindowKind } from '../shared/types.js';

/** dist/ - this file lives at dist/main/index.js once compiled. */
const distDir = path.join(import.meta.dirname, '..');

/**
 * Security baseline for every BrowserWindow in this app. Spread this into
 * `webPreferences` instead of hand-rolling per window, so the guarantee holds
 * everywhere by construction:
 *   contextIsolation on  - renderer cannot touch Electron internals
 *   nodeIntegration off  - renderer cannot touch Node
 *   sandbox on           - preload runs sandboxed, which is why it is CommonJS
 */
const BASE_WEB_PREFERENCES = {
  preload: path.join(distDir, 'preload', 'index.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} as const;

function createWindow(kind: WindowKind): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 640,
    show: false,
    backgroundColor: '#101014',
    title: 'Textlens',
    webPreferences: { ...BASE_WEB_PREFERENCES },
  });

  // Nothing in this app should open a second window or navigate away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`[main] blocked window.open to ${url}`);
    return { action: 'deny' };
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[main] renderer for "${kind}" gone: ${details.reason}`);
  });

  window.once('ready-to-show', () => {
    window.show();
    console.log(`[main] window "${kind}" shown`);
  });

  void window.loadFile(path.join(distDir, 'renderer', 'index.html'), {
    query: windowKindQuery(kind),
  });

  return window;
}

app.on('window-all-closed', () => {
  app.quit();
});

void app.whenReady().then(() => {
  createWindow('settings');
});
