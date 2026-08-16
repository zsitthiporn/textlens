/**
 * The translation seam (issue M4-01, feature T1).
 *
 * The plan is Google now and LM Studio / Ollama later, and those have completely different
 * API shapes - one is a GET-ish form post that answers with a bare JSON array, the other is a
 * chat completion that has to be prompted into behaving. The seam exists from day one so that
 * adding the second one is a new file plus a registration line rather than a rewrite of the
 * pipeline.
 *
 * ## Two rules that the rest of this directory is built around
 *
 * **1. An engine reports failure by throwing, never by returning something plausible.**
 * The stage above this one hands us N text blocks and pins each result to the block it came
 * from *by index*. An engine that returns 4 results for 5 inputs and is believed does not
 * produce an error - it produces confident, well-formed, completely wrong subtitles from the
 * gap onward, with nothing in the log. So there is no `null` in a result array, no empty
 * string standing in for "could not do it", and no partial batch. Either the whole batch came
 * back intact or the engine throws and the chain moves on.
 *
 * **2. Errors carry a machine-readable {@link TranslationErrorKind}, not a parseable message.**
 * `rate-limiter.ts` has to tell a 429 from a dropped connection to pick the right backoff, and
 * a rate limiter that decides that by matching a regex against an error string is one upstream
 * copy edit away from silently treating every 429 as a network blip.
 *
 * ## Error messages are a privacy surface
 *
 * Failures are logged by the chain at `warn`/`error`, which is the default level. `logger.ts`
 * exists because M10-03 established that default-level logs must not contain what is on the
 * user's screen, and a translation request body is screen text while a response body is screen
 * text already translated. So **no message, `detail`, or field constructed in this directory
 * may contain input text or response content** - only counts, status codes, engine names and
 * shape descriptions ("expected 5 elements, got 1"). Anything richer goes through
 * `logger.sensitive()` at the call site, or does not go anywhere.
 */

/**
 * How a translation attempt failed. The rate limiter switches on this; the chain logs it.
 *
 * - `rate-limit` - the service told us to slow down (HTTP 429). The long backoff.
 * - `network`    - transport failed, timed out, or answered 5xx. The short backoff.
 * - `protocol`   - we reached the service and could not believe the answer: unparseable body,
 *                  or the wrong number of results. Short backoff, because an engine answering
 *                  in a shape we do not understand will keep doing so and should not be hammered.
 * - `unavailable`- we did not even try: this engine is inside its backoff window. Costs no
 *                  time and no quota, and exists so the chain can fall past a sick engine
 *                  immediately rather than waiting on it (subtitles cannot wait).
 */
export type TranslationErrorKind = 'rate-limit' | 'network' | 'protocol' | 'unavailable';

/**
 * A translation failure with the kind attached.
 *
 * `status` is the HTTP status when there was one. It is a separate field rather than something
 * to read out of the message for the reason in the module comment.
 */
export class TranslationError extends Error {
  readonly kind: TranslationErrorKind;
  readonly status?: number;
  /** Which engine failed. Filled in by the engine itself; engine names are not screen text. */
  readonly engine?: string;

  constructor(
    message: string,
    options: { kind: TranslationErrorKind; status?: number; engine?: string; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TranslationError';
    this.kind = options.kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.engine !== undefined) this.engine = options.engine;
  }
}

/**
 * Classify an unknown thrown value.
 *
 * Anything that is not one of ours is treated as `network`: the overwhelmingly common case is
 * `fetch` rejecting, and the short backoff is the forgiving choice. Guessing wrong here costs
 * a slightly wrong retry delay, which is much cheaper than the alternative of letting an
 * unrecognised error escape and take the whole frame down.
 */
export function classifyError(error: unknown): TranslationErrorKind {
  return error instanceof TranslationError ? error.kind : 'network';
}

/**
 * A short, safe description of a failure for logs.
 *
 * Deliberately narrow: our own errors have messages we wrote and know to be text-free, and
 * everything else is reduced to its constructor name. A stray `TypeError` from deep inside a
 * transport can carry a URL or a body fragment in its message, and this is the choke point
 * that keeps it out of the log.
 */
export function describeError(error: unknown): string {
  if (error instanceof TranslationError) return error.message;
  if (error instanceof Error) return error.name;
  return typeof error;
}

export interface HealthCheckResult {
  readonly ok: boolean;
  /** Human-readable reason. Subject to the no-screen-text rule in the module comment. */
  readonly detail?: string;
}

/**
 * What every translation backend implements.
 *
 * Pinned by issue M4-01; do not widen it casually. `texts` is a mutable `string[]` because
 * that is the signature the issue specifies - callers in this directory hand engines a
 * defensive copy rather than relying on the engine not to write to it.
 */
export interface TranslationEngine {
  readonly name: string;
  /**
   * Translate every string, returning exactly as many results in exactly the same order.
   *
   * Implementations MUST throw rather than return a short, long, or padded array. See rule 1
   * in the module comment for what accepting one actually looks like on screen.
   */
  translateBatch(texts: string[], src: string, tgt: string): Promise<string[]>;
  healthCheck(): Promise<HealthCheckResult>;
}

/**
 * The subset of a `fetch` response this directory uses.
 *
 * Structural rather than the DOM/undici `Response` on purpose: it is what lets the same
 * adapter run against `globalThis.fetch` in tests and Electron's `net.fetch` in the app -
 * see {@link HttpFetch}.
 */
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface HttpRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/**
 * The HTTP transport, injected rather than imported.
 *
 * M4-02 asks for Electron's network stack so the app honours the system proxy; this brief
 * requires every module here to be importable without Electron (they are unit tested in a
 * plain Node process, and importing `electron` outside a running Electron app throws). Both
 * are satisfied by taking the transport as a parameter: the default is the built-in `fetch`,
 * and `src/main/index.ts` passes `net.fetch` when it wires the pipeline up. Nothing in this
 * directory ever names Electron.
 */
export type HttpFetch = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

/** The built-in `fetch`, narrowed to {@link HttpFetch}. */
export const defaultFetch: HttpFetch = (url, init) => fetch(url, init as RequestInit);
