/**
 * Tests for `SidecarSupervisor` (issue M10-01 / #40).
 *
 * Everything here runs on a fake clock and a fake process, which is what makes a 60-second quota
 * window and a 20-second watchdog checkable in milliseconds. **That is also the limit of what
 * these prove**: a fake child that resolves `start()` cannot demonstrate that the real sidecar
 * comes back, gets reconfigured, and produces frames again. That claim is made by killing the real
 * one and reading the log, and is recorded on the issue - these cover the state machine that
 * decides *when* to do it, including every branch that stops it doing it too eagerly.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ReadyEvent } from '../../src/shared/protocol.js';
import {
  MIN_WATCHDOG_SILENCE_MS,
  SidecarSupervisor,
  type SupervisedSidecar,
  type SupervisorStatus,
} from '../../src/main/services/sidecar-supervisor.js';
import type { SidecarClientEvents } from '../../src/main/services/sidecar-client.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Let a fire-and-forget async chain settle. `ensureRunning` returns before its start finishes. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** A clock and a timer queue that only move when a test says so. */
function fakeClock() {
  let now = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();

  return {
    now: (): number => now,
    setTimer: (callback: () => void, ms: number): unknown => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    get pending(): number {
      return timers.size;
    },
    /** Move time forward, firing every timer that comes due, in order. */
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
        // Let any promise chain the callback started settle before the next timer fires.
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
    },
  };
}

type Clock = ReturnType<typeof fakeClock>;

const READY: ReadyEvent = { ev: 'ready', version: 'test', ocrLanguages: ['en-US'] };

interface FakeClient extends SupervisedSidecar {
  /** Emit an event as the real client would. */
  emit<K extends 'exit' | 'frame' | 'nochange'>(event: K, payload: SidecarClientEvents[K]): void;
  /** Kill the process from outside: an unexpected exit. */
  die(code?: number): void;
  readonly starts: number;
  readonly stops: number;
  /** Make the next `start()` reject, as a missing executable would. */
  failNextStart(message: string): void;
}

function fakeClient(): FakeClient {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  let running = false;
  let starts = 0;
  let stops = 0;
  let failWith: string | null = null;

  const emit = <K extends 'exit' | 'frame' | 'nochange'>(event: K, payload: SidecarClientEvents[K]): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      (listener as (value: SidecarClientEvents[K]) => void)(payload);
    }
  };

  return {
    get isRunning(): boolean {
      return running;
    },
    get starts(): number {
      return starts;
    },
    get stops(): number {
      return stops;
    },
    failNextStart(message: string): void {
      failWith = message;
    },
    async start(): Promise<ReadyEvent> {
      starts += 1;
      if (failWith !== null) {
        const message = failWith;
        failWith = null;
        throw new Error(message);
      }
      running = true;
      return await Promise.resolve(READY);
    },
    async stop(): Promise<void> {
      stops += 1;
      if (running) {
        running = false;
        // The real client's `stop()` closes stdin and the sidecar exits 0; the exit event is what
        // the supervisor actually reacts to, so the fake has to produce one too.
        emit('exit', { code: 0, signal: null, expected: true });
      }
      return await Promise.resolve();
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
    emit,
    die(code = 1): void {
      running = false;
      emit('exit', { code, signal: null, expected: false });
    },
  };
}

interface HarnessOptions {
  readonly wantsSidecar?: () => boolean;
  readonly expectsEvents?: () => boolean;
  readonly watchdogSilenceMs?: () => number;
  readonly maxRestarts?: number;
  readonly backoffMs?: readonly number[];
  readonly onStarted?: (ready: ReadyEvent) => void | Promise<void>;
}

function harness(options: HarnessOptions = {}) {
  const clock = fakeClock();
  const client = fakeClient();
  const statuses: SupervisorStatus[] = [];

  const supervisor = new SidecarSupervisor({
    client,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    backoffMs: options.backoffMs ?? [500, 2_000, 5_000],
    ...(options.maxRestarts === undefined ? {} : { maxRestarts: options.maxRestarts }),
    ...(options.wantsSidecar === undefined ? {} : { wantsSidecar: options.wantsSidecar }),
    ...(options.expectsEvents === undefined ? {} : { expectsEvents: options.expectsEvents }),
    ...(options.watchdogSilenceMs === undefined ? {} : { watchdogSilenceMs: options.watchdogSilenceMs }),
    ...(options.onStarted === undefined ? {} : { onStarted: options.onStarted }),
  });
  supervisor.subscribe((status) => statuses.push(status));

  return { clock: clock as Clock, client, supervisor, statuses };
}

// ---------------------------------------------------------------------------

describe('SidecarSupervisor: restart and backoff', () => {
  it('restarts after an unexpected death, well inside the 5s the issue allows', async () => {
    const h = harness({ expectsEvents: () => true });
    await h.supervisor.start();
    expect(h.client.starts).toBe(1);

    h.client.die();
    expect(h.supervisor.state).toBe('backoff');
    // The wait, not the assertion. Advancing by the full 5s would pass for a supervisor that
    // waited 4.9 seconds, which is not what "restart อัตโนมัติภายใน 5 วินาที" means in practice.
    await h.clock.advance(500);

    expect(h.client.starts).toBe(2);
    expect(h.supervisor.state).toBe('running');
  });

  it('reconfigures on every restart, not just the first start', async () => {
    const onStarted = vi.fn();
    const h = harness({ onStarted });
    await h.supervisor.start();
    h.client.die();
    await h.clock.advance(500);

    // The failure this guards is the one that looks identical to success in the log: a process
    // that came back and was never told what to capture.
    expect(onStarted).toHaveBeenCalledTimes(2);
  });

  it('waits longer after each successive death', async () => {
    const h = harness({ backoffMs: [500, 2_000, 5_000] });
    await h.supervisor.start();

    h.client.die();
    await h.clock.advance(499);
    expect(h.client.starts).toBe(1);
    await h.clock.advance(1);
    expect(h.client.starts).toBe(2);

    h.client.die();
    await h.clock.advance(1_999);
    expect(h.client.starts).toBe(2);
    await h.clock.advance(1);
    expect(h.client.starts).toBe(3);

    h.client.die();
    await h.clock.advance(4_999);
    expect(h.client.starts).toBe(3);
    await h.clock.advance(1);
    expect(h.client.starts).toBe(4);
  });

  it('gives up on the fourth death inside the window and says why', async () => {
    const h = harness({ maxRestarts: 3 });
    await h.supervisor.start();

    h.client.die();
    await h.clock.advance(500);
    h.client.die();
    await h.clock.advance(2_000);
    h.client.die();
    await h.clock.advance(5_000);
    expect(h.client.starts).toBe(4);

    h.client.die();
    expect(h.supervisor.state).toBe('gave-up');
    expect(h.supervisor.status.detail).toContain('code=1');

    // The give-up has to be terminal, or it is not a give-up. Nothing further may fire.
    await h.clock.advance(60_000);
    expect(h.client.starts).toBe(4);
  });

  /**
   * Found by killing the real sidecar four times in a row, not by reading the code.
   *
   * A process that dies inside its startup window produces the `exit` event *and* a rejection from
   * `SidecarClient.#awaitReady` ("exited before ready"). Both used to be counted, so the third kill
   * spent two of three restarts and the supervisor gave up one death early - an over-eager
   * give-up, which is the same class of bug as an over-eager restart.
   */
  it('counts a death during startup once, not twice', async () => {
    const h = harness({ maxRestarts: 3, backoffMs: [500, 2_000, 5_000] });
    await h.supervisor.start();

    // The realistic shape: the exit arrives, then `start()` rejects for the same reason.
    h.client.die();
    expect(h.supervisor.status.deaths).toBe(1);
    h.client.failNextStart('sidecar exited before "ready" (code=1 signal=null)');
    await h.clock.advance(500);

    expect(h.supervisor.status.deaths).toBe(2);
    expect(h.supervisor.state).toBe('backoff');
  });

  it('resets the count once a restart has survived the window', async () => {
    const h = harness({ maxRestarts: 3, backoffMs: [500] });
    await h.supervisor.start();

    for (let i = 0; i < 3; i += 1) {
      h.client.die();
      await h.clock.advance(500);
    }
    expect(h.supervisor.status.deaths).toBe(3);
    expect(h.supervisor.status.remaining).toBe(0);

    // Alive for longer than the rolling window, so every recorded death ages out.
    await h.clock.advance(61_000);
    h.client.die();

    expect(h.supervisor.state).toBe('backoff');
    expect(h.supervisor.status.deaths).toBe(1);
    await h.clock.advance(500);
    expect(h.client.starts).toBe(5);
  });

  it('treats a start that never succeeds as a death, so a bad path backs off too', async () => {
    const h = harness({ maxRestarts: 1, backoffMs: [500] });
    h.client.failNextStart('sidecar executable not found at C:\\nope.exe');

    const ok = await h.supervisor.start();

    // Not thrown: `index.ts` used to swallow this and leave the app permanently uncapturing.
    expect(ok).toBe(false);
    expect(h.supervisor.state).toBe('backoff');
    expect(h.supervisor.status.detail).toContain('not found');

    h.client.failNextStart('sidecar executable not found at C:\\nope.exe');
    await h.clock.advance(500);
    expect(h.supervisor.state).toBe('gave-up');
  });

  it('does not restart a sidecar that was asked to stop', async () => {
    const h = harness();
    await h.supervisor.start();

    await h.client.stop();

    expect(h.supervisor.state).toBe('stopped');
    await h.clock.advance(60_000);
    expect(h.client.starts).toBe(1);
  });

  it('stops reacting to anything once disposed, so a shutdown cannot look like a crash', async () => {
    const h = harness();
    await h.supervisor.start();

    h.supervisor.dispose();
    h.client.die();

    await h.clock.advance(60_000);
    expect(h.client.starts).toBe(1);
    expect(h.supervisor.state).toBe('disposed');
  });
});

describe('SidecarSupervisor: the paused gate (#40)', () => {
  it('does not restart a sidecar that died while the user had paused', async () => {
    let paused = false;
    const h = harness({ wantsSidecar: () => !paused });
    await h.supervisor.start();

    paused = true;
    h.client.die();

    expect(h.supervisor.state).toBe('stopped');
    expect(h.supervisor.status.reason).toBe('not-wanted');
    await h.clock.advance(60_000);
    expect(h.client.starts).toBe(1);
    // And it costs the user none of their quota, because the restart was never wanted.
    expect(h.supervisor.status.deaths).toBe(0);
  });

  it('starts one again when the user returns to auto', async () => {
    let paused = true;
    const h = harness({ wantsSidecar: () => !paused });
    await h.supervisor.start();
    h.client.die();
    expect(h.client.starts).toBe(1);

    paused = false;
    h.supervisor.ensureRunning();
    await Promise.resolve();

    expect(h.client.starts).toBe(2);
  });

  it('abandons a scheduled restart if the user pauses during the backoff', async () => {
    let paused = false;
    const h = harness({ wantsSidecar: () => !paused });
    await h.supervisor.start();

    h.client.die();
    expect(h.supervisor.state).toBe('backoff');
    paused = true;
    await h.clock.advance(500);

    expect(h.client.starts).toBe(1);
    expect(h.supervisor.state).toBe('stopped');
  });

  it('ensureRunning does not stack starts on top of a scheduled one', async () => {
    const h = harness();
    await h.supervisor.start();
    h.client.die();

    h.supervisor.ensureRunning();
    h.supervisor.ensureRunning();
    await h.clock.advance(500);

    expect(h.client.starts).toBe(2);
  });

  /**
   * `ensureRunning` is called from a status subscription, so it fires on any mode change. Left
   * able to act from `gave-up`, the one state the supervisor deliberately cannot leave would be
   * left by accident - and a crash-looping sidecar would be restarted for the rest of the session
   * by nothing more than the user toggling the overlay.
   */
  it('cannot be talked out of giving up by a mode change', async () => {
    const h = harness({ maxRestarts: 0 });
    await h.supervisor.start();
    h.client.die();
    expect(h.supervisor.state).toBe('gave-up');

    h.supervisor.ensureRunning();
    await flush();
    await h.clock.advance(60_000);

    expect(h.client.starts).toBe(1);
    expect(h.supervisor.state).toBe('gave-up');
  });

  it('an explicit retry clears the quota and starts immediately', async () => {
    const h = harness({ maxRestarts: 0 });
    await h.supervisor.start();
    h.client.die();
    expect(h.supervisor.state).toBe('gave-up');

    h.supervisor.retry();
    await flush();

    expect(h.client.starts).toBe(2);
    expect(h.supervisor.status.deaths).toBe(0);
    expect(h.supervisor.state).toBe('running');
  });
});

describe('SidecarSupervisor: the watchdog', () => {
  const SILENCE = 20_000;

  it('kills and restarts a sidecar that has stopped producing events', async () => {
    const h = harness({ expectsEvents: () => true, watchdogSilenceMs: () => SILENCE });
    await h.supervisor.start();

    await h.clock.advance(SILENCE + 1_000);

    expect(h.client.stops).toBe(1);
    await h.clock.advance(500);
    expect(h.client.starts).toBe(2);
  });

  it('leaves a sidecar alone for as long as either event kind keeps arriving', async () => {
    const h = harness({ expectsEvents: () => true, watchdogSilenceMs: () => SILENCE });
    await h.supervisor.start();

    // `nochange` on purpose: a still screen produces nothing else, and a watchdog fed by `frame`
    // alone would kill a sidecar that is working perfectly.
    for (let i = 0; i < 10; i += 1) {
      await h.clock.advance(SILENCE / 2);
      h.client.emit('nochange', { ev: 'nochange', seq: i } as unknown as SidecarClientEvents['nochange']);
    }

    expect(h.client.stops).toBe(0);
    expect(h.client.starts).toBe(1);
  });

  it('never fires while nothing is expecting events - a paused loop is silent by design', async () => {
    const h = harness({ expectsEvents: () => false, watchdogSilenceMs: () => SILENCE });
    await h.supervisor.start();

    await h.clock.advance(10 * SILENCE);

    expect(h.client.stops).toBe(0);
  });

  it('does not trip on time the app spent paused once capture resumes', async () => {
    let capturing = false;
    const h = harness({ expectsEvents: () => capturing, watchdogSilenceMs: () => SILENCE });
    await h.supervisor.start();

    await h.clock.advance(5 * SILENCE);
    capturing = true;
    // Less than the threshold since resuming. A watchdog that measured from the last real event
    // would kill here, blaming the sidecar for a pause the user asked for.
    await h.clock.advance(SILENCE - 1);

    expect(h.client.stops).toBe(0);
  });

  it('refuses a threshold shorter than one plausible OCR pass', async () => {
    const h = harness({ expectsEvents: () => true, watchdogSilenceMs: () => 10 });
    await h.supervisor.start();

    await h.clock.advance(MIN_WATCHDOG_SILENCE_MS - 1);
    expect(h.client.stops).toBe(0);

    await h.clock.advance(MIN_WATCHDOG_SILENCE_MS);
    expect(h.client.stops).toBe(1);
  });

  it('counts a watchdog kill against the quota, so a repeatedly hanging sidecar also gives up', async () => {
    const h = harness({
      expectsEvents: () => true,
      watchdogSilenceMs: () => SILENCE,
      maxRestarts: 1,
      backoffMs: [500],
    });
    await h.supervisor.start();

    await h.clock.advance(SILENCE * 2);
    await h.clock.advance(500);
    expect(h.client.starts).toBe(2);

    await h.clock.advance(SILENCE * 2);

    expect(h.supervisor.state).toBe('gave-up');
    expect(h.supervisor.status.reason).toBe('watchdog');
  });

  it('stops watching once the process is gone, so a dead sidecar is never stopped again', async () => {
    // Paused, so nothing restarts it and the only thing that could call `stop()` is a watchdog
    // still ticking against a process that is not there.
    const h = harness({
      expectsEvents: () => true,
      watchdogSilenceMs: () => SILENCE,
      wantsSidecar: () => false,
    });
    await h.supervisor.start();

    h.client.die();
    await h.clock.advance(SILENCE * 3);

    expect(h.client.stops).toBe(0);
    expect(h.client.starts).toBe(1);
  });
});
