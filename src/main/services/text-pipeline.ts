/**
 * The text half of the pipeline, end to end (issue M4-05, feature T10).
 *
 * Everything from M3 and M4 exists and is tested in isolation; nothing joined them up. This
 * module is that join, and it is the executable form of the data-flow diagram in design doc
 * section 4 - one `frame` in, one overlay payload out:
 *
 *     lines -> logical px -> blocks -> noise -> feedback -> dedup
 *           -> already Thai? skip -> cache lookup
 *                ├─ hit  -> render immediately (progressive)
 *                └─ miss -> translate -> write cache -> render
 *
 * It composes; it does not reimplement. Every rule about *what* counts as noise, as feedback,
 * as a duplicate or as the same string lives in the module that owns it, and this file's job is
 * to call them in the right order and keep the rows straight.
 *
 * ## Row binding is the failure this file is built around
 *
 * Two stages take a **subset** of the blocks and hand back results for that subset only: the
 * same-language skip and the cache. A miss set is a scattered subset of the survivors, and the
 * translator answers with a dense array indexed by *its* input, not by ours. Zipping those two
 * together positionally is how a translation ends up under a neighbour's text - and that failure
 * is silent, fluent and confident. There is no error anywhere; the user simply reads the wrong
 * caption under the right English.
 *
 * So results are never zipped. A single `translated` array is sized to the survivor list once,
 * and every stage writes into it *at the survivor's own index*, carried explicitly in an index
 * array (`pending`, `misses`). Nothing is ever appended in the order it came back.
 *
 * The translator already guarantees a same-length answer (`assertBatchShape`), but that
 * guarantee is checked again here, because {@link PipelineTranslator} is a structural type and
 * a future implementation - an LLM adapter, a test double - can violate it. A mismatch is
 * treated as a total engine failure rather than a partially-believed batch: originals, marked
 * degraded, logged loudly.
 *
 * ## Two rules that interact, and one of them almost erased the warning
 *
 * The issue asks that a translation identical to its source not be forwarded to render, because
 * it carries nothing. Design doc section 7 asks that when every engine fails the user sees the
 * **original text plus a warning**. Applied naively those two rules cancel: the degraded outcome
 * *is* the original text, every entry is "identical to its source", and the overlay goes blank
 * at exactly the moment it most needs to say something.
 *
 * Identical-suppression therefore applies only to results that came back from a cache or an
 * engine. A degraded entry is kept and carries `origin: 'degraded'`, and the payload carries
 * `degraded`/`failures` outward so that M10-02 (#41) has something to render the warning from.
 * Nothing renders it yet; carrying it is this issue's obligation, showing it is that one's.
 *
 * "Identical" is exact string equality after trimming, not `normalizeForComparison`. The
 * acceptance criterion says *เป๊ะ* (exactly), and the two errors are not symmetric: keeping a
 * box that repeats the English is visible clutter, while suppressing a real translation is a
 * caption that silently never appears.
 *
 * ## T10 in a pipeline whose recognizer cannot emit Thai
 *
 * The Thai-script filter (F3) runs before this stage and drops anything containing Thai as our
 * own output coming back around, so with the shipped defaults a block never reaches the
 * same-language check. That check is still here and still tested, for two reasons: F3 is
 * configurable (`maxThaiRatio: 1` switches it off) and feature O7 will make the source language
 * selectable, at which point Thai on screen stops being proof that we drew it. It reuses
 * `thaiScriptRatio` rather than adding a second Thai detector - two of those would eventually
 * disagree.
 *
 * A block skipped as already-Thai produces no overlay entry at all. Its "translation" is itself,
 * which is the identical-to-source case, which carries nothing.
 *
 * ## Cache keys name an engine, and this is which one
 *
 * `TranslationCache` keys on `src + tgt + engineName` (K1), and at lookup time nobody knows
 * which engine will answer. Lookups use the **primary** engine, writes use the engine that
 * **actually answered**. With the MVP's single-engine chain those are the same string. With a
 * longer chain, a fallback engine's results are stored under its own name and are not re-served
 * under the primary's key - the wasteful direction, chosen because the alternative serves text
 * from one engine under another engine's name, which quietly defeats a user who changed engines
 * to change the output.
 *
 * ## What is deliberately not here
 *
 * - **`RecentOutputs.remember`.** That module is explicit that only the stage which actually
 *   puts something on screen may record it, and that stage is M5-01. This one reads (`has`) and
 *   does not write, so an optional `recentOutputs` passed in today filters nothing and is
 *   correct the moment render starts remembering.
 * - **Monitor-to-Display pairing.** `handleFrame` takes the `DisplayGeometry` from its caller;
 *   picking the right display for `frame.monitor.id` is M6-01, and `coordinates.ts` explains at
 *   length why it cannot be derived from the wire.
 * - **`electron`.** Nothing here imports it, so the whole file runs under plain `vitest`. The
 *   HTTP transport is a required parameter of {@link createTextPipeline} precisely so that the
 *   app can hand it Electron's `net.fetch` (which honours the system proxy) and forgetting to
 *   is a compile error rather than a class of user with no translations and no explanation.
 */

import type { FrameEvent } from '../../shared/protocol.js';
import { toLogicalRect, type DisplayGeometry, type LogicalRect } from '../utils/coordinates.js';
import { filterNoise, type NoiseFilterOptions } from '../utils/noise-filter.js';
import { groupLines, type GroupingOptions, type PositionedLine, type TextBlock } from '../utils/text-grouping.js';
import {
  filterThaiScript,
  thaiScriptRatio,
  type ThaiScriptFilterOptions,
} from '../utils/thai-script-filter.js';
import { TranslationCache, type CacheLookup, type CacheStatus, type CacheWrite } from './cache.js';
import { dedupeBlocks, Deduplicator, type DedupOptions } from './dedup.js';
import { nullLogger, type Logger } from './logger.js';
import type { MetricsRecorder } from './metrics.js';
import type { RecentOutputs } from './recent-outputs.js';
import { StabilityTracker, type StabilityOptions } from './stability-tracker.js';
import type { GoogleEngineOptions } from './translator/engines/google.js';
import {
  createDefaultRegistry,
  FallbackTranslator,
  withRateLimit,
  type EngineFailure,
  type RateLimiterOptions,
  type TranslationOutcome,
} from './translator/index.js';
import type { HttpFetch } from './translator/types.js';

/** Where an overlay entry's text came from. `degraded` means it is the untranslated original. */
export type EntryOrigin = 'cache' | 'engine' | 'degraded';

/** One box for the renderer: what to draw, and the source rectangle to draw it under. */
export interface OverlayEntry {
  /** The text to display. The original when `origin` is `degraded`. */
  readonly text: string;
  /** The OCR text this came from. M5-03's sticky placement compares on it; M5-01 remembers it. */
  readonly sourceText: string;
  /** Logical px, absolute on the virtual desktop. The renderer converts to CSS px. */
  readonly bbox: LogicalRect;
  readonly origin: EntryOrigin;
}

/**
 * Counts for one frame. Every number is a count or a length - never text - so the whole object
 * is safe in a default-level log line (PR3).
 */
export interface PipelineStats {
  readonly lines: number;
  readonly blocks: number;
  /** Dropped by the noise filter (#14). */
  readonly noise: number;
  /** Dropped by the Thai-script feedback filter, F3 (#15). */
  readonly thaiFeedback: number;
  /** Dropped because the overlay recently displayed this string, F2 (#15). */
  readonly recentOutput: number;
  /** Dropped as already handled by dedup (#16). */
  readonly duplicate: number;
  /**
   * Consecutive frames this screen has looked unchanged (#36). 0 means it just changed.
   *
   * A count, so it is safe in a default-level log line, and it is the number that explains why a
   * frame produced nothing: an unchanged screen and a broken pipeline are otherwise identical
   * from the outside, which is the failure invariant 4 forbids.
   */
  readonly stableStreak: number;
  /** Skipped by T10 - the text is already in the target language. */
  readonly sameLanguage: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  /** Translated, but the result equalled the source, so it was not forwarded to render. */
  readonly identical: number;
  /** Entries in this payload. */
  readonly rendered: number;
}

/** The half of {@link PipelineStats} that the group/filter/dedup stage produces. */
export type CollectStats = Pick<
  PipelineStats,
  'lines' | 'blocks' | 'noise' | 'thaiFeedback' | 'recentOutput' | 'duplicate' | 'stableStreak'
>;

/**
 * What the pipeline hands to the render stage.
 *
 * Sent up to twice per frame, both carrying the same `seq`: once with the cache hits alone
 * (`complete: false`) while the misses are still in flight, and once with the whole set. That
 * is the progressive-render branch of the design doc section 4 diagram - a cache hit costs 0ms
 * and has no reason to wait behind a 300-500ms round trip. The second payload is the *full*
 * set, not the remainder, so a renderer that replaces its contents wholesale stays correct.
 */
export interface OverlayPayload {
  /** The `frame.seq` this came from. Two payloads may share one. */
  readonly seq: number;
  /** False for the progressive first half; true for the frame's final payload. */
  readonly complete: boolean;
  readonly entries: readonly OverlayEntry[];
  /** True when at least one entry is an untranslated original because every engine failed. */
  readonly degraded: boolean;
  /** The engine that answered, or null when none was called or all of them failed. */
  readonly engine: string | null;
  /** Every engine failure behind this frame, in order. M10-02 (#41) renders these. */
  readonly failures: readonly EngineFailure[];
  /** `disabled` when the translation cache is running without a database. */
  readonly cacheStatus: CacheStatus;
  readonly stats: PipelineStats;
}

/**
 * The translator, structurally.
 *
 * `FallbackTranslator` satisfies this. Declaring the shape rather than the class is what lets a
 * test drive the pipeline with a spy and count engine calls, which is the only way to prove
 * "the engine was never called" - an engine that *was* called and echoed its input is
 * indistinguishable from one that was skipped if you only look at the output.
 */
export interface PipelineTranslator {
  readonly engineNames: readonly string[];
  translate(texts: readonly string[], src: string, tgt: string): Promise<TranslationOutcome>;
}

/** The cache, structurally. `TranslationCache` satisfies this. */
export interface PipelineCache {
  readonly status: CacheStatus;
  getBatch(lookups: readonly CacheLookup[]): (string | undefined)[];
  setBatch(writes: readonly CacheWrite[]): void;
}

export interface TextPipelineOptions {
  readonly translator: PipelineTranslator;
  readonly cache: PipelineCache;
  /**
   * Called with every payload. Up to twice per frame; see {@link OverlayPayload}.
   *
   * **Return `false` when the payload did not actually reach a renderer.** `WindowManager`
   * refuses one when the overlay document has not run its script yet, which is a documented
   * startup race rather than a rarity - and #36's baseline may only advance on something the
   * user could have seen. Anything other than `false`, `undefined` included, counts as
   * delivered, so a caller that does not care need not say anything.
   */
  readonly onPayload: (payload: OverlayPayload) => boolean | void;
  readonly logger?: Logger;
  readonly metrics?: MetricsRecorder;
  /** Reused across frames - the time window is the point. One is created if none is passed. */
  readonly deduplicator?: Deduplicator;
  readonly dedup?: DedupOptions;
  /**
   * Dynamic suppression of a screen that has not changed (#36).
   *
   * Reused across frames like the deduplicator, and for the same reason: the whole rule is about
   * what the previous frames looked like. One is created if none is passed.
   */
  readonly stabilityTracker?: StabilityTracker;
  readonly stability?: StabilityOptions;
  /** Read-only here; see the module comment on why `remember` is M5-01's call. */
  readonly recentOutputs?: RecentOutputs;
  readonly grouping?: GroupingOptions;
  readonly noise?: NoiseFilterOptions;
  readonly thaiScript?: ThaiScriptFilterOptions;
  /** BCP-47-ish tags handed to the engine and mixed into the cache key. */
  readonly srcLang?: string;
  readonly tgtLang?: string;
  /**
   * Fraction of script-bearing characters that must already be Thai for T10 to skip the block.
   * Default 0.5 - a majority. Below that the block is mixed, and the English half is still
   * worth translating.
   */
  readonly sameLanguageMinRatio?: number;
  /** Wall clock in ms. Feeds dedup's window and the translate-stage timer. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export const DEFAULT_SRC_LANG = 'en';
export const DEFAULT_TGT_LANG = 'th';
export const DEFAULT_SAME_LANGUAGE_MIN_RATIO = 0.5;

/** Nothing was translated this frame - no engine was called, so there is nothing to report. */
const NO_TRANSLATION: TranslationOutcome = { texts: [], engine: null, degraded: false, failures: [] };

export class TextPipeline {
  readonly #translator: PipelineTranslator;
  readonly #cache: PipelineCache;
  /**
   * Held as `unknown`-returning rather than as the option's `boolean | void`.
   *
   * TypeScript treats `void` as having no overlap with `false`, so comparing the declared type
   * against `false` is an error - while the whole point of that type is that a consumer which
   * does not care may return nothing at all. `unknown` is what lets an explicit refusal be
   * checked without a cast.
   */
  readonly #onPayload: (payload: OverlayPayload) => unknown;
  readonly #logger: Logger;
  readonly #metrics: MetricsRecorder | undefined;
  readonly #deduplicator: Deduplicator;
  readonly #stability: StabilityTracker;
  readonly #recentOutputs: RecentOutputs | undefined;
  readonly #grouping: GroupingOptions;
  readonly #noise: NoiseFilterOptions;
  readonly #thaiScript: ThaiScriptFilterOptions;
  readonly #srcLang: string;
  readonly #tgtLang: string;
  readonly #sameLanguageMinRatio: number;
  readonly #now: () => number;

  /**
   * Highest `seq` handed to the renderer so far.
   *
   * Frames arrive from an event handler that does not await, so a frame whose misses take 400ms
   * can still be in flight when the next one lands. Without this guard the slow frame's complete
   * payload lands *after* the newer one and the overlay reverts to stale text - which looks like
   * flicker, not like a bug. `>=` rather than `>` so a frame's own partial payload does not lock
   * out its complete one.
   */
  #lastEmittedSeq = Number.NEGATIVE_INFINITY;
  #cacheDisabledReported = false;

  constructor(options: TextPipelineOptions) {
    this.#translator = options.translator;
    this.#cache = options.cache;
    this.#onPayload = options.onPayload;
    this.#logger = (options.logger ?? nullLogger()).child('pipeline');
    this.#metrics = options.metrics;
    this.#deduplicator = options.deduplicator ?? new Deduplicator(options.dedup ?? {});
    this.#stability = options.stabilityTracker ?? new StabilityTracker(options.stability ?? {});
    this.#recentOutputs = options.recentOutputs;
    this.#grouping = options.grouping ?? {};
    this.#noise = options.noise ?? {};
    this.#thaiScript = options.thaiScript ?? {};
    this.#srcLang = options.srcLang ?? DEFAULT_SRC_LANG;
    this.#tgtLang = options.tgtLang ?? DEFAULT_TGT_LANG;
    this.#sameLanguageMinRatio = options.sameLanguageMinRatio ?? DEFAULT_SAME_LANGUAGE_MIN_RATIO;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Run one frame all the way to an overlay payload.
   *
   * @param display The Electron `Display` the region was captured from. The caller pairs it to
   *                `frame.monitor.id`; see the module comment.
   * @returns The complete payload as emitted, or `undefined` when nothing new survived to be
   *          drawn or a newer frame had already reached the renderer first.
   *
   * Never rejects. The caller is an event handler that cannot await, so an exception escaping
   * here would be an unhandled rejection - a crash or a silence, both forbidden by invariant 4.
   */
  async handleFrame(frame: FrameEvent, display: DisplayGeometry): Promise<OverlayPayload | undefined> {
    const startedAt = this.#now();
    try {
      return await this.#run(frame, display, startedAt);
    } catch (error) {
      this.#logger.error('frame failed in the text pipeline; skipping it', {
        seq: frame.seq,
        lines: frame.lines.length,
        error: error instanceof Error ? `${error.name}: ${error.message}` : typeof error,
      });
      return undefined;
    }
  }

  async #run(
    frame: FrameEvent,
    display: DisplayGeometry,
    startedAt: number,
  ): Promise<OverlayPayload | undefined> {
    const nowMs = startedAt;

    // ---- group + filter + dedup (design doc section 4: one 5ms budget row) ----------------
    const survivors = this.#collect(frame, display, nowMs);

    // #36. Called for **every** frame, including the ones that end below, because the streak is a
    // count of consecutive observations - skip the call on a quiet frame and the count is wrong
    // for the loud one after it.
    const stability = this.#stability.observe(survivors.observed);
    const counts: CollectStats = { ...survivors.counts, stableStreak: stability.streak };

    if (survivors.blocks.length === 0) {
      // "ไม่เหลืออะไรใหม่? จบรอบ" - and deliberately no empty payload. Dedup suppresses text
      // that is still on screen unchanged, so an empty round means "nothing new", not "nothing
      // to show"; emitting one would make a renderer that replaces its contents clear the
      // overlay on every steady frame. Invariant 4 is served by the counts in this log line.
      this.#logger.debug('nothing new in this frame', { seq: frame.seq, ...counts });
      this.#recordTotal(frame, startedAt);
      return undefined;
    }

    if (stability.suppress) {
      // Dedup let something through - normally because its 3s window expired under a subtitle
      // that is still on screen - but the screen as a whole has not changed since the last thing
      // the user was shown. Translating and redrawing it would repaint a picture they are already
      // reading. Counts only, and the streak is in them, so this is never a silent drop.
      this.#logger.debug('screen unchanged; suppressing this frame', {
        seq: frame.seq,
        similarity: Math.round(stability.similarity * 100) / 100,
        newLines: stability.newLines,
        ...counts,
      });
      this.#recordTotal(frame, startedAt);
      return undefined;
    }

    // ---- T10: text that is already in the target language never reaches an engine ----------
    const blocks = survivors.blocks;
    const translated: (string | undefined)[] = blocks.map(() => undefined);
    const origins: EntryOrigin[] = blocks.map(() => 'engine');

    /** Indices into `blocks` that still need a translation from somewhere. */
    const pending: number[] = [];
    let sameLanguage = 0;
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block === undefined) continue;
      if (this.#isAlreadyTargetLanguage(block.text)) {
        // No entry is produced: its translation would be itself, which is the identical case.
        sameLanguage += 1;
        continue;
      }
      pending.push(index);
    }

    // ---- cache lookup, one batched query -------------------------------------------------
    const translateStartedAt = this.#now();
    const lookupEngine = this.#translator.engineNames[0] ?? 'unknown';
    const hits = this.#cache.getBatch(
      pending.map((index) => this.#lookupFor(blocks[index]?.text ?? '', lookupEngine)),
    );

    /** Indices into `blocks`, for the blocks the cache could not answer. A scattered subset. */
    const misses: number[] = [];
    let cacheHits = 0;
    for (let slot = 0; slot < pending.length; slot += 1) {
      const index = pending[slot];
      if (index === undefined) continue;
      const hit = hits[slot];
      if (hit === undefined) {
        misses.push(index);
        continue;
      }
      // Written at the *block's* index, never appended. See the module comment.
      translated[index] = hit;
      origins[index] = 'cache';
      cacheHits += 1;
    }
    this.#reportCacheStatus();

    const baseStats = {
      ...counts,
      sameLanguage,
      cacheHits,
      cacheMisses: misses.length,
    };

    // ---- progressive render: hits do not wait behind a 300-500ms round trip ---------------
    const partial = cacheHits > 0 && misses.length > 0 ? this.#buildEntries(blocks, translated, origins) : undefined;
    // `partial.entries` can be empty even with hits: identical translations are cached (a proper
    // noun comes back unchanged from every engine), so the next frame's hit is suppressed as
    // identical and there is nothing early to draw. Emitting that would clear a renderer that
    // replaces its contents - the same reason the empty round below emits nothing.
    if (partial !== undefined && partial.entries.length > 0) {
      this.#emit({
        seq: frame.seq,
        complete: false,
        entries: partial.entries,
        degraded: false,
        engine: null,
        failures: [],
        cacheStatus: this.#cache.status,
        stats: { ...baseStats, identical: partial.identical, rendered: partial.entries.length },
      });
    }

    // ---- translate the misses, and only the misses ---------------------------------------
    const outcome = misses.length === 0 ? NO_TRANSLATION : await this.#translateMisses(blocks, misses);

    const degraded = outcome.degraded;
    for (let slot = 0; slot < misses.length; slot += 1) {
      const index = misses[slot];
      if (index === undefined) continue;
      const block = blocks[index];
      if (block === undefined) continue;
      // `outcome.texts` is dense and indexed by the miss batch; `index` is where that miss sits
      // in the survivor list. Conflating the two is the row shift this module exists to avoid.
      translated[index] = outcome.texts[slot] ?? block.text;
      origins[index] = degraded ? 'degraded' : 'engine';
    }

    if (!degraded && outcome.engine !== null && misses.length > 0) {
      this.#writeBack(blocks, misses, translated, outcome.engine);
    }

    if (misses.length > 0) {
      this.#metrics?.record('translate', this.#now() - translateStartedAt);
    }

    // ---- payload --------------------------------------------------------------------------
    const built = this.#buildEntries(blocks, translated, origins);
    const payload: OverlayPayload = {
      seq: frame.seq,
      complete: true,
      entries: built.entries,
      degraded,
      engine: outcome.engine,
      failures: outcome.failures,
      cacheStatus: this.#cache.status,
      stats: { ...baseStats, identical: built.identical, rendered: built.entries.length },
    };

    this.#recordTotal(frame, startedAt);

    if (payload.entries.length === 0) {
      // The baseline is deliberately **not** advanced here. Nothing reached the screen, so the
      // next frame must still read as new - otherwise this frame's text is suppressed from now
      // on and never drawn at all.
      this.#logger.debug('every block translated to its own source; nothing to draw', {
        seq: frame.seq,
        ...payload.stats,
      });
      return undefined;
    }

    if (!this.#emit(payload)) return undefined;

    // #36's baseline moves only here - after a payload has actually reached the renderer - and it
    // records the frame's **whole observed set**, not the entries this payload carried. Dedup
    // routinely removes the lines that did not change, so the payload describes the delta while
    // the baseline has to describe the screen.
    this.#stability.markEmitted(survivors.observed, degraded);
    return payload;
  }

  /**
   * Forget what the screen looked like (#36's "reset ได้เมื่อเปลี่ยน region หรือ mode").
   *
   * Not folded into a config listener here: this module has no config subscription and gaining
   * one would give it a second route to its own behaviour. `src/main/index.ts` calls this.
   */
  resetStability(reason: string): void {
    this.#stability.reset();
    this.#logger.debug('stability baseline cleared', { reason });
  }

  /** Convert, group, and run every drop rule. Synchronous, and timed as one budget row. */
  #collect(
    frame: FrameEvent,
    display: DisplayGeometry,
    nowMs: number,
  ): { blocks: readonly TextBlock[]; observed: readonly string[]; counts: Omit<CollectStats, 'stableStreak'> } {
    type Collected = {
      blocks: readonly TextBlock[];
      observed: readonly string[];
      counts: Omit<CollectStats, 'stableStreak'>;
    };
    const work = (): Collected => {
      const positioned: PositionedLine[] = frame.lines.map((line) => ({
        text: line.text,
        rect: toLogicalRect(line.bbox, frame.region, display),
      }));

      const grouped = groupLines(positioned, this.#grouping);
      const noise = filterNoise(grouped, this.#noise);
      const thai = filterThaiScript(noise.kept, this.#thaiScript);

      // F2. Read-only: `remember` belongs to the stage that actually draws (M5-01).
      const recent = this.#recentOutputs;
      const afterRecent =
        recent === undefined ? thai.kept : thai.kept.filter((block) => !recent.has(block.text));
      const recentDropped = thai.kept.length - afterRecent.length;

      const deduped = dedupeBlocks(afterRecent, this.#deduplicator, nowMs);

      return {
        blocks: deduped.kept,
        // **Before** dedup, on purpose (#36). Dedup removes precisely the lines that make a frame
        // look unchanged, so the post-dedup list describes what is new while this describes what
        // is on the screen - and "has the screen changed" can only be asked of the second one.
        observed: afterRecent.map((block) => block.text),
        counts: {
          lines: frame.lines.length,
          blocks: grouped.length,
          noise: noise.dropped.length,
          thaiFeedback: thai.dropped.length,
          recentOutput: recentDropped,
          duplicate: deduped.dropped.length,
        },
      };
    };

    return this.#metrics === undefined ? work() : this.#metrics.measure('group', work);
  }

  async #translateMisses(
    blocks: readonly TextBlock[],
    misses: readonly number[],
  ): Promise<TranslationOutcome> {
    const texts = misses.map((index) => blocks[index]?.text ?? '');
    this.#logger.sensitive('translating cache misses', texts.join(' | '), { count: texts.length });

    const outcome = await this.#translator.translate(texts, this.#srcLang, this.#tgtLang);

    if (outcome.texts.length !== texts.length) {
      // The chain promises this can never happen and enforces it per engine. Re-checked because
      // `PipelineTranslator` is structural: believing a short batch here would shift every row
      // after the gap, and would do it without an error anywhere. Counts only - the results are
      // screen text.
      this.#logger.error('translator returned the wrong number of results; showing the originals', {
        expected: texts.length,
        received: outcome.texts.length,
        engine: outcome.engine,
      });
      return { texts, engine: null, degraded: true, failures: outcome.failures };
    }

    return outcome;
  }

  /** Store what an engine produced, under the name of the engine that actually produced it. */
  #writeBack(
    blocks: readonly TextBlock[],
    misses: readonly number[],
    translated: readonly (string | undefined)[],
    engineName: string,
  ): void {
    const writes: CacheWrite[] = [];
    for (const index of misses) {
      const block = blocks[index];
      const text = translated[index];
      if (block === undefined || text === undefined) continue;
      writes.push({
        text: block.text,
        srcLang: this.#srcLang,
        tgtLang: this.#tgtLang,
        engineName,
        translated: text,
      });
    }
    this.#cache.setBatch(writes);
  }

  /**
   * Turn the survivors into entries, dropping the ones that carry nothing.
   *
   * Runs over the whole survivor list both times it is called, so a block is counted the same
   * way in the progressive payload and in the complete one - a block still waiting on the engine
   * simply has no result yet and is skipped rather than counted as anything.
   */
  #buildEntries(
    blocks: readonly TextBlock[],
    translated: readonly (string | undefined)[],
    origins: readonly EntryOrigin[],
  ): { entries: OverlayEntry[]; identical: number } {
    const entries: OverlayEntry[] = [];
    let identical = 0;

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      const text = translated[index];
      // `undefined` here is a block that is still waiting on the engine (progressive half) or
      // one the same-language skip took out. Neither is an entry.
      if (block === undefined || text === undefined) continue;

      const origin = origins[index] ?? 'engine';
      if (origin !== 'degraded' && text.trim() === block.text.trim()) {
        identical += 1;
        continue;
      }

      entries.push({ text, sourceText: block.text, bbox: block.bbox, origin });
    }

    return { entries, identical };
  }

  #isAlreadyTargetLanguage(text: string): boolean {
    return thaiScriptRatio(text) >= this.#sameLanguageMinRatio;
  }

  #lookupFor(text: string, engineName: string): CacheLookup {
    return { text, srcLang: this.#srcLang, tgtLang: this.#tgtLang, engineName };
  }

  /**
   * The `total` budget row (design doc section 4) is the whole round, and half of it happened
   * inside the sidecar. Its µs are the only record of that half, so the row is only meaningful
   * if they are added to what Node just spent. `capture`/`diff`/`ocr` are *not* recorded here -
   * `src/main/index.ts` folds those in from the same event, and recording them twice would halve
   * every percentile.
   */
  #recordTotal(frame: FrameEvent, startedAt: number): void {
    const { captureUs, diffUs, ocrUs } = frame.timings;
    const sidecarMs = (captureUs + diffUs + ocrUs) / 1000;
    this.#metrics?.record('total', sidecarMs + (this.#now() - startedAt));
  }

  /**
   * @returns whether the payload reached the renderer - both that it was not overtaken, and that
   *          the consumer did not refuse it.
   *
   * The second half matters more than it looks. `src/main/index.ts` hands the payload to
   * `WindowManager.sendOverlayPayload`, which returns `false` while the overlay document is still
   * starting up. Counting that as drawn would advance #36's baseline to text nobody saw: the
   * screen would then look unchanged for the rest of the session, the retry that dedup's expiring
   * window produces would be suppressed, and the first subtitle of the session would never appear
   * - silently, which is the whole failure the emit-gated baseline exists to prevent.
   */
  #emit(payload: OverlayPayload): boolean {
    if (payload.seq < this.#lastEmittedSeq) {
      // A slow frame finished after a newer one already drew. Its text is stale by definition.
      this.#logger.debug('dropping a payload overtaken by a newer frame', {
        seq: payload.seq,
        lastEmittedSeq: this.#lastEmittedSeq,
        entries: payload.entries.length,
      });
      return false;
    }
    this.#lastEmittedSeq = payload.seq;
    // `!== false` rather than a truthiness test: a consumer that returns nothing has not claimed
    // a failure, and only an explicit `false` is a refusal.
    return this.#onPayload(payload) !== false;
  }

  /** Invariant 4: a cache that quietly stopped caching is a performance cliff with no cause. */
  #reportCacheStatus(): void {
    if (this.#cache.status !== 'disabled' || this.#cacheDisabledReported) return;
    this.#cacheDisabledReported = true;
    this.#logger.warn('translating without a cache; every frame will pay full latency', {
      cacheStatus: this.#cache.status,
    });
  }
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface CreateTextPipelineOptions
  extends Omit<TextPipelineOptions, 'translator' | 'cache'> {
  /**
   * The HTTP transport every engine will use. **Required, with no default, on purpose.**
   *
   * M4-02 needs Electron's network stack so the app honours the system proxy, and the translator
   * directory is Electron-free so that it can be unit tested - which leaves exactly one place
   * where the two meet: here. `GoogleEngineOptions.fetch` defaults to Node's `fetch`, which does
   * *not* read the system proxy, so a composition point that let this parameter be omitted would
   * ship a build where every corporate-proxy user gets no translations and no error worth
   * reading. Making it required turns that into a compile error.
   *
   * `src/main/index.ts` passes `net.fetch`.
   */
  readonly fetch: HttpFetch;
  /** SQLite file for the translation cache. `:memory:` in tests. */
  readonly cachePath: string;
  /** Engine names in fallback order. Default `['google']`. */
  readonly engines?: readonly string[];
  /** Google adapter options other than the transport, which comes from `fetch`. */
  readonly google?: Omit<GoogleEngineOptions, 'fetch'>;
  /** Per-engine pacing. Each engine gets its own limiter (M4-03). */
  readonly rateLimit?: RateLimiterOptions;
  readonly cacheTtlMs?: number;
}

/** What a caller needs in order to reset the pipeline's memory of the screen. */
export type StabilityResettable = Pick<TextPipeline, 'resetStability'>;

export interface ComposedTextPipeline {
  readonly pipeline: TextPipeline;
  readonly translator: FallbackTranslator;
  readonly cache: TranslationCache;
  /** Releases the cache's database handle. */
  close(): void;
}

/**
 * Build the real chain: registry -> engines -> per-engine rate limiting -> fallback -> cache ->
 * pipeline.
 *
 * No health check is performed. A probe at startup is a live request to the translation service
 * before the user has asked for anything, and design doc section 7 gets its "no silent failure"
 * from failures being reported when they happen, not from pre-flighting them.
 */
export function createTextPipeline(options: CreateTextPipelineOptions): ComposedTextPipeline {
  const {
    fetch: httpFetch,
    cachePath,
    engines = ['google'],
    google,
    rateLimit,
    cacheTtlMs,
    ...pipelineOptions
  } = options;

  const registry = createDefaultRegistry({ google: { ...google, fetch: httpFetch } });
  const chain = registry.createChain(engines).map((engine) => withRateLimit(engine, rateLimit ?? {}));

  const loggerOption = options.logger === undefined ? {} : { logger: options.logger };
  const translator = new FallbackTranslator(chain, loggerOption);
  const cache = new TranslationCache(cachePath, {
    ...loggerOption,
    ...(cacheTtlMs === undefined ? {} : { ttlMs: cacheTtlMs }),
  });

  const pipeline = new TextPipeline({ ...pipelineOptions, translator, cache });

  return {
    pipeline,
    translator,
    cache,
    close: () => {
      cache.close();
    },
  };
}
