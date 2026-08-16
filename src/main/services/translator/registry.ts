/**
 * Engine registration by name (issue M4-01, feature T1).
 *
 * Config names engines as strings - `["google", "lmstudio"]` - and something has to turn those
 * into objects. That is all this file is, but two details in it are decisions:
 *
 * **Factories, not instances.** An engine is constructed only if config actually asks for it.
 * Registering `lmstudio` must not open a socket for a user who never selected it.
 *
 * **A chain is validated whole, before anything is built.** `createChain` checks every name
 * first and reports *all* the unknown ones in one error. Resolving lazily would mean a user
 * with two typos fixes one, restarts, and is told about the second - and worse, a bad name late
 * in the chain would surface only on the day the primary engine first failed, which is the
 * least convenient possible moment to discover the fallback was never real. Invariant 4 is
 * about failures being visible; a fallback that cannot be constructed is a failure.
 */

import type { TranslationEngine } from './types.js';

/** Builds an engine on demand. Called at most once per name per `createChain`. */
export type EngineFactory = () => TranslationEngine;

/**
 * Config named an engine that nothing registered.
 *
 * A distinct class so startup can catch exactly this and show it as a config problem with a
 * fix, rather than as a crash (design doc section 7: a broken config logs, falls back to
 * defaults, and tells the user which field did not pass).
 */
export class UnknownEngineError extends Error {
  readonly unknown: readonly string[];
  readonly known: readonly string[];

  constructor(unknown: readonly string[], known: readonly string[]) {
    const plural = unknown.length === 1 ? 'engine' : 'engines';
    // The known names are in the message because "unknown engine: googel" without them is a
    // riddle; with them it is a typo the user can see.
    super(
      `Unknown translation ${plural}: ${unknown.map((name) => `"${name}"`).join(', ')}. ` +
        `Registered engines: ${known.length === 0 ? '(none)' : known.map((name) => `"${name}"`).join(', ')}.`,
    );
    this.name = 'UnknownEngineError';
    this.unknown = unknown;
    this.known = known;
  }
}

/** Raised when config asks for a chain with nothing in it. */
export class EmptyChainError extends Error {
  constructor() {
    // Silently translating nothing would look exactly like an engine that never answers.
    super('Translation engine chain is empty; configure at least one engine.');
    this.name = 'EmptyChainError';
  }
}

/**
 * Name -> factory.
 *
 * Adding an engine is one new file under `engines/` plus one `register(...)` line, which is
 * the acceptance criterion this class exists to satisfy.
 */
export class EngineRegistry {
  readonly #factories = new Map<string, EngineFactory>();

  /**
   * Register a factory. Re-registering a name replaces it, which is what makes a test able to
   * swap in a stub without a second registry.
   */
  register(name: string, factory: EngineFactory): this {
    const key = name.trim().toLowerCase();
    if (key.length === 0) throw new RangeError('Engine name must not be empty.');
    this.#factories.set(key, factory);
    return this;
  }

  has(name: string): boolean {
    return this.#factories.has(name.trim().toLowerCase());
  }

  /** Registered names, sorted, for error messages and settings UI. */
  names(): readonly string[] {
    return [...this.#factories.keys()].sort();
  }

  /** Build one engine. Throws {@link UnknownEngineError} if the name is not registered. */
  create(name: string): TranslationEngine {
    const key = name.trim().toLowerCase();
    const factory = this.#factories.get(key);
    if (factory === undefined) throw new UnknownEngineError([name], this.names());
    return factory();
  }

  /**
   * Build a whole fallback chain, in the order config listed it.
   *
   * Every name is checked before any engine is constructed - see the module comment. Duplicate
   * names are collapsed: listing `["google", "google"]` means retrying the same engine twice in
   * a row within one frame, which is not a fallback, it is just a slower failure.
   */
  createChain(names: readonly string[]): TranslationEngine[] {
    const seen = new Set<string>();
    const wanted: string[] = [];
    for (const name of names) {
      const key = name.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      wanted.push(key);
    }

    if (wanted.length === 0) throw new EmptyChainError();

    const unknown = wanted.filter((name) => !this.#factories.has(name));
    if (unknown.length > 0) throw new UnknownEngineError(unknown, this.names());

    return wanted.map((name) => {
      const factory = this.#factories.get(name);
      // Unreachable: `unknown` above is empty, so every name is present. Kept because
      // `noUncheckedIndexedAccess`-style narrowing is worth more than a non-null assertion.
      if (factory === undefined) throw new UnknownEngineError([name], this.names());
      return factory();
    });
  }
}
