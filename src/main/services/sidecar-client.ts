/**
 * The Node half of the sidecar conversation (issue M1-04, design doc section 3).
 *
 * Owns exactly three things: the child process, the framing of the JSON-lines stream,
 * and a typed fan-out of decoded events. It owns no business logic, knows nothing about
 * regions or translation, and - per CLAUDE.md invariant 3 - converts no coordinates.
 *
 * Two failure modes here are silent by nature and are what most of this file is about:
 *
 *   - **A line split across chunk boundaries.** `stdout` is a byte stream, not a message
 *     stream; nothing guarantees a `data` event ends on a `\n`. Decoding per chunk
 *     produces JSON parse errors that look like a broken sidecar, and decoding with
 *     `chunk.toString()` per chunk *also* corrupts any multi-byte character that
 *     straddles the boundary - Thai text is three bytes per character, so this is not
 *     hypothetical. {@link LineDecoder} accumulates raw bytes and only ever decodes
 *     complete lines.
 *   - **An orphaned child.** The sidecar blocks on stdin, so closing our end of the pipe
 *     is its shutdown signal; that is also what makes it die when this process is killed
 *     outright. `stop()` uses that path first and only escalates to a kill if the process
 *     does not go away.
 *
 * Out of scope, deliberately: watchdog and restart-with-backoff (issue M10-01). This
 * client reports that the process died; it does not decide what to do about it.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  decodeEvent,
  encodeCommand,
  type AckEvent,
  type ErrorEvent,
  type FrameEvent,
  type NochangeEvent,
  type ReadyEvent,
  type SidecarCommand,
} from '../../shared/protocol.js';
import { nullLogger, type Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/** 32 MiB. Larger than any plausible `debugFrame` PNG, small enough to not be a leak. */
const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;

export interface LineDecoderOptions {
  /**
   * Hard cap on one line. A sidecar that never emits a newline would otherwise grow
   * this buffer until the process dies of memory exhaustion - a silent failure with a
   * misleading cause.
   */
  readonly maxLineBytes?: number;
  /** Called when the cap is hit and bytes are discarded, so the caller can complain. */
  readonly onOverflow?: (droppedBytes: number) => void;
}

/**
 * Turns a byte stream into complete UTF-8 lines.
 *
 * Buffers `Buffer`s and never `Buffer#toString`s a partial line, so a multi-byte
 * character split across two chunks survives. `\r\n` and `\n` both terminate a line;
 * blank lines are dropped rather than handed on as empty messages.
 */
export class LineDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  /** True while discarding the tail of a line that blew the size cap. */
  #resyncing = false;

  readonly #maxLineBytes: number;
  readonly #onOverflow: ((droppedBytes: number) => void) | undefined;

  constructor(options: LineDecoderOptions = {}) {
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.#onOverflow = options.onOverflow;
  }

  /** Bytes held back waiting for a terminator. Exposed for tests and diagnostics. */
  get pendingBytes(): number {
    return this.#buffer.length;
  }

  /** Feed one chunk; get back every line it completed, in order. */
  push(chunk: Buffer): string[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);

    const lines: string[] = [];
    for (;;) {
      const index = this.#buffer.indexOf(NEWLINE);

      if (index === -1) {
        if (this.#resyncing) {
          // Still inside the oversized line - throw the whole chunk away.
          this.#buffer = Buffer.alloc(0);
        } else if (this.#buffer.length > this.#maxLineBytes) {
          this.#onOverflow?.(this.#buffer.length);
          this.#buffer = Buffer.alloc(0);
          this.#resyncing = true;
        }
        return lines;
      }

      const raw = this.#buffer.subarray(0, index);
      this.#buffer = this.#buffer.subarray(index + 1);

      if (this.#resyncing) {
        // That newline ended the line we were discarding. Resume normally.
        this.#resyncing = false;
        continue;
      }

      const line = decodeLine(raw);
      if (line.length > 0) lines.push(line);
    }
  }

  /**
   * Take whatever is left when the stream ends.
   *
   * A sidecar that exits after writing its last message without a trailing newline
   * still said something, and dropping it would turn a real event into a silence.
   */
  flush(): string[] {
    if (this.#resyncing || this.#buffer.length === 0) {
      this.#buffer = Buffer.alloc(0);
      return [];
    }
    const line = decodeLine(this.#buffer);
    this.#buffer = Buffer.alloc(0);
    return line.length > 0 ? [line] : [];
  }
}

function decodeLine(raw: Buffer): string {
  const end = raw.length > 0 && raw[raw.length - 1] === CARRIAGE_RETURN ? raw.length - 1 : raw.length;
  return raw.subarray(0, end).toString('utf8');
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export const SIDECAR_EXECUTABLE = 'Textlens.Capture.exe';

/** Target framework of the sidecar's debug build; see CLAUDE.md. Dev fallback only. */
export const SIDECAR_DEV_TFM = 'net10.0-windows10.0.19041.0';

export const SIDECAR_PATH_ENV = 'TEXTLENS_SIDECAR_PATH';

export interface SidecarPathInputs {
  /** Usually `process.env`. Injected so tests need not mutate the real environment. */
  readonly env: Record<string, string | undefined>;
  /** `app.isPackaged`. */
  readonly isPackaged: boolean;
  /** `process.resourcesPath` - where the packaged app's unpacked payload lives. */
  readonly resourcesPath: string;
  /** `app.getAppPath()` - the repo root in development. */
  readonly appPath: string;
}

export type SidecarPathSource = 'env-override' | 'packaged' | 'dev-build';

export interface ResolvedSidecarPath {
  readonly exePath: string;
  readonly source: SidecarPathSource;
}

/**
 * Decide which executable to run. Pure: it does not touch the filesystem, so it is the
 * policy and `SidecarClient.start` is the enforcement.
 *
 * `TEXTLENS_SIDECAR_PATH` wins even in a packaged build. An override that the packaged
 * build ignores is an override that fails at exactly the moment someone is trying to
 * diagnose a packaged build; the caller logs loudly instead (see `source`).
 */
export function resolveSidecarPath(inputs: SidecarPathInputs): ResolvedSidecarPath {
  const override = inputs.env[SIDECAR_PATH_ENV];
  if (override !== undefined && override.trim() !== '') {
    return { exePath: path.resolve(override.trim()), source: 'env-override' };
  }

  if (inputs.isPackaged) {
    return { exePath: path.join(inputs.resourcesPath, 'sidecar', SIDECAR_EXECUTABLE), source: 'packaged' };
  }

  return {
    exePath: path.join(
      inputs.appPath,
      'sidecar',
      'Textlens.Capture',
      'bin',
      'Debug',
      SIDECAR_DEV_TFM,
      SIDECAR_EXECUTABLE,
    ),
    source: 'dev-build',
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface SidecarExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** True when we asked it to stop. False means it died on its own - M10-01's problem. */
  readonly expected: boolean;
}

/**
 * Everything a caller can subscribe to.
 *
 * The four protocol events keep their wire names. `exit` and `spawnError` are lifecycle,
 * not protocol, and are named so they cannot be confused with the sidecar's own `error`
 * event - which reports a failure *inside* a running sidecar, not a failure to have one.
 */
export interface SidecarClientEvents {
  ready: ReadyEvent;
  frame: FrameEvent;
  nochange: NochangeEvent;
  ack: AckEvent;
  error: ErrorEvent;
  exit: SidecarExit;
  spawnError: Error;
}

export type SidecarClientEventName = keyof SidecarClientEvents;

type Listener<K extends SidecarClientEventName> = (payload: SidecarClientEvents[K]) => void;

export type SpawnFn = typeof nodeSpawn;

export interface SidecarClientOptions {
  readonly exePath: string;
  readonly args?: readonly string[];
  readonly logger?: Logger;
  /** Ms to wait for `ready` before declaring the spawn a failure. AC: 5 seconds. */
  readonly readyTimeoutMs?: number;
  /** Ms to wait for a clean exit after closing stdin, before killing. */
  readonly shutdownTimeoutMs?: number;
  readonly cwd?: string;
  readonly maxLineBytes?: number;
  /** Injection seam for tests. Defaults to `child_process.spawn`. */
  readonly spawn?: SpawnFn;
  /**
   * Absolute path to a JSON-lines file. When set, every raw line read from the
   * sidecar's stdout is appended verbatim - `{"atMs": <int>, "line": "<raw wire line>"}`,
   * one per line, `atMs` relative to the first recorded line - before that line is
   * decoded. Undecodable lines are recorded too, so a session that reproduces a real
   * bug is captured exactly as the sidecar sent it, not as this build understood it.
   *
   * Off unless a caller sets it (issue M3-06, design doc section 8). This is the record
   * half of record/replay: it exists to build fixtures for the fake sidecar, not
   * something the shipped app turns on for itself. `atMs` is an integer for the same
   * reason the protocol's `timings` are integer microseconds - two languages format
   * decimals differently, and a fixture that has to survive a byte-for-byte replay
   * cannot depend on that.
   */
  readonly recordTo?: string;
}

const DEFAULT_READY_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

export class SidecarClient {
  readonly #options: SidecarClientOptions;
  readonly #log: Logger;
  readonly #spawn: SpawnFn;

  #child: ChildProcess | null = null;
  #ready: ReadyEvent | null = null;
  #stopping = false;
  #listeners = new Map<SidecarClientEventName, Set<(payload: never) => void>>();

  #recordStream: fs.WriteStream | null = null;
  #recordStartMs: number | null = null;

  constructor(options: SidecarClientOptions) {
    this.#options = options;
    this.#log = (options.logger ?? nullLogger()).child('sidecar');
    this.#spawn = options.spawn ?? nodeSpawn;
  }

  get isRunning(): boolean {
    return this.#child !== null && this.#child.exitCode === null && !this.#child.killed;
  }

  /** The `ready` payload from the current process, or null before it arrives. */
  get ready(): ReadyEvent | null {
    return this.#ready;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /**
   * Subscribe. Returns an unsubscribe function - handing one back is cheaper than
   * making every caller keep the exact function reference around to pass to `off`.
   */
  on<K extends SidecarClientEventName>(event: K, listener: Listener<K>): () => void {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    const erased = listener as (payload: never) => void;
    set.add(erased);
    return () => {
      set.delete(erased);
    };
  }

  once<K extends SidecarClientEventName>(event: K, listener: Listener<K>): () => void {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  /**
   * Spawn the sidecar and resolve with its `ready` event.
   *
   * Rejects - loudly, with the path in the message - if the executable is missing, if
   * the spawn fails, if the process dies before announcing itself, or if `ready` does
   * not arrive inside the timeout. Design doc section 7: "sidecar cannot start" is a
   * reported condition, never a hang.
   */
  async start(): Promise<ReadyEvent> {
    if (this.#child !== null) throw new Error('SidecarClient.start called while a sidecar is already running');

    const { exePath } = this.#options;
    if (!fs.existsSync(exePath)) {
      throw new Error(
        `sidecar executable not found at ${exePath}. ` +
          `Build it with \`dotnet build sidecar/Textlens.sln\`, or point ${SIDECAR_PATH_ENV} at one.`,
      );
    }

    this.#stopping = false;
    this.#ready = null;
    this.#openRecording();

    const child = this.#spawn(exePath, [...(this.#options.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // A console subsystem exe launched from a GUI process flashes a console window.
      windowsHide: true,
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
    });
    this.#child = child;

    this.#attachStdout(child);
    this.#attachStderr(child);
    this.#attachLifecycle(child);

    this.#log.info('sidecar spawned', { exePath, pid: child.pid });

    return await this.#awaitReady();
  }

  /**
   * Send one command. Returns false when there was nowhere to send it, having said so
   * in the log - a dropped command must not look like a command the sidecar ignored.
   */
  send(command: SidecarCommand): boolean {
    const stdin = this.#child?.stdin;
    if (!this.isRunning || stdin === null || stdin === undefined || stdin.destroyed) {
      this.#log.error('dropped a command: no running sidecar', { cmd: command.cmd });
      return false;
    }

    const line = `${encodeCommand(command)}\n`;
    const flushed = stdin.write(line, (error) => {
      if (error) this.#log.error('failed to write a command to sidecar stdin', { cmd: command.cmd, message: error.message });
    });
    this.#log.debug('command sent', { cmd: command.cmd, bytes: line.length, flushed });
    return true;
  }

  /**
   * Shut the sidecar down and resolve once it is gone.
   *
   * Closes stdin first: the sidecar's read loop ends on EOF and it exits 0, which is
   * the only exit that leaves its own resources released. The kill is the fallback for
   * a sidecar that has stopped reading, not the normal path.
   */
  async stop(): Promise<void> {
    const child = this.#child;
    if (child === null) return;

    this.#stopping = true;

    if (child.exitCode !== null || child.signalCode !== null) {
      this.#child = null;
      await this.#closeRecording();
      return;
    }

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
    });

    try {
      child.stdin?.end();
    } catch (error) {
      this.#log.warn('closing sidecar stdin threw', { message: describeError(error) });
    }

    const timeoutMs = this.#options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const clean = await raceWithTimeout(exited, timeoutMs);

    if (!clean) {
      this.#log.warn('sidecar did not exit after stdin close; killing', { pid: child.pid, timeoutMs });
      child.kill();
      const killed = await raceWithTimeout(exited, timeoutMs);
      if (!killed) this.#log.error('sidecar survived kill()', { pid: child.pid });
    }

    this.#child = null;
    this.#ready = null;
    await this.#closeRecording();
  }

  // -------------------------------------------------------------------------

  /**
   * Open the record-hook file, if one was configured. Errors surface through the
   * stream's own `error` event rather than throwing here - a bad `recordTo` path must
   * not stop the sidecar from starting (invariant 4: reported, never silently fatal,
   * but also never a reason to refuse the thing the caller actually asked for).
   */
  #openRecording(): void {
    const target = this.#options.recordTo;
    if (target === undefined) return;

    this.#recordStartMs = null;
    const stream = fs.createWriteStream(target, { flags: 'a' });
    stream.on('error', (error) => {
      this.#log.error('sidecar session recording failed', { recordTo: target, message: error.message });
    });
    this.#recordStream = stream;
  }

  /** Append one raw wire line, verbatim, with its ms offset from the first recorded line. */
  #record(line: string): void {
    const stream = this.#recordStream;
    if (stream === null) return;

    const now = performance.now();
    if (this.#recordStartMs === null) this.#recordStartMs = now;
    const atMs = Math.round(now - this.#recordStartMs);

    stream.write(`${JSON.stringify({ atMs, line })}\n`);
  }

  /** Flush and close the record-hook file, if one is open. Safe to call more than once. */
  async #closeRecording(): Promise<void> {
    const stream = this.#recordStream;
    this.#recordStream = null;
    this.#recordStartMs = null;
    if (stream === null) return;

    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }

  #attachStdout(child: ChildProcess): void {
    const decoder = new LineDecoder({
      ...(this.#options.maxLineBytes === undefined ? {} : { maxLineBytes: this.#options.maxLineBytes }),
      onOverflow: (droppedBytes) => {
        this.#log.error('discarded an oversized line from sidecar stdout', { droppedBytes });
      },
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) {
        this.#record(line);
        this.#handleLine(line);
      }
    });

    child.stdout?.on('end', () => {
      for (const line of decoder.flush()) {
        this.#record(line);
        this.#handleLine(line);
      }
    });

    child.stdout?.on('error', (error: Error) => {
      this.#log.error('sidecar stdout failed', { message: error.message });
    });
  }

  /**
   * stderr is diagnostics, never protocol. It gets its own scope so a grep for one
   * stream never drags in the other (AC: "stderr is logged separately from stdout").
   */
  #attachStderr(child: ChildProcess): void {
    const log = this.#log.child('stderr');
    const decoder = new LineDecoder();

    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of decoder.push(chunk)) log.warn(line, { stream: 'stderr' });
    });
    child.stderr?.on('end', () => {
      for (const line of decoder.flush()) log.warn(line, { stream: 'stderr' });
    });
  }

  #attachLifecycle(child: ChildProcess): void {
    child.on('error', (error: Error) => {
      this.#log.error('sidecar process error', { message: error.message });
      this.#emit('spawnError', error);
    });

    child.stdin?.on('error', (error: Error) => {
      // EPIPE here means the sidecar closed its end. Expected during shutdown, a real
      // problem otherwise - either way it is reported, not swallowed.
      this.#log.warn('sidecar stdin errored', { message: error.message, stopping: this.#stopping });
    });

    child.once('exit', (code, signal) => {
      const expected = this.#stopping;
      this.#ready = null;
      if (this.#child === child) this.#child = null;

      const fields = { code, signal, expected, pid: child.pid };
      if (expected) this.#log.info('sidecar exited', fields);
      else this.#log.error('sidecar exited unexpectedly', fields);

      // Safety net for the crash path: `stop()` also closes the recording, but a
      // sidecar that dies on its own never goes through `stop()` at all, and an open
      // recording stream on a process nobody is watching is exactly the kind of thing
      // that goes unnoticed until the fixture it should have produced is missing.
      void this.#closeRecording();

      this.#emit('exit', { code, signal, expected });
    });
  }

  async #awaitReady(): Promise<ReadyEvent> {
    const timeoutMs = this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

    return await new Promise<ReadyEvent>((resolve, reject) => {
      const cleanups: Array<() => void> = [];
      const finish = (): void => {
        clearTimeout(timer);
        for (const cleanup of cleanups) cleanup();
      };

      const timer = setTimeout(() => {
        finish();
        void this.stop();
        reject(new Error(`sidecar did not send "ready" within ${timeoutMs}ms`));
      }, timeoutMs);
      // Do not let a pending ready check keep the process alive on its own.
      timer.unref?.();

      cleanups.push(
        this.once('ready', (event) => {
          finish();
          resolve(event);
        }),
        this.once('spawnError', (error) => {
          finish();
          reject(error);
        }),
        this.once('exit', ({ code, signal }) => {
          finish();
          reject(new Error(`sidecar exited before "ready" (code=${code ?? 'null'} signal=${signal ?? 'null'})`));
        }),
      );
    });
  }

  #handleLine(line: string): void {
    const result = decodeEvent(line);

    if (!result.ok) {
      // Neither the raw line nor the decoder's detail is safe at this level: a
      // malformed `frame` carries OCR text, and V8's JSON parse errors quote their
      // input. Counts and a reason code are enough to know something is wrong; the
      // payload itself is debug-gated (PR3).
      this.#log.warn('dropped an undecodable line from sidecar stdout', {
        reason: result.reason,
        bytes: Buffer.byteLength(line, 'utf8'),
      });
      this.#log.sensitive('undecodable sidecar line', line, { reason: result.reason, detail: result.detail });
      return;
    }

    const event = result.value;
    switch (event.ev) {
      case 'ready':
        this.#ready = event;
        this.#log.info('sidecar ready', { version: event.version, ocrLanguages: event.ocrLanguages });
        this.#emit('ready', event);
        return;
      case 'frame':
        this.#log.debug('frame', { seq: event.seq, lines: event.lines.length, timings: event.timings });
        this.#log.sensitive('frame text', event.lines.map((l) => l.text).join(' | '), { seq: event.seq });
        this.#emit('frame', event);
        return;
      case 'nochange':
        this.#emit('nochange', event);
        return;
      case 'ack':
        this.#log.debug('sidecar ack', { cmd: event.cmd, state: event.state });
        this.#emit('ack', event);
        return;
      case 'error':
        this.#log.error('sidecar reported an error', { code: event.code, message: event.message });
        this.#emit('error', event);
        return;
      default: {
        // Exhaustiveness guard. `ack` was added to the protocol by M2-06 long after this
        // switch was written, and until this guard existed it decoded fine and then fell
        // straight through - no emit, no log, `listMonitors` replies unreachable. A silent
        // drop is exactly what invariant 4 forbids, so the next event kind added to the
        // contract must fail the typecheck here rather than disappear at runtime.
        const unhandled: never = event;
        this.#log.warn('decoded an event kind this client does not handle', {
          ev: (unhandled as { ev?: unknown }).ev,
        });
        return;
      }
    }
  }

  #emit<K extends SidecarClientEventName>(event: K, payload: SidecarClientEvents[K]): void {
    const set = this.#listeners.get(event);
    if (set === undefined) return;
    // Copy first: a listener is allowed to unsubscribe itself while we iterate.
    for (const listener of [...set]) {
      try {
        (listener as unknown as Listener<K>)(payload);
      } catch (error) {
        // One bad subscriber must not stop the stream reader (invariant 4: loud, not fatal).
        this.#log.error('a sidecar event listener threw', { event, message: describeError(error) });
      }
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function raceWithTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, ms);
    timer.unref?.();
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
