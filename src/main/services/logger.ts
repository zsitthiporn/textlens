/// <reference path="./pino-roll.d.ts" />

/**
 * Application logging (issue M10-03, features L1 + PR3).
 *
 * Three things this module exists to prevent, all of them mistakes the reference
 * project actually shipped:
 *
 *   1. **It does not touch `console.*`.** The reference overrode the global console,
 *      which meant every `console.log` anywhere in the process appended to a file that
 *      nothing ever rotated. Here the console is left alone and a real logger is passed
 *      to the things that need one.
 *   2. **The file rotates and the archives are capped.** Bounded disk use, so a long
 *      session cannot fill the user's drive.
 *   3. **The default level cannot leak what is on the user's screen.** Screen text has
 *      exactly one sanctioned way into the log - {@link Logger.sensitive} - and that
 *      method drops its payload unless the effective level is `debug`. This is a
 *      property of the API, not a rule people have to remember: grep the codebase for
 *      `.sensitive(` and you have enumerated every place OCR text can reach disk.
 *
 * **Why pino + pino-roll and not winston.** Both were measured on this machine against a
 * burst of log lines written in one tick, which is what a frame arriving produces:
 *
 *   - winston's File transport with `maxsize` wrote **zero bytes** - it rotated into
 *     empty files and lost every line. Silent total data loss is the worst possible
 *     failure for the thing you reach for when something else has gone wrong.
 *   - `winston-daily-rotate-file` kept the data but ignored `maxFiles` under the same
 *     burst, leaving 28 files where 3 were asked for - which is the unbounded growth
 *     this issue exists to fix.
 *   - `pino-roll` never lost a line, and honoured the count limit. Under an extreme
 *     burst it defers the roll to the next tick rather than dropping data, so a file
 *     can briefly exceed the cap; disk use stays bounded at `(count + 1)` files.
 *
 * pino-roll is used as a plain destination stream, not as a `pino.transport()` target,
 * so there is no worker thread and nothing that has to be resolvable from inside an
 * asar archive at runtime.
 *
 * Deliberately Electron-free. `userData` is resolved by the caller (`src/main/index.ts`)
 * and handed in as a plain path, which is what lets this module be unit tested in a
 * plain Node process.
 */

import { Writable } from 'node:stream';

import pino from 'pino';
import roll from 'pino-roll';

/** The four levels this app uses. A subset of pino's, on purpose. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Structured fields attached to a log line. Metrics, ids, counts - never screen text. */
export type LogFields = Record<string, unknown>;

/**
 * What the rest of the app depends on. Services take this interface rather than the
 * concrete logger so they can be tested with a recording stub, and so that swapping the
 * backend never reaches past this file.
 */
export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;

  /**
   * The **only** sanctioned route for user screen content (OCR output, translations)
   * into the log.
   *
   * When the effective level is not `debug` this returns without handing `text` to any
   * transport at all - the string never reaches a formatter, a buffer or a file. When it
   * is `debug`, the text is logged, and the user has been warned in settings that debug
   * logging captures screen content (PR3).
   */
  sensitive(message: string, text: string, fields?: LogFields): void;

  /** True when `sensitive` will actually write. Use it to skip expensive assembly. */
  readonly isDebugEnabled: boolean;

  /** The level actually in effect, after config and env have been reconciled. */
  readonly level: LogLevel;

  /** A logger that tags every line with `scope`. Cheap; make one per service. */
  child(scope: string): Logger;
}

/** A logger with a lifecycle. Only `src/main/index.ts` should hold one of these. */
export interface RootLogger extends Logger {
  /** Directory the log files live in. */
  readonly directory: string;
  /** The file being appended to right now. Changes name on every roll. */
  readonly currentFile: string;
  /** Flush and close. Resolves once the bytes are with the OS. */
  close(): Promise<void>;
}

export interface LoggerOptions {
  /** Directory for log files. Created if absent. In the app this is `userData/logs`. */
  readonly directory: string;
  /** Level from config. Overridden by `LOG_LEVEL` in `env` when that is valid. */
  readonly level?: LogLevel;
  /** Defaults to `process.env`. Injected so tests do not mutate the real environment. */
  readonly env?: Record<string, string | undefined>;
  /** Base file name; roll numbers are inserted before the extension. */
  readonly filename?: string;
  /** Roll the active file once it passes this many bytes. */
  readonly maxSizeBytes?: number;
  /** How many rotated files to keep beside the active one. */
  readonly maxFiles?: number;
  /** Mirror to stdout as well. Useful under `npm run dev`, noise in production. */
  readonly console?: boolean;
}

const DEFAULT_FILENAME = 'textlens.log';
const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/**
 * Reconcile the configured level with `LOG_LEVEL`.
 *
 * The env var wins: it is documented in `.env.example` as the developer's override, and
 * an override that config could beat is not an override. An unparseable value is a
 * misconfiguration, so it is reported rather than silently ignored (invariant 4) - the
 * caller decides where the complaint goes, because at this point there is no logger yet.
 */
export function resolveLogLevel(
  env: Record<string, string | undefined>,
  configured: LogLevel = DEFAULT_LOG_LEVEL,
): { level: LogLevel; warning?: string } {
  const raw = env['LOG_LEVEL'];
  if (raw === undefined || raw.trim() === '') return { level: configured };

  const candidate = raw.trim().toLowerCase();
  if (isLogLevel(candidate)) return { level: candidate };

  return {
    level: configured,
    warning: `LOG_LEVEL="${raw}" is not one of ${LOG_LEVELS.join(' | ')}; using "${configured}"`,
  };
}

/** Adapter from this app's `(message, fields)` shape onto pino's `(fields, message)`. */
class PinoLogger implements Logger {
  constructor(
    protected readonly inner: pino.Logger,
    readonly level: LogLevel,
  ) {}

  get isDebugEnabled(): boolean {
    return this.level === 'debug';
  }

  error(message: string, fields?: LogFields): void {
    this.inner.error(fields ?? {}, message);
  }

  warn(message: string, fields?: LogFields): void {
    this.inner.warn(fields ?? {}, message);
  }

  info(message: string, fields?: LogFields): void {
    this.inner.info(fields ?? {}, message);
  }

  debug(message: string, fields?: LogFields): void {
    this.inner.debug(fields ?? {}, message);
  }

  sensitive(message: string, text: string, fields?: LogFields): void {
    // The early return is the whole privacy guarantee. Do not "simplify" this into
    // `this.debug(message, { ...fields, text })` and let the level filter handle it:
    // that hands the text to pino's serializers and to every destination in the
    // multistream, each of which does its own level check. This way the string is never
    // passed to the logging library at all (PR3).
    if (!this.isDebugEnabled) return;
    this.inner.debug({ ...fields, text }, message);
  }

  child(scope: string): Logger {
    const parent = this.inner.bindings()['scope'];
    const nested = typeof parent === 'string' ? `${parent}.${scope}` : scope;
    return new PinoLogger(this.inner.child({ scope: nested }), this.level);
  }
}

class PinoRootLogger extends PinoLogger implements RootLogger {
  #closed = false;

  constructor(
    inner: pino.Logger,
    level: LogLevel,
    readonly directory: string,
    private readonly stream: {
      end(): void;
      on(event: 'close', listener: () => void): unknown;
      readonly file: string | null;
    },
  ) {
    super(inner, level);
  }

  get currentFile(): string {
    return this.stream.file ?? '';
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await new Promise<void>((resolve) => {
      this.stream.on('close', () => {
        resolve();
      });
      this.stream.end();
    });
  }
}

/**
 * Build the application logger.
 *
 * Async because the rotating destination has to look at the directory before it can
 * know which roll number it is resuming from. Called exactly once, at startup.
 *
 * Writes are buffered and flushed off the calling stack, so `logger.info(...)` queues
 * bytes and returns. That matters because the main process also runs the Node half of
 * the capture loop, and the budget in design doc section 4 has no room for a synchronous
 * write to disk in the middle of a frame.
 */
export async function createLogger(options: LoggerOptions): Promise<RootLogger> {
  const env = options.env ?? process.env;
  const { level, warning } = resolveLogLevel(env, options.level);

  const filename = options.filename ?? DEFAULT_FILENAME;
  const extensionAt = filename.lastIndexOf('.');
  const base = extensionAt > 0 ? filename.slice(0, extensionAt) : filename;
  const extension = extensionAt > 0 ? filename.slice(extensionAt) : '.log';

  const fileStream = await roll({
    file: `${options.directory.replace(/[\\/]+$/, '')}/${base}`,
    extension,
    // The `b` suffix is load-bearing: pino-roll reads a bare number as megabytes.
    size: `${String(options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES)}b`,
    limit: { count: options.maxFiles ?? DEFAULT_MAX_FILES },
    mkdir: true,
  });

  // The destination opens its file asynchronously, and until it has, it cannot say
  // which file that is. Wait here rather than hand back a logger that cannot answer
  // "where are the logs" - which is the first question anyone asks it.
  if (fileStream.file === null) {
    await new Promise<void>((resolve, reject) => {
      fileStream.once('ready', resolve);
      fileStream.once('error', reject);
    });
  }

  const destinations: pino.StreamEntry[] = [{ level, stream: fileStream as unknown as NodeJS.WritableStream }];
  if (options.console ?? true) destinations.push({ level, stream: humanReadableConsole() });

  const inner = pino(
    {
      level,
      // No pid, no hostname: neither tells us anything about a single-user desktop app,
      // and the machine name is the user's, not ours.
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(destinations, { levels: pino.levels.values }),
  );

  const root = new PinoRootLogger(inner, level, options.directory, fileStream);
  if (warning !== undefined) root.warn(warning, { source: 'LOG_LEVEL' });

  return root;
}

/**
 * Reformats pino's JSON into something readable in a dev terminal. Falls back to the
 * raw line if anything about it surprises us - the console is the last place that should
 * throw while trying to report a problem.
 */
function humanReadableConsole(): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const line = chunk.toString('utf8').trimEnd();
      try {
        const { level, time, msg, scope, ...rest } = JSON.parse(line) as Record<string, unknown>;
        const label = pino.levels.labels[Number(level)] ?? String(level);
        const clock = typeof time === 'string' ? time.slice(11, 23) : '';
        const where = typeof scope === 'string' ? ` [${scope}]` : '';
        const fields = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
        process.stdout.write(`${clock} ${label.toUpperCase().padEnd(5)}${where} ${String(msg)}${fields}\n`);
      } catch {
        process.stdout.write(`${line}\n`);
      }
      callback();
    },
  });
}

/**
 * A logger that discards everything. For tests, and for the code paths that must run
 * before the real logger exists.
 */
export function nullLogger(): Logger {
  const logger: Logger = {
    error() {},
    warn() {},
    info() {},
    debug() {},
    sensitive() {},
    isDebugEnabled: false,
    level: 'info',
    child: () => logger,
  };
  return logger;
}
