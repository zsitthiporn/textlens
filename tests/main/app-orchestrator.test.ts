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
  type AppMode,
  type CaptureConfigSource,
  type CaptureSidecar,
  type MonitorRegistry,
  type RegionPickerWindows,
} from '../../src/main/services/app-orchestrator.js';
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

interface FakeSidecar extends CaptureSidecar {
  /** Every command written, in order. */
  readonly sent: SidecarCommand[];
  /** The sidecar's own view of its capture loop - the thing Node must not diverge from. */
  readonly capturing: boolean;
  /** Its command state machine's state, exactly as `Dispatcher` computes it. */
  readonly state: string;
  /** Push an event as the sidecar would. */
  emit<K extends 'ack' | 'error' | 'frame' | 'nochange' | 'exit'>(event: K, payload: SidecarClientEvents[K]): void;
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

interface FakeWindows {
  setOverlayVisible(visible: boolean): boolean;
  openSettings(): unknown;
  readonly calls: boolean[];
  visible: boolean;
  refuse: boolean;
  settingsOpened: number;
}

function fakeWindows(): FakeWindows {
  const windows: FakeWindows = {
    calls: [],
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
  } = {},
): Harness {
  const sidecar = fakeSidecar(options);
  const windows = fakeWindows();
  const config = fakeConfig(options.config ?? DEFAULT_CONFIG);
  const { logger, lines } = collectingLogger();
  const orchestrator = new AppOrchestrator({
    sidecar,
    config,
    windows,
    logger,
    listMonitorsTimeoutMs: 20,
    ...(options.registry === undefined ? {} : { monitors: options.registry }),
    ...(options.picker === undefined ? {} : { picker: options.picker }),
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
    const h = harness();
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
  it('during auto: captures once and ends in auto, still running', async () => {
    const h = harness();
    await h.orchestrator.initialize();

    h.orchestrator.snapshot();

    expect(h.sidecar.kinds).toEqual(['listMonitors', 'configure', 'start', 'snapshot']);
    expectConverged(h, 'auto');
  });

  it('during pause: captures once and stays paused, still stopped', async () => {
    const h = harness();
    await h.orchestrator.initialize();
    h.orchestrator.pause();

    h.orchestrator.snapshot();

    expect(h.sidecar.kinds.at(-1)).toBe('snapshot');
    // The one that matters: a snapshot must not restart the loop it was taken from.
    expectConverged(h, 'paused');
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

  it('interleaved snapshots and toggles converge', async () => {
    const h = harness();
    await h.orchestrator.initialize();

    h.orchestrator.toggleAuto();
    h.orchestrator.snapshot();
    h.orchestrator.toggleAuto();
    h.orchestrator.snapshot();
    h.orchestrator.toggleAuto();
    h.orchestrator.toggleOverlay();
    h.orchestrator.snapshot();

    expectConverged(h, 'paused');
    expect(h.orchestrator.overlayVisible).toBe(false);
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

  it('falls back to idle when the sidecar dies', async () => {
    const h = harness();
    await h.orchestrator.initialize();

    h.sidecar.emit('exit', { code: 1, signal: null, expected: false });

    expect(h.orchestrator.mode).toBe('idle');
    expect(h.orchestrator.configured).toBe(false);
    expect(h.orchestrator.capturing).toBe(false);
    expect(h.orchestrator.status.error).toContain('stopped unexpectedly');
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
describe('AppOrchestrator: idle detection (#50)', () => {
  function idleHarness(nowRef: { value: number }) {
    const sidecar = fakeSidecar({});
    const windows = fakeWindows();
    const config = fakeConfig(DEFAULT_CONFIG);
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

  it('never warns when the whole monitor is the region', async () => {
    // Text against the edge of a full-screen capture is constant and legitimate. Warning about
    // it would be pure noise, and noise is how a warning gets ignored when it matters.
    const h = harness();
    await h.orchestrator.initialize();

    h.sidecar.emit('frame', frameWith([{ bbox: [0, 0, 300, 40] }]));

    expect(h.orchestrator.status.warning).toBeNull();
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
