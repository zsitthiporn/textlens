/**
 * The fallback chain (issue M4-01, features T1 + T6).
 *
 * Try each engine in order; the first one that answers convincingly wins. This is the stage
 * between dedup (`dedup.ts`) and render, and it has one hard obligation: **it always returns
 * exactly as many strings as it was given, in the same order, no matter what went wrong.**
 * Everything downstream pins result `i` to text block `i`, so a chain that returned a short
 * array would not produce an error - it would produce well-formed subtitles attached to the
 * wrong sentences.
 *
 * ## Why total failure returns the English rather than throwing or returning nothing
 *
 * Design doc section 7 specifies "engine ล้ม → fallback chain → ล้มหมดแสดงต้นฉบับพร้อม
 * สัญญาณเตือน": show the original with a warning. Throwing or returning `[]` both end with a
 * blank overlay and no explanation, which is the exact failure the reference project shipped
 * and invariant 4 forbids. Showing the untranslated English is degraded but *honest* - the
 * user can read it, and can see that something is wrong because it is not Thai.
 *
 * That is also why {@link TranslationOutcome} is an envelope and not a bare `string[]`. A bare
 * array cannot say "these are the originals, translation is down", so the warning half of the
 * spec would have nowhere to live and the caller would have to guess by comparing input to
 * output. `degraded` is that signal, and M10-02 is its consumer.
 *
 * ## The length check is here as well as in every engine
 *
 * `google.ts` validates its own response, so on paper this check is redundant. It is not.
 * The engine interface is a public seam that adapters we have not written yet will implement
 * - T4's OpenAI-compatible adapter asks an LLM to return a JSON array, which is a far less
 * reliable promise than an HTTP API - and this is the single place that every result passes
 * through. Enforcing it here means a new adapter cannot introduce a row-shift bug into the
 * pipeline no matter how badly it behaves; the worst it can do is fail over.
 */

import type { Logger } from '../logger.js';
import { nullLogger } from '../logger.js';
import { GoogleTranslateEngine, type GoogleEngineOptions } from './engines/google.js';
import { EngineRegistry } from './registry.js';
import {
  classifyError,
  describeError,
  TranslationError,
  type TranslationEngine,
  type TranslationErrorKind,
} from './types.js';

export * from './types.js';
export * from './registry.js';
export * from './rate-limiter.js';
export { GoogleTranslateEngine, type GoogleEngineOptions } from './engines/google.js';

/** One engine's failure, reduced to fields that are safe at the default log level. */
export interface EngineFailure {
  readonly engine: string;
  readonly kind: TranslationErrorKind;
  readonly status?: number;
  /** Message text only; never input text or response content. See `types.ts`. */
  readonly detail: string;
}

export interface TranslationOutcome {
  /** Always `texts.length` entries, always in input order. Originals when `degraded`. */
  readonly texts: readonly string[];
  /** The engine that produced these, or `null` when every engine failed. */
  readonly engine: string | null;
  /** True when these are the untranslated originals. The user-visible warning hangs off this. */
  readonly degraded: boolean;
  /** Every engine that was tried and failed, in order. Empty on a first-try success. */
  readonly failures: readonly EngineFailure[];
}

export interface FallbackTranslatorOptions {
  readonly logger?: Logger;
}

/**
 * Runs a batch through engines in order until one succeeds.
 *
 * Holds no per-engine state of its own - rate limiting and backoff live in `rate-limiter.ts`,
 * wrapped around individual engines, so that one sick engine's timing cannot reach another.
 */
export class FallbackTranslator {
  readonly #engines: readonly TranslationEngine[];
  readonly #logger: Logger;

  constructor(engines: readonly TranslationEngine[], options: FallbackTranslatorOptions = {}) {
    if (engines.length === 0) {
      // A chain of nothing would return the originals for every frame forever while looking
      // like it was working. Invariant 4.
      throw new RangeError('FallbackTranslator needs at least one engine.');
    }
    this.#engines = [...engines];
    this.#logger = (options.logger ?? nullLogger()).child('translator');
  }

  /** The engine names in fallback order. For diagnostics and the settings UI. */
  get engineNames(): readonly string[] {
    return this.#engines.map((engine) => engine.name);
  }

  /**
   * Translate a batch, falling through the chain on failure.
   *
   * Never throws for a translation failure. The only things that can escape are programmer
   * errors from the caller's own arguments.
   */
  async translate(texts: readonly string[], src: string, tgt: string): Promise<TranslationOutcome> {
    // No network call for an empty batch. Not an optimisation - some endpoints answer a
    // request with no inputs with a shape that has nothing to do with the normal one.
    if (texts.length === 0) {
      return { texts: [], engine: null, degraded: false, failures: [] };
    }

    const failures: EngineFailure[] = [];

    for (const engine of this.#engines) {
      try {
        // A defensive copy per attempt: the interface hands engines a mutable `string[]`, and
        // an engine that sorted or spliced it in place would corrupt the originals we still
        // need as the degraded fallback - and would do it invisibly.
        const results = await engine.translateBatch([...texts], src, tgt);
        assertBatchShape(texts.length, results, engine.name);

        if (failures.length > 0) {
          this.#logger.warn('translated on a fallback engine', {
            engine: engine.name,
            skipped: failures.map((failure) => failure.engine),
            count: texts.length,
          });
        }

        return { texts: results, engine: engine.name, degraded: false, failures };
      } catch (error) {
        const failure: EngineFailure = {
          engine: engine.name,
          kind: classifyError(error),
          detail: describeError(error),
          ...(error instanceof TranslationError && error.status !== undefined
            ? { status: error.status }
            : {}),
        };
        failures.push(failure);

        // `unavailable` means the engine is inside its backoff window and we never called it.
        // That is an expected, already-reported condition, not a new incident, so it is logged
        // quietly - otherwise a rate-limited engine fills the log with warnings once per frame.
        const level = failure.kind === 'unavailable' ? 'debug' : 'warn';
        this.#logger[level]('translation engine failed', {
          engine: failure.engine,
          kind: failure.kind,
          ...(failure.status === undefined ? {} : { status: failure.status }),
          detail: failure.detail,
          count: texts.length,
        });
      }
    }

    // Every engine failed. Show the user what was on screen, untranslated, and say so.
    this.#logger.error('all translation engines failed; showing original text', {
      engines: failures.map((failure) => failure.engine),
      kinds: failures.map((failure) => failure.kind),
      count: texts.length,
    });

    return { texts: [...texts], engine: null, degraded: true, failures };
  }

  /** Ask every engine how it is. Runs them in parallel; never throws. */
  async healthCheck(): Promise<readonly { engine: string; ok: boolean; detail?: string }[]> {
    return Promise.all(
      this.#engines.map(async (engine) => {
        try {
          const result = await engine.healthCheck();
          return {
            engine: engine.name,
            ok: result.ok,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          };
        } catch (error) {
          return { engine: engine.name, ok: false, detail: describeError(error) };
        }
      }),
    );
  }
}

/**
 * The guard that stops a bad batch from becoming wrong subtitles.
 *
 * Both directions matter and they fail differently. **Too few** results and every block after
 * the gap gets the previous block's translation, ending with blocks that get nothing. **Too
 * many** and the surplus is either dropped silently or - if some later stage zips differently -
 * shifts everything. Neither produces an error anywhere without this check; both produce
 * fluent Thai under the wrong English.
 *
 * Non-string entries are rejected for the same reason: `undefined` rendered into an overlay is
 * a caption reading "undefined", not a visible failure.
 */
export function assertBatchShape(
  expected: number,
  results: unknown,
  engineName: string,
): asserts results is string[] {
  if (!Array.isArray(results)) {
    throw new TranslationError(`${engineName}: expected an array of ${String(expected)} results`, {
      kind: 'protocol',
      engine: engineName,
    });
  }

  if (results.length !== expected) {
    // Counts only - the results themselves are screen text.
    throw new TranslationError(
      `${engineName}: expected ${String(expected)} results, got ${String(results.length)}`,
      { kind: 'protocol', engine: engineName },
    );
  }

  for (let index = 0; index < results.length; index += 1) {
    if (typeof results[index] !== 'string') {
      throw new TranslationError(
        `${engineName}: result ${String(index)} is ${typeof results[index]}, not a string`,
        { kind: 'protocol', engine: engineName },
      );
    }
  }
}

/**
 * A registry with every built-in engine in it.
 *
 * **This is the "one registration line" from the acceptance criteria.** A new engine is a new
 * file under `engines/` and one more `.register(...)` below; nothing else in the pipeline
 * changes, because everything downstream only ever sees {@link TranslationEngine}.
 */
export function createDefaultRegistry(options: { google?: GoogleEngineOptions } = {}): EngineRegistry {
  return new EngineRegistry().register('google', () => new GoogleTranslateEngine(options.google));
}
