/**
 * The mode machine (issue M7-03 / #34, features G3, G4, G5).
 *
 * One object decides what mode the app is in and, from that, whether the sidecar should be
 * capturing. Nothing else in the app may send `start`, `stop`, `configure` or `snapshot`:
 * `docs/reference-analysis.md` records that the reference project's "pause" only hides the
 * overlay while its pipeline keeps running, and two independent things driving the capture
 * loop is how a codebase ends up in that state without anyone deciding to.
 *
 * ## The four modes
 *
 * | mode       | capture loop | what the user sees                                    |
 * |------------|--------------|-------------------------------------------------------|
 * | `idle`     | stopped      | nothing; the sidecar is not configured yet             |
 * | `auto`     | **running**  | boxes refreshed on the adaptive interval (G3)          |
 * | `paused`   | stopped      | the last boxes, frozen (G5)                            |
 * | `snapshot` | stopped      | one frame captured on demand, held (G4)                |
 *
 * **`paused` really stops the sidecar.** `stop` disposes the loop's timer
 * (`CaptureLoop.Stop`), so a paused Textlens costs approximately nothing - which is what
 * #34's acceptance criterion measures with a CPU reading, and what distinguishes this from
 * hiding the overlay.
 *
 * **Hiding the overlay is not pausing**, and the two are kept apart by construction:
 * {@link AppOrchestrator.toggleOverlay} touches only the window and never the sidecar, so
 * capture, OCR and translation all carry on while the boxes are hidden.
 *
 * ## `snapshot` is an action everywhere except from `idle`
 *
 * The issue asks for three things which together pin this down: a snapshot taken during
 * `auto` ends back in `auto`, one taken during `paused` stays `paused`, and `snapshot` is
 * nevertheless a mode of its own - G4's "จับครั้งเดียว ค้างไว้จน dismiss", the
 * document-reading mode whose cost is one tick.
 *
 * So: from `auto` or `paused`, a snapshot is one extra `snapshot` command and the mode does
 * not move. From `idle` - where there is no mode to go back to and nothing is running - it
 * becomes the resting mode `snapshot`, and the frame stays on screen until something else
 * moves the machine.
 *
 * ## Why rapid mode switching cannot corrupt anything
 *
 * Every transition updates {@link AppOrchestrator.mode} **synchronously** and then runs
 * {@link AppOrchestrator.#apply}, which is also synchronous: it compares the mode against
 * what this object believes the sidecar is doing and sends at most one `start` or one `stop`.
 * Nothing is queued and nothing is scheduled, so a burst of presses is just a sequence of
 * assignments, and the sidecar receives one command per actual change of intent rather than
 * one per keypress. The sidecar's own `start`/`stop` are idempotent as well
 * (`CaptureLoop.Start` returns early when the timer exists), so even a redundant one is safe.
 *
 * The one genuinely async step is the `listMonitors` round trip during {@link initialize},
 * and it is why {@link AppOrchestrator.#configured} exists: before the `configure` is
 * acknowledged there is nothing legal to send - the sidecar answers `start` with
 * `NOT_CONFIGURED` - so transitions during startup only set the desired mode, and the
 * reconcile that runs after `configure` applies whichever one the user landed on. Hammering
 * the hotkey while the app is starting is therefore uninteresting rather than a race.
 *
 * ## No `electron` import
 *
 * The overlay is reached through {@link OverlayWindows}, the structural slice of
 * `WindowManager` this needs. Same technique, and the same reason, as `ShortcutRegistrar`
 * in `hotkey-service.ts`: these tests run in plain Node.
 */

import type { CaptureConfig, Config } from '../../shared/config-schema.js';
import type { AckEvent, MonitorInfo, Rect, SidecarCommand } from '../../shared/protocol.js';
import { nullLogger, type Logger } from './logger.js';
import type { SidecarClientEvents } from './sidecar-client.js';

export const APP_MODES = ['idle', 'auto', 'paused', 'snapshot'] as const;

export type AppMode = (typeof APP_MODES)[number];

/** The four sidecar events the mode machine reacts to. */
export type CaptureSidecarEvent = 'ack' | 'error' | 'frame' | 'exit';

/**
 * The part of `SidecarClient` the mode machine drives.
 *
 * The payload types come from `SidecarClientEvents` rather than being restated here, so a
 * change to the wire shape fails this file at compile time instead of at runtime. The
 * *methods* are still declared structurally, which is what keeps `SidecarClient` itself out
 * of these tests.
 */
export interface CaptureSidecar {
  send(command: SidecarCommand): boolean;
  on<K extends CaptureSidecarEvent>(event: K, listener: (payload: SidecarClientEvents[K]) => void): () => void;
}

/** The part of `WindowManager` the mode machine touches. */
export interface OverlayWindows {
  /** @returns whether the overlay's visibility is now what was asked for. */
  setOverlayVisible(visible: boolean): boolean;
  openSettings(): unknown;
}

/** The part of `ConfigService` the mode machine reads. */
export interface CaptureConfigSource {
  readonly current: Config;
  subscribe(listener: (current: Config, previous: Config) => void): () => void;
}

/** Everything a listener needs to render the app's state - the tray's `TrayState`, plus nothing. */
export interface AppStatus {
  readonly mode: AppMode;
  readonly overlayVisible: boolean;
  readonly error: string | null;
}

export interface AppOrchestratorOptions {
  readonly sidecar: CaptureSidecar;
  readonly config: CaptureConfigSource;
  readonly windows: OverlayWindows;
  readonly logger?: Logger;
  /** How long to wait for a `listMonitors` reply before giving up loudly (invariant 4). */
  readonly listMonitorsTimeoutMs?: number;
}

const DEFAULT_LIST_MONITORS_TIMEOUT_MS = 2_000;

export class AppOrchestrator {
  readonly #sidecar: CaptureSidecar;
  readonly #config: CaptureConfigSource;
  readonly #windows: OverlayWindows;
  readonly #log: Logger;
  readonly #listMonitorsTimeoutMs: number;

  readonly #unsubscribes: Array<() => void> = [];
  readonly #listeners = new Set<(status: AppStatus) => void>();

  /** The desired mode. Assigned synchronously by every transition; the single source of truth. */
  #mode: AppMode = 'idle';
  /** A `configure` has been acknowledged, so `start`/`stop`/`snapshot` are legal to send. */
  #configured = false;
  /** What this object believes the sidecar's capture loop is doing. */
  #capturing = false;
  /** The `state` from the sidecar's most recent `ack` - *its* view, for divergence checks. */
  #sidecarState: string | null = null;
  #overlayVisible = true;
  #lastError: string | null = null;
  /** A snapshot was asked for and has not been sent yet - only possible before `configure`. */
  #pendingSnapshot = false;
  /** Serialises the async configure path so two config changes cannot interleave. */
  #configuring: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(options: AppOrchestratorOptions) {
    this.#sidecar = options.sidecar;
    this.#config = options.config;
    this.#windows = options.windows;
    this.#log = (options.logger ?? nullLogger()).child('mode');
    this.#listMonitorsTimeoutMs = options.listMonitorsTimeoutMs ?? DEFAULT_LIST_MONITORS_TIMEOUT_MS;

    this.#unsubscribes.push(
      this.#sidecar.on('ack', (ack) => {
        this.#sidecarState = ack.state;
      }),
      this.#sidecar.on('error', (error) => {
        this.#fail(`${error.code}: ${error.message}`);
      }),
      this.#sidecar.on('frame', () => {
        // A frame arriving is the only evidence that whatever failed is over. Clearing on
        // anything less would leave the tray red for the rest of the session.
        if (this.#lastError !== null) {
          this.#lastError = null;
          this.#notify();
        }
      }),
      this.#sidecar.on('exit', (exit) => {
        // Nothing can be sent to a process that is gone, and pretending otherwise would
        // leave `#capturing` true so the next `start` was skipped as redundant.
        this.#configured = false;
        this.#capturing = false;
        this.#pendingSnapshot = false;
        this.#mode = 'idle';
        if (!exit.expected) this.#lastError = 'the capture sidecar stopped unexpectedly';
        this.#notify();
      }),
      this.#config.subscribe((current, previous) => {
        this.#onConfigChanged(current, previous);
      }),
    );
  }

  get mode(): AppMode {
    return this.#mode;
  }

  get overlayVisible(): boolean {
    return this.#overlayVisible;
  }

  /** Whether the sidecar has an applied configuration. False until {@link initialize} finishes. */
  get configured(): boolean {
    return this.#configured;
  }

  /** What this object believes the sidecar's loop is doing. */
  get capturing(): boolean {
    return this.#capturing;
  }

  /** The sidecar's own last-reported state, for asserting the two have not diverged. */
  get sidecarState(): string | null {
    return this.#sidecarState;
  }

  get status(): AppStatus {
    return { mode: this.#mode, overlayVisible: this.#overlayVisible, error: this.#lastError };
  }

  /** Subscribe to status changes. Returns an unsubscribe, matching `ConfigService.subscribe`. */
  subscribe(listener: (status: AppStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Discover the monitors, configure the sidecar, and enter `auto`.
   *
   * **This is the only place capture is ever started.** Called once, after the sidecar
   * reports `ready`. Entering `auto` rather than waiting for a keypress is feature G3's
   * "โหมดหลัก": the app exists to translate what is on screen, and a launch that produces
   * nothing until a shortcut is found is a launch the user reads as broken.
   */
  async initialize(): Promise<void> {
    await this.#reconfigure(this.#config.current.capture, 'startup');
    if (!this.#configured) return;

    // Not an unconditional assignment: a user who hit the hotkey during startup has already
    // expressed a preference, and overwriting it here is the race this ordering avoids.
    if (this.#mode === 'idle') this.#mode = 'auto';
    this.#apply();
    this.#notify();
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /** The main switch: `auto` stops, anything else starts. Bound to `Control+Alt+A`. */
  toggleAuto(): void {
    this.#transition(this.#mode === 'auto' ? 'paused' : 'auto', 'toggleAuto');
  }

  /** Enter `auto` regardless of where we were. */
  resume(): void {
    this.#transition('auto', 'resume');
  }

  /**
   * Stop capturing for real (G5).
   *
   * Only meaningful from `auto` - the other three modes are already stopped, and moving
   * `snapshot` to `paused` would throw away the held frame the user asked for.
   */
  pause(): void {
    if (this.#mode !== 'auto') {
      this.#log.debug('pause ignored; nothing is capturing', { mode: this.#mode });
      return;
    }
    this.#transition('paused', 'pause');
  }

  /**
   * Capture one frame now (G4).
   *
   * From `auto` or `paused` the mode does not move - see the module doc. From `idle` this
   * becomes the document-reading mode `snapshot`, and the frame stays on screen until
   * something else moves the machine.
   *
   * A press that arrives before the sidecar is configured is **held**, not dropped:
   * {@link #apply} fires it as soon as `configure` lands. Dropping it would leave the app
   * sitting in `snapshot` mode having captured nothing, which is the state a user reads as
   * "the button does not work". A burst of presses collapses to one, because a flag is not
   * a queue - and replaying four snapshots of the same screen is not what the fourth press
   * meant.
   */
  snapshot(): void {
    const previous = this.#mode;
    this.#mode = previous === 'idle' ? 'snapshot' : previous;
    this.#pendingSnapshot = true;

    this.#log.info('snapshot requested', { mode: this.#mode, from: previous });
    this.#apply();
    if (previous !== this.#mode) this.#notify();
  }

  /**
   * Show or hide the boxes **without** touching the pipeline (#34: "ซ่อน overlay ≠ pause").
   *
   * Nothing in this method reaches the sidecar, which is the entire point: capture, OCR and
   * translation carry on, so unhiding shows what is on screen now rather than what was there
   * when it was hidden.
   */
  toggleOverlay(): void {
    this.setOverlayVisible(!this.#overlayVisible);
  }

  setOverlayVisible(visible: boolean): void {
    if (this.#overlayVisible === visible) return;
    const ok = this.#windows.setOverlayVisible(visible);
    if (!ok) {
      this.#log.warn('could not change overlay visibility', { visible });
      return;
    }
    this.#overlayVisible = visible;
    this.#log.info('overlay visibility changed', { visible, mode: this.#mode });
    this.#notify();
  }

  /**
   * Re-run the region picker.
   *
   * The picker is issue #30 and does not exist. Saying so out loud rather than doing nothing
   * is invariant 4: a menu item that silently does nothing is indistinguishable from one
   * that is broken.
   */
  selectRegion(): void {
    this.#log.warn('Select Region is not implemented yet; it lands with the region picker (#30)');
  }

  openSettings(): void {
    this.#windows.openSettings();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const off of this.#unsubscribes) off();
    this.#unsubscribes.length = 0;
    this.#listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #transition(next: AppMode, reason: string): void {
    if (this.#mode === next) return;
    const previous = this.#mode;
    this.#mode = next;
    this.#log.info('mode changed', { from: previous, to: next, reason });
    this.#apply();
    this.#notify();
  }

  /**
   * Make the sidecar match {@link #mode}. Synchronous, idempotent, and the only place a
   * `start` or a `stop` is sent.
   *
   * Reading `#mode` here rather than taking it as a parameter is what collapses a burst of
   * transitions into the commands the *final* mode needs: whatever order the presses arrived
   * in, this always compares the mode that is current now against the sidecar's actual state.
   */
  #apply(): void {
    if (!this.#configured) {
      // The desired mode - and a pending snapshot - are still recorded; the reconcile that
      // runs once `configure` lands applies whatever the user settled on.
      this.#log.debug('deferring; the sidecar is not configured yet', {
        mode: this.#mode,
        pendingSnapshot: this.#pendingSnapshot,
      });
      return;
    }

    const shouldCapture = this.#mode === 'auto';
    if (shouldCapture !== this.#capturing) {
      if (shouldCapture) {
        // Only believed once the write succeeded. A dropped `start` that still flipped this
        // would make the next one look redundant and be skipped - a permanently stopped app
        // reporting `auto`.
        this.#capturing = this.#sidecar.send({ cmd: 'start' });
        if (!this.#capturing) this.#log.error('could not start capture: the sidecar took no command');
      } else {
        this.#sidecar.send({ cmd: 'stop' });
        // Unconditionally false: a `stop` that could not be sent means there is no sidecar
        // to be capturing.
        this.#capturing = false;
      }
    }

    // Last, so the loop is already stopped when a snapshot taken from `paused` or `snapshot`
    // fires - otherwise the very next tick would overwrite the frame the user asked to hold.
    if (this.#pendingSnapshot) {
      this.#pendingSnapshot = false;
      this.#sidecar.send({ cmd: 'snapshot' });
    }
  }

  /**
   * `listMonitors`, then `configure`. Resolves once the configure is acknowledged, or once
   * it is clear no reply is coming.
   *
   * Chained onto {@link #configuring} so a config change arriving mid-startup cannot
   * interleave two `listMonitors` round trips - the protocol correlates replies by `cmd`
   * alone (`AckEvent`), so two outstanding `listMonitors` would be genuinely ambiguous.
   */
  async #reconfigure(capture: CaptureConfig, reason: string): Promise<void> {
    const run = this.#configuring.then(async () => {
      await this.#configureOnce(capture, reason);
    });
    // Kept as the tail even if it rejected, so one failure does not wedge the chain.
    this.#configuring = run.catch(() => undefined);
    await run;
  }

  async #configureOnce(capture: CaptureConfig, reason: string): Promise<void> {
    const monitors = await this.#listMonitors();
    if (monitors === null) return;

    const monitor = this.#chooseMonitor(monitors, capture);
    if (monitor === undefined) {
      this.#fail('the sidecar reported no monitors, so capture cannot start');
      return;
    }

    // `null` means the whole display. The size comes straight from the sidecar's own reply,
    // so no conversion happens in Node; the region is physical px relative to the monitor's
    // top-left, which for a full display starts at (0,0). Invariant 3 is untouched.
    const region: Rect = capture.region ?? [0, 0, monitor.bounds[2], monitor.bounds[3]];

    const acked = await this.#send(
      {
        cmd: 'configure',
        region,
        monitorId: monitor.id,
        intervalActive: capture.intervalActive,
        intervalIdle: capture.intervalIdle,
        diffThreshold: capture.diffThreshold,
        ocrLanguage: capture.ocrLanguage,
        debugFrameEnabled: capture.debugFrameEnabled,
      },
      'configure',
    );

    if (!acked) {
      this.#fail('the sidecar did not acknowledge configure; capture is unavailable');
      return;
    }

    this.#configured = true;
    this.#log.info('capture configured', {
      reason,
      monitorId: monitor.id,
      scale: monitor.scale,
      region,
      intervalActive: capture.intervalActive,
      intervalIdle: capture.intervalIdle,
      diffThreshold: capture.diffThreshold,
      ocrLanguage: capture.ocrLanguage,
      debugFrameEnabled: capture.debugFrameEnabled,
    });

    // A `configure` while the loop was running leaves it running (`Dispatcher.Configure`),
    // so `#capturing` is still correct. This re-asserts the mode for the other direction:
    // a configure sent while paused must not have quietly resumed anything.
    this.#apply();
  }

  /**
   * Which display to capture.
   *
   * A configured monitor that is no longer attached falls back to the primary, and says so:
   * issue #35 (R2) is explicit that a stale monitor id must never be substituted silently.
   */
  #chooseMonitor(monitors: readonly MonitorInfo[], capture: CaptureConfig): MonitorInfo | undefined {
    // Win32 defines the primary monitor as the one at physical origin (0,0), which is the
    // same monitor Electron reports as primary - and matching on it needs no scale
    // arithmetic, so invariant 3 is untouched.
    const primary = monitors.find((entry) => entry.bounds[0] === 0 && entry.bounds[1] === 0);
    const configured =
      capture.monitorId === null ? undefined : monitors.find((entry) => entry.id === capture.monitorId);

    if (capture.monitorId !== null && configured === undefined) {
      this.#log.warn('the configured monitor is not attached; falling back to the primary display', {
        monitorId: capture.monitorId,
        attached: monitors.map((entry) => entry.id),
      });
    }

    const monitor = configured ?? primary ?? monitors[0];
    if (monitor !== undefined && monitor !== primary) {
      // Frames are paired to `screen.getPrimaryDisplay()` in `index.ts` until M6-01 (#28),
      // so any monitor other than the primary means boxes placed against the wrong origin.
      this.#log.warn('capturing a non-primary monitor; box positions will be wrong until #28 lands', {
        monitorId: monitor.id,
      });
    }
    return monitor;
  }

  async #listMonitors(): Promise<readonly MonitorInfo[] | null> {
    const ack = await this.#send({ cmd: 'listMonitors' }, 'listMonitors');
    if (ack === null) {
      this.#fail('the sidecar never answered listMonitors; capture is unavailable');
      return null;
    }
    // `monitors` is present only on this reply; an empty list is a real answer on a machine
    // with no attached display, and is not the same thing as a malformed one.
    return ack.monitors ?? [];
  }

  /**
   * Send a command and wait for the `ack` naming it.
   *
   * The listener is attached **before** the command is written: the reply is a line on a
   * pipe that is already flowing, so subscribing afterwards is a race that only loses on a
   * machine faster than the one it was written on.
   */
  async #send(command: SidecarCommand, cmd: string): Promise<AckEvent | null> {
    return await new Promise<AckEvent | null>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const off = this.#sidecar.on('ack', (ack) => {
        if (ack.cmd !== cmd) return;
        clearTimeout(timer);
        off();
        resolve(ack);
      });

      timer = setTimeout(() => {
        off();
        this.#log.error('no reply from the sidecar', { cmd, timeoutMs: this.#listMonitorsTimeoutMs });
        resolve(null);
      }, this.#listMonitorsTimeoutMs);
      timer.unref?.();

      if (!this.#sidecar.send(command)) {
        clearTimeout(timer);
        off();
        resolve(null);
      }
    });
  }

  /**
   * Re-push `configure` when the capture settings change (ST3).
   *
   * The bootstrap this replaced deliberately did *not* do this, and said so: re-sending
   * `configure` belongs to whatever owns the sidecar's state, which is now this. Inert until
   * the settings window can write config (#39), but the alternative was letting a documented
   * requirement disappear along with the comment describing it.
   */
  #onConfigChanged(current: Config, previous: Config): void {
    if (JSON.stringify(current.capture) === JSON.stringify(previous.capture)) return;
    if (!this.#configured) return;

    this.#log.info('capture settings changed; reconfiguring the sidecar');
    void this.#reconfigure(current.capture, 'config-change');
  }

  /** Record something the user has to know about, and light the tray up (invariant 4). */
  #fail(message: string): void {
    this.#log.error(message);
    if (this.#lastError === message) return;
    this.#lastError = message;
    this.#notify();
  }

  #notify(): void {
    const status = this.status;
    for (const listener of [...this.#listeners]) {
      try {
        listener(status);
      } catch (error) {
        // One bad subscriber must not stop the others, exactly as in `ConfigService.#commit`.
        this.#log.error('a status listener threw', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
