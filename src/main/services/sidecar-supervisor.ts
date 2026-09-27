/**
 * Sidecar supervision (issue M10-01 / #40, design doc section 7).
 *
 * `sidecar-client.ts` deliberately stops at "the process died". This is the thing that decides
 * what to do about it: restart with backoff, give up when restarting is clearly not working, and
 * kill a sidecar that is alive but has stopped saying anything.
 *
 * ## Why this is not a wrapper around `SidecarClient`
 *
 * It supervises **one** client instance and never replaces it. `SidecarClient.start` only refuses
 * while `#child !== null`, and the exit handler, a failed spawn and `stop()` all null that field -
 * so the same object can be started again, and every subscription taken out against it (the mode
 * machine's, the frame handler's in `index.ts`) survives a restart untouched. A supervisor that
 * constructed a fresh client per restart would have to re-broadcast the whole event surface, and
 * the day it missed one the app would come back up looking healthy with nothing reaching the
 * pipeline.
 *
 * ## A watchdog that restarts too eagerly is worse than no watchdog
 *
 * Three separate brakes, because the failure mode of this file is a restart storm that pins a
 * core and buries the log:
 *
 *   1. **Backoff.** Each successive death inside the window waits longer. The first wait is short
 *      on purpose - #40's criterion is that an externally killed sidecar is back inside 5s.
 *   2. **A quota over a rolling window.** {@link SidecarSupervisorOptions.maxRestarts} deaths in
 *      {@link SidecarSupervisorOptions.windowMs} are tolerated; the next one stops the machine and
 *      reports. The window is rolling rather than a counter with a reset timer, which is what
 *      makes "survived 60 seconds, so the count resets" fall out with no extra state.
 *   3. **A `wantsSidecar` gate.** A paused app has deliberately stopped capturing, and #40 is
 *      explicit that a sidecar dying while paused must not be restarted until the user returns to
 *      auto. Entering auto calls {@link SidecarSupervisor.ensureRunning}, which is also the
 *      deliberate-retry path out of `gave-up`.
 *
 * The watchdog itself only counts silence while somebody is *expecting* events. A stopped capture
 * loop is silent by design, and a watchdog that could not tell the two apart would kill a healthy
 * paused sidecar every N seconds forever.
 *
 * ## No `electron` import, and no real timers
 *
 * Clock and timers are injected, so the whole state machine - every backoff interval, the quota
 * window, the watchdog threshold - is testable without waiting out a single one of them.
 */

import type { ReadyEvent } from '../../shared/protocol.js';
import { nullLogger, type Logger } from './logger.js';
import type { SidecarClientEvents, SidecarExit } from './sidecar-client.js';

/**
 * The part of `SidecarClient` this supervises.
 *
 * Structural, like every other dependency in `services/`, so these tests need neither Electron nor
 * a real child process. The event payload types come from `SidecarClientEvents` rather than being
 * restated, so a change to the wire shape fails this file at compile time.
 */
export interface SupervisedSidecar {
  start(): Promise<ReadyEvent>;
  stop(): Promise<void>;
  on<K extends 'exit' | 'frame' | 'nochange'>(
    event: K,
    listener: (payload: SidecarClientEvents[K]) => void,
  ): () => void;
  readonly isRunning: boolean;
  /**
   * Defined while the client still holds a process - including one it is in the middle of
   * stopping. Outside a start in flight, `start()` refuses exactly while this is defined.
   *
   * **Not the same question as {@link isRunning}**, which turns false the moment a kill is *sent*
   * (`ChildProcess.killed`), while the process - and the client's hold on it - lasts until its
   * `exit` arrives. Measured on Node 24: `killed=true exitCode=null` straight after `kill()`, the
   * exit later. A restart that waited on `isRunning` would start into that gap and be refused.
   */
  readonly pid: number | undefined;
}

export type SupervisorState =
  /** Nothing is running and nothing is scheduled. The resting state before the first start. */
  | 'stopped'
  /** A start is in flight. */
  | 'starting'
  /** The sidecar is up and has sent `ready`. */
  | 'running'
  /** It died, a restart is scheduled, and {@link SupervisorStatus.retryAtMs} says when. */
  | 'backoff'
  /** The quota is spent. Nothing further happens without {@link SidecarSupervisor.retry}. */
  | 'gave-up'
  /** {@link SidecarSupervisor.dispose} was called; the app is shutting down. */
  | 'disposed';

/** Why the supervisor is in the state it is in. Rendered by the error surface (#41). */
export type SupervisorReason =
  | 'initial'
  /** The process exited on its own. */
  | 'crash'
  /** The process was alive but sent no events for longer than the watchdog allows. */
  | 'watchdog'
  /** `start()` itself failed - a missing executable, a spawn error, no `ready` in time. */
  | 'start-failed'
  /** Died while the app did not want a sidecar (paused). Waiting for auto. */
  | 'not-wanted'
  /** The user, or a mode change, asked for one deliberately. */
  | 'manual';

export interface SupervisorStatus {
  readonly state: SupervisorState;
  readonly reason: SupervisorReason;
  /** Deaths inside the rolling window. Also the index into the backoff schedule. */
  readonly deaths: number;
  /** How many more deaths the quota allows before giving up. */
  readonly remaining: number;
  /** Epoch ms of the next start attempt. Non-null only in `backoff`. */
  readonly retryAtMs: number | null;
  /** Safe, short detail - an exit code, a spawn message. Never screen text. */
  readonly detail: string | null;
}

export interface SidecarSupervisorOptions {
  readonly client: SupervisedSidecar;
  readonly logger?: Logger;
  /**
   * Re-establish the sidecar's configuration after every successful start, including the first.
   *
   * **A restart that does not do this is the worst outcome available here.** The sidecar comes
   * back, the log says it is up, and it sits there having never been told what to capture - which
   * from the outside is indistinguishable from success until somebody notices no frames arrived.
   * Wired to `AppOrchestrator.initialize`, which sends `listMonitors` + `configure` and then
   * re-applies the current mode.
   */
  readonly onStarted?: (ready: ReadyEvent) => void | Promise<void>;
  /**
   * Whether the app wants a sidecar at all right now.
   *
   * `false` while paused (#40: "pause อยู่แล้ว sidecar ตาย → ไม่ restart จนกว่าจะกลับเข้า auto").
   * Consulted at the moment of death, not when the restart fires, because that is when the user's
   * intent is unambiguous.
   */
  readonly wantsSidecar?: () => boolean;
  /**
   * Whether the capture loop is supposed to be producing `frame`/`nochange` right now.
   *
   * The watchdog's arming condition. False while paused, in `snapshot`, and before the first
   * `configure` lands - all states in which silence is the correct behaviour.
   */
  readonly expectsEvents?: () => boolean;
  /** Deaths tolerated inside {@link windowMs}. The next one gives up. #40 asks for 3. */
  readonly maxRestarts?: number;
  readonly windowMs?: number;
  /**
   * Wait before each restart, indexed by how many deaths are already in the window.
   *
   * The first entry is short because #40 measures it: an externally killed sidecar must be back
   * inside 5 seconds, and the spawn plus a `ready` handshake plus `listMonitors` and `configure`
   * all have to fit in what is left. The later entries grow because a sidecar that has already
   * died twice is not going to be fixed by trying harder.
   */
  readonly backoffMs?: readonly number[];
  /**
   * How long the capture loop may say nothing before the watchdog treats it as hung.
   *
   * A function, not a number, because the honest threshold depends on the poll interval the user
   * configured - and that can change under a running sidecar. Returning a value that is not
   * comfortably larger than `intervalIdle` turns this from a safety net into a periodic killer of
   * a healthy process.
   */
  readonly watchdogSilenceMs?: () => number;
  /** Injected clock. Defaults to `Date.now`. */
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_BACKOFF_MS = [500, 2_000, 5_000] as const;

/**
 * The floor under the watchdog threshold, and the reason it exists.
 *
 * A user who sets `intervalIdle` to something tiny would otherwise get a threshold shorter than
 * one OCR pass, and the watchdog would start killing a sidecar that is merely busy. Ten seconds is
 * longer than any single tick this app is designed to produce.
 */
export const MIN_WATCHDOG_SILENCE_MS = 10_000;

/**
 * How long a due restart waits for the client to let go of a process it is still stopping (#77).
 *
 * After a ready timeout the client keeps the timed-out process through its own `stop()`: up to
 * `shutdownTimeoutMs` for a clean exit and the same again after the kill - 4s at the defaults,
 * counted from the rejection. The first restart falls due 500ms after that, so 5s covers the whole
 * teardown with room to spare. Past it the start goes ahead, and a refusal then is a real failure
 * (a process that outlived its kill) and is charged like one.
 */
export const TEARDOWN_WAIT_MS = 5_000;

/** How often that wait looks again. A timer, never a reaction to `exit` - see `#startWhenClear`. */
const TEARDOWN_POLL_MS = 100;

export class SidecarSupervisor {
  readonly #client: SupervisedSidecar;
  readonly #log: Logger;
  readonly #onStarted: ((ready: ReadyEvent) => void | Promise<void>) | null;
  readonly #wantsSidecar: () => boolean;
  readonly #expectsEvents: () => boolean;
  readonly #maxRestarts: number;
  readonly #windowMs: number;
  readonly #backoffMs: readonly number[];
  readonly #watchdogSilenceMs: () => number;
  readonly #now: () => number;
  readonly #setTimer: (callback: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;

  readonly #unsubscribes: Array<() => void> = [];
  readonly #listeners = new Set<(status: SupervisorStatus) => void>();

  #state: SupervisorState = 'stopped';
  #reason: SupervisorReason = 'initial';
  #detail: string | null = null;
  /** Epoch ms of every unexpected death still inside the rolling window. */
  #deaths: number[] = [];
  #retryAtMs: number | null = null;
  #restartTimer: unknown = null;
  #watchdogTimer: unknown = null;
  /** When an event last arrived, or when the loop was last known to be alive. */
  #lastEventAtMs = 0;
  /** True while {@link #restartNow} owns the client, so a re-entrant start cannot overlap it. */
  #starting = false;
  /** Set by the watchdog so the resulting expected exit is still counted as a failure. */
  #killedByWatchdog = false;

  constructor(options: SidecarSupervisorOptions) {
    this.#client = options.client;
    this.#log = (options.logger ?? nullLogger()).child('supervisor');
    this.#onStarted = options.onStarted ?? null;
    this.#wantsSidecar = options.wantsSidecar ?? ((): boolean => true);
    this.#expectsEvents = options.expectsEvents ?? ((): boolean => false);
    this.#maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.#watchdogSilenceMs = options.watchdogSilenceMs ?? ((): number => MIN_WATCHDOG_SILENCE_MS);
    this.#now = options.now ?? Date.now;
    this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

    this.#unsubscribes.push(
      this.#client.on('exit', (exit) => {
        this.#onExit(exit);
      }),
      // Both event kinds, deliberately. `nochange` is the only positive evidence that the loop is
      // alive and finding nothing - a watchdog fed by `frame` alone would kill a sidecar that is
      // working perfectly and pointed at a still screen.
      this.#client.on('frame', () => {
        this.#markAlive();
      }),
      this.#client.on('nochange', () => {
        this.#markAlive();
      }),
    );
  }

  get state(): SupervisorState {
    return this.#state;
  }

  get status(): SupervisorStatus {
    return {
      state: this.#state,
      reason: this.#reason,
      deaths: this.#deaths.length,
      remaining: Math.max(0, this.#maxRestarts - this.#deaths.length),
      retryAtMs: this.#retryAtMs,
      detail: this.#detail,
    };
  }

  /** Subscribe to state changes. Returns an unsubscribe, matching every other service here. */
  subscribe(listener: (status: SupervisorStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * The first start.
   *
   * Resolves with `true` when the sidecar came up. A failure is **not** thrown: it is recorded as
   * a death like any other, so a machine where the executable is momentarily unavailable gets the
   * same backoff and the same quota as one where it crashes - which is what #40 means by moving
   * "sidecar failed to start" out of `index.ts` and into supervision.
   */
  async start(): Promise<boolean> {
    if (this.#state === 'disposed') return false;
    return await this.#startOnce('initial');
  }

  /**
   * Start a sidecar because the app now wants one, if nothing is already happening.
   *
   * Called when the user returns to auto after a death that the `wantsSidecar` gate declined to
   * restart, and by {@link retry}. A no-op while one is running, starting, or already scheduled -
   * a mode change must not be able to stack restarts.
   */
  ensureRunning(): void {
    if (this.#state === 'disposed') return;
    // **`gave-up` is deliberately not recoverable from here**, and that is the difference between
    // a give-up point and a pause. This is called from a status subscription, so any mode change
    // at all would otherwise restart a sidecar the supervisor has just concluded cannot be fixed
    // by restarting - the exact restart storm the quota exists to stop, arrived at by accident.
    // {@link retry} is the way out, and it is a thing the user does on purpose.
    if (this.#state === 'gave-up') return;
    if (this.#state === 'running' || this.#state === 'starting' || this.#state === 'backoff') return;
    if (this.#client.isRunning) return;

    this.#log.info('starting the sidecar on request', { from: this.#state });
    void this.#startOnce('manual');
  }

  /**
   * The deliberate retry out of `gave-up` (#41: "บอกให้ดู log และวิธี restart"), and out of a
   * `backoff` the user does not want to wait for - the tray and settings offer it in every state.
   *
   * Clears the quota, because the user asking again is new information: the automatic path gave up
   * on the evidence that restarting was not working, and a human who has just fixed something has
   * evidence the automatic path cannot see.
   */
  retry(): void {
    if (this.#state === 'disposed') return;
    this.#log.info('restart quota cleared by an explicit retry', { from: this.#state, deaths: this.#deaths.length });
    this.#deaths = [];
    this.#cancelRestart();
    // #77 LR-01. From `backoff` and `gave-up` this starts one itself rather than handing over to
    // `ensureRunning`, for two reasons:
    //
    //   - `ensureRunning` declines `backoff` by design. Having just cancelled the one timer that
    //     would have left `backoff`, handing over to it stranded the machine there with nothing
    //     scheduled - and the tray kept saying "retrying in about Ns" for the rest of the session.
    //   - it also declines while the client still holds a process, and after a ready timeout the
    //     client is still tearing the timed-out one down. Declining there would land in `stopped`
    //     with no timer and no alert. This waits for that process instead (`#startWhenClear`), and
    //     says so as a `backoff` - `gave-up` would claim nothing further is going to happen.
    //
    // Not gated on `wantsSidecar`: this is the user asking, as it always was out of `gave-up`.
    if (this.#state === 'backoff' || this.#state === 'gave-up') {
      const deadlineMs = this.#now() + TEARDOWN_WAIT_MS;
      const pid = this.#client.pid;
      if (pid !== undefined) {
        this.#log.info('retry requested while the previous sidecar is still being stopped; waiting for it', {
          pid,
          upToMs: TEARDOWN_WAIT_MS,
        });
        // Before `#set`, which is when the error surface reads it.
        this.#retryAtMs = deadlineMs;
        this.#set('backoff', 'manual', this.#detail);
      }
      this.#startWhenClear('manual', false, deadlineMs);
      return;
    }
    this.ensureRunning();
  }

  /**
   * Stop supervising. Does **not** stop the client - `index.ts` owns that, and does it after this,
   * so a graceful shutdown cannot be mistaken for a crash and restarted out from under itself.
   */
  dispose(): void {
    if (this.#state === 'disposed') return;
    this.#cancelRestart();
    this.#stopWatchdog();
    for (const off of this.#unsubscribes) off();
    this.#unsubscribes.length = 0;
    this.#set('disposed', this.#reason, this.#detail);
    this.#listeners.clear();
  }

  // -------------------------------------------------------------------------

  async #startOnce(reason: SupervisorReason): Promise<boolean> {
    if (this.#starting) return false;
    this.#starting = true;
    this.#cancelRestart();
    this.#set('starting', reason, this.#detail);

    let ready: ReadyEvent;
    try {
      ready = await this.#client.start();
    } catch (error) {
      this.#starting = false;
      const detail = error instanceof Error ? error.message : String(error);
      this.#log.error('the sidecar could not be started', { reason, detail });
      this.#recordFailure('start-failed', detail);
      return false;
    }
    this.#starting = false;

    if (this.#state === 'disposed') return true;

    this.#markAlive();
    this.#set('running', reason, null);
    this.#startWatchdog();
    this.#log.info('sidecar supervised', {
      reason,
      version: ready.version,
      deathsInWindow: this.#deaths.length,
    });

    if (this.#onStarted !== null) {
      try {
        await this.#onStarted(ready);
      } catch (error) {
        // Reported, not fatal, and deliberately not a restart trigger: a configure that failed is
        // the mode machine's problem to report (it already does), and restarting the process would
        // not change the answer.
        this.#log.error('re-establishing the sidecar configuration after a start failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // The handshake and the configure round trip are silence the watchdog must not count.
    this.#markAlive();
    return true;
  }

  /**
   * A process went away.
   *
   * `expected` covers both a real shutdown and a watchdog kill, and the two must not be treated
   * alike - {@link #killedByWatchdog} is how they are told apart, because `stop()` is the only
   * exit that releases the sidecar's own resources cleanly and the watchdog uses it too.
   */
  #onExit(exit: SidecarExit): void {
    if (this.#state === 'disposed') return;
    this.#stopWatchdog();

    // Read and cleared before the guard below, so an exit that is ignored cannot leave the flag
    // set for some later, unrelated exit to be misread by.
    const killed = this.#killedByWatchdog;
    this.#killedByWatchdog = false;

    // #77 LR-02. Only the death of a **running** sidecar is news; in every other state the process
    // going away has already been accounted for, and acting on it again is how failures were
    // either double-charged or erased.
    //
    //   - `starting`: a process that dies during `start()` is one failure that arrives twice - this
    //     event, and then `SidecarClient.#awaitReady` rejecting with "exited before ready". Measured
    //     on a real run: killing the sidecar in its startup window charged two of three restarts
    //     and gave up one death early. The start path reports it, because it is the one that knows
    //     the attempt is over.
    //   - `backoff` / `gave-up` / `stopped`: the only live process in these states is the one the
    //     client is tearing down after a ready timeout. It sets `#stopping` before rejecting, so
    //     this exit arrives `expected` - and used to overwrite the `backoff` (or the `gave-up`) the
    //     failed start had just recorded with `stopped/manual`: no alert, no timer, capture gone
    //     for the session. At launch nothing ever calls `ensureRunning`, so it never came back.
    //
    // The watchdog is unaffected: it only kills from `running`, and nothing leaves `running`
    // between its `stop()` and the exit that follows.
    if (this.#state !== 'running') {
      const fields = { state: this.#state, code: exit.code, signal: exit.signal, expected: exit.expected };
      if (this.#state === 'starting') this.#log.warn('the sidecar died before it finished starting', fields);
      else this.#log.info('a sidecar exit arrived after its failure was already handled; ignoring it', fields);
      return;
    }

    if (exit.expected && !killed) {
      this.#log.info('sidecar exited as asked; not restarting', { code: exit.code });
      this.#set('stopped', 'manual', null);
      return;
    }

    const detail = `exited code=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'}`;
    this.#recordFailure(killed ? 'watchdog' : 'crash', detail);
  }

  /**
   * Count one failure and decide what happens next: nothing, a scheduled restart, or giving up.
   *
   * The `wantsSidecar` gate is checked **before** the quota, so a paused app that loses its
   * sidecar spends none of it - the death is real but the restart was never wanted, and charging
   * for it would leave the user with a reduced quota for a decision they made on purpose.
   */
  #recordFailure(reason: SupervisorReason, detail: string): void {
    // #77 LR-07. A start still in flight at `dispose()` fails once the shutdown stops its process,
    // and recording that failure used to walk the supervisor from `disposed` back into `backoff`
    // and spawn a fresh sidecar in the middle of the quit. This was the one way out of `disposed`:
    // every public entry checks for it, and the restart timer only acts from `backoff`.
    if (this.#state === 'disposed') {
      this.#log.info('a failure arrived after supervision was disposed; not restarting', { reason, detail });
      return;
    }

    if (!this.#wantsSidecar()) {
      this.#log.warn('the sidecar is gone, but nothing wants one right now; not restarting', {
        reason,
        detail,
      });
      this.#set('stopped', 'not-wanted', detail);
      return;
    }

    const now = this.#now();
    this.#deaths = [...this.#deaths.filter((at) => now - at < this.#windowMs), now];

    if (this.#deaths.length > this.#maxRestarts) {
      // The give-up point. Everything above this line is recoverable; this is the one state the
      // app cannot leave on its own, which is exactly why it has to be visible (#41).
      this.#log.error(
        'the capture sidecar has failed too many times in a row; giving up until it is retried',
        { reason, detail, deaths: this.#deaths.length, windowMs: this.#windowMs },
      );
      // Any restart already scheduled is abandoned, not merely ignored when it fires. A give-up
      // that leaves a live timer behind is a give-up that depends on a state check somewhere else
      // staying correct.
      this.#cancelRestart();
      this.#set('gave-up', reason, detail);
      return;
    }

    const waitMs = this.#backoffFor(this.#deaths.length);
    this.#retryAtMs = now + waitMs;
    this.#log.warn('the capture sidecar died; restarting after a backoff', {
      reason,
      detail,
      attempt: this.#deaths.length,
      of: this.#maxRestarts,
      waitMs,
    });
    this.#set('backoff', reason, detail);

    this.#restartTimer = this.#setTimer(() => {
      this.#restartTimer = null;
      this.#retryAtMs = null;
      if (!this.#restartStillWanted(true)) return;
      const pid = this.#client.pid;
      if (pid !== undefined) {
        this.#log.info('restart due, but the previous sidecar is still being stopped; waiting for it', {
          pid,
          upToMs: TEARDOWN_WAIT_MS,
        });
      }
      this.#startWhenClear(reason, true, this.#now() + TEARDOWN_WAIT_MS);
    }, waitMs);
  }

  /**
   * Whether a restart that has just come due should still happen, asked at the moment it would.
   *
   * `gated` is the automatic path: the user may have paused during the wait, and spawning a process
   * they have just asked to stop is the same mistake in slow motion. An explicit retry is not gated,
   * as it never was. Both drop out of anything but `backoff` - a dispose, or a retry that has
   * already taken over.
   */
  #restartStillWanted(gated: boolean): boolean {
    if (this.#state !== 'backoff') return false;
    if (gated && !this.#wantsSidecar()) {
      this.#set('stopped', 'not-wanted', this.#detail);
      return false;
    }
    return true;
  }

  /**
   * Start one as soon as the client has let go of the previous process, or at `deadlineMs`,
   * whichever is first (#77).
   *
   * Without this, a restart that fell due while the client was still stopping a process that timed
   * out on `ready` was refused with "already running" and **charged as a death** - so a slow but
   * healthy sidecar could walk to `gave-up` on failures that were only ever our own teardown.
   *
   * Polled on a timer, never started from inside the `exit` event. The client's own exit handler
   * runs first and lets go of the child, but `stop()` - still awaiting that same exit - then clears
   * `#child` and the recording in the microtasks that follow, and would clear a *new* child that a
   * start inside the event had just put there. A timer callback only runs after those have.
   */
  #startWhenClear(reason: SupervisorReason, gated: boolean, deadlineMs: number): void {
    const pid = this.#client.pid;
    if (pid !== undefined) {
      if (this.#now() < deadlineMs) {
        this.#retryAtMs = deadlineMs;
        this.#restartTimer = this.#setTimer(() => {
          this.#restartTimer = null;
          this.#retryAtMs = null;
          if (!this.#restartStillWanted(gated)) return;
          this.#startWhenClear(reason, gated, deadlineMs);
        }, TEARDOWN_POLL_MS);
        return;
      }
      this.#log.warn('the previous sidecar is still held after waiting for it; starting anyway', {
        pid,
        waitedMs: TEARDOWN_WAIT_MS,
      });
    }
    void this.#startOnce(reason);
  }

  /** The wait for the nth death in the window, clamped to the last entry for anything beyond. */
  #backoffFor(deaths: number): number {
    if (this.#backoffMs.length === 0) return 0;
    const index = Math.min(Math.max(deaths, 1), this.#backoffMs.length) - 1;
    return this.#backoffMs[index] ?? 0;
  }

  #cancelRestart(): void {
    if (this.#restartTimer !== null) {
      this.#clearTimer(this.#restartTimer);
      this.#restartTimer = null;
    }
    this.#retryAtMs = null;
  }

  // -------------------------------------------------------------------------
  // Watchdog
  // -------------------------------------------------------------------------

  #markAlive(): void {
    this.#lastEventAtMs = this.#now();
  }

  /**
   * A repeating check rather than a timer re-armed on every event.
   *
   * Two reasons, and the second is the load-bearing one. Re-arming per event would put a
   * `clearTimeout`/`setTimeout` pair on the frame path, which is in the latency budget; and a
   * sidecar that hangs *before* sending anything at all would never have armed a timer in the
   * first place, so the hang this exists to catch is precisely the one it would miss.
   */
  #startWatchdog(): void {
    this.#stopWatchdog();
    const silenceMs = Math.max(MIN_WATCHDOG_SILENCE_MS, this.#watchdogSilenceMs());
    // Half the threshold, so the worst-case detection delay is 1.5x rather than 2x it.
    const tickMs = Math.max(1_000, Math.round(silenceMs / 2));
    this.#watchdogTimer = this.#setTimer(() => {
      this.#watchdogTimer = null;
      this.#onWatchdogTick();
    }, tickMs);
  }

  #stopWatchdog(): void {
    if (this.#watchdogTimer === null) return;
    this.#clearTimer(this.#watchdogTimer);
    this.#watchdogTimer = null;
  }

  #onWatchdogTick(): void {
    if (this.#state !== 'running') return;

    // Not "expecting events" means silence is correct - a paused loop, a snapshot being held, a
    // configure that has not landed. The clock is pushed forward rather than merely skipped, so
    // that resuming does not immediately trip on time the app spent deliberately stopped.
    if (!this.#expectsEvents()) {
      this.#markAlive();
      this.#startWatchdog();
      return;
    }

    const silenceMs = Math.max(MIN_WATCHDOG_SILENCE_MS, this.#watchdogSilenceMs());
    const silentFor = this.#now() - this.#lastEventAtMs;
    if (silentFor < silenceMs) {
      this.#startWatchdog();
      return;
    }

    this.#log.error('the capture sidecar has stopped producing events; killing it so it restarts', {
      silentForMs: silentFor,
      thresholdMs: silenceMs,
    });
    this.#killedByWatchdog = true;
    // Through `stop()`, not a kill: closing stdin is the only exit that releases the sidecar's own
    // WGC and OCR resources cleanly, and `stop()` escalates to a kill by itself for a process that
    // has stopped reading. The resulting exit is `expected`, which `#onExit` corrects for.
    void this.#client.stop().catch((error: unknown) => {
      this.#log.warn('stopping a hung sidecar threw', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // -------------------------------------------------------------------------

  #set(state: SupervisorState, reason: SupervisorReason, detail: string | null): void {
    const changed = this.#state !== state || this.#reason !== reason || this.#detail !== detail;
    this.#state = state;
    this.#reason = reason;
    this.#detail = detail;
    if (!changed) return;

    const status = this.status;
    for (const listener of [...this.#listeners]) {
      try {
        listener(status);
      } catch (error) {
        this.#log.error('a supervisor status listener threw', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
