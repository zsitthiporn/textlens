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
  ipcMain,
  nativeImage,
  net,
  screen,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';

import { DEFAULT_CONFIG } from '../shared/config-schema.js';
import { SettingsIpc } from './ipc-handlers.js';
import {
  AppOrchestrator,
  SIDECAR_EXIT_ERROR,
  describeAppWarning,
  type AppStatus,
} from './services/app-orchestrator.js';
import { ConfigService } from './services/config.js';
import { DrawnPayloads } from './services/drawn-payloads.js';
import {
  ErrorReporter,
  alertSurfaces,
  describeConfigIssues,
  describeHotkeyFailures,
  describeMissingRecognizer,
  describeSupervisor,
  judgeTranslation,
} from './services/error-reporter.js';
import { HotkeyService } from './services/hotkey-service.js';
import { createLogger, type RootLogger } from './services/logger.js';
import { MetricsRecorder, startMetricsSummary } from './services/metrics.js';
import { MonitorService } from './services/monitor-service.js';
import { RecentOutputs } from './services/recent-outputs.js';
import { SidecarClient, resolveSidecarPath } from './services/sidecar-client.js';
import { SidecarSupervisor } from './services/sidecar-supervisor.js';
import {
  DEFAULT_SRC_LANG,
  DEFAULT_TGT_LANG,
  createTextPipeline,
  type ComposedTextPipeline,
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
let supervisor: SidecarSupervisor | null = null;
let windows: WindowManager | null = null;
let textPipeline: ComposedTextPipeline | null = null;
let orchestrator: AppOrchestrator | null = null;
let tray: TrayService | null = null;
let monitors: MonitorService | null = null;
/** The settings window's main-process half (#39). Null until `bootstrap` has built its inputs. */
let settingsIpc: SettingsIpc | null = null;
/** F2's writing half (#52). Held so shutdown can drop what the renderer will never answer for. */
let drawnPayloads: DrawnPayloads | null = null;
let stopDrawnListener: (() => void) | null = null;
let stopMetricsSummary: (() => void) | null = null;
let shuttingDown = false;
/** Frames dropped because their monitor is unpaired. Counted so the log can be rate-limited. */
let framesWithoutDisplay = 0;

/**
 * The user-facing error surface (issue M10-02 / #41).
 *
 * Created before anything that can fail, and at module scope rather than inside `bootstrap`,
 * because the earliest thing worth reporting - a config file that would not parse - happens on the
 * first `await` in there.
 */
const reporter = new ErrorReporter();
/** The mode machine's last status, held so the tray can be written from one place. */
let lastStatus: AppStatus = { mode: 'idle', overlayVisible: true, error: null, warning: null };

/**
 * Push the current state to every surface the user can actually see.
 *
 * **One writer.** The mode machine and the reporter both change what the tray should say, and two
 * subscribers each calling `tray.update` with their own half would race - whichever fired last
 * would win, and a status change would erase an alert that is still true. Both of them write into
 * a variable and call this instead.
 *
 * The tray gets the alert in its `error` slot when it is `fatal` or `error`, because that slot is
 * what turns the icon red; a `warning` or `info` alert lands in `warning`, which is the tooltip
 * and a disabled menu row. That mapping is the whole of "tray icon เปลี่ยนเป็นสถานะ error".
 *
 * **The tray and the banner read different views of the same alert (#59).** The tray reads
 * `reporter.top`, which stands until its source clears it; the banner reads `reporter.banner`,
 * which hands the screen back after a while for everything short of an error. The mapping itself
 * is `alertSurfaces`, in `error-reporter.ts`, so the split is pinned by a test rather than by
 * this function being read carefully.
 */
function renderStatus(): void {
  // Pulled from the reporter rather than from a variable a subscriber keeps up to date. A real run
  // caught the difference: `ErrorReporter` only notifies when the *top* alert changes, so a second
  // condition arriving underneath an existing one is correctly silent - and a cached copy that is
  // only ever written by that notification was therefore still `null` for the whole session when
  // the very first alert was published before anything had subscribed. Reading the source of truth
  // at render time removes the ordering question entirely.
  const surfaces = alertSurfaces(reporter);

  tray?.update({
    mode: lastStatus.mode,
    overlayVisible: lastStatus.overlayVisible,
    error: surfaces.trayError,
    warning: surfaces.trayWarning,
  });

  windows?.sendOverlayStatus({ alert: surfaces.overlayAlert });

  // The third surface (#39). It shows the same single worst alert the other two do - one ranking,
  // three renderings - plus everything underneath it that the tray has no room for.
  settingsIpc?.publish();
}

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
  // #41, and the gap recorded when #38 was closed: until now this reached the log and the
  // `issues` getter and stopped, so a user whose `intervalActive` was rejected got the default
  // silently and no way to find out.
  reporter.subscribe(() => {
    renderStatus();
  });
  reporter.set('config', describeConfigIssues(config.issues, config.filePath));

  const metrics = new MetricsRecorder();
  stopMetricsSummary = startMetricsSummary(metrics, logger.child('metrics'), METRICS_SUMMARY_INTERVAL_MS);

  // M6-01 (#28). Constructed before the sidecar client, because the frame handler asks it which
  // display each frame belongs to. Electron's `Display` satisfies `PairableDisplay` structurally,
  // which is what lets `monitor-service.ts` stay Electron-free and testable against mixed-DPI
  // hardware that is not attached to this machine.
  monitors = new MonitorService({
    screen: { getAllDisplays: () => screen.getAllDisplays(), getPrimaryDisplay: () => screen.getPrimaryDisplay() },
    logger,
  });
  // #28: "เสียบ/ถอดจอระหว่างใช้งาน → รายการอัปเดต ไม่ crash". Only the display half can be
  // refreshed here - the monitor half needs a `listMonitors` round trip, and this process has
  // exactly one caller of that for a reason (see `AppOrchestrator.#listMonitors`). A monitor
  // whose display has gone simply comes back unpaired, which is reported rather than guessed at.
  // Spelled out one by one rather than looped: Electron's overloads pair each event name with
  // its own listener signature, so a loop over a union of names matches none of them.
  screen.on('display-added', () => {
    monitors?.refreshDisplays('display-added');
  });
  screen.on('display-removed', () => {
    monitors?.refreshDisplays('display-removed');
  });
  screen.on('display-metrics-changed', () => {
    monitors?.refreshDisplays('display-metrics-changed');
  });

  windows = new WindowManager({ distDir, logger });
  // Published before the first window opens, so no payload can ever be laid out against numbers
  // the user did not choose. The argument is the renderer's own contract type and this is the
  // parsed config - the assignment is the compile-time drift guard between the two.
  windows.setOverlayRender((config?.current ?? DEFAULT_CONFIG).render);
  config?.subscribe((current, previous) => {
    windows?.setOverlayRender(current.render);
    // #36's "reset ได้เมื่อเปลี่ยน region", and since #52 the dedup and displayed-set halves of
    // the same thing. The renderer's own positional memory is cleared by the epoch bump
    // `AppOrchestrator` issues for the same event; this is the main-process half, and it is here
    // rather than in the orchestrator because the pipeline is this file's to hold.
    const monitorChanged = current.capture.monitorId !== previous.capture.monitorId;
    const moved =
      JSON.stringify(current.capture.region) !== JSON.stringify(previous.capture.region) || monitorChanged;
    if (moved) textPipeline?.pipeline.resetScene('capture region or monitor changed');

    // #39, and a bug the monitor picker would have exposed the moment it shipped: nothing moved the
    // overlay when the captured monitor changed. Frames are paired to their own display and
    // converted to screen-global logical px, then the renderer subtracts the overlay window's
    // origin - so capturing DISPLAY2 while the overlay covers DISPLAY1 puts every box off the side
    // of the window, and the app looks like it stopped translating. Nothing reported it, because
    // every stage genuinely succeeded.
    if (monitorChanged) moveOverlayToCaptured(current.capture.monitorId);

    // One apply path for hotkeys, whether the change came from the settings window or from an
    // edited config file. `HotkeyService.register` replaces the previous set, so this is also what
    // releases the old accelerator.
    if (JSON.stringify(current.hotkeys) !== JSON.stringify(previous.hotkeys)) applyHotkeys();

    settingsIpc?.publish();
  });
  // #39's "not-persisted is unreachable", decided. `ConfigService` now announces its own issues,
  // so a write that fails *after* boot - from the region picker, or from a settings control -
  // reaches the same alert the boot-time issues do instead of only the log. Read once at startup
  // was the whole of the gap.
  config?.subscribeIssues((issues) => {
    reporter.set('config', describeConfigIssues(issues, config?.filePath ?? null));
    settingsIpc?.publish();
  });
  windows.openSettings('settings');
  windows.openOverlay();

  // **Closing the settings window used to quit the app** (#56). The reasoning was sound when it
  // was written and expired when the tray shipped: back then the overlay was frameless, had no
  // taskbar entry and could not be focused, so the settings window was the only thing a user
  // could close - and therefore the only way out of the app at all.
  //
  // #33 gave the app a tray with a Quit item and #32 gave it hotkeys, so that is no longer true,
  // and the old behaviour became a trap: the user opens settings to rebind a key, presses the
  // close button by reflex, and the whole session ends - gracefully, silently, and with capture
  // stopped. Nothing warned them, because from the app's point of view nothing went wrong.
  //
  // Nothing replaces it here. `WindowManager.openSettings` already clears its own reference on
  // `closed` and builds a fresh window on the next call, and `SettingsIpc` resolves both the
  // target window and the trusted sender id at message time rather than capturing them - so
  // closing and reopening from the tray is a path that already worked and had no way to be used.

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
    monitors,
    picker: windows,
  });

  const modes = orchestrator;

  // Supervision (#40). Constructed before the tray so the tray's "Restart capture engine" item
  // has something to call, and before the first start so that start failure gets the same backoff
  // and the same quota as a crash - which is what moves `index.ts`'s old "capture is unavailable,
  // give up" branch into something the app can recover from.
  supervisor = new SidecarSupervisor({
    client,
    logger,
    onStarted: async () => {
      // The whole reason a supervisor exists rather than a bare restart loop. A sidecar that came
      // back but was never reconfigured produces no frames and logs nothing about it.
      await modes.initialize();
    },
    // #40: a sidecar that dies while the user has paused stays dead until they return to auto.
    // `idle` counts as wanting one because that is the state the app boots in, before
    // `initialize` has run.
    wantsSidecar: () => modes.mode !== 'paused',
    // The watchdog's arming condition. `capturing` is the mode machine's own belief about the
    // loop, so a paused or snapshot-held sidecar is silent legitimately and is left alone.
    expectsEvents: () => modes.capturing,
    watchdogSilenceMs: () => (config?.current ?? DEFAULT_CONFIG).capture.intervalIdle * 6,
  });
  const supervision = supervisor;

  supervision.subscribe((status) => {
    reporter.set(
      'sidecar',
      describeSupervisor(status, { nowMs: Date.now(), logDirectory: logger?.directory ?? null }),
    );
  });

  // #36's other reset trigger. A pause, a snapshot or an overlay toggle all change what the user
  // is looking at without changing the region, and a baseline held across one of them would
  // suppress the first frame after the app starts capturing again - the one frame that most needs
  // to be drawn, because the screen has been unattended since.
  let lastMode = orchestrator.mode;
  orchestrator.subscribe((status) => {
    lastStatus = status;
    publishOrchestratorAlerts(status);
    renderStatus();

    // Returning to auto is the deliberate retry for a sidecar that died while paused, and the one
    // moment at which restarting it is unambiguously what the user wants.
    if (status.mode === 'auto') supervision.ensureRunning();

    if (status.mode === lastMode) return;
    lastMode = status.mode;
    textPipeline?.pipeline.resetScene(`mode changed to ${status.mode}`);
  });

  startTray(orchestrator);
  startHotkeys(orchestrator);
  startSettingsIpc(orchestrator, supervision);

  lastStatus = orchestrator.status;
  renderStatus();

  await supervision.start();
  log.info('mode machine ready', { mode: modes.mode, capturing: modes.capturing });
}

/**
 * Route the mode machine's own two report channels into the error surface (#41).
 *
 * `error` and `warning` are kept on separate sources rather than merged, because they clear on
 * opposite events - an error is wiped by the next frame, a warning is *produced* by frames
 * arriving - and one slot would have the two overwriting each other.
 */
function publishOrchestratorAlerts(status: AppStatus): void {
  reporter.set(
    'capture',
    // The supervisor tells this story better and is already telling it; see `SIDECAR_EXIT_ERROR`.
    status.error === null || status.error === SIDECAR_EXIT_ERROR
      ? null
      : { severity: 'error', cause: status.error, remedy: 'see the log for detail; capture retries on its own' },
  );
  // The mapping itself lives with the warning texts in `app-orchestrator.ts`, because which of
  // the four conditions on this channel may leave the banner by itself (#59) is a question about
  // what they mean, and this file must be able to say nothing about that.
  reporter.set('region', describeAppWarning(status.warning));
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
      // The way back out of the supervisor's give-up state (#40/#41). The alert tells the user
      // this item exists; without it, "Textlens has stopped restarting the capture engine" would
      // be a message whose only remedy is relaunching the app.
      onRestartSidecar: () => {
        supervisor?.retry();
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
  // Deliberately **not** `modes.subscribe(service.update)`. The mode machine and the error
  // reporter both decide what the tray says, and two subscribers each writing their own half
  // would race: whichever fired last would win, and a mode change would erase an alert that is
  // still true. `renderStatus` is the single writer; see its comment.
  lastStatus = modes.status;
  renderStatus();
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
  hotkeys = new HotkeyService({ shortcuts: globalShortcut, logger });
  applyHotkeys();
  void modes;
}

/**
 * Bind the current config's accelerators and report the outcome.
 *
 * **The only place `register` is called**, and that is what #39 needed it to become. It used to run
 * once at startup, which meant a rebind had nowhere to take effect: the settings window writes
 * config, the config subscriber calls this, and the same path serves an edited file on disk. A
 * second call site would be a second answer to "which keys are live".
 */
function applyHotkeys(): void {
  const service = hotkeys;
  const modes = orchestrator;
  if (service === null || modes === null || logger === null) return;
  const log = logger.child('app');

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
  // #41. `Control+Alt+R` conflicts on this machine and has done for the whole project; the log
  // said so every run and nothing else did. `describeHotkeyFailures` is where 'conflict' and
  // 'duplicate' get different text - see its comment on why that distinction is not cosmetic.
  // Since #39 the remedy it names is reachable: the settings window rebinds from a captured
  // keystroke, so "pick a different key" is a thing the user can do rather than advice.
  reporter.set('hotkeys', describeHotkeyFailures(service.failures));
  settingsIpc?.publish();
}

/**
 * Wire the settings window (issue M9-02 / #39).
 *
 * Last, because it reads from everything: the config service, the mode machine, the monitor
 * registry, the hotkey service, the supervisor and the error reporter. Built here rather than
 * inside `SettingsIpc` for the reason this whole file exists - `ipc-handlers.ts` imports no
 * `electron`, so the two Electron-shaped things it needs (the channel plumbing and the window's
 * identity) are supplied from the one module that is allowed to name them.
 */
function startSettingsIpc(modes: AppOrchestrator, supervision: SidecarSupervisor): void {
  if (logger === null || config === null || monitors === null) return;
  const configService = config;
  const monitorService = monitors;

  const ipc = new SettingsIpc({
    host: {
      handle: (channel, handler) => {
        ipcMain.handle(channel, async (event, payload: unknown) => await handler(event.sender.id, payload));
      },
      removeHandler: (channel) => {
        ipcMain.removeHandler(channel);
      },
      send: (channel, message) => {
        const target = windows?.settings;
        if (target === undefined || target === null || target.isDestroyed()) return false;
        target.webContents.send(channel, message);
        return true;
      },
    },
    config: configService,
    modes,
    hotkeys: {
      get registrations() {
        // A getter, not a snapshot: `applyHotkeys` replaces the array on every rebind, and a value
        // captured here would freeze the window's view at whatever was true when it opened.
        return hotkeys?.registrations ?? [];
      },
      probe: (accelerator) =>
        hotkeys?.probe(accelerator) ?? { ok: false, reason: 'invalid', detail: 'hotkeys are unavailable' },
    },
    monitors: monitorService,
    sidecar: {
      get status() {
        return supervision.status;
      },
      retry: () => {
        supervision.retry();
      },
    },
    // Read at publish time rather than cached, for the reason `renderStatus` gives: the reporter
    // only notifies when the *top* alert changes, so a cached copy is wrong for every alert that
    // arrives underneath an existing one.
    alert: () => reporter.top,
    engines: textPipeline?.translator.engineNames ?? [],
    srcLang: DEFAULT_SRC_LANG,
    tgtLang: DEFAULT_TGT_LANG,
    versions: {
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node ?? 'unknown',
    },
    // Identity, re-read on every message. The window can be closed and reopened, and a captured id
    // would keep authorising a `webContents` that no longer exists - or, worse, one whose id has
    // been reused.
    isTrustedSender: (senderId) => {
      const target = windows?.settings;
      return target !== undefined && target !== null && !target.isDestroyed() && target.webContents.id === senderId;
    },
    logger,
  });

  ipc.register();
  settingsIpc = ipc;

  // The supervisor's own light in the Configuration panel. Its alert already reaches `renderStatus`
  // through the reporter; this is the raw state, which the alert deliberately does not carry for
  // the states that are not worth interrupting anybody over.
  supervision.subscribe(() => {
    ipc.publish();
  });
  ipc.publish();
}

/**
 * Put the overlay on the display the sidecar is capturing (#39).
 *
 * `null` means "whichever monitor is primary", which is resolved the same way `AppOrchestrator`
 * resolves it - so the overlay follows the capture rather than guessing independently. A monitor
 * that has no paired display is left alone deliberately: `MonitorService.displayFor` returning
 * `undefined` is the case #28 exists for, and moving the overlay somewhere arbitrary would be the
 * confident-but-wrong behaviour that issue removed.
 */
function moveOverlayToCaptured(monitorId: string | null): void {
  const log = logger?.child('app');
  if (monitorId === null) {
    windows?.moveOverlayTo(screen.getPrimaryDisplay().id);
    log?.info('overlay moved to the primary display', { reason: 'monitor set to automatic' });
    return;
  }

  const display = monitors?.displayFor(monitorId);
  if (display === undefined) {
    log?.warn('cannot move the overlay: the chosen monitor is not paired to any display', { monitorId });
    return;
  }
  windows?.moveOverlayTo(display.id);
  log?.info('overlay moved to follow the captured monitor', { monitorId, displayId: display.id });
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

  // #52. The writing half of F2, and the reason it is a service rather than four lines here:
  // "displayed" is a fact only the renderer has, and the rules about which of its entries may be
  // recorded are the kind that need a test to hold them down. Visibility is read at ack time, off
  // the window itself - `lastStatus` is the mode machine's belief, and this is the window's.
  const drawn = new DrawnPayloads({
    recentOutputs,
    isVisible: () => windows?.overlayVisible ?? false,
  });
  drawnPayloads = drawn;
  stopDrawnListener = windows?.onOverlayDrawn((id) => {
    drawn.drawn(id);
  }) ?? null;

  const composed = createTextPipeline({
    fetch: net.fetch,
    cachePath: path.join(app.getPath('userData'), 'translation-cache.db'),
    logger,
    metrics,
    recentOutputs,
    // #36. Read once: changing these mid-session would need the baseline discarded anyway, and
    // the reset paths below already cover the events that actually invalidate it.
    stability: (config?.current ?? DEFAULT_CONFIG).stability,
    onPayload: (payload) => {
      const id = windows?.sendOverlayPayload(payload) ?? null;
      const sent = id !== null;
      // Recorded as *sent*, never as displayed. `DrawnPayloads` turns one into the other when the
      // renderer says so, which is the whole of #52: the minimum-display gate can supersede this
      // payload before it is ever painted, and `RecentOutputs` has no TTL to recover from being
      // told about text nobody saw.
      if (id !== null) drawn.sent(id, payload.entries);

      // #41 row 3, and the reason design doc section 7 exempts `degraded` from
      // identical-suppression in the first place: the user is looking at English, on purpose, and
      // until now nothing told them why. `judgeTranslation` owns which payloads count - notably
      // that a cache-only frame is not evidence the engine came back.
      const verdict = judgeTranslation(payload);
      if (verdict.kind === 'set') reporter.set('translation', verdict.alert);
      else if (verdict.kind === 'clear') reporter.set('translation', null);

      // Counts only - every field here is a number or a boolean, never screen text (PR3).
      // Returned, not just logged. The pipeline treats `false` as "nobody saw this", which is
      // what stops #36 from advancing its baseline past a payload the overlay refused.
      log.debug('overlay payload', {
        seq: payload.seq,
        complete: payload.complete,
        sent,
        // Counts only. Evidence that the ack loop is closed: `remembered` climbing while
        // `discarded` stays flat is a renderer answering for everything it is given.
        remembered: drawn.remembered,
        discarded: drawn.discarded,
        engine: payload.engine,
        degraded: payload.degraded,
        failures: payload.failures.length,
        ...payload.stats,
      });

      return sent;
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

  // Feature O8 / #41 row 1, and spike S1's headline finding: without an OCR recognizer for the
  // source language this app cannot produce a single word, and Windows reports that fact exactly
  // once, here. Checked on every `ready` rather than only the first, so a restart onto a machine
  // where the pack was just installed clears it.
  client.on('ready', (ready) => {
    reporter.set(
      'ocr',
      describeMissingRecognizer((config?.current ?? DEFAULT_CONFIG).capture.ocrLanguage, ready.ocrLanguages),
    );
  });

  // Timings arrive with every frame; feeding them here means the summary reflects the
  // sidecar's own measurements rather than anything Node guessed about them.
  client.on('frame', (frame) => {
    metrics.recordFrameTimings(frame.timings);

    // M6-01 (#28). This used to be `screen.getPrimaryDisplay()` regardless of which monitor the
    // frame came from, which put every box on the wrong screen whenever a secondary display was
    // captured. `coordinates.ts` explains why the display cannot be derived from
    // `frame.monitor.bounds`: it is physical px and Chromium lays displays out in DIP space, so
    // the two disagree the moment two monitors differ in DPI.
    const display = monitors?.displayFor(frame.monitor.id);
    if (display === undefined) {
      // Deliberately no fallback to the primary display. Drawing this frame's boxes against
      // some other display's origin is the bug #28 removed, and it fails the way invariant 4
      // forbids - confidently, on the wrong screen, with nothing to see in the log.
      framesWithoutDisplay += 1;
      if (framesWithoutDisplay === 1 || framesWithoutDisplay % 100 === 0) {
        log.warn('dropping a frame from a monitor that is not paired to any display', {
          monitorId: frame.monitor.id,
          dropped: framesWithoutDisplay,
        });
      }
      // #41. This branch drops every frame it sees, so the symptom is an overlay that has simply
      // stopped - the single most confusing failure in the app, and previously a rate-limited log
      // line and nothing else. Set on the first one; cleared by the first frame that does pair.
      reporter.set('monitor', {
        severity: 'error',
        cause: 'the screen being captured is not one Windows is reporting to Textlens, so nothing can be drawn',
        remedy: 'reconnect or re-select the monitor, then use the tray menu → "Select Region…" again',
      });
      return;
    }

    if (framesWithoutDisplay > 0) {
      framesWithoutDisplay = 0;
      reporter.set('monitor', null);
    }

    // The pipeline never rejects, so this deliberately does not need a `.catch`.
    void textPipeline?.pipeline.handleFrame(frame, display);
  });

  return client;
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
  // Before the windows go. A handler left attached to `ipcMain` outlives the window it served, and
  // a relaunch inside one process would find the channel already taken.
  settingsIpc?.dispose();

  // **Before `sidecar.stop()`**, and the order is the whole point. `stop()` closes stdin and the
  // sidecar exits 0; a supervisor still listening would see a process go away during a shutdown
  // that had not finished, and the `expected` flag is the only thing standing between that and a
  // restart racing the quit. Disposing first removes the listener entirely rather than relying on
  // the flag.
  supervisor?.dispose();
  log?.info('sidecar supervision stopped');

  await sidecar?.stop();
  log?.info('sidecar stopped', { running: sidecar?.isRunning ?? false });

  // After the sidecar, so no frame can arrive and find the cache handle already gone.
  textPipeline?.close();
  log?.info('translation cache closed');

  // Before the windows go: once the overlay is destroyed nothing can ever confirm what it drew,
  // and a payload left waiting for an ack that cannot arrive is not a payload that was displayed.
  stopDrawnListener?.();
  drawnPayloads?.reset();

  windows?.closeAll();
  log?.info('shutdown complete');
  await logger?.close();
}

/**
 * Deliberately does not quit (#56).
 *
 * Electron's default with no listener at all is to quit on Windows, so this handler has to exist
 * in order to do nothing - deleting it would put the bug back by a different route than the one
 * #56 describes, which is exactly the trap that issue warns about.
 *
 * **The tray is the only way out of this app**, and that is now a load-bearing statement rather
 * than a design preference. The overlay window lives for the whole session - toggling it hides
 * and shows, never closes - so in practice this fires only during shutdown, after `closeAll`. But
 * "in practice" is not a guarantee: a renderer crash or a future window taking its own exit would
 * reach here, and quitting the user's session because a window went away is not a decision this
 * app gets to make quietly.
 *
 * The risk this accepts is recorded on #56 and is real: Windows 11 hides new tray icons in the
 * overflow by default, so a user who never opens that overflow now has an app with no visible
 * exit. That is a discoverability problem to solve in the tray, not a reason to keep a quit path
 * that fires on a misclick.
 */
app.on('window-all-closed', () => {
  // Silent during shutdown. `shutdown()` calls `closeAll()`, so a graceful quit reaches here as a
  // matter of course, and announcing "staying alive" in the middle of a quit is a log line that
  // contradicts the three around it - the kind of thing that makes someone reading a shutdown
  // trace doubt the trace rather than the message.
  if (shuttingDown) return;
  logger?.child('app').info('all windows closed; staying alive - quit from the tray (#56)');
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
