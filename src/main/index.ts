/**
 * Main process entry point: wiring, and only wiring.
 *
 * Everything electron-specific is resolved here - `userData`, `isPackaged`,
 * `resourcesPath` - and handed to services as plain values. That is what keeps
 * `services/` importable from a plain Node test process, and it is why none of those
 * modules imports `electron`.
 */

import path from 'node:path';

import { app, globalShortcut, net, screen } from 'electron';

import { DEFAULT_CONFIG, type CaptureConfig } from '../shared/config-schema.js';
import { ConfigService } from './services/config.js';
import { HotkeyService } from './services/hotkey-service.js';
import { createLogger, type Logger, type RootLogger } from './services/logger.js';
import { MetricsRecorder, startMetricsSummary } from './services/metrics.js';
import { RecentOutputs } from './services/recent-outputs.js';
import { SidecarClient, resolveSidecarPath } from './services/sidecar-client.js';
import {
  createTextPipeline,
  type ComposedTextPipeline,
  type OverlayPayload,
} from './services/text-pipeline.js';
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

  startHotkeys();

  await startSidecar(metrics);
}

/**
 * Bind the global hotkeys (issue #32).
 *
 * The handlers are placeholders that log and nothing more, and that is the honest state of
 * things: every action they name is owned by the mode machine in #34, which does not exist
 * yet. Wiring the keys to real behaviour before there is a state machine to hold it would put
 * mode logic in the entry point, which is the one thing this file is not for.
 *
 * What is real now, and testable now, is registration: whether each key was taken by another
 * program, and whether it is released on quit.
 */
function startHotkeys(): void {
  if (logger === null) return;
  const log = logger.child('app');

  const service = new HotkeyService({ shortcuts: globalShortcut, logger });
  hotkeys = service;

  const announce = (action: string) => (): void => {
    // #34 replaces every one of these. Until then a press proves the key reached us, which is
    // the only thing that can be proved before there is something for it to do.
    log.info('hotkey pressed; no handler until the mode machine lands (#34)', { action });
  };

  service.register((config?.current ?? DEFAULT_CONFIG).hotkeys, {
    toggleAuto: announce('toggleAuto'),
    snapshot: announce('snapshot'),
    selectRegion: announce('selectRegion'),
    toggleOverlay: announce('toggleOverlay'),
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

    // Pairing `frame.monitor.id` to the right Electron `Display` is M6-01 (#28); until then the
    // region is hardcoded to the primary display anyway. `coordinates.ts` explains at length why
    // this cannot be derived from `frame.monitor.bounds` - it is physical px and Chromium lays
    // displays out in DIP space, so the two disagree the moment two monitors differ in DPI.
    // The pipeline never rejects, so this deliberately does not need a `.catch`.
    void textPipeline?.pipeline.handleFrame(frame, screen.getPrimaryDisplay());
  });

  try {
    const ready = await client.start();
    log.info('sidecar is up', { version: ready.version, ocrLanguages: ready.ocrLanguages });
    startSmokeCapture(client, (config?.current ?? DEFAULT_CONFIG).capture, log);
  } catch (error) {
    // Design doc section 7: a sidecar that will not start is reported, and the app stays
    // up so settings remain reachable. Restarting it is M10-01, not this issue.
    log.error('sidecar failed to start; capture is unavailable', {
      exePath,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// TEMPORARY BOOTSTRAP - issue #34 (M6-04, mode orchestration) MUST DELETE ALL OF THIS.
// ---------------------------------------------------------------------------
/*
 * Everything from here to the end of `startSmokeCapture` is scaffolding, and #34's
 * definition of done includes removing it.
 *
 * Why it exists: every stage of the pipeline was built and wired, but nothing in `src/`
 * ever called `SidecarClient.send`, so the sidecar sat in `idle` forever and no frame was
 * ever produced. The app booted cleanly and did nothing, which is the worst shape a bug
 * can take. This is the smallest honest thing that makes the whole path run once.
 *
 * Why it must not survive: #34 owns `idle -> auto -> paused -> snapshot`, and *it* is what
 * decides when capture starts. Two independent things sending `start` is precisely the bug
 * the milestone ordering exists to avoid - the mode machine would report `idle` while a
 * capture loop it does not know about ticks away underneath it.
 *
 * The *settings* it sends are no longer hardcoded - they come from `ConfigService` (#38), so
 * a run can be retuned by editing `config.json` rather than by rebuilding. What remains
 * temporary is the decision to start at all, which is the part #34 takes over.
 *
 * It deliberately does **not** subscribe to config changes. Re-sending `configure` when a
 * setting changes is a real requirement, but it belongs to the mode machine that owns the
 * sidecar's state - adding it here would build the second start path this comment exists to
 * warn about, and then delete it a step later.
 */

/** How long to wait for the `listMonitors` reply before giving up loudly (invariant 4). */
const SMOKE_LIST_MONITORS_TIMEOUT_MS = 2_000;

/**
 * Ask which monitors exist, then configure and start capture.
 *
 * `capture.monitorId` selects the monitor and `null` means "whichever is primary"; likewise
 * `capture.region` is `null` for the whole display. Both defaults are deliberate. Issue #30
 * (R7) records that a region whose edge cuts through a letter breaks OCR outright, so until
 * the region picker exists the uncropped display is the only honest choice - a hardcoded
 * rectangle would be a guess that fails that way on some machines and not others.
 */
function startSmokeCapture(client: SidecarClient, capture: CaptureConfig, log: Logger): void {
  // Subscribed before the command is sent. The reply is a line on a pipe that is already
  // flowing, so a listener attached afterwards is a race that only ever loses on a machine
  // faster than this one.
  let timer: NodeJS.Timeout | undefined;
  const off = client.on('ack', (ack) => {
    if (ack.cmd !== 'listMonitors') return;
    clearTimeout(timer);
    off();

    // `monitors` is present only on this reply; an empty list is a real answer on a machine
    // with no attached display, and is not the same thing as a malformed one.
    const monitors = ack.monitors ?? [];
    // Win32 defines the primary monitor as the one at physical origin (0,0), which is the
    // same monitor Electron reports as primary - and matching on it needs no scale
    // arithmetic, so invariant 3 is untouched.
    const primary = monitors.find((entry) => entry.bounds[0] === 0 && entry.bounds[1] === 0);
    const configured =
      capture.monitorId === null ? undefined : monitors.find((entry) => entry.id === capture.monitorId);

    if (capture.monitorId !== null && configured === undefined) {
      // Issue #35 (R2) is explicit that a monitor that has been unplugged since the config was
      // written must never be substituted for silently. Falling back is still better than not
      // capturing, but it is said out loud.
      log.warn('the configured monitor is not attached; falling back to the primary display', {
        monitorId: capture.monitorId,
        attached: monitors.map((entry) => entry.id),
      });
    }

    const monitor = configured ?? primary ?? monitors[0];
    if (monitor === undefined) {
      log.error('listMonitors returned no monitors; capture cannot start');
      return;
    }
    if (monitor !== primary) {
      // Frames are paired to `screen.getPrimaryDisplay()` above until M6-01 (#28), so any
      // monitor other than the primary means the boxes are placed against the wrong origin.
      log.warn('capturing a non-primary monitor; box positions will be wrong until #28 lands', {
        monitorId: monitor.id,
      });
    }

    // `null` means the whole display. The size comes straight from the sidecar's own reply, so
    // no conversion happens in Node; the region is physical px relative to the monitor's
    // top-left, which for a full display starts at (0,0).
    const region = capture.region ?? ([0, 0, monitor.bounds[2], monitor.bounds[3]] as const);

    client.send({
      cmd: 'configure',
      region,
      monitorId: monitor.id,
      intervalActive: capture.intervalActive,
      intervalIdle: capture.intervalIdle,
      diffThreshold: capture.diffThreshold,
      ocrLanguage: capture.ocrLanguage,
      debugFrameEnabled: capture.debugFrameEnabled,
    });
    client.send({ cmd: 'start' });

    log.info('smoke capture started', {
      monitorId: monitor.id,
      scale: monitor.scale,
      region,
      intervalActive: capture.intervalActive,
      intervalIdle: capture.intervalIdle,
      diffThreshold: capture.diffThreshold,
      ocrLanguage: capture.ocrLanguage,
      debugFrameEnabled: capture.debugFrameEnabled,
    });
  });

  timer = setTimeout(() => {
    off();
    log.error('no listMonitors reply; capture never started', { timeoutMs: SMOKE_LIST_MONITORS_TIMEOUT_MS });
  }, SMOKE_LIST_MONITORS_TIMEOUT_MS);
  timer.unref?.();

  if (!client.send({ cmd: 'listMonitors' })) {
    clearTimeout(timer);
    off();
  }
}

// --------------------------- end of temporary bootstrap ---------------------------

/** Stop the child, flush the log, in that order. Idempotent. */
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  stopMetricsSummary?.();
  // First: a global shortcut is registered process-wide, and #32's criterion is that quitting
  // leaves nothing stuck in the system. Releasing before the slow work means a shutdown that
  // stalls on the sidecar still cannot leave a key held.
  hotkeys?.unregisterAll();
  await sidecar?.stop();
  // After the sidecar, so no frame can arrive and find the cache handle already gone.
  textPipeline?.close();
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
