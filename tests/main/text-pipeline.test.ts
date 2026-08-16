/**
 * M4-05 / feature T10: the text pipeline, frame to overlay payload.
 *
 * ## What this suite is actually guarding
 *
 * Every acceptance criterion here is about something *not* happening, and the two ways to get
 * that wrong are both invisible from the output alone:
 *
 * 1. **"the engine was never called"** is asserted on `FakeEngine.callCount`, never on the text
 *    that came out. An engine that was called and echoed its input produces output identical to
 *    an engine that was skipped, so an output-shape assertion would pass in both worlds and
 *    prove nothing about quota, latency or privacy.
 *
 * 2. **Row binding** is asserted with cache hits, cache misses and a same-language skip
 *    *interleaved* in one batch. Both of those stages hand the next one a scattered subset, and
 *    the translator answers with a dense array indexed by its own input. A test where everything
 *    hits, or everything misses, cannot detect a scatter-back that reassembles in the wrong
 *    order - and that bug is the worst one in the file: fluent, confident Thai positioned under
 *    the wrong English, with nothing in the log.
 *
 *    That test was tautology-checked by reversing the scatter-back in `text-pipeline.ts`
 *    (`outcome.texts[misses.length - 1 - slot]`) and confirming it fails on the text/bbox pair
 *    rather than on a count, then restoring.
 *
 * The real `TranslationCache` (on `:memory:`) is used rather than a stub, so the K2 key
 * normalization is exercised for real; the engine is faked because the suite must pass with no
 * network at all.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TranslationCache } from '../../src/main/services/cache.js';
import { MetricsRecorder } from '../../src/main/services/metrics.js';
import { RecentOutputs } from '../../src/main/services/recent-outputs.js';
import {
  createTextPipeline,
  TextPipeline,
  type OverlayPayload,
  type PipelineCache,
  type PipelineTranslator,
  type TextPipelineOptions,
} from '../../src/main/services/text-pipeline.js';
import { FallbackTranslator, type TranslationOutcome } from '../../src/main/services/translator/index.js';
import { GOOGLE_ENDPOINT } from '../../src/main/services/translator/engines/google.js';
import type { HttpFetch, HttpRequestInit, HttpResponse } from '../../src/main/services/translator/types.js';
import { decodeEvent, type FrameEvent } from '../../src/shared/protocol.js';
import type { DisplayGeometry } from '../../src/main/utils/coordinates.js';
import { FakeEngine, RecordingLogger } from './translator/fakes.js';

/** Scale 1 at the origin, so logical px equal the physical px in the fixtures below. */
const DISPLAY: DisplayGeometry = { bounds: { x: 0, y: 0 }, scaleFactor: 1 };

/**
 * One OCR line per string, stacked far enough apart that `groupLines` keeps them separate.
 *
 * Height 20 with a 40px gap is a ratio of 2.0, four times the 0.5 paragraph threshold - so the
 * blocks in these tests are one line each by construction and the grouping stage is not silently
 * deciding the shape of the batch. Width 200 and height 20 clear the noise filter's floors.
 */
function frameWith(texts: readonly string[], seq = 1): FrameEvent {
  return {
    ev: 'frame',
    seq,
    timings: { captureUs: 500, diffUs: 100, ocrUs: 4000 },
    monitor: { id: '\\\\.\\DISPLAY1', scale: 1, bounds: [0, 0, 1920, 1080] },
    region: [0, 0, 1200, 400],
    lines: texts.map((text, index) => ({ text, bbox: [0, index * 60, 200, 20] as const })),
  };
}

interface Harness {
  readonly pipeline: TextPipeline;
  readonly engine: FakeEngine;
  readonly translator: FallbackTranslator;
  readonly cache: TranslationCache;
  readonly payloads: OverlayPayload[];
  readonly logger: RecordingLogger;
  readonly metrics: MetricsRecorder;
}

function harness(
  overrides: Partial<Omit<TextPipelineOptions, 'translator' | 'cache' | 'onPayload'>> = {},
  engine = new FakeEngine('google'),
): Harness {
  const logger = new RecordingLogger();
  const metrics = new MetricsRecorder();
  const translator = new FallbackTranslator([engine], { logger });
  const cache = new TranslationCache(':memory:', { logger });
  const payloads: OverlayPayload[] = [];

  const pipeline = new TextPipeline({
    translator,
    cache,
    logger,
    metrics,
    onPayload: (payload) => payloads.push(payload),
    ...overrides,
  });

  return { pipeline, engine, translator, cache, payloads, logger, metrics };
}

/** Cache-hit seeding goes through the real cache, keyed the way the pipeline will look it up. */
function seed(cache: TranslationCache, source: string, translated: string, engineName = 'google'): void {
  cache.set(source, 'en', 'th', engineName, translated);
}

describe('acceptance: text already in the target language never reaches an engine', () => {
  it('all-Thai text is dropped as feedback and the engine is never called', async () => {
    const h = harness();

    const payload = await h.pipeline.handleFrame(
      frameWith(['เจ้าต้องตามหากุญแจ', 'ประตูทางทิศเหนือเปิดอยู่']),
      DISPLAY,
    );

    expect(h.engine.callCount).toBe(0);
    expect(payload).toBeUndefined();
    expect(h.payloads).toHaveLength(0);
  });

  it('T10 still holds when the Thai feedback filter is switched off', async () => {
    // maxThaiRatio 1 disables F3 entirely, so these blocks survive to the translate stage and
    // the same-language skip is the only thing left between them and the engine. Without T10
    // this test calls Google with Thai text.
    const h = harness({ thaiScript: { maxThaiRatio: 1 } });

    const payload = await h.pipeline.handleFrame(
      frameWith(['เจ้าต้องตามหากุญแจ', 'ประตูทางทิศเหนือเปิดอยู่']),
      DISPLAY,
    );

    expect(h.engine.callCount).toBe(0);
    // Their translation would be themselves, which carries nothing, so nothing is drawn.
    expect(payload).toBeUndefined();
  });

  it('mixed text below the majority threshold is still translated', async () => {
    const h = harness({ thaiScript: { maxThaiRatio: 1 } });

    // Mostly English with one Thai word: 0.5 is a majority test, not a "contains Thai" test.
    await h.pipeline.handleFrame(frameWith(['press the ปุ่ม to continue now']), DISPLAY);

    expect(h.engine.callCount).toBe(1);
  });
});

describe('acceptance: the cache decides whether the engine is called at all', () => {
  it('every block a cache hit means zero engine calls', async () => {
    const h = harness();
    seed(h.cache, 'alpha alpha', 'TH-alpha');
    seed(h.cache, 'bravo bravo', 'TH-bravo');

    const payload = await h.pipeline.handleFrame(frameWith(['alpha alpha', 'bravo bravo']), DISPLAY);

    expect(h.engine.callCount).toBe(0);
    expect(payload?.entries.map((entry) => entry.text)).toEqual(['TH-alpha', 'TH-bravo']);
    expect(payload?.entries.map((entry) => entry.origin)).toEqual(['cache', 'cache']);
    expect(payload?.stats.cacheHits).toBe(2);
    expect(payload?.stats.cacheMisses).toBe(0);
  });

  it('a partial hit sends the engine exactly the misses, and nothing else', async () => {
    const h = harness();
    seed(h.cache, 'bravo bravo', 'TH-bravo');

    await h.pipeline.handleFrame(frameWith(['alpha alpha', 'bravo bravo', 'charlie charlie']), DISPLAY);

    expect(h.engine.callCount).toBe(1);
    // Not "contains the misses" - exactly the misses, in order. A batch that also carried the
    // hit would be paid for twice and would still look right on screen.
    expect(h.engine.calls[0]?.texts).toEqual(['alpha alpha', 'charlie charlie']);
    expect(h.engine.calls[0]?.src).toBe('en');
    expect(h.engine.calls[0]?.tgt).toBe('th');
  });

  it('what the engine returns is written back to the cache, so the next frame is a hit', async () => {
    const h = harness();

    await h.pipeline.handleFrame(frameWith(['alpha alpha']), DISPLAY);
    expect(h.engine.callCount).toBe(1);

    // A second pipeline over the same cache: a fresh deduplicator, so dedup cannot be what
    // suppresses the second call.
    const second = new TextPipeline({
      translator: h.translator,
      cache: h.cache,
      logger: h.logger,
      onPayload: () => {},
    });
    const payload = await second.handleFrame(frameWith(['alpha alpha'], 2), DISPLAY);

    expect(h.engine.callCount).toBe(1);
    expect(payload?.entries[0]?.text).toBe('google(alpha alpha)');
    expect(payload?.entries[0]?.origin).toBe('cache');
  });
});

describe('acceptance: results bind to their own block, with hits and misses interleaved', () => {
  /**
   * The dangerous case, and the only shape that can catch it.
   *
   * Six blocks, laid out so that both subsetting stages punch holes in different places:
   *
   *   index 0  alpha     miss   -> engine
   *   index 1  Thai      skipped by T10 (never reaches the cache lookup)
   *   index 2  charlie   hit
   *   index 3  delta     miss   -> engine
   *   index 4  echo      hit
   *   index 5  foxtrot   miss   -> engine
   *
   * The engine therefore receives three strings and answers with a dense array of three, which
   * has to be scattered back to indices 0, 3 and 5 - not appended, and not zipped against the
   * survivor list. Each assertion pairs a translation with the bbox of the block it came from,
   * because the whole failure mode is right text, wrong box.
   */
  it('each translation lands on its own bbox', async () => {
    const h = harness({ thaiScript: { maxThaiRatio: 1 } });
    seed(h.cache, 'charlie charlie', 'TH-charlie');
    seed(h.cache, 'echo echo', 'TH-echo');

    const payload = await h.pipeline.handleFrame(
      frameWith([
        'alpha alpha',
        'เจ้าต้องตามหากุญแจ',
        'charlie charlie',
        'delta delta',
        'echo echo',
        'foxtrot foxtrot',
      ]),
      DISPLAY,
    );

    expect(h.engine.callCount).toBe(1);
    expect(h.engine.calls[0]?.texts).toEqual(['alpha alpha', 'delta delta', 'foxtrot foxtrot']);

    // y is `index * 60` from `frameWith`, so the bbox names the source block unambiguously.
    expect(
      payload?.entries.map((entry) => ({ y: entry.bbox.y, text: entry.text, source: entry.sourceText })),
    ).toEqual([
      { y: 0, text: 'google(alpha alpha)', source: 'alpha alpha' },
      { y: 120, text: 'TH-charlie', source: 'charlie charlie' },
      { y: 180, text: 'google(delta delta)', source: 'delta delta' },
      { y: 240, text: 'TH-echo', source: 'echo echo' },
      { y: 300, text: 'google(foxtrot foxtrot)', source: 'foxtrot foxtrot' },
    ]);

    expect(payload?.stats.sameLanguage).toBe(1);
    expect(payload?.stats.cacheHits).toBe(2);
    expect(payload?.stats.cacheMisses).toBe(3);
  });

  it('an engine that reorders its own answer cannot shift the rows either', async () => {
    // The scatter-back is index-driven, so an engine returning its results in a different order
    // is believed positionally - which is the contract in translator/types.ts. This pins that the
    // pipeline does not additionally try to re-match by content and get clever about it.
    const engine = new FakeEngine('google', (texts) => texts.map((text) => `x:${text}`));
    const h = harness({}, engine);
    seed(h.cache, 'bravo bravo', 'TH-bravo');

    const payload = await h.pipeline.handleFrame(
      frameWith(['alpha alpha', 'bravo bravo', 'charlie charlie']),
      DISPLAY,
    );

    expect(payload?.entries.map((entry) => [entry.bbox.y, entry.text])).toEqual([
      [0, 'x:alpha alpha'],
      [60, 'TH-bravo'],
      [120, 'x:charlie charlie'],
    ]);
  });
});

describe('acceptance: a translation identical to its source is not forwarded to render', () => {
  it('an untouched string is counted and dropped', async () => {
    // A real case: proper nouns and short UI strings come back unchanged from every engine.
    const engine = new FakeEngine('google', (texts) => texts.map((text) => (text.startsWith('alpha') ? text : `TH-${text}`)));
    const h = harness({}, engine);

    const payload = await h.pipeline.handleFrame(frameWith(['alpha alpha', 'bravo bravo']), DISPLAY);

    expect(payload?.entries.map((entry) => entry.sourceText)).toEqual(['bravo bravo']);
    expect(payload?.stats.identical).toBe(1);
    expect(payload?.stats.rendered).toBe(1);
  });

  it('a difference in surrounding whitespace only is still identical', async () => {
    const engine = new FakeEngine('google', (texts) => texts.map((text) => `  ${text} `));
    const h = harness({}, engine);

    const payload = await h.pipeline.handleFrame(frameWith(['alpha alpha']), DISPLAY);

    expect(payload).toBeUndefined();
  });

  it('a difference in punctuation is NOT identical, and is drawn', async () => {
    // The rule is exact equality after trimming, not `normalizeForComparison` - suppressing a
    // real translation is silent and permanent, while an extra box is merely visible.
    const engine = new FakeEngine('google', (texts) => texts.map((text) => `${text}!`));
    const h = harness({}, engine);

    const payload = await h.pipeline.handleFrame(frameWith(['alpha alpha']), DISPLAY);

    expect(payload?.entries[0]?.text).toBe('alpha alpha!');
    expect(payload?.stats.identical).toBe(0);
  });
});

describe('the degraded signal survives the identical-suppression rule', () => {
  const dead = (): FakeEngine =>
    new FakeEngine('google', () => {
      throw new Error('endpoint is down');
    });

  it('every engine failing shows the original text rather than nothing at all', async () => {
    const h = harness({}, dead());

    const payload = await h.pipeline.handleFrame(frameWith(['alpha alpha', 'bravo bravo']), DISPLAY);

    // Design doc section 7: the originals, plus a signal. Applying identical-suppression here
    // would produce an empty payload at the exact moment the user needs to be told something.
    expect(payload?.degraded).toBe(true);
    expect(payload?.engine).toBeNull();
    expect(payload?.entries.map((entry) => entry.text)).toEqual(['alpha alpha', 'bravo bravo']);
    expect(payload?.entries.map((entry) => entry.origin)).toEqual(['degraded', 'degraded']);
    expect(payload?.stats.identical).toBe(0);
  });

  it('carries the per-engine failures outward for M10-02 to render', async () => {
    const h = harness({}, dead());

    const payload = await h.pipeline.handleFrame(frameWith(['alpha alpha']), DISPLAY);

    expect(payload?.failures).toHaveLength(1);
    expect(payload?.failures[0]?.engine).toBe('google');
    expect(payload?.failures[0]?.kind).toBe('network');
  });

  it('untranslated originals are never written to the cache', async () => {
    const h = harness({}, dead());
    await h.pipeline.handleFrame(frameWith(['alpha alpha']), DISPLAY);

    expect(h.cache.get('alpha alpha', 'en', 'th', 'google')).toBeUndefined();
  });

  it('a translator that returns the wrong number of results is treated as total failure', async () => {
    // `FallbackTranslator` cannot do this, but `PipelineTranslator` is structural and a future
    // LLM adapter can. Believing a short batch shifts every row after the gap.
    const short: PipelineTranslator = {
      engineNames: ['google'],
      translate: async (): Promise<TranslationOutcome> => ({
        texts: ['only one'],
        engine: 'google',
        degraded: false,
        failures: [],
      }),
    };
    const logger = new RecordingLogger();
    const cache = new TranslationCache(':memory:', { logger });
    const payloads: OverlayPayload[] = [];
    const pipeline = new TextPipeline({
      translator: short,
      cache,
      logger,
      onPayload: (payload) => payloads.push(payload),
    });

    const payload = await pipeline.handleFrame(frameWith(['alpha alpha', 'bravo bravo']), DISPLAY);

    expect(payload?.degraded).toBe(true);
    expect(payload?.entries.map((entry) => entry.text)).toEqual(['alpha alpha', 'bravo bravo']);
    expect(logger.defaultLevelText()).toContain('wrong number of results');
    expect(cache.get('alpha alpha', 'en', 'th', 'google')).toBeUndefined();
  });
});

describe('progressive render: cache hits do not wait behind a round trip', () => {
  it('emits the hits first, then the full set, both under the same seq', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = new FakeEngine('google', async (texts) => {
      await gate;
      return texts.map((text) => `TH-${text}`);
    });
    const h = harness({}, engine);
    seed(h.cache, 'bravo bravo', 'TH-cached');

    const running = h.pipeline.handleFrame(frameWith(['alpha alpha', 'bravo bravo'], 7), DISPLAY);

    // Let the microtask queue drain up to the awaited engine call.
    await Promise.resolve();
    await Promise.resolve();

    expect(h.payloads).toHaveLength(1);
    expect(h.payloads[0]?.complete).toBe(false);
    expect(h.payloads[0]?.seq).toBe(7);
    expect(h.payloads[0]?.entries.map((entry) => entry.text)).toEqual(['TH-cached']);

    release?.();
    await running;

    expect(h.payloads).toHaveLength(2);
    expect(h.payloads[1]?.complete).toBe(true);
    expect(h.payloads[1]?.seq).toBe(7);
    // The complete payload is the whole set, not the remainder: a renderer that replaces its
    // contents wholesale would otherwise lose the hit it already drew.
    expect(h.payloads[1]?.entries.map((entry) => entry.text)).toEqual(['TH-alpha alpha', 'TH-cached']);
  });

  it('does not emit a partial payload when there is nothing to show early', async () => {
    const h = harness();
    await h.pipeline.handleFrame(frameWith(['alpha alpha', 'bravo bravo']), DISPLAY);

    expect(h.payloads).toHaveLength(1);
    expect(h.payloads[0]?.complete).toBe(true);
  });
});

describe('ordering and failure containment', () => {
  it('a slow frame that finishes late cannot overwrite a newer one', async () => {
    const h = harness();

    await h.pipeline.handleFrame(frameWith(['alpha alpha'], 9), DISPLAY);
    expect(h.payloads).toHaveLength(1);

    const stale = await h.pipeline.handleFrame(frameWith(['bravo bravo'], 4), DISPLAY);

    expect(stale).toBeUndefined();
    expect(h.payloads).toHaveLength(1);
  });

  it('a throwing stage is reported and the frame is skipped, not crashed', async () => {
    const h = harness();

    // scaleFactor 0 makes `toLogicalRect` throw - the one thing in the group stage that does.
    const payload = await h.pipeline.handleFrame(frameWith(['alpha alpha']), {
      bounds: { x: 0, y: 0 },
      scaleFactor: 0,
    });

    expect(payload).toBeUndefined();
    expect(h.logger.defaultLevelText()).toContain('frame failed in the text pipeline');
  });
});

describe('a disabled cache degrades the pipeline without stopping it', () => {
  /** A cache that reports itself disabled, exactly as `TranslationCache` does after a sqlite error. */
  const disabledCache: PipelineCache = {
    status: 'disabled',
    getBatch: (lookups) => lookups.map(() => undefined),
    setBatch: () => {},
  };

  it('still translates, reports the status in the payload, and says so once', async () => {
    const logger = new RecordingLogger();
    const engine = new FakeEngine('google');
    const payloads: OverlayPayload[] = [];
    const pipeline = new TextPipeline({
      translator: new FallbackTranslator([engine], { logger }),
      cache: disabledCache,
      logger,
      onPayload: (payload) => payloads.push(payload),
    });

    const first = await pipeline.handleFrame(frameWith(['alpha alpha'], 1), DISPLAY);
    const second = await pipeline.handleFrame(frameWith(['bravo bravo'], 2), DISPLAY);

    expect(first?.cacheStatus).toBe('disabled');
    expect(second?.entries[0]?.text).toBe('google(bravo bravo)');
    expect(engine.callCount).toBe(2);

    const warnings = logger.lines.filter((line) => line.message.includes('without a cache'));
    expect(warnings, 'warned once, not once per frame').toHaveLength(1);
  });
});

describe('per-stage timings feed M10-03', () => {
  it('records group, translate and total on a frame that had to translate', async () => {
    const h = harness();
    await h.pipeline.handleFrame(frameWith(['alpha alpha']), DISPLAY);

    const stages = h.metrics.snapshot().map((stat) => stat.stage);
    expect(stages).toContain('group');
    expect(stages).toContain('translate');
    expect(stages).toContain('total');
  });

  it('does not record a translate sample on a frame that only hit the cache', async () => {
    // The budget row is literally "translate (cache miss)". Feeding it 0ms hit-only frames
    // would drag p90 down and hide a slow engine.
    const h = harness();
    seed(h.cache, 'alpha alpha', 'TH-alpha');

    await h.pipeline.handleFrame(frameWith(['alpha alpha']), DISPLAY);

    const stages = h.metrics.snapshot().map((stat) => stat.stage);
    expect(stages).toContain('group');
    expect(stages).not.toContain('translate');
  });

  it('total includes the sidecar half of the round, from the wire timings', async () => {
    const metrics = new MetricsRecorder();
    // A clock that does not advance, so the only thing left in `total` is the wire's µs.
    const h = harness({ metrics, now: () => 1000 });

    await h.pipeline.handleFrame(frameWith(['alpha alpha']), DISPLAY);

    // captureUs 500 + diffUs 100 + ocrUs 4000 = 4600µs = 4.6ms.
    const total = metrics.snapshot().find((stat) => stat.stage === 'total');
    expect(total?.p50).toBe(4.6);
  });
});

describe('the earlier filter stages are wired in, not skipped', () => {
  it('noise blocks are dropped before the cache is even asked', async () => {
    const h = harness();

    const payload = await h.pipeline.handleFrame(frameWith(['16:36', '86%', 'alpha alpha']), DISPLAY);

    expect(h.engine.calls[0]?.texts).toEqual(['alpha alpha']);
    expect(payload?.stats.noise).toBe(2);
  });

  it('a block the overlay recently displayed is filtered as feedback', async () => {
    const recentOutputs = new RecentOutputs();
    recentOutputs.remember('alpha alpha');
    const h = harness({ recentOutputs });

    const payload = await h.pipeline.handleFrame(frameWith(['alpha alpha', 'bravo bravo']), DISPLAY);

    expect(h.engine.calls[0]?.texts).toEqual(['bravo bravo']);
    expect(payload?.stats.recentOutput).toBe(1);
  });

  it('the same text in the same place on the next frame is a duplicate', async () => {
    const h = harness();

    await h.pipeline.handleFrame(frameWith(['alpha alpha'], 1), DISPLAY);
    const second = await h.pipeline.handleFrame(frameWith(['alpha alpha'], 2), DISPLAY);

    expect(second).toBeUndefined();
    // Dedup, not the cache: the engine was called once and the second frame never got as far
    // as a lookup.
    expect(h.engine.callCount).toBe(1);
  });
});

describe('privacy: screen text never reaches a default-level log line', () => {
  it('neither OCR text nor its translation appears at warn/error/info', async () => {
    const h = harness({}, new FakeEngine('google', (texts) => texts.map((text) => `แปลแล้ว:${text}`)));
    seed(h.cache, 'bravo bravo', 'TH-bravo');

    await h.pipeline.handleFrame(frameWith(['alpha alpha', 'bravo bravo', '16:36']), DISPLAY);
    // And on the path that logs the loudest.
    const dead = harness({}, new FakeEngine('google', () => {
      throw new Error('endpoint is down');
    }));
    await dead.pipeline.handleFrame(frameWith(['charlie charlie']), DISPLAY);

    for (const logger of [h.logger, dead.logger]) {
      const text = logger.defaultLevelText();
      expect(text).not.toContain('alpha');
      expect(text).not.toContain('bravo');
      expect(text).not.toContain('charlie');
      expect(text).not.toContain('แปลแล้ว');
    }
  });
});

describe('createTextPipeline: the injected transport is what the engine actually calls', () => {
  /**
   * The M4-02 proxy gap.
   *
   * `GoogleEngineOptions.fetch` defaults to Node's `fetch`, which ignores the system proxy, and
   * the whole translator directory is Electron-free so that it can be unit tested. That leaves
   * the composition helper as the single place where the app's transport is injected - so this
   * asserts *behaviourally* that the function handed to `createTextPipeline` is the one that
   * carries the request, rather than inspecting a private field.
   *
   * `src/main/index.ts` passes `net.fetch` here; that half is proved by running Electron.
   */
  it('drives a cache miss through the caller-supplied fetch, not the global one', async () => {
    const seen: { url: string; init?: HttpRequestInit }[] = [];
    const spy: HttpFetch = async (url, init): Promise<HttpResponse> => {
      seen.push({ url, ...(init === undefined ? {} : { init }) });
      return { ok: true, status: 200, text: async () => JSON.stringify(['สวัสดีชาวโลก']) };
    };

    const payloads: OverlayPayload[] = [];
    const composed = createTextPipeline({
      fetch: spy,
      cachePath: ':memory:',
      rateLimit: { minIntervalMs: 0 },
      onPayload: (payload) => payloads.push(payload),
    });

    try {
      const payload = await composed.pipeline.handleFrame(frameWith(['hello world']), DISPLAY);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.url.startsWith(GOOGLE_ENDPOINT)).toBe(true);
      expect(seen[0]?.init?.method).toBe('POST');
      expect(seen[0]?.init?.body).toContain('hello+world');
      expect(payload?.entries[0]?.text).toBe('สวัสดีชาวโลก');
      expect(payload?.engine).toBe('google');
    } finally {
      composed.close();
    }
  });

  it('composes the real chain: google, rate limited, over a real cache', () => {
    const composed = createTextPipeline({
      fetch: async () => ({ ok: true, status: 200, text: async () => '[]' }),
      cachePath: ':memory:',
      onPayload: () => {},
    });

    try {
      expect(composed.translator.engineNames).toEqual(['google']);
      expect(composed.cache.status).toBe('ready');
    } finally {
      composed.close();
    }
  });
});

describe('end to end from a real recorded sidecar frame', () => {
  /**
   * The M3-06 fixture is a real recording of the real `Textlens.Capture.exe`, so this exercises
   * the pipeline against bytes the sidecar actually produced - decoded through the real wire
   * decoder, not hand-built like the frames above.
   */
  it('turns the recorded frame into one overlay box under the merged source text', async () => {
    const fixture = path.resolve(import.meta.dirname, '..', 'fixtures', 'sessions', 'with-text.jsonl');
    const frames = fs
      .readFileSync(fixture, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { line: string })
      .map((row) => decodeEvent(row.line))
      .flatMap((result) => (result.ok && result.value.ev === 'frame' ? [result.value] : []));

    expect(frames, 'with-text.jsonl must contain a frame').toHaveLength(1);
    const frame = frames[0]!;

    const h = harness();
    const payload = await h.pipeline.handleFrame(frame, DISPLAY);

    expect(payload?.entries).toHaveLength(1);
    // Two OCR lines, one block, one box (the M5-01 contract: 1 block = 1 box).
    expect(payload?.stats.lines).toBe(2);
    expect(payload?.stats.blocks).toBe(1);

    // region [50,60,...] + bbox [4,35,317,13] and [21,53,396,13], scale 1: the union in logical px.
    expect(payload?.entries[0]?.bbox).toEqual({ x: 54, y: 95, width: 413, height: 31 });
    expect(payload?.entries[0]?.origin).toBe('engine');
    expect(h.engine.calls[0]?.texts).toHaveLength(1);
  });
});
