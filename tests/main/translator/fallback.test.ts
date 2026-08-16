/**
 * M4-01, features T1 + T6 - the engine seam, the registry, and the fallback chain.
 *
 * The load-bearing test in this file is the mismatched-length pair. If an engine returns four
 * results for five inputs and the chain believes it, every block after the gap is captioned
 * with its neighbour's translation: fluent, confident, wrong, and completely silent. The tests
 * cover both directions - short and long - because a guard written as `results.length < expected`
 * passes the short case and lets the long one through.
 */

import { describe, expect, it } from 'vitest';

import {
  assertBatchShape,
  createDefaultRegistry,
  EmptyChainError,
  EngineRegistry,
  FallbackTranslator,
  TranslationError,
  UnknownEngineError,
} from '../../../src/main/services/translator/index.js';
import { FakeEngine, RecordingLogger } from './fakes.js';

const TEXTS = ['The gate is closed', 'Your health is low'];

describe('FallbackTranslator - the happy path does not touch the fallback', () => {
  it('returns the primary result and never calls the fallback', async () => {
    const primary = new FakeEngine('primary');
    const fallback = new FakeEngine('fallback');
    const translator = new FallbackTranslator([primary, fallback]);

    const outcome = await translator.translate(TEXTS, 'en', 'th');

    // Three independent ways of saying "the primary answered", because the tagged strings
    // alone would not rule out a fallback that happened to agree.
    expect(outcome.texts).toEqual(['primary(The gate is closed)', 'primary(Your health is low)']);
    expect(outcome.engine).toBe('primary');
    expect(outcome.degraded).toBe(false);
    expect(outcome.failures).toEqual([]);
    expect(primary.callCount).toBe(1);
    expect(fallback.callCount).toBe(0);
  });

  it('passes the language pair through unchanged', async () => {
    const primary = new FakeEngine('primary');
    await new FallbackTranslator([primary]).translate(['hello'], 'en', 'th');

    expect(primary.calls[0]?.src).toBe('en');
    expect(primary.calls[0]?.tgt).toBe('th');
  });

  it('does not call any engine for an empty batch', async () => {
    const primary = new FakeEngine('primary');
    const outcome = await new FallbackTranslator([primary]).translate([], 'en', 'th');

    expect(outcome.texts).toEqual([]);
    expect(outcome.degraded).toBe(false);
    expect(primary.callCount).toBe(0);
  });
});

describe('FallbackTranslator - falling through', () => {
  it('returns the fallback result when the primary throws', async () => {
    const primary = new FakeEngine('primary', () => {
      throw new TranslationError('primary: HTTP 500', { kind: 'network', status: 500 });
    });
    const fallback = new FakeEngine('fallback');
    const translator = new FallbackTranslator([primary, fallback]);

    const outcome = await translator.translate(TEXTS, 'en', 'th');

    expect(outcome.texts).toEqual(['fallback(The gate is closed)', 'fallback(Your health is low)']);
    expect(outcome.engine).toBe('fallback');
    expect(outcome.degraded).toBe(false);
    expect(primary.callCount).toBe(1);
    expect(fallback.callCount).toBe(1);
  });

  it('records why each engine was skipped, with the status code', async () => {
    const primary = new FakeEngine('primary', () => {
      throw new TranslationError('primary: HTTP 429', { kind: 'rate-limit', status: 429 });
    });
    const translator = new FallbackTranslator([primary, new FakeEngine('fallback')]);

    const outcome = await translator.translate(TEXTS, 'en', 'th');

    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.engine).toBe('primary');
    expect(outcome.failures[0]?.kind).toBe('rate-limit');
    expect(outcome.failures[0]?.status).toBe(429);
  });

  it('walks the whole chain in order rather than stopping at the second engine', async () => {
    const boom = (name: string): FakeEngine =>
      new FakeEngine(name, () => {
        throw new Error(`${name} down`);
      });
    const first = boom('first');
    const second = boom('second');
    const third = new FakeEngine('third');

    const outcome = await new FallbackTranslator([first, second, third]).translate(TEXTS, 'en', 'th');

    expect(outcome.engine).toBe('third');
    expect(outcome.texts[0]).toBe('third(The gate is closed)');
    expect(outcome.failures.map((failure) => failure.engine)).toEqual(['first', 'second']);
  });

  it('treats a non-TranslationError throw as a network failure rather than letting it escape', async () => {
    const primary = new FakeEngine('primary', () => {
      throw new TypeError('fetch failed');
    });
    const outcome = await new FallbackTranslator([primary, new FakeEngine('fallback')]).translate(
      TEXTS,
      'en',
      'th',
    );

    expect(outcome.engine).toBe('fallback');
    expect(outcome.failures[0]?.kind).toBe('network');
  });
});

describe('FallbackTranslator - mismatched result count is a failure, not a result', () => {
  it('falls back when an engine returns FEWER results than inputs', async () => {
    const five = ['one', 'two', 'three', 'four', 'five'];
    // The silent-corruption case: four Thai strings for five English blocks.
    const primary = new FakeEngine('primary', () => ['a', 'b', 'c', 'd']);
    const fallback = new FakeEngine('fallback');

    const outcome = await new FallbackTranslator([primary, fallback]).translate(five, 'en', 'th');

    expect(outcome.texts).toHaveLength(5);
    expect(outcome.texts).toEqual(five.map((text) => `fallback(${text})`));
    expect(outcome.engine).toBe('fallback');
    expect(fallback.callCount).toBe(1);
    expect(outcome.failures[0]?.kind).toBe('protocol');
    // The count is in the message; the text never is.
    expect(outcome.failures[0]?.detail).toContain('expected 5 results, got 4');
  });

  it('falls back when an engine returns MORE results than inputs', async () => {
    const five = ['one', 'two', 'three', 'four', 'five'];
    const primary = new FakeEngine('primary', () => ['a', 'b', 'c', 'd', 'e', 'f']);
    const fallback = new FakeEngine('fallback');

    const outcome = await new FallbackTranslator([primary, fallback]).translate(five, 'en', 'th');

    expect(outcome.texts).toHaveLength(5);
    expect(outcome.texts).toEqual(five.map((text) => `fallback(${text})`));
    expect(outcome.engine).toBe('fallback');
    expect(outcome.failures[0]?.detail).toContain('expected 5 results, got 6');
  });

  it('rejects an array padded with non-strings instead of rendering "undefined" on screen', async () => {
    const primary = new FakeEngine('primary', () => ['ok', undefined as unknown as string]);
    const fallback = new FakeEngine('fallback');

    const outcome = await new FallbackTranslator([primary, fallback]).translate(TEXTS, 'en', 'th');

    expect(outcome.engine).toBe('fallback');
    expect(outcome.failures[0]?.kind).toBe('protocol');
    expect(outcome.failures[0]?.detail).toContain('result 1 is undefined');
  });

  it('rejects a non-array result', async () => {
    const primary = new FakeEngine('primary', () => 'not an array' as unknown as string[]);
    const outcome = await new FallbackTranslator([primary, new FakeEngine('fallback')]).translate(
      TEXTS,
      'en',
      'th',
    );

    expect(outcome.engine).toBe('fallback');
    expect(outcome.failures[0]?.kind).toBe('protocol');
  });
});

describe('assertBatchShape', () => {
  it('accepts an array of exactly the expected length', () => {
    expect(() => {
      assertBatchShape(2, ['a', 'b'], 'test');
    }).not.toThrow();
  });

  it('throws in both directions and names the engine', () => {
    expect(() => {
      assertBatchShape(2, ['a'], 'test');
    }).toThrow(/test: expected 2 results, got 1/u);
    expect(() => {
      assertBatchShape(2, ['a', 'b', 'c'], 'test');
    }).toThrow(/test: expected 2 results, got 3/u);
  });

  it('classifies the failure as protocol so the rate limiter picks the short backoff', () => {
    try {
      assertBatchShape(2, ['a'], 'test');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TranslationError);
      expect((error as TranslationError).kind).toBe('protocol');
    }
  });
});

describe('FallbackTranslator - when everything is down', () => {
  const downChain = (): FallbackTranslator =>
    new FallbackTranslator([
      new FakeEngine('primary', () => {
        throw new TranslationError('primary: HTTP 429', { kind: 'rate-limit', status: 429 });
      }),
      new FakeEngine('fallback', () => {
        throw new TranslationError('fallback: request failed', { kind: 'network' });
      }),
    ]);

  it('returns the ORIGINAL texts - not an empty array, and without throwing', async () => {
    const outcome = await downChain().translate(TEXTS, 'en', 'th');

    expect(outcome.texts).toEqual(TEXTS);
    expect(outcome.texts).toHaveLength(TEXTS.length);
    expect(outcome.texts).not.toEqual([]);
  });

  it('flags the result as degraded so the user can be told', async () => {
    const outcome = await downChain().translate(TEXTS, 'en', 'th');

    expect(outcome.degraded).toBe(true);
    expect(outcome.engine).toBeNull();
    expect(outcome.failures.map((failure) => failure.kind)).toEqual(['rate-limit', 'network']);
  });

  it('logs the total failure at error level - a blank overlay with a quiet log is the bug this prevents', async () => {
    const logger = new RecordingLogger();
    const translator = new FallbackTranslator(
      [
        new FakeEngine('primary', () => {
          throw new TranslationError('primary: HTTP 500', { kind: 'network', status: 500 });
        }),
      ],
      { logger },
    );

    await translator.translate(TEXTS, 'en', 'th');

    expect(logger.lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('returns a copy, so a caller mutating the result cannot corrupt the source array', async () => {
    const source = [...TEXTS];
    const outcome = await downChain().translate(source, 'en', 'th');

    (outcome.texts as string[])[0] = 'mutated';
    expect(source[0]).toBe(TEXTS[0]);
  });
});

describe('FallbackTranslator - screen text must not reach the default log level', () => {
  it('logs counts and engine names, never the text being translated', async () => {
    const logger = new RecordingLogger();
    const secret = 'Zorblatt the Unspeakable guards the ninth gate';
    const translator = new FallbackTranslator(
      [
        new FakeEngine('primary', () => {
          throw new TranslationError('primary: HTTP 429', { kind: 'rate-limit', status: 429 });
        }),
        new FakeEngine('fallback', () => {
          throw new TranslationError('fallback: request failed or timed out', { kind: 'network' });
        }),
      ],
      { logger },
    );

    await translator.translate([secret], 'en', 'th');

    // PR3 / M10-03: default-level logs must not contain what is on the user's screen.
    expect(logger.defaultLevelText()).not.toContain('Zorblatt');
    expect(logger.defaultLevelText()).toContain('primary');
  });
});

describe('FallbackTranslator - construction', () => {
  it('refuses an empty chain instead of silently degrading every frame', () => {
    expect(() => new FallbackTranslator([])).toThrow(RangeError);
  });

  it('reports the chain order for diagnostics', () => {
    const translator = new FallbackTranslator([new FakeEngine('a'), new FakeEngine('b')]);
    expect(translator.engineNames).toEqual(['a', 'b']);
  });
});

describe('FallbackTranslator - defensive copy', () => {
  it('does not let an engine mutate the array it was handed', async () => {
    const source = ['one', 'two', 'three'];
    const vandal = new FakeEngine('vandal', (texts) => {
      texts.length = 0;
      throw new TranslationError('vandal: nope', { kind: 'network' });
    });

    const outcome = await new FallbackTranslator([vandal]).translate(source, 'en', 'th');

    // If the engine had been handed the real array, the degraded fallback would be empty -
    // a blank overlay produced by our own code rather than by the failure.
    expect(outcome.texts).toEqual(source);
    expect(source).toHaveLength(3);
  });
});

describe('FallbackTranslator - health', () => {
  it('reports every engine and survives one that throws', async () => {
    const good = new FakeEngine('good');
    const bad = new FakeEngine('bad');
    bad.healthCheck = async (): Promise<never> => {
      throw new Error('ENOTFOUND');
    };

    const report = await new FallbackTranslator([good, bad]).healthCheck();

    expect(report).toEqual([
      { engine: 'good', ok: true },
      { engine: 'bad', ok: false, detail: 'Error' },
    ]);
  });
});

describe('EngineRegistry', () => {
  it('builds a chain in the order config listed it', () => {
    const registry = new EngineRegistry()
      .register('alpha', () => new FakeEngine('alpha'))
      .register('beta', () => new FakeEngine('beta'));

    expect(registry.createChain(['beta', 'alpha']).map((engine) => engine.name)).toEqual([
      'beta',
      'alpha',
    ]);
  });

  it('gives a readable error naming the unknown engine AND the known ones', () => {
    const registry = new EngineRegistry().register('google', () => new FakeEngine('google'));

    let thrown: unknown;
    try {
      registry.createChain(['googel']);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnknownEngineError);
    const message = (thrown as Error).message;
    expect(message).toContain('"googel"');
    // Without the known list, "unknown engine: googel" is a riddle rather than a fix.
    expect(message).toContain('"google"');
  });

  it('reports every unknown name at once rather than one restart at a time', () => {
    const registry = new EngineRegistry().register('google', () => new FakeEngine('google'));

    try {
      registry.createChain(['nope', 'google', 'alsonope']);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as UnknownEngineError).unknown).toEqual(['nope', 'alsonope']);
    }
  });

  it('validates the whole chain before constructing anything', () => {
    let built = 0;
    const registry = new EngineRegistry().register('good', () => {
      built += 1;
      return new FakeEngine('good');
    });

    expect(() => registry.createChain(['good', 'missing'])).toThrow(UnknownEngineError);
    // A bad fallback name must surface at startup, not on the day the primary first fails.
    expect(built).toBe(0);
  });

  it('does not construct engines that config did not ask for', () => {
    let built = 0;
    const registry = new EngineRegistry()
      .register('used', () => new FakeEngine('used'))
      .register('unused', () => {
        built += 1;
        return new FakeEngine('unused');
      });

    registry.createChain(['used']);
    expect(built).toBe(0);
  });

  it('collapses duplicates - retrying one engine twice is not a fallback', () => {
    const registry = new EngineRegistry().register('google', () => new FakeEngine('google'));
    expect(registry.createChain(['google', 'google'])).toHaveLength(1);
  });

  it('rejects an empty chain', () => {
    const registry = new EngineRegistry().register('google', () => new FakeEngine('google'));
    expect(() => registry.createChain([])).toThrow(EmptyChainError);
    expect(() => registry.createChain(['  '])).toThrow(EmptyChainError);
  });

  it('is case- and whitespace-insensitive about names from config', () => {
    const registry = new EngineRegistry().register('google', () => new FakeEngine('google'));
    expect(registry.has(' GOOGLE ')).toBe(true);
    expect(registry.createChain([' Google '])).toHaveLength(1);
  });

  it('lists what is registered, for the settings UI and the error message', () => {
    const registry = new EngineRegistry()
      .register('zeta', () => new FakeEngine('zeta'))
      .register('alpha', () => new FakeEngine('alpha'));
    expect(registry.names()).toEqual(['alpha', 'zeta']);
  });
});

describe('createDefaultRegistry - the "one registration line" criterion', () => {
  it('ships google', () => {
    expect(createDefaultRegistry().names()).toEqual(['google']);
  });

  it('lets a new engine join with a single register call and no pipeline change', () => {
    const registry = createDefaultRegistry().register('lmstudio', () => new FakeEngine('lmstudio'));

    const chain = registry.createChain(['lmstudio', 'google']);
    expect(chain.map((engine) => engine.name)).toEqual(['lmstudio', 'google']);
    // And the chain accepts it with no knowledge of what it is.
    expect(() => new FallbackTranslator(chain)).not.toThrow();
  });
});
