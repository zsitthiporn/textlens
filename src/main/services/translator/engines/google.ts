/**
 * Google Translate via the free endpoint (issue M4-02, features T2 + T7).
 *
 * The permanent primary engine: measured warm round trips of 139-176ms sit comfortably inside
 * the 300-500ms translate row of the design doc section 4 budget, and nothing else on the
 * shortlist is close.
 *
 * The endpoint is undocumented, so everything below was established by calling it (2026-08-16,
 * six requests total). The two findings that shaped this file:
 *
 * ## 1. The obvious batching endpoint silently drops inputs
 *
 * `translate_a/single?client=gtx&dt=t` with a repeated `q` parameter - the form most examples
 * use - answers **HTTP 200 with a translation of the first string only**. Five inputs, one
 * result, no error, no warning. Believed and zipped positionally, that is four text blocks
 * captioned with a neighbour's translation.
 *
 * `translate_a/t?client=dict-chrome-ex` is used instead: it honours a repeated `q` and answers
 * with a flat JSON array of one string per input, in order. Verified at n=1, 2, 3 and 5; the
 * shape does not change with the count, which is the other classic trap.
 *
 * **Do not "simplify" this back to `translate_a/single`.** The length guard in `index.ts` would
 * catch the resulting mismatch and fail over, so the symptom would be "Google mysteriously
 * never works", not a crash.
 *
 * ## 2. POST, not GET
 *
 * The same endpoint accepts a form-encoded POST body (verified, 147ms, identical shape). GET
 * would put every subtitle on screen into a URL, and a batch of long lines can outgrow what is
 * safe to put in one. POST also keeps screen text out of the query string, which is the part of
 * a request most likely to end up in someone's proxy log.
 *
 * ## Failure behaviour
 *
 * Every abnormal outcome throws, none returns a plausible-looking array - see the rules in
 * `../types.ts`. The status code is on the error object so `rate-limiter.ts` can tell a 429
 * from a dead socket, and is in the message too because that is what a human reading the log
 * needs. Neither the request texts nor the response body ever appears in either.
 */

import {
  defaultFetch,
  TranslationError,
  type HealthCheckResult,
  type HttpFetch,
  type TranslationEngine,
} from '../types.js';

export const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/t';

/**
 * The client id that makes the endpoint return one result per input. See finding 1 above;
 * this string is load-bearing, not decoration.
 */
export const GOOGLE_CLIENT = 'dict-chrome-ex';

/**
 * Give up on a request after this long.
 *
 * Without a deadline a hung connection stalls the pipeline for as long as the OS allows, and
 * the user sees an overlay that simply stopped updating - indistinguishable from the silent
 * failure invariant 4 forbids. Set well above the observed p100 (~1.2s cold) and well below
 * anything a person would sit through.
 */
export const DEFAULT_TIMEOUT_MS = 5000;

/** Requests without one are answered with 403 by this endpoint. */
const DEFAULT_USER_AGENT = 'Mozilla/5.0';

export interface GoogleEngineOptions {
  /** Injected transport. Defaults to the built-in `fetch`; the app passes Electron's `net.fetch`. */
  readonly fetch?: HttpFetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

export class GoogleTranslateEngine implements TranslationEngine {
  readonly name = 'google';

  readonly #fetch: HttpFetch;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #userAgent: string;

  constructor(options: GoogleEngineOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(`timeoutMs must be a positive finite number, got ${String(timeoutMs)}`);
    }

    this.#fetch = options.fetch ?? defaultFetch;
    this.#endpoint = options.endpoint ?? GOOGLE_ENDPOINT;
    this.#timeoutMs = timeoutMs;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async translateBatch(texts: string[], src: string, tgt: string): Promise<string[]> {
    if (texts.length === 0) return [];

    // Blank entries are passed through by position rather than sent. The endpoint does not
    // return a result for an empty `q`, so sending one would come back one element short and
    // be (correctly) rejected as a mismatch - a self-inflicted failure. Holding their slots
    // here is what keeps the returned array the same length as the input.
    const sendable: { index: number; text: string }[] = [];
    for (const [index, text] of texts.entries()) {
      if (text.trim().length > 0) sendable.push({ index, text });
    }
    if (sendable.length === 0) return [...texts];

    const body = new URLSearchParams();
    for (const item of sendable) body.append('q', item.text);

    const query = new URLSearchParams({ client: GOOGLE_CLIENT, sl: src, tl: tgt });
    const raw = await this.#post(`${this.#endpoint}?${query.toString()}`, body.toString());
    const translated = parseBatchResponse(raw, sendable.length);

    const results = [...texts];
    for (const [position, item] of sendable.entries()) {
      // `translated` is known to have `sendable.length` entries; parseBatchResponse threw
      // otherwise. The fallback keeps `noUncheckedIndexedAccess` honest without an assertion.
      results[item.index] = translated[position] ?? item.text;
    }
    return results;
  }

  /**
   * Send one small real request and report what happened.
   *
   * A fixed, neutral token rather than anything from the screen: a health check may run at
   * startup or from a settings button, and neither is a moment where user content should leave
   * the machine.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const results = await this.translateBatch(['ok'], 'en', 'th');
      if (results.length !== 1 || (results[0] ?? '').length === 0) {
        return { ok: false, detail: 'endpoint answered with an unusable result' };
      }
      return { ok: true };
    } catch (error) {
      // Our own errors carry no screen text; anything else is reduced to its type.
      const detail = error instanceof TranslationError ? error.message : (error as Error).name;
      return { ok: false, detail };
    }
  }

  async #post(url: string, body: string): Promise<string> {
    let response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': this.#userAgent,
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      // A transport-level throw covers DNS failure, connection reset and our own timeout. All
      // three are "try again shortly", which is the short backoff. The original is kept as
      // `cause` for a debug-level dump; the message we construct carries nothing from it,
      // because a transport error message can quote the URL or a body fragment.
      throw new TranslationError('google: request failed or timed out', {
        kind: 'network',
        engine: this.name,
        cause: error,
      });
    }

    if (!response.ok) {
      // 429 is the one the rate limiter must be able to recognise; it gets the long backoff.
      // Everything else - 5xx, 403, anything - is treated as transient network trouble.
      throw new TranslationError(`google: HTTP ${String(response.status)}`, {
        kind: response.status === 429 ? 'rate-limit' : 'network',
        status: response.status,
        engine: this.name,
      });
    }

    try {
      return await response.text();
    } catch (error) {
      throw new TranslationError('google: could not read the response body', {
        kind: 'network',
        engine: this.name,
        cause: error,
      });
    }
  }
}

/**
 * Turn the endpoint's body into exactly `expected` strings, or throw.
 *
 * Two response shapes are accepted, because the endpoint picks between them by request:
 * a flat `["ก", "ข"]` (what an explicit `sl` produces, which is all we send) and a nested
 * `[["ก", "en"], ["ข", "en"]]` (what `sl=auto` produces). Anything else is a shape we do not
 * understand, and a shape we do not understand is never guessed at - an empty string returned
 * here becomes a blank caption under readable English, with nothing in the log.
 */
export function parseBatchResponse(raw: string, expected: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Length, not content: the body is screen text once it parses, and might be an HTML
    // block page when it does not.
    throw new TranslationError(
      `google: response was not JSON (${String(raw.length)} bytes)`,
      { kind: 'protocol', engine: 'google' },
    );
  }

  if (!Array.isArray(parsed)) {
    throw new TranslationError(`google: expected a JSON array, got ${typeName(parsed)}`, {
      kind: 'protocol',
      engine: 'google',
    });
  }

  if (parsed.length !== expected) {
    // The finding-1 failure lands here: 5 sent, 1 returned, HTTP 200.
    throw new TranslationError(
      `google: expected ${String(expected)} results, got ${String(parsed.length)}`,
      { kind: 'protocol', engine: 'google' },
    );
  }

  return parsed.map((entry, index) => {
    if (typeof entry === 'string') return entry;
    if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
    throw new TranslationError(
      `google: result ${String(index)} was ${typeName(entry)}, not a string`,
      { kind: 'protocol', engine: 'google' },
    );
  });
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}
