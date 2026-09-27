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
  TEARDOWN_WAIT_MS,
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

/** A `start()` the test settles by hand. */
interface HeldStart {
  /** `ready` arrived. */
  resolve(): void;
  /**
   * `start()` rejected. The process is left exactly as it was: whether it is still alive (a ready
   * timeout, which the real client answers with a `stop()` whose exit arrives *later*) or already
   * gone (an exit during startup, delivered with `die()` *before* this) is the test's to say.
   */
  reject(message: string): void;
}

interface FakeClient extends SupervisedSidecar {
  /** Emit an event as the real client would. */
  emit<K extends 'exit' | 'frame' | 'nochange'>(event: K, payload: SidecarClientEvents[K]): void;
  /** Kill the process from outside: an unexpected exit. */
  die(code?: number): void;
  /**
   * The process goes away because the client asked it to: an `expected` exit. The tail of the
   * real client's ready timeout, which calls `void this.stop()` before it rejects.
   */
  exitExpected(code?: number): void;
  /**
   * The client's `stop()` has escalated to a kill. As with a real `ChildProcess`, `isRunning` turns
   * false at once while the process - and `pid`, and `start()`'s refusal - last until its exit.
   */
  sendKill(): void;
  readonly starts: number;
  readonly stops: number;
  /** Make the next `start()` reject, as a missing executable would. */
  failNextStart(message: string): void;
  /**
   * Make the next `start()` spawn and then wait for the test to settle it (#77 LR-05).
   *
   * Every other start here settles in the same tick, so without this no test can deliver an exit
   * while a start is pending, or after one has failed - the two orderings the supervisor actually
   * has to get right, and the two that were broken.
   */
  holdNextStart(): HeldStart;
}

const FAKE_PID = 4242;

function fakeClient(): FakeClient {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  /** The client holds a process: the real one's `#child !== null`. */
  let running = false;
  let killSent = false;
  let starts = 0;
  let stops = 0;
  let failWith: string | null = null;
  let held: Promise<ReadyEvent> | null = null;

  const emit = <K extends 'exit' | 'frame' | 'nochange'>(event: K, payload: SidecarClientEvents[K]): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      (listener as (value: SidecarClientEvents[K]) => void)(payload);
    }
  };

  return {
    get isRunning(): boolean {
      return running && !killSent;
    },
    get pid(): number | undefined {
      return running ? FAKE_PID : undefined;
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
    holdNextStart(): HeldStart {
      let resolve!: (ready: ReadyEvent) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<ReadyEvent>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      held = promise;
      return {
        resolve: () => {
          resolve(READY);
        },
        reject: (message) => {
          reject(new Error(message));
        },
      };
    },
    async start(): Promise<ReadyEvent> {
      starts += 1;
      // As the real client does while `#child` is set - including while it is still tearing down a
      // process whose start timed out.
      if (running) throw new Error('SidecarClient.start called while a sidecar is already running');
      if (failWith !== null) {
        const message = failWith;
        failWith = null;
        throw new Error(message);
      }
      running = true;
      killSent = false;
      if (held !== null) {
        const pending = held;
        held = null;
        return await pending;
      }
      return await Promise.resolve(READY);
    },
    async stop(): Promise<void> {
      stops += 1;
      if (running) {
        running = false;
        killSent = false;
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
      killSent = false;
      emit('exit', { code, signal: null, expected: false });
    },
    exitExpected(code = 0): void {
      running = false;
      killSent = false;
      emit('exit', { code, signal: null, expected: true });
    },
    sendKill(): void {
      killSent = true;
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
   *
   * #77 LR-05: this used to kill a *running* sidecar and then fail the next start, so the exit never
   * arrived while a start was pending - and a supervisor with the startup guard deleted passed it.
   * The exit now lands inside the start, which is the only ordering the guard exists for.
   */
  it('counts a death during startup once, not twice', async () => {
    const h = harness({ maxRestarts: 3, backoffMs: [500, 2_000, 5_000] });
    const pending = h.client.holdNextStart();
    const started = h.supervisor.start();
    expect(h.supervisor.state).toBe('starting');

    // The realistic shape: the exit arrives while `start()` is still waiting for `ready`, and then
    // `start()` rejects for the same reason.
    h.client.die();
    pending.reject('sidecar exited before "ready" (code=1 signal=null)');
    expect(await started).toBe(false);

    expect(h.supervisor.status.deaths).toBe(1);
    expect(h.supervisor.state).toBe('backoff');
    expect(h.supervisor.status.reason).toBe('start-failed');
    // One restart scheduled, not one per report of the same death.
    expect(h.clock.pending).toBe(1);
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

/**
 * #77. Each of these left capture dead until the app was relaunched, and each needs an exit or a
 * failure to arrive at a moment the settle-immediately fake could not produce. The real client's
 * ready timeout is the common shape: it calls `void this.stop()` and *then* rejects, so the
 * supervisor handles the failure first and the timed-out process's `expected` exit after it.
 */
describe('SidecarSupervisor: exits and failures that arrive out of step (#77)', () => {
  const READY_TIMEOUT = 'sidecar did not send "ready" within 5000ms';

  it('keeps the restart scheduled when the timed-out process exits after its start failed (LR-02)', async () => {
    const h = harness({ backoffMs: [500, 2_000, 5_000] });
    const pending = h.client.holdNextStart();
    const started = h.supervisor.start();

    pending.reject(READY_TIMEOUT);
    expect(await started).toBe(false);
    expect(h.supervisor.state).toBe('backoff');

    h.client.exitExpected();

    // Not `stopped/manual`: that state has no alert and no timer, and at launch - mode `idle` -
    // nothing ever calls `ensureRunning` to leave it.
    expect(h.supervisor.state).toBe('backoff');
    expect(h.supervisor.status.reason).toBe('start-failed');
    expect(h.supervisor.status.deaths).toBe(1);
    await h.clock.advance(500);
    expect(h.client.starts).toBe(2);
    expect(h.supervisor.state).toBe('running');
  });

  it('does not let that same exit erase a give-up either (LR-02)', async () => {
    const h = harness({ maxRestarts: 0 });
    const pending = h.client.holdNextStart();
    const started = h.supervisor.start();

    pending.reject(READY_TIMEOUT);
    await started;
    expect(h.supervisor.state).toBe('gave-up');

    h.client.exitExpected();

    // Overwritten to `stopped`, the give-up lost its alert *and* became recoverable by any mode
    // change - the quota defeated by an exit event.
    expect(h.supervisor.state).toBe('gave-up');
    h.supervisor.ensureRunning();
    await flush();
    expect(h.client.starts).toBe(1);
  });

  it('an explicit retry during a backoff starts one now instead of stranding it (LR-01)', async () => {
    const h = harness({ backoffMs: [5_000] });
    await h.supervisor.start();
    h.client.die();
    expect(h.supervisor.state).toBe('backoff');

    h.supervisor.retry();
    await flush();

    expect(h.client.starts).toBe(2);
    expect(h.supervisor.state).toBe('running');
    expect(h.supervisor.status.deaths).toBe(0);
    // The cancelled timer must not come back as a second start.
    await h.clock.advance(60_000);
    expect(h.client.starts).toBe(2);
  });

  it('a retry while the timed-out process is still going away waits for it, uncharged (LR-01)', async () => {
    const h = harness({ backoffMs: [500] });
    const pending = h.client.holdNextStart();
    const started = h.supervisor.start();
    pending.reject(READY_TIMEOUT);
    await started;
    expect(h.supervisor.state).toBe('backoff');

    // Restart pressed before the client has finished stopping the process that timed out. Handing
    // this to `ensureRunning` would decline - the client still holds a process - and land in a
    // `stopped` with no timer and no alert; starting straight away is refused "already running"
    // and charged as a death that never happened.
    h.supervisor.retry();
    await h.clock.advance(1_000);

    expect(h.client.starts).toBe(1);
    expect(h.supervisor.state).toBe('backoff');
    expect(h.supervisor.status.reason).toBe('manual');
    expect(h.supervisor.status.deaths).toBe(0);

    h.client.exitExpected();
    await h.clock.advance(100);
    expect(h.client.starts).toBe(2);
    expect(h.supervisor.state).toBe('running');
    expect(h.supervisor.status.deaths).toBe(0);
  });

  it('an explicit retry cannot stack a second start on one still in flight', async () => {
    const h = harness();
    const pending = h.client.holdNextStart();
    const started = h.supervisor.start();

    h.supervisor.retry();
    await flush();
    expect(h.client.starts).toBe(1);

    pending.resolve();
    expect(await started).toBe(true);
    expect(h.supervisor.state).toBe('running');
    expect(h.client.starts).toBe(1);
  });

  it('a start in flight at dispose that then fails does not bring supervision back (LR-07)', async () => {
    const h = harness();
    const pending = h.client.holdNextStart();
    const started = h.supervisor.start();

    h.supervisor.dispose();
    // What the shutdown's own `sidecar.stop()` does to a sidecar that has not said `ready` yet.
    h.client.exitExpected();
    pending.reject('sidecar exited before "ready" (code=0 signal=null)');
    await started;

    expect(h.supervisor.state).toBe('disposed');
    expect(h.clock.pending).toBe(0);
    await h.clock.advance(60_000);
    expect(h.client.starts).toBe(1);
  });
});

/**
 * #77 follow-up. With LR-02 fixed the restart after a ready timeout really fires - 500ms after the
 * rejection, while the client is still inside its own `stop()` of the timed-out process (up to 2s
 * for stdin close, 2s more after the kill). Started into that, it was refused "already running"
 * and charged, so a slow-but-healthy sidecar walked to `gave-up` on failures of our own making.
 */
describe('SidecarSupervisor: a restart due while the client is still stopping the last process (#77)', () => {
  const READY_TIMEOUT = 'sidecar did not send "ready" within 5000ms';

  /** A first start that timed out on `ready`, leaving the client holding the process. */
  async function timedOut(h: ReturnType<typeof harness>): Promise<void> {
    const pending = h.client.holdNextStart();
    const started = h.supervisor.start();
    pending.reject(READY_TIMEOUT);
    await started;
    expect(h.supervisor.state).toBe('backoff');
    expect(h.supervisor.status.deaths).toBe(1);
  }

  it('waits for the old process to go, then starts - without charging a death for the wait', async () => {
    const h = harness({ backoffMs: [500, 2_000, 5_000] });
    await timedOut(h);

    await h.clock.advance(500);
    // Due, but not started: still `backoff`, so the alert keeps saying the app is restarting.
    expect(h.client.starts).toBe(1);
    expect(h.supervisor.state).toBe('backoff');
    expect(h.supervisor.status.deaths).toBe(1);

    await h.clock.advance(1_500);
    h.client.exitExpected();
    await h.clock.advance(100);

    expect(h.client.starts).toBe(2);
    expect(h.supervisor.state).toBe('running');
    expect(h.supervisor.status.deaths).toBe(1);
  });

  /**
   * Why the wait is on `pid` and not `isRunning`. `ChildProcess.killed` flips the moment the kill is
   * sent, so `isRunning` is already false while the client still holds the process and `start()`
   * still refuses. A 2000ms backoff lands exactly there: the client's 2000ms kill timer was created
   * a moment before it and fires first.
   */
  it('waits for the process to be gone, not merely for its kill to have been sent', async () => {
    const h = harness({ backoffMs: [500] });
    await timedOut(h);
    h.client.sendKill();
    expect(h.client.isRunning).toBe(false);

    await h.clock.advance(500);
    expect(h.client.starts).toBe(1);
    expect(h.supervisor.status.deaths).toBe(1);

    h.client.exitExpected();
    await h.clock.advance(100);
    expect(h.client.starts).toBe(2);
    expect(h.supervisor.state).toBe('running');
  });

  it('gives up waiting after TEARDOWN_WAIT_MS, and a start refused then is charged like any failure', async () => {
    const h = harness({ backoffMs: [500, 2_000, 5_000] });
    await timedOut(h);

    await h.clock.advance(500 + TEARDOWN_WAIT_MS - 100);
    expect(h.client.starts).toBe(1);

    // A process that outlived its kill: the client never lets go. Waiting longer would be a hang.
    await h.clock.advance(100);
    await flush();
    expect(h.client.starts).toBe(2);
    expect(h.supervisor.status.deaths).toBe(2);
    expect(h.supervisor.state).toBe('backoff');
    expect(h.supervisor.status.detail).toContain('already running');
  });

  it('re-checks the pause gate when the wait ends, not only when the restart fell due', async () => {
    let paused = false;
    const h = harness({ wantsSidecar: () => !paused });
    await timedOut(h);
    await h.clock.advance(500);

    paused = true;
    h.client.exitExpected();
    await h.clock.advance(100);

    expect(h.client.starts).toBe(1);
    expect(h.supervisor.state).toBe('stopped');
    expect(h.supervisor.status.reason).toBe('not-wanted');
  });

  it('abandons the wait on dispose', async () => {
    const h = harness();
    await timedOut(h);
    await h.clock.advance(500);

    h.supervisor.dispose();
    h.client.exitExpected();
    await h.clock.advance(60_000);

    expect(h.client.starts).toBe(1);
    expect(h.supervisor.state).toBe('disposed');
    expect(h.clock.pending).toBe(0);
  });

  it('a retry out of gave-up that has to wait says backoff while it does, with a time', async () => {
    const h = harness({ maxRestarts: 0 });
    const pending = h.client.holdNextStart();
    const started = h.supervisor.start();
    pending.reject(READY_TIMEOUT);
    await started;
    expect(h.supervisor.state).toBe('gave-up');

    h.supervisor.retry();

    // `gave-up` would tell the user nothing more is going to happen; something is.
    const announced = h.statuses.at(-1);
    expect(announced?.state).toBe('backoff');
    expect(announced?.retryAtMs).toBe(h.clock.now() + TEARDOWN_WAIT_MS);
    expect(h.client.starts).toBe(1);

    h.client.exitExpected();
    await h.clock.advance(100);
    expect(h.client.starts).toBe(2);
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
