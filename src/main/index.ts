/**
 * Main process entry point: wiring, and only wiring.
 *
 * Everything electron-specific is resolved here - `userData`, `isPackaged`,
 * `resourcesPath` - and handed to services as plain values. That is what keeps
 * `services/` importable from a plain Node test process, and it is why none of those
 * modules imports `electron`.
 */

import path from 'node:path';

import {
  Menu,
  Tray,
  app,
  globalShortcut,
  nativeImage,
  net,
  screen,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';

import { DEFAULT_CONFIG } from '../shared/config-schema.js';
import { AppOrchestrator } from './services/app-orchestrator.js';
import { ConfigService } from './services/config.js';
import { HotkeyService } from './services/hotkey-service.js';
import { createLogger, type RootLogger } from './services/logger.js';
import { MetricsRecorder, startMetricsSummary } from './services/metrics.js';
import { RecentOutputs } from './services/recent-outputs.js';
import { SidecarClient, resolveSidecarPath } from './services/sidecar-client.js';
import {
  createTextPipeline,
  type ComposedTextPipeline,
  type OverlayPayload,
} from './services/text-pipeline.js';
import {
  TrayService,
  resolveTrayIconDir,
  type TrayHandle,
  type TrayImage,
  type TrayMenuItem,
  type TrayPlatform,
} from './services/tray-service.js';
import { WindowManager } from './services/window-manager.js';

/** dist/ - this file lives at dist/main/index.js once compiled. */
const distDir = path.join(import.meta.dirname, '..');

/** How often the latency summary lands in the log (feature L3). */
const METRICS_SUMMARY_INTERVAL_MS = 60_000;

/** The user override layer, in `userData`. Absent on a first run, which is not an error (#38). */
const CONFIG_FILE_NAME = 'config.json';

let logger: RootLogger | null = null;
let config: ConfigService | null = null;
let hotkeys: HotkeyService | null = null;
let sidecar: SidecarClient | null = null;
let windows: WindowManager | null = null;
let textPipeline: ComposedTextPipeline | null = null;
let orchestrator: AppOrchestrator | null = null;
let tray: TrayService | null = null;
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

  // Before anything reads a setting, and after the logger so a broken config file has
  // somewhere to be reported. `load` never rejects: a config that cannot be used falls back
  // to the bundled defaults and leaves an entry in `issues` (#38).
  config = await ConfigService.load({
    filePath: path.join(app.getPath('userData'), CONFIG_FILE_NAME),
    logger,
  });
  for (const issue of config.issues) {
    // Already logged in detail by the service; repeated here at app scope because "the app is
    // running on defaults you did not choose" is a fact about the session, not about a file.
    log.warn('config was not fully applied', { kind: issue.kind, fields: issue.fields });
  }

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

  textPipeline = startTextPipeline(metrics);

  // The client is constructed before the mode machine because the machine drives it, and
  // spawned after, because `initialize` is what turns a live sidecar into a capturing one.
  // Constructing does not spawn anything.
  const client = createSidecarClient(metrics);
  if (client === null) return;

  orchestrator = new AppOrchestrator({
    sidecar: client,
    config,
    windows,
    logger,
  });

  startTray(orchestrator);
  startHotkeys(orchestrator);

  await startSidecar(client, orchestrator);
}

/**
 * Build the tray (issue #33), and give it the mode machine to drive.
 *
 * Before the sidecar, so the app has a visible quit path even when capture never starts -
 * a session that failed to spawn the sidecar is exactly the session a user most needs to be
 * able to end cleanly.
 */
function startTray(modes: AppOrchestrator): void {
  if (logger === null) return;

  const service = new TrayService({
    platform: electronTrayPlatform(),
    iconDir: resolveTrayIconDir({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    }),
    logger,
    actions: {
      onSelectRegion: () => {
        modes.selectRegion();
      },
      onSnapshot: () => {
        modes.snapshot();
      },
      onToggleAuto: () => {
        modes.toggleAuto();
      },
      onPause: () => {
        modes.pause();
      },
      onToggleOverlay: () => {
        modes.toggleOverlay();
      },
      onOpenSettings: () => {
        modes.openSettings();
      },
      // Nothing but `app.quit()`. The shutdown sequence lives in `before-quit` and this is
      // deliberately not a second copy of it - see `shutdown` below.
      onQuit: () => {
        app.quit();
      },
    },
  });
  tray = service;

  service.create();
  service.update(modes.status);
  modes.subscribe((status) => {
    service.update(status);
  });
}

/**
 * Electron's `Tray`, `Menu` and `nativeImage`, adapted to the structural interface
 * `tray-service.ts` declares.
 *
 * The casts are the price of that service not importing Electron, and they are sound in one
 * direction only: every `TrayImage` and `TrayMenu` that comes back here was produced by
 * `createImage`, `createEmptyImage` or `buildMenu` a few lines above, so it is always the
 * real Electron object. This function is the whole of the Electron-specific tray code, which
 * is the point of it existing.
 */
function electronTrayPlatform(): TrayPlatform {
  return {
    // Returns an *empty* image for a file it cannot read rather than throwing; the service
    // checks `isEmpty()` for exactly that reason.
    createImage: (filePath) => nativeImage.createFromPath(filePath),
    createEmptyImage: () => nativeImage.createEmpty(),
    buildMenu: (template: readonly TrayMenuItem[]) =>
      Menu.buildFromTemplate([...template] as MenuItemConstructorOptions[]),
    createTray: (image: TrayImage): TrayHandle => {
      const instance = new Tray(image as NativeImage);
      return {
        setToolTip: (tooltip) => {
          instance.setToolTip(tooltip);
        },
        setContextMenu: (menu) => {
          instance.setContextMenu(menu as Menu | null);
        },
        setImage: (next) => {
          instance.setImage(next as NativeImage);
        },
        on: (event, listener) => {
          instance.on(event, listener);
        },
        destroy: () => {
          instance.destroy();
        },
        isDestroyed: () => instance.isDestroyed(),
      };
    },
  };
}

/**
 * Bind the global hotkeys (issue #32) to the mode machine (issue #34).
 *
 * The four handlers were logging placeholders until now, on purpose: every action they name
 * belongs to the mode machine, and binding them before it existed would have put mode logic
 * in the entry point - the one thing this file is not for. This is the wiring they were
 * waiting for, and it is four lines because the machine holds all of the behaviour.
 */
function startHotkeys(modes: AppOrchestrator): void {
  if (logger === null) return;
  const log = logger.child('app');

  const service = new HotkeyService({ shortcuts: globalShortcut, logger });
  hotkeys = service;

  service.register((config?.current ?? DEFAULT_CONFIG).hotkeys, {
    toggleAuto: () => {
      modes.toggleAuto();
    },
    snapshot: () => {
      modes.snapshot();
    },
    selectRegion: () => {
      modes.selectRegion();
    },
    toggleOverlay: () => {
      modes.toggleOverlay();
    },
  });

  for (const failure of service.failures) {
    // Already logged per-key by the service. Repeated at app scope for the same reason config
    // issues are: the user needs one place that says what about this session is not working.
    log.warn('a hotkey is unavailable', {
      action: failure.action,
      accelerator: failure.accelerator,
      reason: failure.reason,
    });
  }
}

/**
 * Compose the text pipeline, and hand it Electron's network stack.
 *
 * `net.fetch` is the entire point of this function existing here rather than inside
 * `text-pipeline.ts`. The translator modules take their HTTP transport as a parameter and
 * default it to Node's `fetch`, which does **not** honour the system proxy - a user behind a
 * corporate proxy would get no translations and an error that reads like the endpoint being
 * down. `createTextPipeline` makes the parameter required so this cannot be forgotten, and this
 * is the one place in the app that is allowed to name Electron.
 */
function startTextPipeline(metrics: MetricsRecorder): ComposedTextPipeline | null {
  if (logger === null) return null;
  const log = logger.child('app');

  // Layer 2 of the feedback-loop defence (F2). Created here, not inside the pipeline, because
  // two stages share it: the pipeline reads it to drop text it recognises as our own output, and
  // the render path below writes it - `recent-outputs.ts` is explicit that only the stage which
  // actually puts something on screen may record it.
  const recentOutputs = new RecentOutputs();

  const composed = createTextPipeline({
    fetch: net.fetch,
    cachePath: path.join(app.getPath('userData'), 'translation-cache.db'),
    logger,
    metrics,
    recentOutputs,
    onPayload: (payload) => {
      // M10-02 (#41) still owns rendering the degraded warning; this only draws the boxes.
      const sent = windows?.sendOverlayPayload(payload) ?? false;
      if (sent) rememberDisplayed(payload, recentOutputs);

      // Counts only - every field here is a number or a boolean, never screen text (PR3).
      log.debug('overlay payload', {
        seq: payload.seq,
        complete: payload.complete,
        sent,
        engine: payload.engine,
        degraded: payload.degraded,
        failures: payload.failures.length,
        ...payload.stats,
      });
    },
  });

  log.info('translation pipeline ready', {
    engines: composed.translator.engineNames,
    // Evidence, not decoration: this line is how a real run proves which transport was injected.
    // Node's global `fetch` and Electron's `net.fetch` are different functions, and only the
    // latter reads the system proxy.
    transport: net.fetch === globalThis.fetch ? 'node-fetch' : 'electron-net',
    cache: composed.cache.status,
  });

  return composed;
}

/**
 * Record what the overlay just drew, so OCR reading it back is recognised as our own output
 * (feature F2, design doc section 6, layer 2).
 *
 * Called only when {@link WindowManager.sendOverlayPayload} reports the payload actually
 * reached a live renderer. Remembering text that was never drawn would filter a translation the
 * user never saw.
 *
 * Two exclusions, both of which look like omissions and are not:
 *
 * **Only `entry.text`, never `entry.sourceText`.** `OverlayEntry.sourceText`'s own doc comment
 * says "M5-01 remembers it", and doing that would be a serious bug. `sourceText` is the *English
 * on the user's screen* - the thing we are here to translate. `RecentOutputs` has no TTL, so
 * remembering it means that subtitle line is dropped by F2 for the rest of the session, and
 * never translated again. Only the Thai we painted is our own output.
 *
 * **Never a `degraded` entry.** Its text *is* the original English, so remembering it is the
 * same bug by a different route: the English echoed during an engine outage would be suppressed
 * permanently once the engine recovered. Recorded on issue #23.
 */
function rememberDisplayed(payload: OverlayPayload, recentOutputs: RecentOutputs): void {
  for (const entry of payload.entries) {
    if (entry.origin === 'degraded') continue;
    recentOutputs.remember(entry.text);
  }
}

/**
 * Construct the sidecar client and hand every frame to the pipeline.
 *
 * Constructing does not spawn: {@link SidecarClient.start} does, and it is called from
 * {@link startSidecar} once the mode machine exists to drive the result.
 */
function createSidecarClient(metrics: MetricsRecorder): SidecarClient | null {
  if (logger === null) return null;
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

    // Pairing `frame.monitor.id` to the right Electron `Display` is M6-01 (#28); until then the
    // region is hardcoded to the primary display anyway. `coordinates.ts` explains at length why
    // this cannot be derived from `frame.monitor.bounds` - it is physical px and Chromium lays
    // displays out in DIP space, so the two disagree the moment two monitors differ in DPI.
    // The pipeline never rejects, so this deliberately does not need a `.catch`.
    void textPipeline?.pipeline.handleFrame(frame, screen.getPrimaryDisplay());
  });

  return client;
}

/**
 * Spawn the sidecar, then let the mode machine take it from `idle` to capturing.
 *
 * `orchestrator.initialize()` is now **the only path that starts capture** in this app. The
 * temporary bootstrap that used to live here - `listMonitors` then `configure` then `start`,
 * fired straight from this file - is gone, which is part of #34's definition of done: two
 * independent things sending `start` is the bug the milestone ordering exists to prevent,
 * because the mode machine would report `idle` while a loop it does not know about ticked
 * away underneath it.
 */
async function startSidecar(client: SidecarClient, modes: AppOrchestrator): Promise<void> {
  if (logger === null) return;
  const log = logger.child('app');

  try {
    const ready = await client.start();
    log.info('sidecar is up', { version: ready.version, ocrLanguages: ready.ocrLanguages });
  } catch (error) {
    // Design doc section 7: a sidecar that will not start is reported, and the app stays
    // up so settings remain reachable. Restarting it is M10-01, not this issue.
    log.error('sidecar failed to start; capture is unavailable', {
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  await modes.initialize();
  log.info('mode machine ready', { mode: modes.mode, capturing: modes.capturing });
}

/**
 * Stop the child, flush the log, in that order. Idempotent.
 *
 * Every step logs, and that is not decoration. Until the tray (#33) shipped there was no
 * graceful way out of this app at all - `taskkill` never runs `before-quit`, so none of this
 * had ever executed in a real session and #32's "quit แล้ว hotkey ถูกปลดหมด" was being
 * satisfied by Windows reclaiming process-wide shortcuts on kill rather than by this code.
 * These lines are how a real run proves otherwise.
 */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const log = logger?.child('app');
  log?.info('shutting down');

  stopMetricsSummary?.();
  // First: a global shortcut is registered process-wide, and #32's criterion is that quitting
  // leaves nothing stuck in the system. Releasing before the slow work means a shutdown that
  // stalls on the sidecar still cannot leave a key held.
  // Counted *before* the call. `unregisterAll` clears `registrations`, so reading it
  // afterwards reports zero whether or not a single key was actually released - a log line
  // that cannot fail is not evidence of anything. The failures, if any, are logged per-key
  // by the service itself; this says how many there were to release in the first place.
  const held = hotkeys?.registrations.filter((result) => result.ok).length ?? 0;
  hotkeys?.unregisterAll();
  log?.info('hotkeys released', { released: held });

  // Before the sidecar, so the icon disappears the moment the user asks rather than after
  // however long the child takes to exit.
  tray?.destroy();
  orchestrator?.dispose();

  await sidecar?.stop();
  log?.info('sidecar stopped', { running: sidecar?.isRunning ?? false });

  // After the sidecar, so no frame can arrive and find the cache handle already gone.
  textPipeline?.close();
  log?.info('translation cache closed');

  windows?.closeAll();
  log?.info('shutdown complete');
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
