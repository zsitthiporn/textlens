/**
 * Main process entry point: wiring, and only wiring.
 *
 * Everything electron-specific is resolved here - `userData`, `isPackaged`,
 * `resourcesPath` - and handed to services as plain values. That is what keeps
 * `services/` importable from a plain Node test process, and it is why none of those
 * modules imports `electron`.
 */

import path from 'node:path';

import { app } from 'electron';

import { createLogger, type RootLogger } from './services/logger.js';
import { MetricsRecorder, startMetricsSummary } from './services/metrics.js';
import { SidecarClient, resolveSidecarPath } from './services/sidecar-client.js';
import { WindowManager } from './services/window-manager.js';

/** dist/ - this file lives at dist/main/index.js once compiled. */
const distDir = path.join(import.meta.dirname, '..');

/** How often the latency summary lands in the log (feature L3). */
const METRICS_SUMMARY_INTERVAL_MS = 60_000;

let logger: RootLogger | null = null;
let sidecar: SidecarClient | null = null;
let windows: WindowManager | null = null;
let stopMetricsSummary: (() => void) | null = null;
let shuttingDown = false;

async function bootstrap(): Promise<void> {
  logger = await createLogger({
    directory: path.join(app.getPath('userData'), 'logs'),
    // `console: true` only in development - a packaged app has no console to read.
    console: !app.isPackaged,
  });
  const log = logger.child('app');
  log.info('starting', {
    version: app.getVersion(),
    // Not `level`: pino writes its own `level` field, and a duplicate key produces a
    // line that two JSON parsers will disagree about.
    logLevel: logger.level,
    logDirectory: logger.directory,
    packaged: app.isPackaged,
  });

  const metrics = new MetricsRecorder();
  stopMetricsSummary = startMetricsSummary(metrics, logger.child('metrics'), METRICS_SUMMARY_INTERVAL_MS);

  windows = new WindowManager({ distDir, logger });
  windows.openSettings('settings');
  windows.openOverlay();

  // Closing the settings window ends the session: the overlay is frameless, has no
  // taskbar entry and cannot be focused, so it can never be the window the user closes.
  windows.settings?.on('closed', () => {
    app.quit();
  });

  await startSidecar(metrics);
}

async function startSidecar(metrics: MetricsRecorder): Promise<void> {
  if (logger === null) return;
  const log = logger.child('app');

  const { exePath, source } = resolveSidecarPath({
    env: process.env,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  if (source === 'env-override') {
    log.warn('using the TEXTLENS_SIDECAR_PATH override instead of the bundled sidecar', { exePath });
  }

  const client = new SidecarClient({ exePath, logger });
  sidecar = client;

  // Timings arrive with every frame; feeding them here means the summary reflects the
  // sidecar's own measurements rather than anything Node guessed about them.
  client.on('frame', (frame) => {
    metrics.recordFrameTimings(frame.timings);
  });

  try {
    const ready = await client.start();
    log.info('sidecar is up', { version: ready.version, ocrLanguages: ready.ocrLanguages });
  } catch (error) {
    // Design doc section 7: a sidecar that will not start is reported, and the app stays
    // up so settings remain reachable. Restarting it is M10-01, not this issue.
    log.error('sidecar failed to start; capture is unavailable', {
      exePath,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Stop the child, flush the log, in that order. Idempotent. */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  stopMetricsSummary?.();
  await sidecar?.stop();
  windows?.closeAll();
  await logger?.close();
}

app.on('window-all-closed', () => {
  app.quit();
});

// `before-quit` is the last point at which async work can still be awaited. Cancel the
// quit, shut down properly, then quit for real - otherwise the sidecar's shutdown races
// the process exit and the last log lines never reach the disk.
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  void shutdown().then(() => {
    app.quit();
  });
});

void app.whenReady().then(bootstrap);
