/**
 * M4-03, feature T9 - minimum interval, exponential backoff, and per-engine isolation.
 *
 * Every timing assertion here is about **when the underlying engine was actually entered**,
 * measured on the injected clock, or about the engine provably not being entered at all.
 * Asserting that `sleep` was called with some number would prove a delay was *scheduled*, which
 * is not the same claim and is satisfied by code that schedules and then dispatches anyway.
 *
 * The isolation suite needs two engines by construction: a single-engine test can show that a
 * backoff happened, but it cannot show that the backoff stayed where it belongs.
 */

import { describe, expect, it } from 'vitest';

import { FallbackTranslator } from '../../../src/main/services/translator/index.js';
import {
  DEFAULT_MAX_BACKOFF_MS,
  RateLimiter,
  withRateLimit,
} from '../../../src/main/services/translator/rate-limiter.js';
import { TranslationError } from '../../../src/main/services/translator/types.js';
import { FakeClock, FakeEngine } from './fakes.js';

const OPTIONS = {
  minIntervalMs: 200,
  rateLimitBackoffMs: 2000,
  networkBackoffMs: 500,
  backoffMultiplier: 2,
  maxBackoffMs: 60_000,
};

const rateLimited = (): TranslationError =>
  new TranslationError('engine: HTTP 429', { kind: 'rate-limit', status: 429 });

/** An engine that stamps the clock every time it is genuinely entered. */
function timedEngine(
  name: string,
  clock: FakeClock,
  behaviour: 'ok' | (() => never) = 'ok',
): { engine: FakeEngine; dispatches: number[] } {
  const dispatches: number[] = [];
  const engine = new FakeEngine(name, (texts) => {
    dispatches.push(clock.now());
    if (behaviour !== 'ok') behaviour();
    return texts.map((text) => `${name}(${text})`);
  });
  return { engine, dispatches };
}

describe('minimum interval - the later request waits, and we can see when it went out', () => {
  it('dispatches the first request with no delay', async () => {
    const clock = new FakeClock(1000);
    const { engine, dispatches } = timedEngine('e', clock);
    const limited = withRateLimit(engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep });

    await limited.translateBatch(['a'], 'en', 'th');

    expect(dispatches).toEqual([1000]);
    expect(clock.sleeps).toEqual([]);
  });

  it('holds a back-to-back request until the interval has actually elapsed', async () => {
    const clock = new FakeClock(1000);
    const { engine, dispatches } = timedEngine('e', clock);
    const limited = withRateLimit(engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep });

    await limited.translateBatch(['a'], 'en', 'th');
    await limited.translateBatch(['b'], 'en', 'th');

    // The assertion is the dispatch clock, not the sleep call: the second request must not
    // have reached the engine before t=1200.
    expect(dispatches).toEqual([1000, 1200]);
  });

  it('does not delay a request that is already late enough', async () => {
    const clock = new FakeClock(1000);
    const { engine, dispatches } = timedEngine('e', clock);
    const limited = withRateLimit(engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep });

    await limited.translateBatch(['a'], 'en', 'th');
    clock.advance(5000);
    await limited.translateBatch(['b'], 'en', 'th');

    expect(dispatches).toEqual([1000, 6000]);
    expect(clock.sleeps).toEqual([]);
  });

  it('measures the gap between dispatches, not from a fixed origin', async () => {
    const clock = new FakeClock(0);
    const { engine, dispatches } = timedEngine('e', clock);
    const limited = withRateLimit(engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep });

    await limited.translateBatch(['a'], 'en', 'th');
    await limited.translateBatch(['b'], 'en', 'th');
    await limited.translateBatch(['c'], 'en', 'th');

    expect(dispatches).toEqual([0, 200, 400]);
  });
});

describe('backoff - fails fast rather than making the pipeline wait', () => {
  it('refuses without entering the engine once it is backing off', async () => {
    const clock = new FakeClock(1000);
    const { engine, dispatches } = timedEngine('e', clock, () => {
      throw rateLimited();
    });
    const limited = withRateLimit(engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep });

    await expect(limited.translateBatch(['a'], 'en', 'th')).rejects.toMatchObject({
      kind: 'rate-limit',
    });
    expect(dispatches).toEqual([1000]);

    const before = clock.now();
    await expect(limited.translateBatch(['b'], 'en', 'th')).rejects.toMatchObject({
      kind: 'unavailable',
    });

    // Subtitles cannot wait: the refusal must cost no time and must not reach the engine.
    expect(clock.now()).toBe(before);
    expect(clock.sleeps).toEqual([]);
    expect(dispatches).toEqual([1000]);
  });

  it('lets the engine be tried again once the window has passed', async () => {
    const clock = new FakeClock(1000);
    let failNext = true;
    const dispatches: number[] = [];
    const engine = new FakeEngine('e', (texts) => {
      dispatches.push(clock.now());
      if (failNext) throw rateLimited();
      return texts;
    });
    const limited = withRateLimit(engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep });

    await expect(limited.translateBatch(['a'], 'en', 'th')).rejects.toThrow();
    failNext = false;
    clock.advance(2000);
    await limited.translateBatch(['b'], 'en', 'th');

    expect(dispatches).toEqual([1000, 3000]);
  });
});

describe('backoff - growth, cap and reset', () => {
  const limiter = (): { limiter: RateLimiter; clock: FakeClock } => {
    const clock = new FakeClock(0);
    return { limiter: new RateLimiter({ ...OPTIONS, now: clock.now, sleep: clock.sleep }), clock };
  };

  it('grows exponentially with consecutive rate limits', () => {
    const { limiter: rl, clock } = limiter();

    rl.recordFailure('rate-limit');
    expect(rl.status.remainingMs).toBe(2000);

    clock.advance(2000);
    rl.recordFailure('rate-limit');
    expect(rl.status.remainingMs).toBe(4000);

    clock.advance(4000);
    rl.recordFailure('rate-limit');
    expect(rl.status.remainingMs).toBe(8000);
  });

  it('uses a shorter first pause for a network failure than for a 429', () => {
    const { limiter: network } = limiter();
    network.recordFailure('network');
    expect(network.status.remainingMs).toBe(500);

    const { limiter: throttled } = limiter();
    throttled.recordFailure('rate-limit');
    expect(throttled.status.remainingMs).toBe(2000);
  });

  it('never exceeds the ceiling', () => {
    const { limiter: rl, clock } = limiter();
    const observed: number[] = [];

    for (let i = 0; i < 20; i += 1) {
      rl.recordFailure('rate-limit');
      observed.push(rl.status.remainingMs);
      clock.advance(1);
    }

    // 2000 * 2^19 is about 17 minutes; without the cap this would be the last entry.
    expect(Math.max(...observed)).toBe(OPTIONS.maxBackoffMs);
    expect(observed[observed.length - 1]).toBe(OPTIONS.maxBackoffMs);
  });

  it('resets the streak after a single success, so recovery is not punished', () => {
    const { limiter: rl, clock } = limiter();

    rl.recordFailure('rate-limit');
    rl.recordFailure('rate-limit');
    expect(rl.status.consecutiveFailures).toBe(2);

    clock.advance(10_000);
    rl.recordSuccess();
    expect(rl.status.consecutiveFailures).toBe(0);
    expect(rl.status.backingOff).toBe(false);

    // And the next failure starts from the base delay again, not from where it left off.
    rl.recordFailure('rate-limit');
    expect(rl.status.remainingMs).toBe(2000);
  });

  it('does not count a refusal as a failure, which would escalate without ever asking again', () => {
    const { limiter: rl } = limiter();

    rl.recordFailure('rate-limit');
    const after = rl.status.retryAtMs;
    rl.recordFailure('unavailable');
    rl.recordFailure('unavailable');

    expect(rl.status.consecutiveFailures).toBe(1);
    expect(rl.status.retryAtMs).toBe(after);
  });

  it('rejects settings that would make backoff shrink instead of grow', () => {
    expect(() => new RateLimiter({ backoffMultiplier: 0.5 })).toThrow(RangeError);
    expect(() => new RateLimiter({ minIntervalMs: -1 })).toThrow(RangeError);
  });

  it('has a sane default ceiling', () => {
    expect(DEFAULT_MAX_BACKOFF_MS).toBe(60_000);
  });
});

describe('isolation - one engine backing off must not touch another', () => {
  it('leaves the healthy engine dispatching immediately and its own state untouched', async () => {
    // One shared clock: if A's pacing leaked into B, B's dispatch stamps would show it.
    const clock = new FakeClock(1000);
    const sick = timedEngine('sick', clock, () => {
      throw rateLimited();
    });
    const healthy = timedEngine('healthy', clock);

    const limitedSick = withRateLimit(sick.engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep });
    const limitedHealthy = withRateLimit(healthy.engine, {
      ...OPTIONS,
      now: clock.now,
      sleep: clock.sleep,
    });

    // Drive A deep into backoff.
    await expect(limitedSick.translateBatch(['a'], 'en', 'th')).rejects.toThrow();
    clock.advance(2000);
    await expect(limitedSick.translateBatch(['a'], 'en', 'th')).rejects.toThrow();
    clock.advance(4000);
    await expect(limitedSick.translateBatch(['a'], 'en', 'th')).rejects.toThrow();

    expect(limitedSick.limiter.status.backingOff).toBe(true);
    expect(limitedSick.limiter.status.consecutiveFailures).toBe(3);

    // B has never failed and has never been paced. It must go out at the current instant.
    const at = clock.now();
    await limitedHealthy.translateBatch(['x'], 'en', 'th');

    expect(healthy.dispatches).toEqual([at]);
    expect(limitedHealthy.limiter.status.backingOff).toBe(false);
    expect(limitedHealthy.limiter.status.consecutiveFailures).toBe(0);
  });

  it('does not let one engine consume another engine’s minimum interval', async () => {
    const clock = new FakeClock(0);
    const a = timedEngine('a', clock);
    const b = timedEngine('b', clock);

    const limitedA = withRateLimit(a.engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep });
    const limitedB = withRateLimit(b.engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep });

    await limitedA.translateBatch(['x'], 'en', 'th');
    await limitedB.translateBatch(['x'], 'en', 'th');

    // If the interval state were shared, B would have been held until t=200.
    expect(a.dispatches).toEqual([0]);
    expect(b.dispatches).toEqual([0]);
    expect(clock.sleeps).toEqual([]);
  });

  it('keeps failure streaks separate', async () => {
    const clock = new FakeClock(0);
    const sick = timedEngine('sick', clock, () => {
      throw rateLimited();
    });
    const healthy = timedEngine('healthy', clock);

    const limitedSick = withRateLimit(sick.engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep });
    const limitedHealthy = withRateLimit(healthy.engine, {
      ...OPTIONS,
      now: clock.now,
      sleep: clock.sleep,
    });

    await expect(limitedSick.translateBatch(['a'], 'en', 'th')).rejects.toThrow();
    await limitedHealthy.translateBatch(['a'], 'en', 'th');

    expect(limitedSick.limiter.status.consecutiveFailures).toBe(1);
    expect(limitedHealthy.limiter.status.consecutiveFailures).toBe(0);
  });
});

describe('the chain on top of the limiter', () => {
  it('falls through a backing-off engine to a healthy one without waiting', async () => {
    const clock = new FakeClock(1000);
    const sick = timedEngine('sick', clock, () => {
      throw rateLimited();
    });
    const healthy = timedEngine('healthy', clock);

    const chain = new FallbackTranslator([
      withRateLimit(sick.engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep }),
      withRateLimit(healthy.engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep }),
    ]);

    await chain.translate(['first'], 'en', 'th');
    // Step past the healthy engine's own minimum interval, so that any delay left in the
    // second round can only have come from the sick engine's backoff.
    clock.advance(OPTIONS.minIntervalMs);
    const at = clock.now();

    const outcome = await chain.translate(['second'], 'en', 'th');

    expect(outcome.engine).toBe('healthy');
    expect(outcome.degraded).toBe(false);
    // The sick engine was refused at the gate - never entered a second time - and the healthy
    // one went out at the current instant rather than inheriting a 2000ms backoff.
    expect(sick.dispatches).toEqual([1000]);
    expect(healthy.dispatches[healthy.dispatches.length - 1]).toBe(at);
    expect(clock.now()).toBe(at);
  });

  it('returns the original text immediately when every engine is backing off', async () => {
    const clock = new FakeClock(1000);
    const one = timedEngine('one', clock, () => {
      throw rateLimited();
    });
    const two = timedEngine('two', clock, () => {
      throw rateLimited();
    });

    const chain = new FallbackTranslator([
      withRateLimit(one.engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep }),
      withRateLimit(two.engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep }),
    ]);

    await chain.translate(['warm up'], 'en', 'th');

    const at = clock.now();
    const outcome = await chain.translate(['The gate is closed'], 'en', 'th');

    expect(outcome.texts).toEqual(['The gate is closed']);
    expect(outcome.degraded).toBe(true);
    expect(outcome.engine).toBeNull();
    expect(outcome.failures.map((failure) => failure.kind)).toEqual(['unavailable', 'unavailable']);
    // "ระหว่าง backoff → คืนข้อความต้นฉบับทันที ไม่ค้างรอ": no time may pass.
    expect(clock.now()).toBe(at);
    expect(one.dispatches).toHaveLength(1);
    expect(two.dispatches).toHaveLength(1);
  });
});

describe('healthCheck through the limiter', () => {
  it('reports the backoff instead of spending a request to rediscover it', async () => {
    const clock = new FakeClock(0);
    const engine = new FakeEngine('e');
    const limited = withRateLimit(engine, { ...OPTIONS, now: clock.now, sleep: clock.sleep });

    limited.limiter.recordFailure('rate-limit');
    const result = await limited.healthCheck();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('backing off');
    expect(engine.healthCalls).toBe(0);
  });

  it('delegates when the engine is healthy', async () => {
    const engine = new FakeEngine('e');
    const limited = withRateLimit(engine, OPTIONS);

    expect(await limited.healthCheck()).toEqual({ ok: true });
    expect(engine.healthCalls).toBe(1);
  });
});

describe('the wrapper keeps the engine interface intact', () => {
  it('preserves the name and exposes the engine underneath', () => {
    const engine = new FakeEngine('google');
    const limited = withRateLimit(engine, OPTIONS);

    expect(limited.name).toBe('google');
    expect(limited.inner).toBe(engine);
  });

  it('passes results and arguments through untouched on the happy path', async () => {
    const engine = new FakeEngine('e');
    const limited = withRateLimit(engine, OPTIONS);

    expect(await limited.translateBatch(['a', 'b'], 'en', 'th')).toEqual(['e(a)', 'e(b)']);
    expect(engine.calls[0]?.src).toBe('en');
  });

  it('accepts a pre-built limiter, so a caller can hold onto the state it observes', async () => {
    const clock = new FakeClock(0);
    const shared = new RateLimiter({ ...OPTIONS, now: clock.now, sleep: clock.sleep });
    const limited = withRateLimit(new FakeEngine('e'), shared);

    expect(limited.limiter).toBe(shared);
    await limited.translateBatch(['a'], 'en', 'th');
    expect(shared.status.consecutiveFailures).toBe(0);
  });
});
