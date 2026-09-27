/**
 * #78: frames that overlap.
 *
 * `src/main/index.ts` hands every frame to `handleFrame` with `void` and no queue, on a 500-800ms
 * tick, while a cache miss takes ~870ms to come back. So in production the next frame routinely
 * *starts* while the previous one is still waiting on the engine. Every test in
 * `text-pipeline.test.ts` awaits one frame before starting the next, which is why none of them
 * could see any of the three bugs below - each test here keeps at least two frames in flight at
 * once, and none of them may be "simplified" into running the frames one after another.
 *
 * The engine is a real `FakeEngine` behind the real `FallbackTranslator` and a real
 * `TranslationCache(':memory:')`. The only thing added is a gate: while it is closed, each engine
 * call parks until the test releases it, which is how a test holds a translation in flight for
 * exactly as long as it needs to.
 *
 * Assertions are made on the **final state** - the last payload that reached the renderer - and
 * not on which frame produced it. When two frames wait on the same translation they resume on the
 * same settled promise, the microtask order decides which of them emits first, and both orders
 * have to leave the right picture on screen.
 */

import { describe, expect, it } from 'vitest';

import { TranslationCache } from '../../src/main/services/cache.js';
import {
  TextPipeline,
  type OverlayPayload,
  type PipelineTranslator,
} from '../../src/main/services/text-pipeline.js';
import { FallbackTranslator, type TranslationOutcome } from '../../src/main/services/translator/index.js';
import type { DisplayGeometry } from '../../src/main/utils/coordinates.js';
import type { FrameEvent } from '../../src/shared/protocol.js';
import { FakeEngine, RecordingLogger } from './translator/fakes.js';

const DISPLAY: DisplayGeometry = { bounds: { x: 0, y: 0 }, scaleFactor: 1 };

const A = 'the northern gate is open and the guards have gone';
const B = 'do not shoot until you see the signal fire';
const HUD = 'ammunition twenty seven rounds remaining';

const th = (text: string): string => `TH(${text})`;

/** Lines keep the y they are given, so a line that stays put is the same block to dedup. */
function frame(lines: readonly (readonly [string, number])[], seq: number): FrameEvent {
  return {
    ev: 'frame',
    seq,
    timings: { captureUs: 500, diffUs: 100, ocrUs: 4000 },
    monitor: { id: '\\\\.\\DISPLAY1', scale: 1, bounds: [0, 0, 1920, 1080] },
    region: [0, 0, 1200, 400],
    lines: lines.map(([text, y]) => ({ text, bbox: [0, y, 200, 20] as const })),
  };
}

/**
 * Run every microtask and every already-queued callback, so each frame gets as far as it can -
 * up to its parked engine call - before the test moves on. Not a fixed count of
 * `Promise.resolve()`s, which silently stops being enough the day a stage gains one more `await`.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function shown(payload: OverlayPayload | undefined): string[] {
  return (payload?.entries ?? []).map((entry) => entry.text);
}

interface Rig {
  readonly pipeline: TextPipeline;
  readonly engine: FakeEngine;
  readonly cache: TranslationCache;
  readonly payloads: OverlayPayload[];
  readonly logger: RecordingLogger;
  /** While closed, every engine call parks until released. */
  gate(closed: boolean): void;
  /** While true, every engine call fails - the outage path. */
  offline(on: boolean): void;
  /** Engine calls currently parked. */
  parked(): number;
  /** Let one parked call answer. `oldest` is the call that was made first. */
  release(which?: 'oldest' | 'newest'): void;
  releaseAll(): void;
  at(ms: number): void;
  handle(frame: FrameEvent): Promise<OverlayPayload | undefined>;
}

function rig(): Rig {
  let clock = 0;
  let closed = false;
  let down = false;
  const parked: (() => void)[] = [];
  const engine = new FakeEngine('google', async (texts) => {
    if (closed) {
      await new Promise<void>((resolve) => {
        parked.push(resolve);
      });
    }
    if (down) throw new Error('offline');
    return texts.map(th);
  });
  const logger = new RecordingLogger();
  const cache = new TranslationCache(':memory:', { logger });
  const payloads: OverlayPayload[] = [];
  const pipeline = new TextPipeline({
    translator: new FallbackTranslator([engine], { logger }),
    cache,
    logger,
    now: () => clock,
    onPayload: (payload) => {
      payloads.push(payload);
    },
  });

  return {
    pipeline,
    engine,
    cache,
    payloads,
    logger,
    gate: (value) => {
      closed = value;
    },
    offline: (value) => {
      down = value;
    },
    parked: () => parked.length,
    release: (which = 'oldest') => {
      const next = which === 'oldest' ? parked.shift() : parked.pop();
      if (next === undefined) throw new Error('nothing is parked');
      next();
    },
    releaseAll: () => {
      for (const next of parked.splice(0)) next();
    },
    at: (ms) => {
      clock = ms;
    },
    handle: (event) => pipeline.handleFrame(event, DISPLAY),
  };
}

describe('P1: a block another frame is still translating is shared, not dropped (#78)', () => {
  it('a subtitle still in flight when the next frame arrives is drawn, and stays drawn', async () => {
    // The reviewer's scenario 1. Subtitle A is up, B replaces it, the video keeps the pixels
    // changing so the next tick produces a frame while B is still at the engine. That frame sees
    // B as a duplicate (dedup admitted it a moment ago) with nothing on screen to hold - and before
    // #78 it emitted "A is gone, nothing else", overtook the frame carrying B, and recorded B as
    // shown. The screen then read as unchanged forever and B was never drawn.
    const h = rig();
    await h.handle(frame([[A, 120]], 1));
    expect(shown(h.payloads.at(-1))).toEqual([th(A)]);

    h.gate(true);
    h.at(4000);
    const first = h.handle(frame([[B, 120]], 2));
    await flush();
    expect(h.parked()).toBe(1);

    h.at(4800);
    const second = h.handle(frame([[B, 120]], 3));
    await flush();

    h.releaseAll();
    await Promise.all([first, second]);
    h.gate(false);

    expect(shown(h.payloads.at(-1))).toEqual([th(B)]);

    // Twelve more seconds of the same screen, long enough for dedup to readmit B more than once.
    for (let seq = 4, t = 5600; t <= 16000; seq += 1, t += 800) {
      h.at(t);
      await h.handle(frame([[B, 120]], seq));
    }
    expect(shown(h.payloads.at(-1))).toEqual([th(B)]);
    // B was sent to the engine once: the frame that arrived while it was in flight shared it.
    expect(h.engine.calls.map((call) => call.texts)).toEqual([[A], [B]]);
  });

  it.each(['oldest', 'newest'] as const)(
    'a newer frame built before the older one landed does not erase what it was carrying (%s answers first)',
    async (first) => {
      // The reviewer's scenario 2. A HUD number ticks while a subtitle sits still. Frame 2 starts
      // while frame 1 is translating both; B is a duplicate to frame 2, and before #78 frame 2's
      // payload - built from a snapshot taken before frame 1 landed - retired B's box.
      const h = rig();
      const hud = (n: number): string => `mission timer ${String(n)} seconds remaining on the clock`;
      h.gate(true);

      const one = h.handle(frame([[hud(10), 0], [B, 120]], 1));
      await flush();
      h.at(800);
      const two = h.handle(frame([[hud(9), 0], [B, 120]], 2));
      await flush();
      expect(h.parked()).toBe(2);

      h.release(first);
      await flush();
      h.release();
      await Promise.all([one, two]);

      expect(shown(h.payloads.at(-1))).toEqual([th(hud(9)), th(B)]);
      // B was not sent twice: frame 2 translated only the line that was new to it.
      expect(h.engine.calls.map((call) => call.texts)).toEqual([[hud(10), B], [hud(9)]]);
    },
  );

  it('a cache hit the in-flight frame has not delivered yet is shared too, without waiting for its misses', async () => {
    // Frame 2 sees the hit H as a duplicate. H is not in the displayed set - frame 1 is still
    // waiting on M - so without sharing, frame 2 draws no box for H, overtakes frame 1 (it has a
    // removal to report) and H is stranded exactly the way B is in the first test.
    const h = rig();
    const H = 'reinforcements are three minutes out';
    const M = 'fall back to the river crossing at once';
    h.cache.set(H, 'en', 'th', 'google', 'TH-cached');

    await h.handle(frame([[A, 0]], 1));

    h.gate(true);
    h.at(800);
    const one = h.handle(frame([[H, 120], [M, 240]], 2));
    await flush();
    expect(h.parked()).toBe(1);

    // M has left the screen; H has not. This frame needs nothing that is still at the engine, so
    // it must finish while the gate is still closed - which is the latency half of the claim.
    h.at(1600);
    const two = await h.handle(frame([[H, 120]], 3));
    expect(h.parked()).toBe(1);
    expect(shown(two)).toEqual(['TH-cached']);

    h.releaseAll();
    await one;
    expect(shown(h.payloads.at(-1))).toEqual(['TH-cached']);
  });

  it('a frame that shares nothing with the one in flight does not wait for it', async () => {
    const h = rig();
    h.gate(true);
    const slow = h.handle(frame([[A, 0]], 1));
    await flush();

    h.gate(false);
    h.at(800);
    const fast = await h.handle(frame([[B, 120]], 2));

    expect(h.parked()).toBe(1);
    expect(shown(fast)).toEqual([th(B)]);

    h.releaseAll();
    // The older frame lands late and is dropped as overtaken; the newer picture stays.
    expect(await slow).toBeUndefined();
    expect(shown(h.payloads.at(-1))).toEqual([th(B)]);
  });

  it('a frame that shares a pending translation still draws its own cache hits first', async () => {
    const h = rig();
    const H = 'reinforcements are three minutes out';
    h.cache.set(H, 'en', 'th', 'google', 'TH-cached');

    h.gate(true);
    const one = h.handle(frame([[B, 120]], 1));
    await flush();

    h.at(800);
    const two = h.handle(frame([[H, 0], [B, 120]], 2));
    await flush();

    // The hit is on screen while B is still at the engine - the progressive rule, now also for
    // a frame whose only wait is on somebody else's round trip.
    expect(h.parked()).toBe(1);
    expect(shown(h.payloads.at(-1))).toEqual(['TH-cached']);
    expect(h.payloads.at(-1)?.complete).toBe(false);

    h.releaseAll();
    await Promise.all([one, two]);
    expect(shown(h.payloads.at(-1))).toEqual(['TH-cached', th(B)]);
  });

  it('a line readmitted while its first translation is still in flight is not sent again', async () => {
    // Dedup's window is 3s. A slow engine (a timeout, a backoff) outlives it, and the next frame
    // then sees the same line as *fresh* and a cache miss - a second request for text that is
    // already being translated.
    const h = rig();
    h.gate(true);
    const one = h.handle(frame([[B, 120]], 1));
    await flush();

    h.at(3200);
    const two = h.handle(frame([[B, 120]], 2));
    await flush();

    expect(h.engine.callCount).toBe(1);

    h.releaseAll();
    await Promise.all([one, two]);
    expect(h.engine.callCount).toBe(1);
    expect(shown(h.payloads.at(-1))).toEqual([th(B)]);
  });

  it('a translator that throws fails every frame sharing its answer, loudly, instead of delivering without it', async () => {
    // `FallbackTranslator` never throws for a translation failure, but `PipelineTranslator` is
    // structural. The owning frame is skipped with an error line, as it always was. The frame
    // sharing its answer must neither hang on it nor deliver without it: delivering would record
    // B as shown in #36's baseline without B ever having been drawn.
    //
    // Deliberately stops there. What happens to B *afterwards* is not this issue's: the owning
    // frame's dedup admission of B outlives the throw, so the next frame that emits for any other
    // reason (here: A leaving) records B as shown anyway - on `main` too, with no overlap at all.
    let clock = 0;
    let release: (() => void) | undefined;
    let fail = false;
    const translator: PipelineTranslator = {
      engineNames: ['google'],
      translate: async (texts): Promise<TranslationOutcome> => {
        if (fail) {
          fail = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          throw new Error('translator bug');
        }
        return { texts: texts.map(th), engine: 'google', degraded: false, failures: [] };
      },
    };
    const logger = new RecordingLogger();
    const payloads: OverlayPayload[] = [];
    const pipeline = new TextPipeline({
      translator,
      cache: new TranslationCache(':memory:', { logger }),
      logger,
      now: () => clock,
      onPayload: (payload) => {
        payloads.push(payload);
      },
    });
    const handle = (event: FrameEvent): Promise<OverlayPayload | undefined> => pipeline.handleFrame(event, DISPLAY);

    await handle(frame([[A, 120]], 1));

    fail = true;
    clock = 4000;
    const owner = handle(frame([[B, 120]], 2));
    await flush();
    clock = 4800;
    const sharer = handle(frame([[B, 120]], 3));
    await flush();

    release?.();
    expect(await owner).toBeUndefined();
    expect(await sharer).toBeUndefined();
    expect(payloads).toHaveLength(1);
    expect(logger.lines.filter((line) => line.message.includes('frame failed in the text pipeline'))).toHaveLength(2);
  });

  it('a retry after an outage is not overtaken by the untranslated box it is replacing', async () => {
    // Why a translation in flight outranks the displayed set. B is on screen as degraded English;
    // dedup's window expires and a frame retries it. The next frame sees B as a duplicate, and the
    // displayed set offers it the degraded entry - take that, emit because the HUD changed, and
    // the retry's Thai is dropped as overtaken. Every retry, for as long as the HUD keeps moving.
    const h = rig();
    h.offline(true);
    const outage = await h.handle(frame([[B, 120]], 1));
    expect(outage?.entries.map((entry) => entry.origin)).toEqual(['degraded']);

    h.offline(false);
    h.gate(true);
    h.at(3200);
    const retry = h.handle(frame([[B, 120]], 2));
    await flush();

    h.at(4000);
    const next = h.handle(frame([[HUD, 0], [B, 120]], 3));
    await flush();
    expect(h.parked()).toBe(2);

    h.releaseAll();
    await Promise.all([retry, next]);

    expect(shown(h.payloads.at(-1))).toEqual([th(HUD), th(B)]);
    expect(h.payloads.at(-1)?.entries.map((entry) => entry.origin)).toEqual(['engine', 'engine']);
  });
});

describe('P2: frames are ordered by when Node received them, not by the sidecar seq (#78)', () => {
  it('a sidecar that restarted and counts from 1 again is still drawn', async () => {
    // A restarted sidecar is a new process and its `seq` starts over. Nothing on this path is
    // guaranteed to call `resetScene` - the supervisor re-runs `initialize`, which need not change
    // the mode - so the fix cannot depend on one.
    const h = rig();
    await h.handle(frame([[A, 120]], 3000));
    expect(h.payloads).toHaveLength(1);

    const subtitles = [
      'do not shoot until you see the signal fire',
      'reinforcements are three minutes out',
      'the bridge will not hold much longer now',
      'fall back to the river crossing at once',
    ];
    for (const [index, text] of subtitles.entries()) {
      h.at((index + 1) * 4000);
      await h.handle(frame([[text, 120]], index + 1));
    }

    expect(h.payloads.map((payload) => shown(payload))).toEqual([[th(A)], ...subtitles.map((text) => [th(text)])]);
    // The wire's number is still the sidecar's, for diagnostics - nothing renumbers it.
    expect(h.payloads.map((payload) => payload.seq)).toEqual([3000, 1, 2, 3, 4]);
  });

  it('and when a reset does happen around the restart, that is not what makes it work', async () => {
    // The reviewer's literal repro. `resetScene` never touched the ordering guard before #78, and
    // it still does not: the counter is what lets these through, with or without it.
    const h = rig();
    await h.handle(frame([[A, 120]], 3000));
    h.pipeline.resetScene('mode changed to auto');

    h.at(4000);
    const after = await h.handle(frame([[B, 120]], 1));

    expect(shown(after)).toEqual([th(B)]);
    expect(h.payloads.map((payload) => payload.seq)).toEqual([3000, 1]);
  });
});

describe('P3: resetScene fences off frames that started before it (#78)', () => {
  it.each(['dismissed', 'capture region or monitor changed', 'mode changed to paused', 'mode changed to snapshot'])(
    'a frame still translating when the scene is reset (%s) never lands, and refills nothing',
    async (reason) => {
      const h = rig();
      h.gate(true);
      const running = h.handle(frame([[A, 120]], 5));
      await flush();

      h.pipeline.resetScene(reason);
      const sent = h.payloads.length;
      h.releaseAll();

      expect(await running).toBeUndefined();
      expect(h.payloads).toHaveLength(sent);

      // Nothing from the fenced frame reached the pipeline's memory of the screen either: with a
      // stale displayed set, an empty screen now would report A as removed and emit a payload.
      h.gate(false);
      h.at(800);
      expect(await h.handle(frame([], 6))).toBeUndefined();
      expect(h.payloads).toHaveLength(sent);
    },
  );

  it('a frame that starts after the reset is unaffected, and reuses the fenced translation', async () => {
    // Auto -> snapshot: `AppOrchestrator` sends `snapshot` before the mode change is announced, and
    // the frame it produces comes back over IPC afterwards - so it always starts after the reset.
    // The in-flight auto frame is dropped; its translation is not, because translating a string
    // does not depend on which scene it was read from.
    const h = rig();
    h.gate(true);
    const auto = h.handle(frame([[A, 120]], 10));
    await flush();

    h.pipeline.resetScene('mode changed to snapshot');
    const snapshot = h.handle(frame([[A, 120]], 11));
    await flush();

    h.releaseAll();
    const [late, held] = await Promise.all([auto, snapshot]);

    expect(late).toBeUndefined();
    expect(shown(held)).toEqual([th(A)]);
    expect(h.payloads.map((payload) => payload.seq)).toEqual([11]);
    expect(h.engine.callCount).toBe(1);
  });
});
