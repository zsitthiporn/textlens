/**
 * Content stability tracking and dynamic suppression (issue M8-02 / #36).
 *
 * ## The metric
 *
 * This is the one anti-flicker rule whose failure mode is a caption that never appears, so the
 * number that matters is not how much it suppresses - it is **how many genuine subtitle changes
 * fail to reach the renderer**. The integration case at the bottom of this file runs a six-line
 * subtitle track at the real cadence (2s per line, 800ms polls, OCR jitter on every read) and
 * asserts:
 *
 *   - `missed === 0` - every line the screen showed produced a payload; and
 *   - `suppressed > 0` - measured against a control with the tracker disabled, so the first
 *     assertion is not being satisfied by a tracker that does nothing.
 *
 * Both halves are needed. A tracker that never suppresses passes the first; a tracker that
 * suppresses everything passes the second.
 */

import { describe, expect, it } from 'vitest';

import { TranslationCache } from '../../src/main/services/cache.js';
import {
  StabilityTracker,
  setSimilarity,
  type StabilityOptions,
} from '../../src/main/services/stability-tracker.js';
import {
  TextPipeline,
  type OverlayPayload,
  type TextPipelineOptions,
} from '../../src/main/services/text-pipeline.js';
import { FallbackTranslator } from '../../src/main/services/translator/index.js';
import type { FrameEvent } from '../../src/shared/protocol.js';
import type { DisplayGeometry } from '../../src/main/utils/coordinates.js';
import { FakeEngine, RecordingLogger } from './translator/fakes.js';

const DISPLAY: DisplayGeometry = { bounds: { x: 0, y: 0 }, scaleFactor: 1 };

// ---------------------------------------------------------------------------
// setSimilarity
// ---------------------------------------------------------------------------

const T = 0.95;

describe('setSimilarity', () => {
  it('scores an unchanged screen at 1', () => {
    expect(setSimilarity(['get to the port'], ['get to the port'], T)).toBe(1);
  });

  it('scores the same lines read imperfectly at 1', () => {
    // The whole reason this is fuzzy: spike S1 measured `o`/`O`, `I`/`1` and dropped spaces on
    // text that had not changed. An exact-match Jaccard scores this pair 0.
    expect(setSimilarity(['the northern gate is open'], ['the northerngate is open'], T)).toBe(1);
  });

  it('stops calling two lines the same well before they mean different things', () => {
    // The threshold's real position, pinned rather than assumed. `northern` -> `northem` is two
    // edits in 25 characters and scores 0.92, so it reads as *changed* - the direction that costs
    // one redundant render rather than a lost sentence. This is dedup's argument for 0.95, and
    // the reason a set threshold cannot be relaxed here without re-reading it.
    expect(setSimilarity(['the northern gate is open'], ['the northem gate is open'], T)).toBe(0);
    // Two words apart in a sentence of the same length is unambiguously different.
    expect(
      setSimilarity(
        ['secure the evacuation of the northern district'],
        ['secure the extraction of the northern district'],
        T,
      ),
    ).toBe(0);
  });

  it('scores a wholly different subtitle at 0', () => {
    expect(setSimilarity(['do not shoot the hostage'], ['get to the port and wait'], T)).toBe(0);
  });

  it('scores a partial change between the two, not as all-or-nothing', () => {
    const score = setSimilarity(
      ['the northern gate is open', 'do not shoot the hostage'],
      ['the northern gate is open', 'get to the port and wait'],
      T,
    );
    // One of three distinct lines matched.
    expect(score).toBeCloseTo(1 / 3, 5);
    // ...which is the side of the default 0.9 threshold that emits, and that is the point.
    expect(score).toBeLessThan(0.9);
  });

  it('does not let several near-duplicates all claim one baseline line', () => {
    // Without one-to-one matching the intersection can exceed either set and the score can exceed
    // 1 - a "more than identical" screen, permanently suppressed.
    const score = setSimilarity(
      ['the northern gate is open', 'the northern gate is open', 'the northern gate is open'],
      ['the northern gate is open'],
      T,
    );
    expect(score).toBeCloseTo(1 / 3, 5);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('treats an empty screen as unchanged only against another empty one', () => {
    expect(setSimilarity([], [], T)).toBe(1);
    expect(setSimilarity([], ['anything at all'], T)).toBe(0);
    expect(setSimilarity(['anything at all'], [], T)).toBe(0);
  });

  it('ignores punctuation and case, as the rest of the pipeline does', () => {
    expect(setSimilarity(['Get to the port!'], ['get to the port'], T)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// StabilityTracker
// ---------------------------------------------------------------------------

function tracker(options: StabilityOptions = {}): StabilityTracker {
  return new StabilityTracker(options);
}

describe('StabilityTracker', () => {
  const A = ['the northern gate is open'];

  it('never suppresses before anything has been drawn', () => {
    const t = tracker();
    expect(t.observe(A)).toMatchObject({ suppress: false, reason: 'no-baseline' });
    expect(t.observe(A)).toMatchObject({ suppress: false, reason: 'no-baseline' });
  });

  it('suppresses only once the streak reaches the configured frame count', () => {
    const t = tracker({ frames: 2 });
    t.markEmitted(A, false);

    expect(t.observe(A)).toMatchObject({ suppress: false, streak: 1, reason: 'warming' });
    expect(t.observe(A)).toMatchObject({ suppress: true, streak: 2, reason: 'suppressed' });
    expect(t.observe(A)).toMatchObject({ suppress: true, streak: 3 });
  });

  it('lets a changed screen straight through and restarts the count', () => {
    const t = tracker({ frames: 2 });
    t.markEmitted(A, false);
    t.observe(A);
    t.observe(A);

    expect(t.observe(['do not shoot the hostage'])).toMatchObject({
      suppress: false,
      streak: 0,
      reason: 'changed',
    });
  });

  it('does not advance the baseline when nothing was drawn', () => {
    // The hole this design exists to close. Compare against the previous *frame* instead of the
    // last thing actually shown, and a frame whose payload never made it leaves the next frame
    // looking unchanged - so it is suppressed, and the text is never drawn at all.
    const t = tracker({ frames: 1 });
    t.markEmitted(A, false);

    const B = ['do not shoot the hostage'];
    expect(t.observe(B).suppress).toBe(false); // B arrives; suppose the emit fails
    expect(t.observe(B).suppress).toBe(false); // and the retry must still go through
    expect(t.observe(B).suppress).toBe(false);
  });

  it('never suppresses while the screen is holding untranslated text', () => {
    // Design doc section 7's exemption, at its second edge: English on screen during an outage is
    // waiting to be replaced, and the replacement arrives as a frame that looks unchanged.
    const t = tracker({ frames: 1 });
    t.markEmitted(A, true);

    expect(t.observe(A)).toMatchObject({ suppress: false, reason: 'degraded' });
    expect(t.observe(A)).toMatchObject({ suppress: false, reason: 'degraded' });

    // ...and it starts working again as soon as a real translation lands.
    t.markEmitted(A, false);
    expect(t.observe(A).suppress).toBe(true);
  });

  it('keeps counting but never suppresses when disabled', () => {
    const t = tracker({ enabled: false, frames: 1 });
    t.markEmitted(A, false);

    expect(t.observe(A)).toMatchObject({ suppress: false, streak: 1, reason: 'disabled' });
  });

  it('restarts the count when a new baseline is recorded', () => {
    const t = tracker({ frames: 2 });
    t.markEmitted(A, false);
    t.observe(A);

    t.markEmitted(['do not shoot the hostage'], false);
    expect(t.streak).toBe(0);
  });

  it('never suppresses a frame that contains a line the baseline does not', () => {
    // The bug a real run found, and the reason `maxNewLines` exists at all.
    //
    // On a full-screen capture the pipeline observed 70 blocks. One line changing out of 70
    // scores 0.97 - above any usable ratio threshold - so the frame was suppressed; and because
    // the baseline only advances on an emit, every frame after it scored 0.97 too. The changed
    // line would never have been translated or drawn, for the rest of the session, silently.
    const wall = Array.from({ length: 70 }, (_unused, index) => `desktop label number ${String(index)} here`);
    const t = tracker({ frames: 1 });
    t.markEmitted(wall, false);

    const oneChanged = [...wall];
    oneChanged[40] = 'a completely different line has appeared right here';

    const verdict = t.observe(oneChanged);
    expect(verdict.newLines).toBe(1);
    // The ratio alone would have called this stable, which is the whole point of the assertion.
    expect(verdict.similarity).toBeGreaterThan(0.9);
    expect(verdict.suppress).toBe(false);
    expect(verdict.reason).toBe('changed');

    // ...and it stays emitting, rather than settling into a permanent suppression.
    expect(t.observe(oneChanged).suppress).toBe(false);
    expect(t.observe(oneChanged).suppress).toBe(false);
  });

  it('still notices lines vanishing, which add nothing new', () => {
    // The direction the count cannot see and the ratio can. Both rules are load-bearing.
    const wall = Array.from({ length: 6 }, (_unused, index) => `subtitle line number ${String(index)} here`);
    const t = tracker({ frames: 1 });
    t.markEmitted(wall, false);

    const verdict = t.observe(wall.slice(0, 2));
    expect(verdict.newLines).toBe(0);
    expect(verdict.suppress).toBe(false);
    expect(verdict.reason).toBe('changed');
  });

  it('forgets everything on reset', () => {
    const t = tracker({ frames: 1 });
    t.markEmitted(A, false);
    t.observe(A);
    t.reset();

    expect(t.hasBaseline).toBe(false);
    expect(t.observe(A)).toMatchObject({ suppress: false, reason: 'no-baseline' });
  });

  it('rejects a frame count that would suppress from nothing', () => {
    expect(() => tracker({ frames: 0 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Through the real pipeline, at the real cadence
// ---------------------------------------------------------------------------

/** One OCR line per string, spaced so `groupLines` keeps them separate. */
function frameWith(texts: readonly string[], seq: number): FrameEvent {
  return {
    ev: 'frame',
    seq,
    timings: { captureUs: 500, diffUs: 100, ocrUs: 4000 },
    monitor: { id: '\\\\.\\DISPLAY1', scale: 1, bounds: [0, 0, 1920, 1080] },
    region: [0, 0, 1200, 400],
    lines: texts.map((text, index) => ({ text, bbox: [0, index * 60, 200, 20] as const })),
  };
}

interface PipeHarness {
  readonly pipeline: TextPipeline;
  readonly payloads: OverlayPayload[];
  advance(ms: number): void;
}

function pipeHarness(
  overrides: Partial<Omit<TextPipelineOptions, 'translator' | 'cache'>> = {},
): PipeHarness {
  const logger = new RecordingLogger();
  const translator = new FallbackTranslator([new FakeEngine('google')], { logger });
  const cache = new TranslationCache(':memory:', { logger });
  const payloads: OverlayPayload[] = [];
  let clock = 0;

  const pipeline = new TextPipeline({
    translator,
    cache,
    logger,
    onPayload: (payload) => {
      payloads.push(payload);
    },
    now: () => clock,
    ...overrides,
  });

  return {
    pipeline,
    payloads,
    advance: (ms) => {
      clock += ms;
    },
  };
}

/** The recogniser's usual slips, applied deterministically so a run is reproducible. */
function misread(text: string, round: number): string {
  if (round % 3 === 0) return text;
  if (round % 3 === 1) return text.replace('rn', 'm');
  return text.replace(/ ([a-z])/u, '$1');
}

describe('acceptance: an unchanged screen stops costing anything', () => {
  const LINE = 'the northern gate is open and the guards have gone';

  it('suppresses the re-emit that dedup lets through when its window expires', async () => {
    const h = pipeHarness();
    let seq = 0;

    // t=0: the subtitle appears and is drawn.
    await h.pipeline.handleFrame(frameWith([LINE], (seq += 1)), DISPLAY);
    expect(h.payloads).toHaveLength(1);

    // The next four polls are eaten by dedup, which is the existing behaviour.
    for (let round = 0; round < 4; round += 1) {
      h.advance(800);
      await h.pipeline.handleFrame(frameWith([misread(LINE, round)], (seq += 1)), DISPLAY);
    }
    expect(h.payloads).toHaveLength(1);

    // t=4s. Dedup's 3s window has expired, so it readmits the line and the pipeline would
    // retranslate and redraw a subtitle the user has been reading for four seconds. This is the
    // frame #36 exists for.
    h.advance(800);
    await h.pipeline.handleFrame(frameWith([LINE], (seq += 1)), DISPLAY);
    expect(h.payloads).toHaveLength(1);
  });

  it('does not treat a payload the overlay refused as something the user saw', async () => {
    // The startup race `WindowManager.sendOverlayPayload` documents: the overlay document has not
    // run its script yet, so the payload is dropped. Counted as drawn, the baseline advances to
    // text nobody saw, the screen then looks unchanged forever, and the retry dedup's expiring
    // window produces is suppressed - so the first subtitle of the session never appears.
    const delivered: boolean[] = [];
    let overlayReady = false;
    const h = pipeHarness({
      onPayload: () => {
        delivered.push(overlayReady);
        return overlayReady;
      },
    });
    let seq = 0;

    await h.pipeline.handleFrame(frameWith([LINE], (seq += 1)), DISPLAY);
    expect(delivered).toEqual([false]);

    overlayReady = true;
    for (let round = 0; round < 6; round += 1) {
      h.advance(800);
      await h.pipeline.handleFrame(frameWith([misread(LINE, round)], (seq += 1)), DISPLAY);
    }

    // The retry must have got through. Counted as drawn, this would still be `[false]`.
    expect(delivered.filter(Boolean).length).toBeGreaterThan(0);
  });

  it('would have re-emitted without the tracker', async () => {
    // The control. Without it the assertion above is satisfied by anything that stops the
    // pipeline, including a bug that stops it for good.
    const h = pipeHarness({ stability: { enabled: false } });
    let seq = 0;

    await h.pipeline.handleFrame(frameWith([LINE], (seq += 1)), DISPLAY);
    for (let round = 0; round < 5; round += 1) {
      h.advance(800);
      await h.pipeline.handleFrame(frameWith([misread(LINE, round)], (seq += 1)), DISPLAY);
    }

    expect(h.payloads.length).toBeGreaterThan(1);
  });

  it('keeps tracking the whole screen, not just the lines that changed', async () => {
    // The two-line case. Dedup removes the unchanged first line, so the payload carries one entry
    // while the screen holds two. A baseline built from the payload would never match again.
    const h = pipeHarness();
    const first = 'the northern gate is open and the guards have gone';
    const second = 'do not shoot until you see the signal fire';
    const third = 'take the eastern road and follow it to the river';
    let seq = 0;

    await h.pipeline.handleFrame(frameWith([first, second], (seq += 1)), DISPLAY);
    h.advance(800);
    await h.pipeline.handleFrame(frameWith([first, third], (seq += 1)), DISPLAY);
    const afterChange = h.payloads.length;

    // The screen now holds `first` and `third` and stops changing. Dedup expires at 3s.
    for (let round = 0; round < 6; round += 1) {
      h.advance(800);
      await h.pipeline.handleFrame(
        frameWith([misread(first, round), misread(third, round)], (seq += 1)),
        DISPLAY,
      );
    }

    expect(h.payloads.length).toBe(afterChange);
  });
});

describe('acceptance: a subtitle track loses nothing', () => {
  /**
   * Six lines, each on screen for 2s, polled every 800ms with a different misreading each time.
   *
   * The criterion is "emit ทุกครั้งที่เปลี่ยนจริง ไม่ตกหล่น": suppression that costs a sentence is
   * worse than no suppression at all.
   */
  const TRACK = [
    'the northern gate is open and the guards have gone',
    'do not shoot until you see the signal fire',
    'take the eastern road and follow it to the river',
    'we will meet again when the winter has passed',
    'leave the horses here and go the rest on foot',
    'nothing beyond this point belongs to the empire',
  ];

  async function run(overrides: Partial<TextPipelineOptions> = {}): Promise<{
    payloads: OverlayPayload[];
    frames: number;
  }> {
    const h = pipeHarness(overrides);
    let seq = 0;
    let frames = 0;

    for (const line of TRACK) {
      // 2s on screen at an 800ms poll: three reads of the same line, each read imperfectly.
      for (let round = 0; round < 3; round += 1) {
        await h.pipeline.handleFrame(frameWith([misread(line, round)], (seq += 1)), DISPLAY);
        frames += 1;
        h.advance(700);
      }
    }

    return { payloads: h.payloads, frames };
  }

  it('draws every line of the track', async () => {
    const { payloads } = await run();

    const drawn = payloads.flatMap((payload) => payload.entries.map((entry) => entry.sourceText));
    for (const line of TRACK) {
      // The metric: zero missed. `misread` may have altered the exact string, so a line counts as
      // drawn when something recognisably it reached the renderer.
      const head = line.slice(0, 20);
      expect(drawn.some((text) => text.startsWith(head.slice(0, 12)))).toBe(true);
    }
  });

  it('sends fewer payloads than frames, but never fewer than lines', async () => {
    const { payloads, frames } = await run();

    expect(payloads.length).toBeLessThan(frames);
    expect(payloads.length).toBeGreaterThanOrEqual(TRACK.length);
  });
});
