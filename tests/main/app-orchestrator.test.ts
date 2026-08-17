/**
 * Issue M7-03 / #34, features G3, G4, G5 - the mode machine.
 *
 * ## What the fake sidecar models, and why it has to
 *
 * It is not a `vi.fn()`. It reimplements the three rules of the real sidecar's dispatcher
 * (`sidecar/Textlens.Capture/Protocol/Dispatcher.cs`) that this machine's correctness rests
 * on, so that "Node thinks it is capturing" and "the sidecar is capturing" can be asserted
 * as two separate facts:
 *
 *   1. `start`/`stop`/`snapshot` before any `configure` are refused with `NOT_CONFIGURED`;
 *   2. `start` and `stop` are idempotent and always ack with the state they produced;
 *   3. `configure` while running leaves it running.
 *
 * That is what makes the rapid-switching tests mean something. Asserting only
 * `orchestrator.mode` would pass against an implementation that never sent a single command,
 * so every test that claims capture started or stopped also asserts the fake's own
 * `capturing` flag - the stand-in for the CPU reading the issue asks for, which only a real
 * run can take and which is reported separately.
 *
 * What no test here reaches: whether stopping the sidecar actually costs less CPU, and
 * whether Windows delivers a global hotkey to this machine at all.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  AppOrchestrator,
  NO_REGION_WARNING,
  describeAppWarning,
  type AppMode,
  type CaptureConfigSource,
  type CaptureSidecar,
  type MonitorRegistry,
  type RegionPickerWindows,
} from '../../src/main/services/app-orchestrator.js';
import {
  DEFAULT_BANNER_TIMEOUT_MS,
  ErrorReporter,
  type ScheduleTimer,
} from '../../src/main/services/error-reporter.js';
import type { LogFields, Logger } from '../../src/main/services/logger.js';
import type { SidecarClientEvents } from '../../src/main/services/sidecar-client.js';
import { DEFAULT_CONFIG, type Config, type ConfigOverride } from '../../src/shared/config-schema.js';
import type { AckEvent, MonitorInfo, SidecarCommand } from '../../src/shared/protocol.js';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function collectingLogger(): {
  logger: Logger;
  lines: Array<{ level: string; message: string; fields?: LogFields }>;
} {
  const lines: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    };
  const logger: Logger = {
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    sensitive() {},
    isDebugEnabled: true,
    level: 'debug',
    child: () => logger,
  };
  return { logger, lines };
}

const PRIMARY: MonitorInfo = { id: '\\\\.\\DISPLAY1', bounds: [0, 0, 1920, 1080], scale: 1 };
const SECONDARY: MonitorInfo = { id: '\\\\.\\DISPLAY2', bounds: [1920, 0, 1080, 1920], scale: 1.5 };

/**
 * The harness's default config, and **it has a region** (#51).
 *
 * `DEFAULT_CONFIG` has `region: null`, which since #51 means "this user has never chosen what to
 * translate" - and that is now a distinct state with its own behaviour: `initialize` rests in
 * `idle` and `toggleAuto` opens the picker instead of starting capture. Every test in this file
 * that is about mode transitions, snapshots, pausing or reconfiguration is about a *configured*
 * user, so that is what the default models. The first-run state is exercised deliberately, by the
 * tests that pass `DEFAULT_CONFIG` and by the `first run` describe at the end.
 *
 * The rectangle is the whole of `PRIMARY` on purpose: padded and clamped it comes back as
 * `[0, 0, 1920, 1080]`, which is the same region a null one produces - so making this the default
 * changed no assertion about what reaches the wire.
 */
const CONFIGURED_CONFIG: Config = {
  ...DEFAULT_CONFIG,
  capture: {
    ...DEFAULT_CONFIG.capture,
    region: { rect: [0, 0, 1920, 1080], monitorId: PRIMARY.id, monitorSize: [1920, 1080] },
  },
};

interface FakeSidecar extends CaptureSidecar {
  /** Every command written, in order. */
  readonly sent: SidecarCommand[];
  /** The sidecar's own view of its capture loop - the thing Node must not diverge from. */
  readonly capturing: boolean;
  /** Its command state machine's state, exactly as `Dispatcher` computes it. */
  readonly state: string;
  /** Push an event as the sidecar would. */
  emit<K extends 'ack' | 'error' | 'frame' | 'nochange' | 'exit'>(event: K, payload: SidecarClientEvents[K]): void;
  /**
   * Fire one turn of the capture loop's timer.
   *
   * Emits a `frame` **only while the loop is running**, which is what `CaptureLoop` does: `stop`
   * disposes the timer, so a stopped loop produces nothing at all. This is what makes "the held
   * frame is not overwritten" an assertion about behaviour rather than about a boolean - the
   * default interval is 800ms and a user reading a held translation is looking at the screen for
   * far longer than that.
   */
  tick(): void;
  /** Stop accepting commands, as a dead process does. */
  die(): void;
  readonly kinds: string[];
}

interface FakeSidecarOptions {
  readonly monitors?: readonly MonitorInfo[];
  /** Commands to swallow without acking, to exercise the no-reply path. */
  readonly silentFor?: readonly string[];
  /** Never accept a write, as a client with no running child does. */
  readonly dead?: boolean;
}

function fakeSidecar(options: FakeSidecarOptions = {}): FakeSidecar {
  const sent: SidecarCommand[] = [];
  const listeners = new Map<string, Set<(payload: never) => void>>();
  let configured = false;
  let capturing = false;
  let state = 'idle';
  let alive = options.dead !== true;

  const emit = <K extends 'ack' | 'error' | 'frame' | 'nochange' | 'exit'>(
    event: K,
    payload: SidecarClientEvents[K],
  ): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      (listener as (value: SidecarClientEvents[K]) => void)(payload);
    }
  };

  const ack = (cmd: string, extra: Partial<AckEvent> = {}): void => {
    if (options.silentFor?.includes(cmd) === true) return;
    emit('ack', { ev: 'ack', cmd, state, ...extra });
  };

  return {
    sent,
    get capturing() {
      return capturing;
    },
    get state() {
      return state;
    },
    get kinds() {
      return sent.map((command) => command.cmd);
    },
    emit,
    tick() {
      if (!alive || !capturing) return;
      emit('frame', frameEvent());
    },
    die() {
      alive = false;
    },
    send(command) {
      if (!alive) return false;
      sent.push(command);

      switch (command.cmd) {
        case 'listMonitors':
          ack('listMonitors', { monitors: options.monitors ?? [PRIMARY] });
          return true;

        case 'configure':
          configured = true;
          // Dispatcher.Configure: a configure while running leaves it running.
          state = capturing ? 'running' : 'configured';
          ack('configure');
          return true;

        case 'start':
          if (!configured) {
            emit('error', { ev: 'error', code: 'NOT_CONFIGURED', message: '"start" needs a region' });
            return true;
          }
          // CaptureLoop.Start is idempotent; the ack still reports the resulting state.
          capturing = true;
          state = 'running';
          ack('start');
          return true;

        case 'stop':
          // Dispatcher.Stop: not an error when nothing is running.
          capturing = false;
          state = configured ? 'stopped' : 'idle';
          ack('stop');
          return true;

        case 'snapshot':
          if (!configured) {
            emit('error', { ev: 'error', code: 'NOT_CONFIGURED', message: '"snapshot" needs a region' });
            return true;
          }
          // Replies with a frame, never an ack, and never changes state.
          emit('frame', frameEvent());
          return true;

        default:
          return true;
      }
    },
    on(event, listener) {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      const erased = listener as (payload: never) => void;
      set.add(erased);
      return () => {
        set.delete(erased);
      };
    },
  };
}

let seq = 0;
function frameEvent(): SidecarClientEvents['frame'] {
  seq += 1;
  return {
    ev: 'frame',
    seq,
    timings: { captureUs: 1, diffUs: 1, ocrUs: 1 },
    monitor: PRIMARY,
    region: [0, 0, 1920, 1080],
    lines: [],
  };
}

/**
 * A `ScheduleTimer` a test can fire by hand, the same shape `error-reporter.test.ts` uses for
 * `#59`'s banner timeout - a test that waits out a real hold is a test nobody runs (#61).
 */
function fakeTimers(): {
  readonly schedule: ScheduleTimer;
  /** Timers still waiting to fire. */
  readonly live: readonly { readonly delayMs: number }[];
  /** Let every waiting timer's delay elapse, in the order they were scheduled. */
  elapse(): void;
} {
  const scheduled: { handler: () => void; delayMs: number; cancelled: boolean }[] = [];
  const schedule: ScheduleTimer = (handler, delayMs) => {
    const entry = { handler, delayMs, cancelled: false };
    scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  return {
    schedule,
    get live() {
      return scheduled.filter((entry) => !entry.cancelled);
    },
    elapse() {
      for (const entry of [...scheduled]) {
        if (entry.cancelled) continue;
        entry.cancelled = true;
        entry.handler();
      }
    },
  };
}

interface FakeWindows {
  setOverlayVisible(visible: boolean): boolean;
  openSettings(): unknown;
  bumpOverlayEpoch(reason: string): void;
  clearOverlay(reason: string): void;
  readonly calls: boolean[];
  /** Every epoch bump, with the reason. #35's "region changed → cache cleared" is asserted here. */
  readonly epochBumps: string[];
  /** Every `clearOverlay` call, with the reason (#61). */
  readonly clears: string[];
  visible: boolean;
  refuse: boolean;
  settingsOpened: number;
}

function fakeWindows(): FakeWindows {
  const windows: FakeWindows = {
    calls: [],
    epochBumps: [],
    clears: [],
    visible: true,
    refuse: false,
    settingsOpened: 0,
    setOverlayVisible(visible) {
      windows.calls.push(visible);
      if (windows.refuse) return false;
      windows.visible = visible;
      return true;
    },
    openSettings() {
      windows.settingsOpened += 1;
      return null;
    },
    bumpOverlayEpoch(reason) {
      windows.epochBumps.push(reason);
    },
    clearOverlay(reason) {
      windows.clears.push(reason);
    },
  };
  return windows;
}

interface FakeConfig extends CaptureConfigSource {
  /** Apply an override and notify, as `ConfigService.set` does. */
  change(patch: ConfigOverride): void;
}

function fakeConfig(initial: Config = DEFAULT_CONFIG): FakeConfig {
  const listeners = new Set<(current: Config, previous: Config) => void>();
  let current = initial;
  return {
    get current() {
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    change(patch) {
      const previous = current;
      current = {
        ...current,
        capture: { ...current.capture, ...patch.capture },
        hotkeys: { ...current.hotkeys, ...patch.hotkeys },
      };
      for (const listener of [...listeners]) listener(current, previous);
    },
    // The region picker's write path (#29). Behaves like the real `ConfigService.set`: apply,
    // then notify - which is what makes `#onConfigChanged` re-push `configure` in these tests
    // exactly as it does in the app.
    async set(change: ConfigOverride) {
      this.change(change);
      return { applied: true, persisted: true, errors: [] as const };
    },
  };
}

interface Harness {
  readonly orchestrator: AppOrchestrator;
  readonly sidecar: FakeSidecar;
  readonly windows: FakeWindows;
  readonly config: FakeConfig;
  readonly lines: Array<{ level: string; message: string; fields?: LogFields }>;
}

function harness(
  options: FakeSidecarOptions & {
    config?: Config;
    registry?: MonitorRegistry;
    picker?: RegionPickerWindows;
    /** Injectable timer behind `modes.snapshotHoldMs` (#61). Real `setTimeout` when omitted. */
    schedule?: ScheduleTimer;
    onDismissed?: () => void;
  } = {},
): Harness {
  const sidecar = fakeSidecar(options);
  const windows = fakeWindows();
  const config = fakeConfig(options.config ?? CONFIGURED_CONFIG);
  const { logger, lines } = collectingLogger();
  const orchestrator = new AppOrchestrator({
    sidecar,
    config,
    windows,
    logger,
    listMonitorsTimeoutMs: 20,
    ...(options.registry === undefined ? {} : { monitors: options.registry }),
    ...(options.picker === undefined ? {} : { picker: options.picker }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    ...(options.onDismissed === undefined ? {} : { onDismissed: options.onDismissed }),
  });
  return { orchestrator, sidecar, windows, config, lines };
}

/**
 * Assert Node and the sidecar agree about whether frames are being produced.
 *
 * `running` is compared rather than the exact state string because the sidecar has three
 * different ways of not capturing and they are not interchangeable: `idle` (never
 * configured), `configured` (configured, never started) and `stopped` (was running, halted).
 * A configure that lands while paused leaves it `configured`, not `stopped`, and pinning the
 * string here would have failed on correct behaviour. What matters to this machine is the
 * boolean.
 */
function expectConverged(h: Harness, mode: AppMode): void {
  expect(h.orchestrator.mode).toBe(mode);
  const shouldCapture = mode === 'auto';
  expect(h.orchestrator.capturing).toBe(shouldCapture);
  expect(h.sidecar.capturing).toBe(shouldCapture);
  expect(h.sidecar.state === 'running').toBe(shouldCapture);
}

// ---------------------------------------------------------------------------

describe('AppOrchestrator.initialize', () => {
  it('starts idle and sends nothing before it is initialized', () => {
    const h = harness();
    expect(h.orchestrator.mode).toBe('idle');
    expect(h.orchestrator.configured).toBe(false);
    expect(h.sidecar.sent).toHaveLength(0);
  });

  it('discovers monitors, configures, then enters auto - in that order', async () => {
    const h = harness();
    await h.orchestrator.initialize();

    expect(h.sidecar.kinds).toEqual(['listMonitors', 'configure', 'start']);
    expect(h.orchestrator.mode).toBe('auto');
    expect(h.sidecar.capturing).toBe(true);
  });

  it('configures the whole primary display when config names no region', async () => {
    const h = harness({ config: DEFAULT_CONFIG });
    await h.orchestrator.initialize();

    expect(h.sidecar.sent[1]).toMatchObject({
      cmd: 'configure',
      monitorId: PRIMARY.id,
      region: [0, 0, 1920, 1080],
      intervalActive: DEFAULT_CONFIG.capture.intervalActive,
      debugFrameEnabled: false,
    });
  });

  it('falls back to the primary display when the configured monitor is gone, and says so', async () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      capture: { ...DEFAULT_CONFIG.capture, monitorId: '\\\\.\\DISPLAY9' },
    };
    const h = harness({ config });
    await h.orchestrator.initialize();

    expect(h.sidecar.sent[1]).toMatchObject({ monitorId: PRIMARY.id });
    expect(h.lines.some((line) => line.level === 'warn' && line.message.includes('not attached'))).toBe(true);
  });

  it('configures a non-primary monitor without complaint now that #28 pairs displays', () => {
    // This used to assert a warning. That warning existed because `index.ts` paired every frame
    // to `screen.getPrimaryDisplay()` regardless of origin, so capturing a secondary display
    // put every box on the wrong screen. M6-01 replaced that with a real pairing, and warning
    // about an ordinary configuration would be noise that trains the user to ignore the log.
    return (async () => {
      const h = harness({ monitors: [SECONDARY] });
      await h.orchestrator.initialize();

      expect(h.sidecar.sent[1]).toMatchObject({ monitorId: SECONDARY.id });
      expect(h.lines.some((line) => line.level === 'warn' && line.message.includes('non-primary'))).toBe(false);
    })();
  });

  it('publishes the monitor list to the registry so frames can be paired to displays', async () => {
    const published: MonitorInfo[][] = [];
    const h = harness({
      monitors: [PRIMARY, SECONDARY],
      registry: {
        monitors: [],
        setMonitors: (list) => {
          published.push([...list]);
        },
        displayFor: () => undefined,
      },
    });
    await h.orchestrator.initialize();

    expect(published).toHaveLength(1);
    expect(published[0]?.map((entry) => entry.id)).toEqual([PRIMARY.id, SECONDARY.id]);
  });

  it('reports a sidecar that never answers listMonitors, and stays idle', async () => {
    const h = harness({ silentFor: ['listMonitors'] });
    await h.orchestrator.initialize();

    expect(h.orchestrator.configured).toBe(false);
    expect(h.orchestrator.mode).toBe('idle');
    expect(h.orchestrator.status.error).toContain('never answered listMonitors');
    expect(h.sidecar.kinds).toEqual(['listMonitors']);
  });

  it('reports a configure that is never acknowledged', async () => {
    const h = harness({ silentFor: ['configure'] });
    await h.orchestrator.initialize();

    expect(h.orchestrator.configured).toBe(false);
    expect(h.orchestrator.status.error).toContain('did not acknowledge configure');
    // Nothing was started against a sidecar that may not have applied the configuration.
    expect(h.sidecar.kinds).not.toContain('start');
  });

  it('reports a sidecar that takes no commands at all', async () => {
    const h = harness({ dead: true });
    await h.orchestrator.initialize();

    expect(h.orchestrator.configured).toBe(false);
    expect(h.orchestrator.mode).toBe('idle');
    expect(h.sidecar.sent).toHaveLength(0);
  });
});

describe('AppOrchestrator: pause really stops capture', () => {
  it('auto -> paused sends stop and the sidecar stops capturing', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    expectConverged(h, 'auto');

    h.orchestrator.pause();

    expect(h.sidecar.kinds).toEqual(['listMonitors', 'configure', 'start', 'stop']);
    expectConverged(h, 'paused');
  });

  it('paused -> auto resumes it', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.orchestrator.pause();
    h.orchestrator.resume();

    expect(h.sidecar.kinds).toEqual(['listMonitors', 'configure', 'start', 'stop', 'start']);
    expectConverged(h, 'auto');
  });

  it('toggleAuto flips between the two', async () => {
    const h = harness();
    await h.orchestrator.initialize();

    h.orchestrator.toggleAuto();
    expectConverged(h, 'paused');
    h.orchestrator.toggleAuto();
    expectConverged(h, 'auto');
  });

  it('ignores pause when nothing is capturing', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.orchestrator.pause();
    const before = h.sidecar.sent.length;

    h.orchestrator.pause();
    h.orchestrator.pause();

    expect(h.sidecar.sent).toHaveLength(before);
    expect(h.orchestrator.mode).toBe('paused');
  });

  it('does not believe it is capturing when the start could not be sent', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.orchestrator.pause();
    h.sidecar.die();

    h.orchestrator.resume();

    // The mode is what the user asked for; `capturing` is what is true. Conflating them
    // would make the next `start` look redundant and get skipped forever.
    expect(h.orchestrator.mode).toBe('auto');
    expect(h.orchestrator.capturing).toBe(false);
    expect(h.lines.some((line) => line.level === 'error' && line.message.includes('could not start capture'))).toBe(
      true,
    );
  });
});

describe('AppOrchestrator: hiding the overlay is not pausing', () => {
  it('hides the window and leaves the sidecar capturing', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    const before = h.sidecar.sent.length;

    h.orchestrator.toggleOverlay();

    expect(h.windows.visible).toBe(false);
    expect(h.orchestrator.overlayVisible).toBe(false);
    // The whole criterion, in one line: not a single command reached the sidecar.
    expect(h.sidecar.sent).toHaveLength(before);
    expectConverged(h, 'auto');
  });

  it('toggles back', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.orchestrator.toggleOverlay();
    h.orchestrator.toggleOverlay();

    expect(h.windows.visible).toBe(true);
    expect(h.orchestrator.overlayVisible).toBe(true);
    expectConverged(h, 'auto');
  });

  it('does not record the overlay as hidden when the window refused', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.windows.refuse = true;

    h.orchestrator.toggleOverlay();

    expect(h.orchestrator.overlayVisible).toBe(true);
    expect(h.lines.some((line) => line.level === 'warn' && line.message.includes('overlay visibility'))).toBe(true);
  });

  it('survives pause and resume unchanged', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.orchestrator.toggleOverlay();
    h.orchestrator.pause();
    h.orchestrator.resume();

    expect(h.orchestrator.overlayVisible).toBe(false);
  });
});

describe('AppOrchestrator: snapshot', () => {
  /**
   * **#60, and the reversal of #34.**
   *
   * The two assertions this replaced said the mode stays `auto` and the loop keeps running, which
   * is what #34 asked for and what the module doc argued for at length. What nobody had written
   * down was the price: the loop is still running, so the tick 800ms later replaces the frame the
   * user pressed the key to hold. "Translate once" therefore held nothing at all from the mode
   * users are in essentially all the time - and feature spec G4 has said "จับครั้งเดียว ค้างไว้จน
   * dismiss" since before either issue.
   *
   * `stop` before `snapshot` is the mechanism, and the order is asserted rather than inferred.
   */
  it('during auto: stops the loop, so no later tick can overwrite the held frame', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    const frames: number[] = [];
    h.sidecar.on('frame', (frame) => {
      frames.push(frame.seq);
    });

    h.orchestrator.snapshot();
    const held = frames.at(-1);
    h.sidecar.tick();
    h.sidecar.tick();

    expect(held).toBeDefined();
    expect(frames.at(-1)).toBe(held);
    expect(h.sidecar.kinds).toEqual(['listMonitors', 'configure', 'start', 'stop', 'snapshot']);
    expectConverged(h, 'snapshot');
  });

  it('during pause: captures once and holds it too, still stopped', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.orchestrator.pause();

    h.orchestrator.snapshot();

    expect(h.sidecar.kinds.at(-1)).toBe('snapshot');
    // The one that matters either way: a snapshot must not restart the loop it was taken from.
    expectConverged(h, 'snapshot');
  });

  it('from idle: enters the resting snapshot mode with nothing running', async () => {
    // `idle` with a configured sidecar is only reachable through startup, because
    // `initialize` leaves `idle` for `auto`. So this is the real route into G4's
    // document-reading mode: ask for a snapshot before capture ever started.
    const h = harness();
    h.orchestrator.snapshot();
    await h.orchestrator.initialize();

    expect(h.orchestrator.mode).toBe('snapshot');
    expect(h.sidecar.capturing).toBe(false);
    expect(h.sidecar.kinds).toEqual(['listMonitors', 'configure', 'snapshot']);
  });

  it('holds a snapshot asked for before the sidecar was configured, and fires it after', () => {
    const h = harness();

    h.orchestrator.snapshot();

    // Nothing can be sent yet - but the request is not thrown away either; the test above
    // proves it lands. Dropping it would leave the app in `snapshot` mode showing nothing.
    expect(h.orchestrator.mode).toBe('snapshot');
    expect(h.sidecar.sent).toHaveLength(0);
  });

  it('collapses a burst of snapshot presses during startup into one capture', async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) h.orchestrator.snapshot();
    await h.orchestrator.initialize();

    expect(h.sidecar.kinds.filter((kind) => kind === 'snapshot')).toHaveLength(1);
  });

  it('does not fire a held snapshot at a sidecar that died first', async () => {
    const h = harness();
    h.orchestrator.snapshot();
    h.sidecar.emit('exit', { code: 1, signal: null, expected: false });
    await h.orchestrator.initialize();

    expect(h.sidecar.kinds).not.toContain('snapshot');
  });

  it('leaving snapshot for auto starts the loop', async () => {
    const h = harness();
    h.orchestrator.snapshot();
    await h.orchestrator.initialize();

    h.orchestrator.toggleAuto();

    expectConverged(h, 'auto');
  });
});

/**
 * #61: `dismiss` closes the gap G4 named - "จับครั้งเดียว ค้างไว้จน dismiss" - and
 * `modes.snapshotHoldMs` is the same ending on a timer. Every hold-expiry test uses a fake
 * `schedule`; a test that waited out a real hold would be a test nobody runs.
 */
describe('AppOrchestrator: dismiss', () => {
  it('clears the overlay without changing mode, and sends nothing to the sidecar', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.orchestrator.snapshot();
    const before = h.sidecar.sent.length;
    h.windows.clears.length = 0;

    h.orchestrator.dismiss();

    expect(h.windows.clears).toEqual(['dismiss']);
    expect(h.orchestrator.mode).toBe('snapshot');
    // Never paused (that would misreport which mode was chosen, #60) and never idle (that means
    // no sidecar is configured, which dismissing does not change).
    expect(h.sidecar.sent).toHaveLength(before);
  });

  it('is harmless with nothing displayed - still sends nothing to the sidecar', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    expectConverged(h, 'auto');
    const before = h.sidecar.sent.length;

    h.orchestrator.dismiss();
    h.orchestrator.dismiss();

    expect(h.sidecar.sent).toHaveLength(before);
    expect(h.orchestrator.mode).toBe('auto');
  });

  it('tells onDismissed, so the pipeline forgets what was on screen', async () => {
    let dismissed = 0;
    const h = harness({ onDismissed: () => { dismissed += 1; } });
    await h.orchestrator.initialize();
    h.orchestrator.snapshot();

    h.orchestrator.dismiss();

    expect(dismissed).toBe(1);
  });
});

describe('AppOrchestrator: the snapshot hold (#61, modes.snapshotHoldMs)', () => {
  function withHold(ms: number): Config {
    return { ...CONFIGURED_CONFIG, modes: { snapshotHoldMs: ms } };
  }

  it('does not arm a timer at the default of 0 - held until dismissed', async () => {
    const timers = fakeTimers();
    const h = harness({ schedule: timers.schedule });
    await h.orchestrator.initialize();

    h.orchestrator.snapshot();

    expect(timers.live).toHaveLength(0);
  });

  it('clears itself after snapshotHoldMs, through the same path dismiss uses', async () => {
    const timers = fakeTimers();
    const h = harness({ config: withHold(5_000), schedule: timers.schedule });
    await h.orchestrator.initialize();

    h.orchestrator.snapshot();
    expect(timers.live.map((entry) => entry.delayMs)).toEqual([5_000]);
    h.windows.clears.length = 0;

    timers.elapse();

    // The exact same call `dismiss()` makes - not a parallel implementation that happens to look
    // similar.
    expect(h.windows.clears).toEqual(['dismiss']);
    expect(h.orchestrator.mode).toBe('snapshot');
  });

  it('does not arm a hold for a deferred snapshot that fires after the mode already left snapshot', async () => {
    // #pendingSnapshot can survive a mode change while the sidecar is not configured yet: the
    // user presses Translate once, then Auto, before `configure` lands. When the deferred
    // `snapshot` command finally goes out (inside `initialize`), the mode is `auto` - and a timer
    // armed against that would later blank live content it was never meant to touch.
    const timers = fakeTimers();
    const h = harness({ config: withHold(5_000), schedule: timers.schedule });
    h.orchestrator.snapshot();
    h.orchestrator.toggleAuto();

    await h.orchestrator.initialize();

    expect(h.orchestrator.mode).toBe('auto');
    expect(timers.live).toHaveLength(0);
  });

  /**
   * (f), case by case: "this is the part most likely to be silently wrong", so each of the four
   * gets its own test rather than one combined one.
   */
  describe('the timer never outlives what it was timing', () => {
    it('case 1: pressing Translate once again restarts the countdown for the new frame', async () => {
      const timers = fakeTimers();
      const h = harness({ config: withHold(5_000), schedule: timers.schedule });
      await h.orchestrator.initialize();
      h.orchestrator.snapshot();
      expect(timers.live).toHaveLength(1);

      h.orchestrator.snapshot();

      // The first timer is gone, not still ticking alongside a second one - a naive
      // implementation that forgot to cancel would leave two live here.
      expect(timers.live.map((entry) => entry.delayMs)).toEqual([5_000]);
      h.windows.clears.length = 0;
      timers.elapse();
      // And exactly one dismiss comes out the other end, not two.
      expect(h.windows.clears).toEqual(['dismiss']);
    });

    it('case 2: switching to Auto cancels it', async () => {
      const timers = fakeTimers();
      const h = harness({ config: withHold(5_000), schedule: timers.schedule });
      await h.orchestrator.initialize();
      h.orchestrator.snapshot();
      expect(timers.live).toHaveLength(1);

      h.orchestrator.toggleAuto();

      expect(timers.live).toHaveLength(0);
      h.windows.clears.length = 0;
      timers.elapse();
      // Nothing left to fire - a stale timer must not blank the Auto content that followed.
      expect(h.windows.clears).toEqual([]);
    });

    it('case 3: dismissing by hand cancels it', async () => {
      const timers = fakeTimers();
      const h = harness({ config: withHold(5_000), schedule: timers.schedule });
      await h.orchestrator.initialize();
      h.orchestrator.snapshot();
      expect(timers.live).toHaveLength(1);

      h.orchestrator.dismiss();

      expect(timers.live).toHaveLength(0);
      h.windows.clears.length = 0;
      timers.elapse();
      // The manual dismiss already cleared the screen; the timer that would have repeated the
      // same clear later must not still be live to do it again.
      expect(h.windows.clears).toEqual([]);
    });

    it('case 4: disposing the orchestrator cancels it', async () => {
      const timers = fakeTimers();
      const h = harness({ config: withHold(5_000), schedule: timers.schedule });
      await h.orchestrator.initialize();
      h.orchestrator.snapshot();
      expect(timers.live).toHaveLength(1);

      h.orchestrator.dispose();

      expect(timers.live).toHaveLength(0);
    });
  });
});

describe('AppOrchestrator: rapid switching', () => {
  it('a burst of toggles leaves Node and the sidecar agreeing', async () => {
    const h = harness();
    await h.orchestrator.initialize();

    for (let i = 0; i < 25; i++) h.orchestrator.toggleAuto();

    // 25 toggles from `auto` is an odd count, so the machine must end paused.
    expectConverged(h, 'paused');
  });

  it('an even burst returns to auto and the sidecar is still running', async () => {
    const h = harness();
    await h.orchestrator.initialize();

    for (let i = 0; i < 40; i++) h.orchestrator.toggleAuto();

    expectConverged(h, 'auto');
  });

  it('never sends a redundant start or stop', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.sidecar.sent.length = 0;

    h.orchestrator.resume();
    h.orchestrator.resume();
    h.orchestrator.resume();
    expect(h.sidecar.kinds).toEqual([]);

    h.orchestrator.pause();
    h.orchestrator.pause();
    expect(h.sidecar.kinds).toEqual(['stop']);
  });

  /**
   * The convergence property, restated for #60's model: a snapshot is now a transition like any
   * other, so the machine ends wherever the **last** press asked for and the sidecar agrees.
   *
   * It used to end `paused` here, because a snapshot from `auto` or `paused` left the mode where
   * it found it. Now the final press is a Translate once, so that is where it rests - which is the
   * same property (final intent wins, one command per real change) asserted against the new rule.
   */
  it('interleaved snapshots and toggles converge on the last press', async () => {
    const h = harness();
    await h.orchestrator.initialize();

    h.orchestrator.toggleAuto();
    h.orchestrator.snapshot();
    h.orchestrator.toggleAuto();
    h.orchestrator.snapshot();
    h.orchestrator.toggleAuto();
    h.orchestrator.toggleOverlay();
    h.orchestrator.snapshot();

    expectConverged(h, 'snapshot');
    expect(h.orchestrator.overlayVisible).toBe(false);
  });

  /** The other half of the same property: the last press being a toggle resumes the loop. */
  it('a Translate once followed by Auto is capturing again', async () => {
    const h = harness();
    await h.orchestrator.initialize();

    h.orchestrator.snapshot();
    expectConverged(h, 'snapshot');
    h.orchestrator.toggleAuto();

    expectConverged(h, 'auto');
    const frames: number[] = [];
    h.sidecar.on('frame', (frame) => {
      frames.push(frame.seq);
    });
    h.sidecar.tick();
    expect(frames).toHaveLength(1);
  });

  it('hotkeys hammered during startup are applied once, after configure', async () => {
    const h = harness();
    // The user leans on Control+Alt+A while the app is still finding its monitors.
    const starting = h.orchestrator.initialize();
    for (let i = 0; i < 9; i++) h.orchestrator.toggleAuto();
    await starting;

    // Nine toggles from `idle`: odd, so the last one asked for `paused`... and the machine
    // must have obeyed the *final* press rather than replaying all nine at the sidecar.
    expect(h.orchestrator.mode).toBe('auto');
    expectConverged(h, 'auto');
    expect(h.sidecar.kinds).toEqual(['listMonitors', 'configure', 'start']);
  });

  it('a pause during startup is honoured instead of the auto default', async () => {
    const h = harness();
    const starting = h.orchestrator.initialize();
    h.orchestrator.toggleAuto();
    h.orchestrator.toggleAuto();
    await starting;

    // Ends on `paused`, and initialize must not overwrite it: nothing ever started.
    expectConverged(h, 'paused');
    expect(h.sidecar.kinds).toEqual(['listMonitors', 'configure']);
  });
});

describe('AppOrchestrator: configuration changes', () => {
  it('re-pushes configure when the capture settings change', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.sidecar.sent.length = 0;

    h.config.change({ capture: { intervalActive: 250 } });
    await vi.waitFor(() => {
      expect(h.sidecar.kinds).toContain('configure');
    });

    expect(h.sidecar.sent.find((command) => command.cmd === 'configure')).toMatchObject({ intervalActive: 250 });
    // A configure while running leaves it running - no start/stop churn.
    expect(h.sidecar.kinds).toEqual(['listMonitors', 'configure']);
    expectConverged(h, 'auto');
  });

  it('tells the renderer to forget its positions when the region changes', async () => {
    // #35's "เปลี่ยน region → cache ถูกล้าง". A sticky anchor survives a jittering bbox by
    // design, so nothing else would ever dislodge one: a box held at a position from the old
    // region would sit under whatever now happens to be there, indefinitely.
    const h = harness();
    await h.orchestrator.initialize();
    h.windows.epochBumps.length = 0;

    h.config.change({
      capture: {
        region: { rect: [10, 20, 300, 100], monitorId: '\\\\.\\DISPLAY1', monitorSize: [1920, 1080] },
      },
    });
    await vi.waitFor(() => {
      expect(h.sidecar.kinds).toContain('configure');
    });

    expect(h.windows.epochBumps).toHaveLength(1);
  });

  it('does not forget them for a setting that cannot have moved anything', async () => {
    // The other half, and the one worth pinning: discarding the anchors on every capture change
    // would reintroduce the jitter they exist to absorb, on a settings edit that has nothing to
    // do with position.
    const h = harness();
    await h.orchestrator.initialize();
    h.windows.epochBumps.length = 0;

    h.config.change({ capture: { intervalActive: 250 } });
    await vi.waitFor(() => {
      expect(h.sidecar.kinds).toContain('configure');
    });

    expect(h.windows.epochBumps).toHaveLength(0);
  });

  it('ignores a change that does not touch capture', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.sidecar.sent.length = 0;

    h.config.change({ hotkeys: { snapshot: 'Control+Alt+P' } });
    await Promise.resolve();

    expect(h.sidecar.sent).toHaveLength(0);
  });

  it('does not reconfigure before the first configure landed', async () => {
    const h = harness({ silentFor: ['listMonitors'] });
    await h.orchestrator.initialize();
    h.sidecar.sent.length = 0;

    h.config.change({ capture: { intervalActive: 250 } });
    await Promise.resolve();

    expect(h.sidecar.sent).toHaveLength(0);
  });

  it('a reconfigure while paused does not resume capture', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.orchestrator.pause();

    h.config.change({ capture: { intervalActive: 250 } });
    await vi.waitFor(() => {
      expect(h.sidecar.kinds.filter((kind) => kind === 'configure')).toHaveLength(2);
    });

    expectConverged(h, 'paused');
  });
});

describe('AppOrchestrator: failure reporting', () => {
  it('surfaces a sidecar error to subscribers', async () => {
    const h = harness();
    await h.orchestrator.initialize();

    h.sidecar.emit('error', { ev: 'error', code: 'OCR_FAILED', message: 'recognizer blew up' });

    expect(h.orchestrator.status.error).toBe('OCR_FAILED: recognizer blew up');
  });

  it('clears the error once a frame arrives again', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.sidecar.emit('error', { ev: 'error', code: 'OCR_FAILED', message: 'boom' });

    h.sidecar.emit('frame', frameEvent());

    expect(h.orchestrator.status.error).toBeNull();
  });

  it('stops believing anything is configured or capturing when the sidecar dies', async () => {
    const h = harness();
    await h.orchestrator.initialize();

    h.sidecar.emit('exit', { code: 1, signal: null, expected: false });

    expect(h.orchestrator.configured).toBe(false);
    expect(h.orchestrator.capturing).toBe(false);
    expect(h.orchestrator.status.error).toContain('stopped unexpectedly');
  });

  /**
   * This replaces "falls back to idle when the sidecar dies", and the change is deliberate (#40).
   *
   * Dropping to `idle` was right while nothing restarted the sidecar. It is wrong now that
   * `SidecarSupervisor` does, for two separate reasons: the supervisor refuses to restart a
   * sidecar that died while the user had paused, and `#mode` is the only record that they had;
   * and a restart re-runs `initialize`, which resumes whatever mode this holds - so a reset would
   * have every crash silently promote `paused` to `auto`.
   */
  it('keeps the mode across a death, so a restart resumes it instead of promoting paused to auto', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.orchestrator.pause();
    expect(h.orchestrator.mode).toBe('paused');

    h.sidecar.emit('exit', { code: 1, signal: null, expected: false });

    expect(h.orchestrator.mode).toBe('paused');
  });

  it('sends no command at a sidecar that is gone, whatever the mode still says', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.sidecar.emit('exit', { code: 1, signal: null, expected: false });
    const before = h.sidecar.kinds.length;

    // `#configured` is what gates sending, not the mode - so a preserved `auto` must not make
    // this reach a dead process.
    h.orchestrator.pause();
    h.orchestrator.resume();
    h.orchestrator.snapshot();

    expect(h.sidecar.kinds).toHaveLength(before);
  });

  it('does not report an expected exit as an error', async () => {
    const h = harness();
    await h.orchestrator.initialize();

    h.sidecar.emit('exit', { code: 0, signal: null, expected: true });

    expect(h.orchestrator.status.error).toBeNull();
  });

  it('reports that region selection is impossible rather than opening a picker on a guessed screen', async () => {
    // No registry, so no monitor can be turned into a display. Opening the picker on the
    // primary anyway would have the user draw a region against the wrong content and then
    // succeed completely, which is the failure invariant 4 is about.
    const h = harness({ picker: { pickRegion: async () => null } });
    await h.orchestrator.initialize();

    await h.orchestrator.selectRegion();

    expect(h.orchestrator.status.error).not.toBeNull();
  });
});

/**
 * #50, the half that survives whatever the threshold ends up being.
 *
 * The bug: with a large region, a subtitle-sized change falls under `diffThreshold` entirely, so
 * every tick is `nochange` and nothing ever reaches the screen - while the tray says `auto`, the
 * sidecar genuinely captures, and nothing anywhere reports a problem. The user concludes OCR or
 * translation is broken, when neither was ever called.
 *
 * Driven by `nochange` rather than a timer on purpose: a `nochange` is evidence the loop is
 * alive and looking, where a timer fires identically for a sidecar that has died - a different
 * problem, already reported on the `exit` arm.
 */
/**
 * #54: a setting that does nothing must not do nothing quietly (invariant 4).
 *
 * `effectiveDiffThreshold` takes the smaller of the configured fraction and the pixel ceiling, so
 * on any region past ~800k px the fraction is discarded entirely. That is correct - #50 comes
 * straight back without it - but it means `diffThreshold` is a knob a user can turn all day for no
 * result. `configure` is the one moment where the region's size is known, so it is where this has
 * to be said.
 */
describe('AppOrchestrator: reporting an inert diffThreshold (#54)', () => {
  function harness(region: readonly [number, number, number, number]) {
    const sidecar = fakeSidecar({});
    const { logger, lines } = collectingLogger();
    const config = fakeConfig({
      ...DEFAULT_CONFIG,
      capture: {
        ...DEFAULT_CONFIG.capture,
        region: { rect: [...region], monitorId: PRIMARY.id, monitorSize: [1920, 1080] },
        regionPadding: 0,
      },
    });
    const orchestrator = new AppOrchestrator({
      sidecar,
      config,
      windows: fakeWindows(),
      logger,
      listMonitorsTimeoutMs: 20,
    });
    return { orchestrator, sidecar, lines };
  }

  const inertLine = (lines: Array<{ level: string; message: string; fields?: LogFields }>) =>
    lines.find((line) => line.message.includes('has no effect on a region this large'));

  it('says so when the region is large enough for the ceiling to take over', async () => {
    // 1920x1080 = 2,073,600 px. 4000/area = 0.00193, below the configured 0.005.
    const h = harness([0, 0, 1920, 1080]);
    await h.orchestrator.initialize();

    const line = inertLine(h.lines);
    expect(line?.level).toBe('warn');
    // Both numbers, in both units. A warning that says "your setting is being overridden" without
    // saying by how much leaves the user with no way to choose a value that would work.
    expect(line?.fields).toMatchObject({
      configuredDiffThreshold: 0.005,
      diffMaxRequiredPx: 4_000,
      requiredPx: 4_000,
      requiredPxIfFractionGoverned: 10_368,
    });
    h.orchestrator.dispose();
  });

  it('stays silent when the configured fraction is the one in force', async () => {
    // 1200x220 = 264,000 px. 4000/area = 0.0152, above 0.005, so nothing is being overridden.
    // This is the half that makes the test above discriminating rather than a message that is
    // always emitted.
    const h = harness([400, 800, 1200, 220]);
    await h.orchestrator.initialize();

    expect(inertLine(h.lines)).toBeUndefined();
    h.orchestrator.dispose();
  });

  it('records which rule won on the configure line itself, either way', async () => {
    const big = harness([0, 0, 1920, 1080]);
    await big.orchestrator.initialize();
    const small = harness([400, 800, 1200, 220]);
    await small.orchestrator.initialize();

    const governedBy = (lines: Array<{ message: string; fields?: LogFields }>) =>
      lines.find((line) => line.message === 'capture configured')?.fields?.['diffGovernedBy'];

    // The pair of numbers was already logged; #54 is that the pair alone does not say which one
    // the sidecar is actually using, and working it out requires the reader to know the rule.
    expect(governedBy(big.lines)).toBe('maxRequiredPx');
    expect(governedBy(small.lines)).toBe('fraction');

    big.orchestrator.dispose();
    small.orchestrator.dispose();
  });

  it('puts the value it reported on the wire, so the log cannot describe a different run', async () => {
    const h = harness([0, 0, 1920, 1080]);
    await h.orchestrator.initialize();

    const configure = h.sidecar.sent.find((command) => command.cmd === 'configure');
    const line = h.lines.find((entry) => entry.message === 'capture configured');
    expect(configure?.cmd === 'configure' ? configure.diffThreshold : null).toBeCloseTo(0.001_929, 6);
    expect(line?.fields?.['effectiveDiffThreshold']).toBe(
      configure?.cmd === 'configure' ? configure.diffThreshold : null,
    );
    h.orchestrator.dispose();
  });
});

describe('AppOrchestrator: idle detection (#50)', () => {
  function idleHarness(nowRef: { value: number }) {
    const sidecar = fakeSidecar({});
    const windows = fakeWindows();
    // A configured user, like the shared harness (#51). These tests are about auto mode finding
    // nothing in a region the user chose; with no region the app would not be in auto at all, and
    // the warning channel would be carrying the first-run message instead.
    const config = fakeConfig(CONFIGURED_CONFIG);
    const { logger, lines } = collectingLogger();
    const orchestrator = new AppOrchestrator({
      sidecar,
      config,
      windows,
      logger,
      listMonitorsTimeoutMs: 20,
      idleWarningMs: 25_000,
      now: () => nowRef.value,
    });
    return { orchestrator, sidecar, lines };
  }

  it('warns when auto mode has found nothing for long enough', async () => {
    const now = { value: 0 };
    const h = idleHarness(now);
    await h.orchestrator.initialize();

    // The first nochange establishes the baseline rather than tripping the warning, so a slow
    // launch is not reported as a bad region.
    h.sidecar.emit('nochange', { ev: 'nochange', seq: 1 });
    expect(h.orchestrator.status.warning).toBeNull();

    now.value = 25_000;
    h.sidecar.emit('nochange', { ev: 'nochange', seq: 2 });

    expect(h.orchestrator.status.warning).toContain('no change detected');
    expect(h.orchestrator.status.warning).toContain('diffThreshold');
  });

  it('warns once and then stays quiet, however long the dry spell runs', async () => {
    // The bug this guards: an earlier version interpolated the *live* elapsed seconds into the
    // message, so it differed on every tick, the `===` latch never matched, and it warned and
    // re-notified on every `nochange` forever. A still screen in auto mode is an ordinary state,
    // so that is a permanent stream of warnings for a user who has done nothing wrong.
    const now = { value: 0 };
    const h = idleHarness(now);
    await h.orchestrator.initialize();
    const statuses: (string | null)[] = [];
    h.orchestrator.subscribe((status) => statuses.push(status.warning));

    h.sidecar.emit('nochange', { ev: 'nochange', seq: 1 });
    for (const [index, time] of [25_000, 27_000, 40_000, 120_000].entries()) {
      now.value = time;
      h.sidecar.emit('nochange', { ev: 'nochange', seq: index + 2 });
    }

    const warnings = h.lines.filter(
      (line) => line.level === 'warn' && line.message.includes('no frames for an extended period'),
    );
    expect(warnings).toHaveLength(1);
    // And exactly one status notification, rather than one per tick.
    expect(statuses.filter((warning) => warning !== null)).toHaveLength(1);
  });

  /**
   * #54: the idle warning used to recommend a knob that cannot move.
   *
   * The remedy said "lower diffThreshold" whatever the region was, and on a region large enough
   * to produce this warning in the first place that fraction is inert - the pixel ceiling is the
   * smaller rule and decides alone. A user following the advice turns the knob, sees nothing
   * change, and has been sent down a dead end by the app's own error message.
   *
   * Both directions are asserted, because a message that named `diffMaxRequiredPx` unconditionally
   * would pass a one-sided test while being just as wrong on a cropped region.
   */
  it('names the knob that is actually in force on a large region, not the inert one', async () => {
    const now = { value: 0 };
    // The shared 1920x1080 region: 2,073,600 px, so 4000/area = 0.00193 is below the configured
    // 0.005 and the ceiling governs.
    const h = idleHarness(now);
    await h.orchestrator.initialize();
    h.sidecar.emit('nochange', { ev: 'nochange', seq: 1 });
    now.value = 25_000;
    h.sidecar.emit('nochange', { ev: 'nochange', seq: 2 });

    const warning = h.orchestrator.status.warning;
    expect(warning).toContain('diffMaxRequiredPx');
    // And it says why the other knob is not the answer, rather than silently omitting it.
    expect(warning).toContain('diffThreshold has no effect');
  });

  it('still names diffThreshold on a region small enough for it to be live', async () => {
    const now = { value: 0 };
    const sidecar = fakeSidecar({});
    const { logger, lines } = collectingLogger();
    // 1200x220 = 264,000 px: 4000/area = 0.0152, comfortably above 0.005, so the user's fraction
    // is the smaller rule and the one worth reaching for.
    const config = fakeConfig({
      ...DEFAULT_CONFIG,
      capture: {
        ...DEFAULT_CONFIG.capture,
        region: { rect: [400, 800, 1200, 220], monitorId: PRIMARY.id, monitorSize: [1920, 1080] },
        // Padding would grow the rect and is not what this test is about.
        regionPadding: 0,
      },
    });
    const orchestrator = new AppOrchestrator({
      sidecar,
      config,
      windows: fakeWindows(),
      logger,
      listMonitorsTimeoutMs: 20,
      idleWarningMs: 25_000,
      now: () => now.value,
    });
    await orchestrator.initialize();

    sidecar.emit('nochange', { ev: 'nochange', seq: 1 });
    now.value = 25_000;
    sidecar.emit('nochange', { ev: 'nochange', seq: 2 });

    expect(orchestrator.status.warning).toContain('lower diffThreshold');
    expect(orchestrator.status.warning).not.toContain('diffMaxRequiredPx');
    // The configure path agrees with the message: nothing was overridden, so nothing was warned.
    expect(lines.filter((line) => line.message.includes('has no effect on a region this large'))).toHaveLength(0);
    orchestrator.dispose();
  });

  it('stays quiet during an ordinary gap between subtitles', async () => {
    const now = { value: 0 };
    const h = idleHarness(now);
    await h.orchestrator.initialize();
    h.sidecar.emit('nochange', { ev: 'nochange', seq: 1 });

    // Ten seconds of nothing is a pause in the dialogue, not a broken region.
    now.value = 10_000;
    h.sidecar.emit('nochange', { ev: 'nochange', seq: 2 });

    expect(h.orchestrator.status.warning).toBeNull();
  });

  it('clears the warning the moment a frame arrives', async () => {
    const now = { value: 0 };
    const h = idleHarness(now);
    await h.orchestrator.initialize();
    h.sidecar.emit('nochange', { ev: 'nochange', seq: 1 });
    now.value = 30_000;
    h.sidecar.emit('nochange', { ev: 'nochange', seq: 2 });
    expect(h.orchestrator.status.warning).not.toBeNull();

    h.sidecar.emit('frame', {
      ev: 'frame',
      seq: 3,
      timings: { captureUs: 1, diffUs: 1, ocrUs: 1 },
      monitor: PRIMARY,
      region: [0, 0, 1920, 1080],
      lines: [],
    });

    expect(h.orchestrator.status.warning).toBeNull();
  });

  it('never warns while paused, because finding nothing is what paused means', async () => {
    const now = { value: 0 };
    const h = idleHarness(now);
    await h.orchestrator.initialize();
    h.orchestrator.pause();

    now.value = 120_000;
    h.sidecar.emit('nochange', { ev: 'nochange', seq: 2 });

    expect(h.orchestrator.status.warning).toBeNull();
  });

  it('does not blame the region for time spent paused', async () => {
    // Resuming after a long pause must not warn on the first `nochange`: the app was stopped on
    // purpose, and the dry spell it produced says nothing about the region.
    const now = { value: 0 };
    const h = idleHarness(now);
    await h.orchestrator.initialize();
    h.sidecar.emit('nochange', { ev: 'nochange', seq: 1 });

    h.orchestrator.pause();
    now.value = 300_000;
    h.orchestrator.resume();
    h.sidecar.emit('nochange', { ev: 'nochange', seq: 2 });

    expect(h.orchestrator.status.warning).toBeNull();
  });
});

/**
 * M6-03 (#30), the half that only exists at the seam.
 *
 * `region-guard.test.ts` owns whether a bbox counts as touching an edge. What is only testable
 * here is that the report survives the *same frame* that clears the error - the two live in one
 * listener precisely because a separate listener registered in `index.ts` would have its report
 * wiped by the frame that produced it.
 */
describe('AppOrchestrator: region edge warning', () => {
  const REGION_CONFIG: Config = {
    ...DEFAULT_CONFIG,
    capture: {
      ...DEFAULT_CONFIG.capture,
      region: { rect: [400, 900, 1200, 150], monitorId: PRIMARY.id, monitorSize: [1920, 1080] },
    },
  };

  function frameWith(lines: readonly { bbox: readonly [number, number, number, number] }[]) {
    return {
      ev: 'frame' as const,
      seq: 1,
      timings: { captureUs: 1, diffUs: 1, ocrUs: 1 },
      monitor: PRIMARY,
      region: [400, 900, 1200, 150] as const,
      lines: lines.map((entry) => ({ text: 'sample', bbox: entry.bbox })),
    };
  }

  it('warns when recognised text is against the region edge', async () => {
    const h = harness({ config: REGION_CONFIG });
    await h.orchestrator.initialize();

    h.sidecar.emit('frame', frameWith([{ bbox: [0, 20, 300, 40] }]));

    expect(h.orchestrator.status.warning).toContain('left');
  });

  it('says nothing when every line sits clear of the edges', async () => {
    const h = harness({ config: REGION_CONFIG });
    await h.orchestrator.initialize();

    h.sidecar.emit('frame', frameWith([{ bbox: [20, 20, 300, 40] }]));

    expect(h.orchestrator.status.warning).toBeNull();
  });

  it('survives the same frame that clears the error, rather than being wiped by it', async () => {
    // The ordering bug this guards against: registered as a second listener, the edge check
    // would run before the arm that clears `error` and its result would be discarded.
    const h = harness({ config: REGION_CONFIG, silentFor: [] });
    await h.orchestrator.initialize();
    h.sidecar.emit('error', { ev: 'error', code: 'OCR_FAILED', message: 'boom' });
    expect(h.orchestrator.status.error).not.toBeNull();

    h.sidecar.emit('frame', frameWith([{ bbox: [0, 20, 300, 40] }]));

    expect(h.orchestrator.status.error).toBeNull();
    expect(h.orchestrator.status.warning).toContain('left');
  });

  it('clears the warning as soon as a frame comes back clean', async () => {
    const h = harness({ config: REGION_CONFIG });
    await h.orchestrator.initialize();
    h.sidecar.emit('frame', frameWith([{ bbox: [0, 20, 300, 40] }]));
    expect(h.orchestrator.status.warning).not.toBeNull();

    h.sidecar.emit('frame', frameWith([{ bbox: [20, 20, 300, 40] }]));

    expect(h.orchestrator.status.warning).toBeNull();
  });

  it('never warns about edges when the whole monitor is the region', async () => {
    // Text against the edge of a full-screen capture is constant and legitimate. Warning about
    // it would be pure noise, and noise is how a warning gets ignored when it matters.
    //
    // The assertion is "not an edge warning" rather than "no warning at all", and the difference
    // is #51: a config with no region now carries a standing warning of its own, because a
    // full-screen region is the state that makes the app translate the whole desktop. So the
    // channel is occupied - by the more useful of the two messages.
    const h = harness({ config: DEFAULT_CONFIG });
    await h.orchestrator.initialize();

    h.sidecar.emit('frame', frameWith([{ bbox: [0, 0, 300, 40] }]));

    expect(h.orchestrator.status.warning).not.toContain('touching');
    expect(h.orchestrator.status.warning).toContain('no capture region has been chosen');
  });

  /**
   * #59, cause 2, at the seam.
   *
   * `region-guard.test.ts` owns the rule. What is only testable here is that the monitor's size
   * reaches it at all: the check reads `frame.monitor.bounds`, and a plumbing mistake there is
   * invisible in the guard's own tests because they are handed the number directly.
   */
  describe('a region pinned to the edge of the screen (#59)', () => {
    const CORNER_RECT = [0, 930, 1200, 150] as const;
    const CORNER_CONFIG: Config = {
      ...DEFAULT_CONFIG,
      capture: {
        ...DEFAULT_CONFIG.capture,
        region: { rect: [...CORNER_RECT], monitorId: PRIMARY.id, monitorSize: [1920, 1080] },
      },
    };

    function cornerFrame(lines: readonly { bbox: readonly [number, number, number, number] }[]) {
      return {
        ev: 'frame' as const,
        seq: 1,
        timings: { captureUs: 1, diffUs: 1, ocrUs: 1 },
        // The bottom-left corner of PRIMARY: x is 0 and y + h is 1080, so two of its four edges
        // are the screen's own and `padRegion` has already clamped them.
        monitor: PRIMARY,
        region: CORNER_RECT,
        lines: lines.map((entry) => ({ text: 'sample', bbox: entry.bbox })),
      };
    }

    it('says nothing when the text is only against the edges of the screen itself', async () => {
      const h = harness({ config: CORNER_CONFIG });
      await h.orchestrator.initialize();

      h.sidecar.emit('frame', cornerFrame([{ bbox: [0, 110, 300, 40] }]));

      // Not "a warning the user can ignore" - no warning at all. There is nothing past the edge
      // of the screen to lose, and "widen it" names an action that cannot be taken.
      expect(h.orchestrator.status.warning).toBeNull();
    });

    it('still warns about the right edge, which that same region can be widened into', async () => {
      const h = harness({ config: CORNER_CONFIG });
      await h.orchestrator.initialize();

      h.sidecar.emit('frame', cornerFrame([{ bbox: [0, 20, 1200, 40] }]));

      expect(h.orchestrator.status.warning).toContain('right');
      expect(h.orchestrator.status.warning).not.toContain('left');
    });
  });
});

/**
 * M6-02 (#29) and M6-04 (#31) through the orchestrator.
 *
 * These assert the seam rather than the arithmetic - `coordinates.test.ts` owns the conversion
 * and `region-guard.test.ts` owns the padding. What is only testable here is that the picker's
 * answer reaches **`config.set`** and not a direct `configure`, because that is what makes the
 * region persist and what keeps this class the only sender of `configure`.
 */
describe('AppOrchestrator: region selection', () => {
  const DISPLAY = {
    id: 11,
    label: 'Acme 24',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
  };

  function registryFor(display = DISPLAY): MonitorRegistry {
    return {
      monitors: [PRIMARY],
      setMonitors: () => undefined,
      displayFor: (id) => (id === PRIMARY.id ? display : undefined),
    };
  }

  it('writes the picked region through config, not straight to configure', async () => {
    const h = harness({
      registry: registryFor(),
      picker: {
        pickRegion: async () => ({
          rect: { x: 400, y: 900, width: 1200, height: 150 },
          origin: { x: 0, y: 0 },
          displayId: 11,
        }),
      },
    });
    await h.orchestrator.initialize();

    await h.orchestrator.selectRegion();

    // Persisted, bound to the monitor, and stored as the *raw* drag - padding is applied on the
    // way to the sidecar so that changing the margin later changes the result.
    expect(h.config.current.capture.region).toEqual({
      rect: [400, 900, 1200, 150],
      monitorId: PRIMARY.id,
      monitorSize: [1920, 1080],
    });
  });

  it('sends the padded region to the sidecar while storing the unpadded one', async () => {
    const h = harness({
      registry: registryFor(),
      picker: {
        pickRegion: async () => ({
          rect: { x: 400, y: 400, width: 600, height: 200 },
          origin: { x: 0, y: 0 },
          displayId: 11,
        }),
      },
    });
    await h.orchestrator.initialize();

    await h.orchestrator.selectRegion();

    // `#onConfigChanged` re-pushes `configure` fire-and-forget, and that push does its own
    // `listMonitors` round trip - so the write returning is not the same as the sidecar having
    // been reconfigured. Waiting for the second `configure` is the honest assertion; awaiting
    // only `selectRegion` would pass or fail on scheduler timing.
    await vi.waitFor(() => {
      expect(h.sidecar.sent.filter((command) => command.cmd === 'configure')).toHaveLength(2);
    });

    const configures = h.sidecar.sent.filter((command) => command.cmd === 'configure');
    const last = configures[configures.length - 1];
    // Default padding is 8 physical px on every side: origin back by 8, size up by 16.
    expect(last).toMatchObject({ region: [392, 392, 616, 216] });
    expect(h.config.current.capture.region?.rect).toEqual([400, 400, 600, 200]);
  });

  it('keeps telling the user their saved region was dropped, even once frames flow', async () => {
    // #31's whole promise is that a stale region is never dropped silently. The fallback is to
    // capture the whole monitor, which starts producing frames within about a second - and a
    // frame clears `error`. Reported as an error, the message would flash red for under a
    // second and be gone before the user looked at the tray.
    const stale: Config = {
      ...DEFAULT_CONFIG,
      capture: {
        ...DEFAULT_CONFIG.capture,
        // Saved when the monitor was 1920x1080; `PRIMARY` is 1920x1080 in these fixtures, so
        // the mismatch here is the *monitor id* - that display is not attached.
        region: { rect: [10, 10, 200, 100], monitorId: '\\\\.\\GONE', monitorSize: [1920, 1080] },
      },
    };
    const h = harness({ config: stale });
    await h.orchestrator.initialize();
    expect(h.orchestrator.status.warning).toContain('pick a region again');

    h.sidecar.emit('frame', {
      ev: 'frame',
      seq: 1,
      timings: { captureUs: 1, diffUs: 1, ocrUs: 1 },
      monitor: PRIMARY,
      region: [0, 0, 1920, 1080],
      lines: [],
    });

    expect(h.orchestrator.status.warning).toContain('pick a region again');
  });

  it('leaves the previous region alone when the user cancels', async () => {
    const h = harness({
      registry: registryFor(),
      picker: { pickRegion: async () => null },
    });
    await h.orchestrator.initialize();
    const before = h.config.current.capture.region;

    await h.orchestrator.selectRegion();

    expect(h.config.current.capture.region).toBe(before);
    expect(h.orchestrator.status.error).toBeNull();
  });

  it('does not open a second picker while one is already open', async () => {
    let opened = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      registry: registryFor(),
      picker: {
        pickRegion: async () => {
          opened += 1;
          await gate;
          return null;
        },
      },
    });
    await h.orchestrator.initialize();

    const first = h.orchestrator.selectRegion();
    await h.orchestrator.selectRegion();
    release?.();
    await first;

    expect(opened).toBe(1);
  });

  /**
   * The case this machine cannot show. Every display here is scaleFactor 1.0, so a picker that
   * ignored the scale entirely would produce visibly correct regions on all three monitors.
   */
  it('converts the selection at a scale factor no display on this machine has', async () => {
    const h = harness({
      registry: registryFor({
        id: 11,
        label: '4K at 150%',
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        size: { width: 2560, height: 1440 },
        scaleFactor: 1.5,
      }),
      picker: {
        pickRegion: async () => ({
          rect: { x: 200, y: 100, width: 400, height: 80 },
          origin: { x: 0, y: 0 },
          displayId: 11,
        }),
      },
    });
    await h.orchestrator.initialize();

    await h.orchestrator.selectRegion();

    // 200 CSS px at 150% is 300 physical px, not 200. An implementation that skipped the
    // conversion would store [200, 100, 400, 80] and be indistinguishable from this one on
    // every display attached to this machine.
    expect(h.config.current.capture.region?.rect).toEqual([300, 150, 600, 120]);
  });

  it('offsets by the window origin the picker actually got, not the one it asked for', async () => {
    const h = harness({
      registry: registryFor({
        id: 11,
        label: 'secondary',
        bounds: { x: 1920, y: 0, width: 1080, height: 1920 },
        size: { width: 1080, height: 1920 },
        scaleFactor: 1,
      }),
      picker: {
        pickRegion: async () => ({
          rect: { x: 100, y: 100, width: 400, height: 200 },
          // The ground truth records this happening for real: a fullscreen window on a
          // secondary display came back inside the work area, 48px down from the bounds it
          // asked for. Measuring against the requested origin would offset the region by 48px.
          origin: { x: 1920, y: 48 },
          displayId: 11,
        }),
      },
    });
    await h.orchestrator.initialize();

    await h.orchestrator.selectRegion();

    expect(h.config.current.capture.region?.rect).toEqual([100, 148, 400, 200]);
  });
});

describe('AppOrchestrator: subscribers', () => {
  it('notifies on every state change with the full status', async () => {
    const h = harness();
    const seen: Array<{ mode: AppMode; overlayVisible: boolean }> = [];
    h.orchestrator.subscribe((status) => {
      seen.push({ mode: status.mode, overlayVisible: status.overlayVisible });
    });

    await h.orchestrator.initialize();
    h.orchestrator.pause();
    h.orchestrator.toggleOverlay();

    expect(seen).toEqual([
      { mode: 'auto', overlayVisible: true },
      { mode: 'paused', overlayVisible: true },
      { mode: 'paused', overlayVisible: false },
    ]);
  });

  it('one throwing subscriber does not stop the others', async () => {
    const h = harness();
    const seen: AppMode[] = [];
    h.orchestrator.subscribe(() => {
      throw new Error('subscriber blew up');
    });
    h.orchestrator.subscribe((status) => {
      seen.push(status.mode);
    });

    await h.orchestrator.initialize();

    expect(seen).toEqual(['auto']);
    expect(h.lines.some((line) => line.level === 'error' && line.message.includes('status listener threw'))).toBe(
      true,
    );
  });

  it('dispose unsubscribes from the sidecar', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.orchestrator.dispose();

    h.sidecar.emit('error', { ev: 'error', code: 'OCR_FAILED', message: 'boom' });

    expect(h.orchestrator.status.error).toBeNull();
  });
});

/**
 * The first run (issue #51).
 *
 * With no region chosen the region is the whole display, and `effectiveDiffThreshold` turns the
 * default 0.005 fraction into 0.0008 on a 3440x1440 screen because `diffMaxRequiredPx` is the
 * smaller of the two there (#54). A live desktop is never still - measured at 3 frames in 8 seconds
 * even at the old 0.02 - so a fresh install pressing auto captures, OCRs and translates on nearly
 * every tick, on content nobody asked about.
 *
 * #51 is explicit that this is a **flow** problem: the numbers that make a subtitle detectable and
 * the numbers that make a desktop quiet are on opposite sides of each other, and three regression
 * tests in `region-guard.test.ts` hold the current ones shut so that #50 cannot come back. So
 * nothing below touches `diffThreshold` or `diffMaxRequiredPx`; what changes is where the app rests
 * and where it sends the user.
 */
describe('AppOrchestrator: the first run has no region (#51)', () => {
  const DISPLAY = {
    id: 11,
    label: 'Acme 24',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1,
  };

  function registry(): MonitorRegistry {
    return {
      monitors: [PRIMARY],
      setMonitors: () => undefined,
      displayFor: (id) => (id === PRIMARY.id ? DISPLAY : undefined),
    };
  }

  /** A picker that answers with one rectangle, and counts how often it was opened. */
  function countingPicker(): RegionPickerWindows & { opened: number } {
    const picker = {
      opened: 0,
      pickRegion: async () => {
        picker.opened += 1;
        return await Promise.resolve({
          rect: { x: 400, y: 900, width: 1200, height: 150 },
          origin: { x: 0, y: 0 },
          displayId: 11,
        });
      },
    };
    return picker;
  }

  it('configures the sidecar but rests in idle instead of starting auto', async () => {
    const h = harness({ config: DEFAULT_CONFIG });
    await h.orchestrator.initialize();

    // Configured, so the tray, the monitor list and a deliberate snapshot all still work...
    expect(h.orchestrator.configured).toBe(true);
    // ...but nothing is capturing, which is the whole of the issue.
    expect(h.sidecar.kinds).toEqual(['listMonitors', 'configure']);
    expectConverged(h, 'idle');
  });

  it('says why, through the standing warning channel', async () => {
    const h = harness({ config: DEFAULT_CONFIG });
    await h.orchestrator.initialize();

    // Invariant 4: an app that does nothing on launch and does not say why is an app the user
    // reads as broken. A warning rather than an error, because nothing has failed - and because an
    // error is cleared by the next frame, which is exactly what will never arrive here.
    expect(h.orchestrator.status.warning).toContain('no capture region has been chosen');
  });

  it('opens the picker instead of starting auto when the hotkey is pressed', async () => {
    const picker = countingPicker();
    const h = harness({ config: DEFAULT_CONFIG, registry: registry(), picker });
    await h.orchestrator.initialize();

    h.orchestrator.toggleAuto();

    await vi.waitFor(() => {
      expect(picker.opened).toBe(1);
    });
  });

  it('routes resume to the picker as well, not only toggleAuto', async () => {
    const picker = countingPicker();
    const h = harness({ config: DEFAULT_CONFIG, registry: registry(), picker });
    await h.orchestrator.initialize();

    h.orchestrator.resume();

    await vi.waitFor(() => {
      expect(picker.opened).toBe(1);
    });
  });

  it('enters auto once a region has actually been picked', async () => {
    const h = harness({ config: DEFAULT_CONFIG, registry: registry(), picker: countingPicker() });
    await h.orchestrator.initialize();
    expect(h.orchestrator.mode).toBe('idle');

    await h.orchestrator.selectRegion();

    // #51's "เลือก region แล้วพฤติกรรมกลับมาเป็นปกติ": the user who just drew a box around a
    // subtitle has said what they want at least as clearly as pressing the hotkey would.
    expect(h.orchestrator.mode).toBe('auto');
    expect(h.orchestrator.status.warning).toBeNull();
  });

  it('sends configure for the picked region before the first start', async () => {
    // The ordering that stops one tick of the very behaviour this issue removes: a `start` sent
    // before the new `configure` landed would capture the whole display once.
    const h = harness({ config: DEFAULT_CONFIG, registry: registry(), picker: countingPicker() });
    await h.orchestrator.initialize();

    await h.orchestrator.selectRegion();

    const startIndex = h.sidecar.kinds.indexOf('start');
    const configures = h.sidecar.kinds
      .map((kind, index) => (kind === 'configure' ? index : -1))
      .filter((index) => index >= 0);
    expect(startIndex).toBeGreaterThan(-1);
    expect(configures.length).toBeGreaterThanOrEqual(2);
    expect(configures[1]).toBeLessThan(startIndex);
    // Padded by 8 and clamped, exactly as `#resolveRegion` does for any other region.
    expect(h.sidecar.sent[configures[1] ?? 0]).toMatchObject({ region: [392, 892, 1216, 166] });
  });

  it('stays idle when the picker is cancelled, and keeps saying why', async () => {
    // The user was asked and declined. Starting anything behind that would be the app deciding it
    // knew better - and it would be the #51 behaviour again.
    const h = harness({
      config: DEFAULT_CONFIG,
      registry: registry(),
      picker: { pickRegion: async () => await Promise.resolve(null) },
    });
    await h.orchestrator.initialize();

    h.orchestrator.toggleAuto();

    await vi.waitFor(() => {
      expect(h.lines.some((line) => line.message.includes('previous region still applies'))).toBe(true);
    });
    expect(h.orchestrator.mode).toBe('idle');
    expect(h.orchestrator.status.warning).toContain('no capture region has been chosen');
  });

  it('does not promote idle to auto when the sidecar restarts', async () => {
    // The reason the gate is in `initialize` and not only on the transitions. `SidecarSupervisor`
    // re-runs `initialize` after every restart, so a gate on `toggleAuto` alone would have any
    // crash quietly start full-screen capture on a machine that never chose a region.
    const h = harness({ config: DEFAULT_CONFIG });
    await h.orchestrator.initialize();
    expect(h.orchestrator.mode).toBe('idle');

    h.sidecar.emit('exit', { code: 1, signal: null, expected: false });
    await h.orchestrator.initialize();

    expect(h.orchestrator.mode).toBe('idle');
    expect(h.sidecar.capturing).toBe(false);
  });

  it('still resumes a configured user into auto after a restart', async () => {
    // The other direction of the same gate: a user who has a region must not be left idle by it.
    const h = harness();
    await h.orchestrator.initialize();
    expect(h.orchestrator.mode).toBe('auto');

    h.sidecar.emit('exit', { code: 1, signal: null, expected: false });
    await h.orchestrator.initialize();

    expectConverged(h, 'auto');
  });

  it('raises the warning again if the region is cleared from the settings window', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    expect(h.orchestrator.status.warning).toBeNull();

    h.config.change({ capture: { region: null } });

    expect(h.orchestrator.status.warning).toContain('no capture region has been chosen');
  });

  it('still allows a deliberate snapshot, which costs one tick', async () => {
    // G4's document-reading mode is one frame on demand. It is not the runaway loop #51 is about,
    // and refusing it would take a working feature away to fix a different one.
    const h = harness({ config: DEFAULT_CONFIG });
    await h.orchestrator.initialize();

    h.orchestrator.snapshot();

    expect(h.orchestrator.mode).toBe('snapshot');
    expect(h.sidecar.kinds).toContain('snapshot');
  });
});

/**
 * Four different conditions reach the user through the one `warning` channel, and since #59 the
 * banner drops a `warning` after a few seconds so it stops covering the screen.
 *
 * That is right for three of them and wrong for the fourth. "You have not chosen a region yet" is
 * not something that went wrong during a session - it is the state a fresh install sits in,
 * translating nothing on purpose, and the banner is the only thing on screen that explains why
 * the app appears to be doing nothing. Auto-hiding it would put a first run back exactly where it
 * was before that message existed: an app that starts, shows nothing, and says nothing.
 */
describe('AppOrchestrator: which warnings may leave the screen by themselves (#59)', () => {
  function fakeTimers() {
    const scheduled: { handler: () => void; cancelled: boolean }[] = [];
    const schedule: ScheduleTimer = (handler) => {
      const entry = { handler, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    };
    return {
      schedule,
      elapse() {
        for (const entry of [...scheduled]) {
          if (entry.cancelled) continue;
          entry.cancelled = true;
          entry.handler();
        }
      },
    };
  }

  it('never hides "you have not chosen a region yet", however long it is left up', () => {
    const timers = fakeTimers();
    const reporter = new ErrorReporter({ schedule: timers.schedule });

    reporter.set('region', describeAppWarning(NO_REGION_WARNING));
    timers.elapse();
    timers.elapse();

    expect(reporter.banner?.cause).toBe(NO_REGION_WARNING);
  });

  it('carries that exemption all the way from a first run with no region configured', async () => {
    // The seam a hand-built alert cannot check: that the orchestrator's own status text is the
    // one the exemption is keyed on. A reworded warning that missed the constant would show up
    // here and nowhere else.
    const timers = fakeTimers();
    const reporter = new ErrorReporter({ schedule: timers.schedule });
    const h = harness({ config: DEFAULT_CONFIG });
    await h.orchestrator.initialize();

    reporter.set('region', describeAppWarning(h.orchestrator.status.warning));
    timers.elapse();

    expect(h.orchestrator.status.warning).toBe(NO_REGION_WARNING);
    expect(reporter.banner?.cause).toBe(NO_REGION_WARNING);
    // And the tray was never in question.
    expect(reporter.top?.cause).toBe(NO_REGION_WARNING);
  });

  it.each([
    ['text clipping the region (#30)', 'text is touching the right edge of the region; widen it'],
    ['a saved region that no longer applies (#31)', 'DISPLAY1 was 1920x1080 when the region was saved'],
    ['auto mode finding nothing (#50)', 'no change has been detected for over 25s'],
  ])('lets the warning about %s stop covering the screen', (_label, warning) => {
    const timers = fakeTimers();
    const reporter = new ErrorReporter({ schedule: timers.schedule });

    reporter.set('region', describeAppWarning(warning));
    timers.elapse();

    // Every one of these describes something happening to a capture that is running. The user
    // has read it, the tray still holds it, and the screen is worth more than the repetition.
    expect(reporter.banner).toBeNull();
    expect(reporter.top?.cause).toBe(warning);
  });

  it('marks only the no-region warning as one that stays', () => {
    expect(describeAppWarning(NO_REGION_WARNING)?.sticky).toBe(true);
    expect(describeAppWarning('anything else at all')?.sticky).toBe(false);
    expect(describeAppWarning(null)).toBeNull();
    // Not a substring match: a message that merely mentions the region is not this message.
    expect(describeAppWarning(`${NO_REGION_WARNING}, probably`)?.sticky).toBe(false);
    // Sanity: the exemption is worth nothing if the timeout is not real.
    expect(DEFAULT_BANNER_TIMEOUT_MS).toBeGreaterThan(0);
  });

  /**
   * #64: "change what is being captured" names an act with no object for a user who has never
   * chosen anything. Keyed on the same {@link NO_REGION_WARNING} identity `sticky` uses, so the
   * two cannot disagree about which warning is the first-run one.
   */
  it('gives the first-run warning its own remedy, and leaves the other three alone', () => {
    expect(describeAppWarning(NO_REGION_WARNING)?.remedy).toBe(
      'use the tray menu → "Select Region…" to choose what Textlens should capture',
    );
    expect(describeAppWarning(NO_REGION_WARNING)?.remedy).not.toContain('change');

    for (const warning of [
      'text is touching the right edge of the region; widen it',
      'DISPLAY1 was 1920x1080 when the region was saved',
      'no change has been detected for over 25s',
    ]) {
      expect(describeAppWarning(warning)?.remedy).toBe(
        'use the tray menu → "Select Region…" to change what is being captured',
      );
    }
  });
});
