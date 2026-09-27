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
  /**
   * Runs inside `onPayload`, before the payload is recorded. Returning `false` refuses it, the way
   * `WindowManager` does while the overlay document is starting; a refused payload is not in
   * `payloads`, because nobody saw it.
   */
  intercept(hook: ((payload: OverlayPayload) => boolean | void) | undefined): void;
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
  let hook: ((payload: OverlayPayload) => boolean | void) | undefined;
  const pipeline = new TextPipeline({
    translator: new FallbackTranslator([engine], { logger }),
    cache,
    logger,
    now: () => clock,
    onPayload: (payload) => {
      if (hook?.(payload) === false) return false;
      payloads.push(payload);
      return true;
    },
  });

  return {
    intercept: (next) => {
      hook = next;
    },
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

describe('P1: a shared line stays visible while any frame holding it is in flight (#78, verifier V1)', () => {
  /**
   * The shape all three variants share. Frame A owns X and is held at the engine. Frame B sees X
   * (shares it) and has a miss of its own, Y, so it is still in flight when A finishes. A then
   * fails to deliver - overtaken, refused or fenced - and frame C starts while B is still waiting
   * on Y. To C, X is a duplicate; if nothing still publishes it, C draws no box for X, delivers
   * after B, and records X as shown. X is cached and the screen then reads as unchanged, so X is
   * never drawn again.
   */
  const X = 'the northern gate is open and the guards have gone';
  const Y = 'fall back to the river crossing at once';
  const H = 'reinforcements are three minutes out';

  /** Twelve more seconds of the same screen, long enough for dedup to readmit everything. */
  async function hold(h: Rig, lines: readonly (readonly [string, number])[], from: number): Promise<void> {
    for (let seq = 100, t = from; t <= from + 12_000; seq += 1, t += 800) {
      h.at(t);
      await h.handle(frame(lines, seq));
    }
  }

  it('(a) the owner is overtaken by the progressive payload of a frame sharing its line', async () => {
    const h = rig();
    h.cache.set(H, 'en', 'th', 'google', 'TH-cached');
    const screen = [[H, 0], [X, 120], [Y, 240]] as const;
    h.gate(true);

    const a = h.handle(frame([[X, 120]], 1));
    await flush();
    h.at(800);
    const b = h.handle(frame(screen, 2));
    await flush();
    // B's progressive half, which is what overtakes A.
    expect(shown(h.payloads.at(-1))).toEqual(['TH-cached']);

    h.release();
    expect(await a).toBeUndefined();

    h.at(1600);
    const c = h.handle(frame(screen, 3));
    await flush();
    h.releaseAll();
    await Promise.all([b, c]);

    expect(shown(h.payloads.at(-1))).toEqual(['TH-cached', th(X), th(Y)]);
    await hold(h, screen, 2400);
    expect(shown(h.payloads.at(-1))).toEqual(['TH-cached', th(X), th(Y)]);
  });

  it('(b) the owner is refused by the renderer', async () => {
    const h = rig();
    const screen = [[X, 120], [Y, 240]] as const;
    h.gate(true);

    const a = h.handle(frame([[X, 120]], 1));
    await flush();
    h.at(800);
    const b = h.handle(frame(screen, 2));
    await flush();

    h.intercept((payload) => payload.seq !== 1);
    h.release();
    expect(await a).toBeUndefined();
    h.intercept(undefined);

    h.at(1600);
    const c = h.handle(frame(screen, 3));
    await flush();
    h.releaseAll();
    await Promise.all([b, c]);

    expect(shown(h.payloads.at(-1))).toEqual([th(X), th(Y)]);
    await hold(h, screen, 2400);
    expect(shown(h.payloads.at(-1))).toEqual([th(X), th(Y)]);
  });

  it('(c) the owner is fenced by a reset and the frame sharing its line started after it', async () => {
    const h = rig();
    const screen = [[X, 120], [Y, 240]] as const;
    h.gate(true);

    const a = h.handle(frame([[X, 120]], 1));
    await flush();
    h.pipeline.resetScene('dismissed');
    h.at(800);
    const b = h.handle(frame(screen, 2));
    await flush();
    expect(h.engine.calls.map((call) => call.texts)).toEqual([[X], [Y]]);

    h.release();
    expect(await a).toBeUndefined();

    h.at(1600);
    const c = h.handle(frame(screen, 3));
    await flush();
    h.releaseAll();
    await Promise.all([b, c]);

    expect(shown(h.payloads.at(-1))).toEqual([th(X), th(Y)]);
    await hold(h, screen, 2400);
    expect(shown(h.payloads.at(-1))).toEqual([th(X), th(Y)]);
  });

  it('control: the same screen with C arriving after B has delivered keeps X', async () => {
    // Proves the three above fail on the gap and not on the scene: without the overlap, nothing
    // in this sequence loses X.
    const h = rig();
    h.cache.set(H, 'en', 'th', 'google', 'TH-cached');
    const screen = [[H, 0], [X, 120], [Y, 240]] as const;
    h.gate(true);

    const a = h.handle(frame([[X, 120]], 1));
    await flush();
    h.at(800);
    const b = h.handle(frame(screen, 2));
    await flush();
    h.release();
    expect(await a).toBeUndefined();
    h.releaseAll();
    await b;

    h.at(1600);
    await h.handle(frame(screen, 3));
    expect(shown(h.payloads.at(-1))).toEqual(['TH-cached', th(X), th(Y)]);
    await hold(h, screen, 2400);
    expect(shown(h.payloads.at(-1))).toEqual(['TH-cached', th(X), th(Y)]);
  });

  it('a frame that starts while a payload is being handed over still sees that payload’s lines', async () => {
    // The one place "released before delivering" and "released after" can be told apart: inside
    // the delivery itself, which is synchronous. A frame is started from `onPayload` - not
    // something production does, and that is the point: it is the latest possible moment, so if
    // the lines are still published here they are published at every earlier one.
    const h = rig();
    let probe: Promise<OverlayPayload | undefined> | undefined;
    h.intercept((payload) => {
      if (probe === undefined && payload.seq === 1 && payload.complete) probe = h.handle(frame([[X, 120]], 2));
    });
    h.gate(true);

    const a = h.handle(frame([[X, 120]], 1));
    await flush();
    h.releaseAll();
    await a;

    expect(shown(await probe)).toEqual([th(X)]);
  });

  const timer = (n: number): string => `mission timer ${String(n)} seconds remaining on the clock`;

  /**
   * The HUD chain, up to the retry. A timer that changes every second gives every frame a miss of
   * its own, so each frame is still in flight when the next starts and a line they all see - X,
   * untranslated because the engine was down - is held continuously. Frame 5 reads X afresh
   * (dedup's window expired) and is left at the engine with it, with frame 4 still holding the
   * degraded answer.
   */
  async function hudChainToRetry(h: Rig): Promise<Promise<OverlayPayload | undefined>[]> {
    h.offline(true);
    h.gate(true);

    const frames: Promise<OverlayPayload | undefined>[] = [];
    frames.push(h.handle(frame([[X, 120]], 1)));
    await flush();
    h.at(800);
    frames.push(h.handle(frame([[timer(1), 0], [X, 120]], 2)));
    await flush();
    h.release(); // frame 1's X fails: degraded
    await flush();
    h.offline(false);

    for (let n = 2, t = 1600; t <= 2400; n += 1, t += 800) {
      h.at(t);
      frames.push(h.handle(frame([[timer(n), 0], [X, 120]], n + 1)));
      await flush();
      h.release();
      await flush();
    }

    h.at(3200);
    frames.push(h.handle(frame([[timer(4), 0], [X, 120]], 5)));
    await flush();
    return frames;
  }

  it('a degraded line held across a chain of overlapping frames does not block its own retry', async () => {
    // Rule (a) in `#share`. If a frame reading X afresh took the held degraded answer, X would never
    // be retried while the timer runs: English, indefinitely, with the engine healthy.
    const h = rig();
    const frames = await hudChainToRetry(h);
    expect(h.engine.calls.at(-1)?.texts).toEqual([timer(4), X]);

    h.releaseAll();
    await Promise.all(frames);
    expect(shown(h.payloads.at(-1))).toEqual([th(timer(4)), th(X)]);
    expect(h.payloads.at(-1)?.entries.map((entry) => entry.origin)).toEqual(['engine', 'engine']);
  });

  it('the retry replaces the stale answer, so a frame starting while it is out waits for it', async () => {
    // Rule (b) in `#publish`, first half. Frame 6 starts while the retry is at the engine and sees X
    // as a duplicate. Had the retry not replaced the degraded answer in `#inflight` - still held by
    // frame 4 - frame 6 would take that over everything and paint the English back over the Thai.
    const h = rig();
    const frames = await hudChainToRetry(h);
    h.at(4000);
    frames.push(h.handle(frame([[timer(5), 0], [X, 120]], 6)));
    await flush();

    h.releaseAll();
    await Promise.all(frames);
    expect(shown(h.payloads.at(-1))).toEqual([th(timer(5)), th(X)]);
  });

  it('an answer read afresh replaces a stale held one even when its frame never waits', async () => {
    // Rule (b), second half: `#publish` runs on every frame, not only the ones that wait. Frame 3
    // below finds X in the cache and has nothing to wait for, so it delivers in the turn it started
    // - and if it did not publish, the degraded X that frame 2 is still holding would stay the answer
    // in `#inflight`, and frame 4 would take it and flip the box back to English.
    const h = rig();
    h.offline(true);
    h.gate(true);
    const one = h.handle(frame([[X, 120]], 1));
    await flush();
    h.at(800);
    const two = h.handle(frame([[timer(1), 0], [X, 120]], 2));
    await flush();
    h.release(); // X fails: degraded, and frame 2 - still waiting on its timer - holds it
    await flush();
    expect(shown(h.payloads.at(-1))).toEqual([X]);

    // X's translation has reached the cache by another route since; frame 2 is still out.
    h.offline(false);
    h.cache.set(X, 'en', 'th', 'google', 'TH-cached-X');
    h.at(3200); // past dedup's window: X is read afresh
    expect(shown(await h.handle(frame([[X, 120]], 3)))).toEqual(['TH-cached-X']);

    h.at(4000);
    await h.handle(frame([[X, 120]], 4));
    expect(shown(h.payloads.at(-1))).toEqual(['TH-cached-X']);

    h.releaseAll();
    await Promise.all([one, two]);
    expect(shown(h.payloads.at(-1))).toEqual(['TH-cached-X']);
  });

  it.each([
    ['dedup readmits it', (h: Rig): void => h.at(3900)],
    ['the scene is reset', (h: Rig): void => h.pipeline.resetScene('mode changed to snapshot')],
  ])(
    'an answer that arrived while its frame still waits on a slower shared line is not requested again (%s)',
    async (_label, reread) => {
      // Frame 2 has X's answer but is still waiting on S, which frame 1 is translating. A frame that
      // reads X afresh in that window passes over frame 2's settled answer (rule (a)) and asks the
      // cache - so the answer has to be in the cache by then, not written after the shared wait.
      const h = rig();
      const S = 'reinforcements are three minutes out';
      h.gate(true);

      const one = h.handle(frame([[S, 0]], 1));
      await flush();
      h.at(800);
      const two = h.handle(frame([[S, 0], [X, 120]], 2));
      await flush();
      expect(h.parked()).toBe(2);
      h.release('newest'); // frame 2's own X answers; S is still out
      await flush();

      reread(h);
      const three = h.handle(frame([[X, 120]], 3));
      await flush();
      expect(h.engine.calls.filter((call) => call.texts.includes(X))).toHaveLength(1);

      h.releaseAll();
      await Promise.all([one, two, three]);
      expect(h.engine.calls.filter((call) => call.texts.includes(X))).toHaveLength(1);
      expect(shown(h.payloads.at(-1))).toEqual([th(X)]);
    },
  );

  it('a translator answering with a non-string cannot become an unhandled rejection', async () => {
    // `FallbackTranslator` rejects non-string results, but `PipelineTranslator` is structural. The
    // published answer is computed with `.trim()`, and a promise nobody awaits that throws there is
    // an unhandled rejection - which Electron 43 only warns about, i.e. silence (CLAUDE.md, #67).
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let release: (() => void) | undefined;
      const translator: PipelineTranslator = {
        engineNames: ['google'],
        translate: async (texts): Promise<TranslationOutcome> => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { texts: texts.map(() => 42 as unknown as string), engine: 'google', degraded: false, failures: [] };
        },
      };
      const logger = new RecordingLogger();
      const pipeline = new TextPipeline({
        translator,
        cache: new TranslationCache(':memory:', { logger }),
        logger,
        onPayload: () => {},
      });

      // Alone first - nobody else is waiting on the published answer - then with a frame sharing it.
      const alone = pipeline.handleFrame(frame([[X, 120]], 1), DISPLAY);
      await flush();
      release?.();
      expect(await alone).toBeUndefined();
      await flush();
      await flush();

      pipeline.resetScene('capture region or monitor changed');
      const owner = pipeline.handleFrame(frame([[Y, 120]], 2), DISPLAY);
      await flush();
      const sharer = pipeline.handleFrame(frame([[Y, 120]], 3), DISPLAY);
      await flush();
      release?.();
      expect(await owner).toBeUndefined();
      expect(await sharer).toBeUndefined();
      await flush();
      await flush();

      expect(logger.lines.filter((line) => line.message.includes('frame failed in the text pipeline'))).toHaveLength(3);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
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
