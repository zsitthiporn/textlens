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
 * ## Frames overlap, and the pipeline has to be right across them (#78)
 *
 * `src/main/index.ts` hands every frame over with `void handleFrame(...)` and no queue, on a
 * 500-800ms tick, while a cache miss takes ~870ms. So the next frame routinely starts while the
 * previous one is still waiting on the engine - and every memory here is *read* when a frame
 * starts but *written* only when it delivers. Three rules keep that gap from losing text:
 *
 * 1. **A line another frame is still resolving is shared, not dropped.** Dedup admitted it when
 *    the earlier frame started, so to the next frame it is a duplicate - with nothing in the
 *    displayed set yet to show for it. Emitting without it retires the box, overtakes the frame
 *    carrying it, and records the text as shown, after which the screen reads as unchanged and
 *    that line is never drawn. Each frame therefore publishes what it has resolved (cache hits
 *    included), and a later frame that sees one of those lines waits for that same answer and
 *    carries it. A line stays published while **any** frame holding it - its publisher or one
 *    carrying it - is in flight, and each frame lets go only after it has tried to deliver.
 *    A frame waits only for lines it can see and is not translating itself; its own misses are
 *    in flight at the same time. Not a latest-wins mailbox, which is simpler but makes a
 *    subtitle that changes mid-flight wait for the round trip it replaced.
 * 2. **Order is the order Node received frames in**, from a counter that is never reset - not the
 *    sidecar's `seq`, which starts over whenever the sidecar process does.
 * 3. **`resetScene` fences off frames already in progress.** Each frame carries the generation it
 *    started in, and a payload from an older generation is refused at emit, so a frame that lands
 *    after a dismiss or a region change cannot write the forgotten scene back.
 *
 * ## What is deliberately not here
 *
 * - **`RecentOutputs.remember`.** That module is explicit that only the stage which actually
 *   puts something on screen may record it, and that stage is the renderer - which since #52 says
 *   so itself, on the ack channel. This one reads (`has`) and does not write. Note that the
 *   displayed set below is *not* a second copy of that memory and must not be conflated with it:
 *   this one holds what the overlay should be showing, including untranslated originals, while
 *   `RecentOutputs` holds only what we painted and must never learn about a degraded entry.
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
import {
  dedupeBlocks,
  Deduplicator,
  digitSignature,
  similarity,
  DEFAULT_POSITION_TOLERANCE,
  DEFAULT_SIMILARITY_THRESHOLD,
  type DedupOptions,
} from './dedup.js';
import { nullLogger, type Logger } from './logger.js';
import type { MetricsRecorder } from './metrics.js';
import { normalizeForComparison, type RecentOutputs } from './recent-outputs.js';
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
  /**
   * The OCR text this came from. M5-03's sticky placement compares on it.
   *
   * **Nothing records this string.** It is the English on the user's screen, and `RecentOutputs`
   * has no TTL - remembering it would drop that line from translation for the rest of the session
   * (#52). Only `text`, and only once the renderer confirms it was drawn.
   */
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
  /**
   * Entries carried over from an earlier frame because their source text is still on screen (#53).
   *
   * The counterpart to `duplicate`: dedup removed those blocks so they are not translated again,
   * and this is how many of them are still in the payload anyway. A frame where `duplicate` is
   * high and this is 0 is the bug #53 describes, visible in one log line.
   *
   * Since #78 this also counts lines whose translation this frame took from an earlier frame that
   * had not delivered it yet - carried over from an earlier frame too, one step sooner.
   */
  readonly held: number;
  /** Entries retired because OCR no longer sees their source text (#53). */
  readonly removed: number;
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
 *
 * ## `entries` is the whole displayed set, never a delta (#53)
 *
 * Every entry the overlay should be showing is in here, including the ones this frame did not
 * translate because dedup recognised their source text as unchanged. That is what the renderer
 * has always assumed - `renderEntries` draws what it is given and retires everything else - and
 * what `transitions.ts` relies on when it argues that a payload displacing another inside the
 * minimum-display hold cannot lose content.
 *
 * Until #53 it was not true: dedup's job is to remove the unchanged blocks, so a frame in which
 * one line of forty changed carried one entry and retired thirty-nine boxes whose text was still
 * on the screen. Measured on a live desktop capture, the overlay oscillated between 39 boxes and
 * 1 every 1.6 seconds. `TextPipeline` therefore remembers what each block was translated to and
 * re-emits it for as long as OCR keeps reporting the source.
 */
export interface OverlayPayload {
  /**
   * The `frame.seq` this came from. Two payloads may share one.
   *
   * For diagnostics only: nothing orders payloads by it any more (#78), because a restarted
   * sidecar counts from 1 again. The pipeline orders frames by when it received them.
   */
  readonly seq: number;
  /** False for the progressive first half; true for the frame's final payload. */
  readonly complete: boolean;
  readonly entries: readonly OverlayEntry[];
  /**
   * True when **this frame's** translation attempt fell back to the untranslated original.
   *
   * Deliberately not "this payload contains a degraded entry", which since #53 is a different
   * question: an English box held from an earlier outage can still be on screen after an engine
   * has recovered. `judgeTranslation` (#41) reads this one, and it must keep describing the
   * attempt, because `failures` - the only thing that can say *why* the user is looking at
   * English - is empty on a frame that called no engine. The other reader, #36's degraded
   * baseline, needs the on-screen question instead and is given it separately; see `#run`.
   */
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
 * One entry the overlay is currently showing, remembered so it can be sent again (#53).
 *
 * Keyed exactly the way `dedup.ts` keys its own entries - `normalizeForComparison(block.text)` -
 * because dedup is what answers "is this block the one that produced that entry". A duplicate
 * verdict carries the recorded entry's text as `matchedText`, and that string *is* the key here,
 * which is what lets a jittered re-read of the same line find its translation.
 */
interface DisplayedEntry {
  /** The text on screen: the translation, or the original when `origin` is `degraded`. */
  readonly text: string;
  /**
   * The source text as first read, **not** as re-read this frame.
   *
   * #35 keys its sticky anchors on this, so a value that drifted with OCR jitter would give the
   * box a new anchor identity every frame - the churn the sticky anchors exist to remove, moved
   * one stage upstream. The rectangle *does* follow the fresh reading; only the identity is held.
   */
  readonly sourceText: string;
  /** Where it was last seen. Only {@link TextPipeline.recall}'s fallback match reads this. */
  readonly bbox: LogicalRect;
  readonly origin: EntryOrigin;
}

/**
 * One block as this frame observed it, with dedup's verdict already applied.
 *
 * The ordered list of these is the screen; `slot` is the only thing that distinguishes a block
 * that needs translating from one that is already accounted for.
 */
interface ObservedBlock {
  readonly block: TextBlock;
  /** The key its translation is remembered under. See {@link DisplayedEntry}. */
  readonly key: string;
  /** Index into the fresh-block array when dedup let it through; `null` when it is a duplicate. */
  readonly slot: number | null;
}

/** One observed block paired with whatever the overlay is already showing for it. */
interface RecalledBlock extends ObservedBlock {
  readonly remembered: DisplayedEntry | undefined;
}

/**
 * What one frame learned about one line, as another frame sees it (#78).
 *
 * `entry` is `undefined` when the line produced no box - its translation came back identical to
 * its source. `failed` means the owning frame's translator threw, so nothing was learned at all.
 */
type SharedOutcome =
  | { readonly failed: false; readonly entry: DisplayedEntry | undefined }
  | { readonly failed: true };

const SHARE_FAILED: SharedOutcome = { failed: true };

/**
 * A line some frame has resolved and not yet delivered, published so that frames starting in the
 * meantime can use it instead of treating the line as unaccounted for (#78). See `#publish`.
 */
interface SharedLine {
  /** Set the moment the answer is known - immediately for a cache hit. `undefined` while pending. */
  outcome: SharedOutcome | undefined;
  /**
   * Settles when {@link outcome} is set. **Never rejects**, whatever the translator hands back: a
   * rejection, or an answer that cannot be turned into an entry, settles as {@link SHARE_FAILED}.
   * Nothing is obliged to await this, and an unawaited rejection under Electron 43 is a warning,
   * not a crash - i.e. a silence (CLAUDE.md, #67).
   */
  readonly settled: Promise<SharedOutcome>;
  /**
   * Frames still in flight that hold this line: the one that published it, and every one that took
   * it from another. It stays published until this reaches 0 - see `#release`.
   */
  holders: number;
}

/** One frame's hold on one line, released exactly once when that frame is done. */
type HeldLine = readonly [key: string, line: SharedLine];

function settledLine(entry: DisplayedEntry | undefined): SharedLine {
  const outcome: SharedOutcome = { failed: false, entry };
  return { outcome, settled: Promise.resolve(outcome), holders: 1 };
}

function pendingLine(
  translation: Promise<TranslationOutcome>,
  pick: (outcome: TranslationOutcome) => DisplayedEntry | undefined,
): SharedLine {
  const line: SharedLine = {
    outcome: undefined,
    settled: translation
      .then(
        (outcome): SharedOutcome => {
          // `PipelineTranslator` is structural, so an element of `texts` can be anything, and
          // `freshEntry` calls `.trim()` on it. Thrown here, that would reject a promise nobody may
          // be awaiting. The owning frame meets the same value on its own path and reports it.
          try {
            return { failed: false, entry: pick(outcome) };
          } catch {
            return SHARE_FAILED;
          }
        },
        // The owning frame awaits the same promise and reports the throw itself; this branch only
        // has to stop the frames sharing it from hanging, or from each raising an unhandled one.
        (): SharedOutcome => SHARE_FAILED,
      )
      .then((outcome) => {
        line.outcome = outcome;
        return outcome;
      }),
    holders: 1,
  };
  return line;
}

/**
 * The entry a block's own fresh result puts on screen, or `undefined` when it is identical to its
 * source. One rule, used by the frame that translated the block and by every frame sharing it, so
 * the two cannot disagree about whether a line has a box.
 *
 * "Identical" is exact equality after trimming - see the module comment - and never applies to a
 * degraded result, which *is* the source by construction (design doc section 7).
 */
function freshEntry(block: TextBlock, text: string, origin: EntryOrigin): DisplayedEntry | undefined {
  if (origin !== 'degraded' && text.trim() === block.text.trim()) return undefined;
  return { text, sourceText: block.text, bbox: block.bbox, origin };
}

/**
 * What a frame is, as far as ordering is concerned (#78). Fixed the moment the pipeline receives it.
 *
 * `order` is the pipeline's own count of frames received and is never reset; `generation` is the
 * scene the frame was read from, bumped by every {@link TextPipeline.resetScene}. `seq` is the
 * sidecar's number, kept for log lines and for the wire - it is no longer compared with anything.
 */
interface FrameTicket {
  readonly seq: number;
  readonly order: number;
  readonly generation: number;
}

/**
 * How closely a re-read has to match a remembered entry to be the same line, when the key does
 * not match outright. Deliberately `dedup.ts`'s own numbers.
 *
 * The fallback exists because dedup's key is only stable while dedup remembers the line. Its
 * window is 3s and a match does not refresh it, so a subtitle that sits still is readmitted every
 * 3s and - if OCR read it even one character differently that time - readmitted under a *new*
 * key. Keyed alone, the entry the user is looking at would read as vanished on that frame and the
 * box would be retired and rebuilt every three seconds, which is #53 again with a longer period.
 *
 * Matching on the same threshold as dedup means the two agree by construction: any reading dedup
 * would have called a duplicate is a reading this finds, and the position bound stops a repeated
 * label elsewhere on the screen from adopting an entry that really did disappear.
 */
const RECALL_SIMILARITY = DEFAULT_SIMILARITY_THRESHOLD;
const RECALL_POSITION_TOLERANCE = DEFAULT_POSITION_TOLERANCE;

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
   * Frames received so far - the source of {@link FrameTicket.order}. Never reset (#78).
   *
   * Frames arrive from an event handler that does not await, so a frame whose misses take 400ms
   * can still be in flight when the next one lands. Without an ordering guard the slow frame's
   * complete payload lands *after* the newer one and the overlay reverts to stale text - which
   * looks like flicker, not like a bug.
   *
   * The guard used to compare the sidecar's `frame.seq`. That number belongs to a process, and a
   * restarted sidecar is a new process counting from 1 again: every payload after a restart was
   * "older" than the last one before it and was dropped, at debug level, until the new count
   * caught up with the old one. What the guard means is "which frame did we receive later", and
   * only this side can answer that.
   */
  #received = 0;
  /** {@link FrameTicket.order} of the last payload handed to the renderer. */
  #lastEmittedOrder = 0;
  /**
   * Which scene a frame was read from (#78). Bumped by {@link resetScene}.
   *
   * Resetting the memories does not stop a frame that is already waiting on the engine, and when
   * that frame lands it refills them with the scene the reset was meant to forget - a dismissed
   * snapshot's boxes come back about a second later and stay. A frame whose generation is not the
   * current one is refused at emit, which is the one door every payload goes through.
   */
  #generation = 0;
  #cacheDisabledReported = false;

  /**
   * Lines that some frame still in flight has resolved or is carrying, by the key `#displayed`
   * uses (#78).
   *
   * A line stays here for as long as **any** frame holding it is in flight - the frame that
   * published it and every frame that took it from another (see `#share`, `#release`). Tying it to
   * the publisher alone left a gap: the publisher finishes, fails to deliver (overtaken, refused,
   * fenced), and the line is in neither this map nor `#displayed` while another frame is still on
   * its way to drawing it. A frame starting in that gap sees the line as a duplicate with nothing
   * to show, delivers after the carrier, and records it as shown - stranded, exactly as before #78.
   *
   * Deliberately **not** cleared by {@link resetScene}: a translation is a function of the text
   * alone, not of the scene it was read from, so a frame that starts after a reset may use a fenced
   * frame's answer rather than paying for the same request twice. What the reset fences is the
   * *payload*, and that is refused at emit.
   */
  readonly #inflight = new Map<string, SharedLine>();

  /**
   * What the overlay is showing, as of the last payload that reached it (#53).
   *
   * Replaced wholesale on every successful emit rather than mutated, so it can only ever contain
   * blocks this frame observed - which is what makes "gone" an observation instead of a guess.
   * Advanced only on a *successful* emit, for the same reason #36's baseline is: a payload the
   * renderer refused did not change the screen.
   */
  #displayed = new Map<string, DisplayedEntry>();

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
    // #78. Taken before anything else, so both describe the moment the frame arrived rather than
    // the moment it finished - which is the whole difference between them and `frame.seq`.
    this.#received += 1;
    const ticket: FrameTicket = { seq: frame.seq, order: this.#received, generation: this.#generation };
    /** Every line this frame published or took from another. See `#inflight`. */
    const held: HeldLine[] = [];
    try {
      return await this.#run(frame, display, startedAt, ticket, held);
    } catch (error) {
      this.#logger.error('frame failed in the text pipeline; skipping it', {
        seq: frame.seq,
        lines: frame.lines.length,
        error: error instanceof Error ? `${error.name}: ${error.message}` : typeof error,
      });
      return undefined;
    } finally {
      // Here, and not inside `#run`, so that it is structurally **after** the frame's delivery
      // attempt: `#run` settles only once `#deliver` has returned, on every path - delivered,
      // overtaken, fenced, refused, suppressed or thrown. Released any earlier, a line this frame
      // is carrying could vanish from `#inflight` before it is in `#displayed`.
      this.#release(held);
    }
  }

  async #run(
    frame: FrameEvent,
    display: DisplayGeometry,
    startedAt: number,
    ticket: FrameTicket,
    held: HeldLine[],
  ): Promise<OverlayPayload | undefined> {
    const nowMs = startedAt;

    // ---- group + filter + dedup (design doc section 4: one 5ms budget row) ----------------
    const survivors = this.#collect(frame, display, nowMs);

    // #36. Called for **every** frame, including the ones that end below, because the streak is a
    // count of consecutive observations - skip the call on a quiet frame and the count is wrong
    // for the loud one after it.
    const stability = this.#stability.observe(survivors.observedTexts);
    const counts: CollectStats = { ...survivors.counts, stableStreak: stability.streak };

    /**
     * What the overlay is showing, matched against what this frame sees (#53).
     *
     * `absent` is the entries no block in this frame accounts for, and **one frame of absence is
     * the whole rule**. It is an observation rather than a guess: the sidecar runs OCR over the
     * *entire* region and only emits a frame when the pixels changed, so a line missing from
     * `frame.lines` is a line that is not on the screen. A grace period would buy nothing against
     * the case that matters - text vanishing usually leaves a quiet screen behind it, no further
     * frames arrive, and a countdown measured in frames would never expire.
     */
    const resolved = this.#resolve(survivors.observed);
    const absent = resolved.absent;

    /**
     * Lines on this screen that a frame still in flight has resolved and not delivered yet (#78).
     *
     * Such a line is neither a duplicate with nothing to show nor absent: its translation is on
     * its way, and this frame waits for it and carries it. Treating it as a plain duplicate is how
     * a subtitle that had been translated and cached was never drawn - this frame would emit
     * without it, overtake the frame carrying it, and record the text as shown. Taking a line also
     * holds it, so it stays visible to later frames until this one is done with it.
     */
    const sharing = this.#share(resolved.blocks, held);

    if (survivors.blocks.length === 0 && sharing.size === 0) {
      if (absent.length === 0) {
        // "ไม่เหลืออะไรใหม่? จบรอบ" - and deliberately no payload at all. Everything on screen is
        // still on screen and already drawn, so the only payload this frame could produce is the
        // one the renderer is already showing. Invariant 4 is served by the counts in this line.
        this.#logger.debug('nothing new in this frame', { seq: frame.seq, ...counts });
        this.#recordTotal(frame, startedAt);
        return undefined;
      }

      // Nothing new, but something left: the two-source case in #53 - a HUD disappears while the
      // subtitle under it is unchanged. No engine, no cache, no translation; the payload is simply
      // what is still there, which is how the box that is not comes off the screen.
      const built = this.#buildEntries(resolved.blocks, [], []);
      this.#recordTotal(frame, startedAt);
      return this.#deliver(
        ticket,
        {
          seq: frame.seq,
          complete: true,
          entries: built.entries,
          degraded: false,
          engine: null,
          failures: [],
          cacheStatus: this.#cache.status,
          stats: {
            ...counts,
            sameLanguage: 0,
            cacheHits: 0,
            cacheMisses: 0,
            identical: 0,
            held: built.held,
            removed: absent.length,
            rendered: built.entries.length,
          },
        },
        { observed: survivors.observedTexts, next: built.next, absent, degradedOnScreen: built.degraded },
      );
    }

    // A frame that only *loses* entries is never suppressed. #36 scores similarity over the whole
    // screen, and one line vanishing from a screen of seventy scores 0.986 - comfortably
    // "unchanged", which is true of the text that remains and false of the box that no longer has
    // any. The override cannot loop: the payload it lets through is strictly smaller, so it
    // differs from the one on screen and the baseline advances past it.
    if (stability.suppress && absent.length === 0) {
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
    /** Each fresh block's key, at its index in `blocks`. Aligned, never compacted. */
    const keys = new Array<string | undefined>(blocks.length);
    for (const item of resolved.blocks) {
      if (item.slot !== null) keys[item.slot] = item.key;
    }

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
      // #78. Fresh, and yet another frame is already fetching it - dedup's window expired under a
      // slow engine, or a reset cleared dedup. That frame's answer is this block's answer; asking
      // again would pay for the same request twice. Filled in from `sharing` below.
      const key = keys[index];
      if (key !== undefined && sharing.has(key)) continue;
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
    /** Indices into `blocks`, for the blocks the cache did answer. */
    const answered: number[] = [];
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
      answered.push(index);
    }
    const cacheHits = answered.length;
    this.#reportCacheStatus();

    const baseStats = {
      ...counts,
      sameLanguage,
      cacheHits,
      cacheMisses: misses.length,
    };

    /**
     * Shared lines this frame has to wait for (#78). One that is already settled - another frame's
     * cache hit - is applied without waiting, so a frame that needs nothing still at an engine
     * finishes as soon as it would have on its own.
     */
    const waiting = [...sharing.values()].filter((line) => line.outcome === undefined);

    // ---- progressive render: hits do not wait behind a 300-500ms round trip ---------------
    // Nor behind somebody else's round trip (#78): a frame whose only wait is on a shared line
    // still draws its own hits first.
    const partial =
      cacheHits > 0 && (misses.length > 0 || waiting.length > 0)
        ? this.#buildEntries(this.#applyShared(resolved.blocks, sharing), translated, origins)
        : undefined;
    // `partial.entries` can be empty even with hits: identical translations are cached (a proper
    // noun comes back unchanged from every engine), so the next frame's hit is suppressed as
    // identical and there is nothing early to draw. Emitting that would clear a renderer that
    // replaces its contents - the same reason the empty round below emits nothing.
    //
    // The blocks still in flight are *absent* from this payload, which is the one place the
    // whole-set rule costs something: a box whose words just changed is retired for the length of
    // the round trip and re-enters with the new text. Before #53 every box in the frame was, so
    // this is the same trade made over a far smaller set - and `#displayed` is deliberately not
    // advanced here, so the in-flight blocks are not mistaken for gone on the next frame.
    if (partial !== undefined && partial.entries.length > 0) {
      this.#emit(ticket, {
        seq: frame.seq,
        complete: false,
        entries: partial.entries,
        degraded: false,
        engine: null,
        failures: [],
        cacheStatus: this.#cache.status,
        stats: {
          ...baseStats,
          identical: partial.identical,
          held: partial.held,
          removed: absent.length,
          rendered: partial.entries.length,
        },
      });
    }

    // ---- translate the misses, and only the misses ---------------------------------------
    const translation = misses.length === 0 ? undefined : this.#translateMisses(blocks, misses);

    // Before the first `await`, and that placement is the point: from here until this frame has
    // tried to deliver, any frame that starts can see what this one has resolved. Done even by a
    // frame that will not wait, because publishing is also how a fresh answer replaces a stale one
    // another frame is still holding - see `#publish`. Released in `handleFrame`, after delivery.
    this.#publish(blocks, keys, answered, translated, misses, translation, held);

    // A frame with nothing to wait for does not `await` at all, exactly as before #78: it delivers
    // in the same turn it started, so no other frame can observe it half-done.
    let outcome = NO_TRANSLATION;
    if (translation !== undefined || waiting.length > 0) {
      if (waiting.length > 0) {
        this.#logger.debug('waiting on lines an earlier frame is still translating', {
          seq: frame.seq,
          order: ticket.order,
          shared: sharing.size,
          waiting: waiting.length,
        });
      }
      // Started together, awaited together: a frame's own misses and the shared lines are in
      // flight at the same time, so the wait is the longer of the two, not their sum.
      const shared = Promise.all(waiting.map((line) => line.settled));
      if (translation !== undefined) {
        outcome = await translation;
        // This frame's own answers are taken in - and cached - the moment they arrive, **not**
        // after the shared wait below. A frame that reads one of these lines afresh while this one
        // is still waiting on a slower shared line passes over the settled answer here (see
        // `#share`) and asks the cache; written only after the wait, the cache would miss and the
        // engine would be asked for the same line twice. Nothing is emitted from here, so the
        // payload is the same either way. The `translate` sample is taken here too, so it times
        // this frame's own round trip - the budget row it feeds - and not somebody else's.
        this.#takeAnswers(blocks, misses, translated, origins, outcome, translateStartedAt);
      }
      await shared;
    }

    const degraded = outcome.degraded;

    // ---- payload --------------------------------------------------------------------------
    for (const line of sharing.values()) {
      if (line.outcome?.failed === true) {
        // The frame that owned this line has already reported its translator throwing, and skipped
        // itself. This frame needed the same answer and does not have it; delivering without it
        // would record the line as shown - the stranding #78 is about - so it is skipped the same
        // way, through `handleFrame`'s error line.
        throw new Error('a translation this frame was sharing failed in the frame that owned it');
      }
    }
    const built = this.#buildEntries(this.#applyShared(resolved.blocks, sharing), translated, origins);
    const payload: OverlayPayload = {
      seq: frame.seq,
      complete: true,
      entries: built.entries,
      degraded,
      engine: outcome.engine,
      failures: outcome.failures,
      cacheStatus: this.#cache.status,
      stats: {
        ...baseStats,
        identical: built.identical,
        held: built.held,
        removed: absent.length,
        rendered: built.entries.length,
      },
    };

    this.#recordTotal(frame, startedAt);

    if (payload.entries.length === 0 && absent.length === 0) {
      // The baseline is deliberately **not** advanced here. Nothing reached the screen, so the
      // next frame must still read as new - otherwise this frame's text is suppressed from now
      // on and never drawn at all.
      //
      // `absent.length === 0` is what keeps this from swallowing a screen that emptied: an empty
      // payload with something to remove is not "nothing to draw", it is "draw nothing", and the
      // renderer needs to be told before it will let the last boxes go.
      this.#logger.debug('every block translated to its own source; nothing to draw', {
        seq: frame.seq,
        ...payload.stats,
      });
      return undefined;
    }

    return this.#deliver(ticket, payload, {
      observed: survivors.observedTexts,
      next: built.next,
      absent,
      // #36's degraded exemption asks whether the **user is looking at** untranslated English, not
      // whether this frame's engine call failed. Since #53 those differ: after a recovery the new
      // line translates while old English boxes are still held, and a baseline that called that
      // frame healthy would let suppression strand them - the exact stranding
      // `stability-tracker.ts` documents. `payload.degraded` keeps the narrower meaning for #41.
      degradedOnScreen: degraded || built.degraded,
    });
  }

  /**
   * Emit a payload and, if it landed, adopt everything that follows from it (#53).
   *
   * One place, because the three effects are one decision and splitting them is how they drift:
   * the displayed set, #36's baseline and dedup's memory of vanished text all describe the screen
   * *after* this payload, and none of them may move if the payload never reached it.
   */
  #deliver(
    ticket: FrameTicket,
    payload: OverlayPayload,
    scene: {
      readonly observed: readonly string[];
      readonly next: Map<string, DisplayedEntry>;
      readonly absent: readonly string[];
      readonly degradedOnScreen: boolean;
    },
  ): OverlayPayload | undefined {
    // Every refusal - overtaken, fenced by a reset (#78), or turned away by the renderer - returns
    // here, before any of the three memories below has moved.
    if (!this.#emit(ticket, payload)) return undefined;

    this.#displayed = scene.next;

    // The other half of one-frame removal, and the half that is easy to miss: the entry is gone
    // from the displayed set while dedup still holds the text for up to `windowMs`. Left alone,
    // the same line reappearing inside that window is called a duplicate, finds no translation to
    // be re-shown from, and is drawn nowhere at all. See `Deduplicator.forget`.
    for (const key of scene.absent) this.#deduplicator.forget(key);

    // #36's baseline moves only here - after a payload has actually reached the renderer - and it
    // records the frame's **whole observed set**, not the entries this payload carried. The two
    // still differ: the payload holds only the blocks that produced a box, while the baseline has
    // to describe every line on the screen, including the ones nothing was drawn for.
    this.#stability.markEmitted(scene.observed, scene.degradedOnScreen);
    return payload;
  }

  /**
   * Forget everything this pipeline believes about the screen (#36 and #52).
   *
   * Three memories, one event. `StabilityTracker` was reset on a region or mode change from the
   * day it was written; `Deduplicator` was not, and had no caller anywhere in the project - so a
   * user who re-pointed the region at text they had just been reading got it silently filtered as
   * a duplicate and never translated. The displayed set (#53) joins them because it describes a
   * screen that is about to stop existing.
   *
   * Not folded into a config listener here: this module has no config subscription and gaining
   * one would give it a second route to its own behaviour. `src/main/index.ts` calls this.
   *
   * **And it fences off every frame already in progress (#78).** Clearing the memories is not
   * enough on its own: a frame waiting on the engine when this runs lands afterwards, and its
   * delivery writes the old scene straight back into all three - after a dismiss, the boxes the
   * user just cleared reappear about a second later and stay. Bumping the generation makes that
   * frame's payload refused at emit, whatever the reason for the reset. Frames that *start* after
   * this call are unaffected; note that means started, not captured - a frame the sidecar had
   * already sent before hearing about the change still counts as new here.
   */
  resetScene(reason: string): void {
    this.#stability.reset();
    this.#deduplicator.reset();
    this.#displayed = new Map();
    this.#generation += 1;
    this.#logger.debug('screen memory cleared', { reason, generation: this.#generation });
  }

  /**
   * Pair every observed block with what the overlay is already showing for it, and work out what
   * is showing that this frame did not see at all (#53).
   *
   * Pure and cheap - a map lookup per block, and the fallback scan only runs over entries no block
   * claimed by key, which is normally none. It happens before the cache and the engine because its
   * answer decides whether the frame is worth translating at all.
   */
  #resolve(observed: readonly ObservedBlock[]): { blocks: RecalledBlock[]; absent: string[] } {
    const unclaimed = new Map(this.#displayed);
    const remembered = new Array<DisplayedEntry | undefined>(observed.length);
    /** Indices into `observed`, aligned - never compacted. */
    const deferred: number[] = [];

    // Two passes, so an exact key match always wins over a fuzzy one: a screen holding two similar
    // lines must not have the first block it happens to visit adopt the entry belonging to the
    // other one.
    //
    // An exact match is read from the whole map rather than from `unclaimed`, so two blocks with
    // the *same* text - a repeated label, a name in both subtitle lines - both get the entry
    // instead of the second one silently losing its box. Their translation is by definition the
    // same string; only the rectangle differs, and that comes from the block. `unclaimed` is
    // still narrowed, because one sighting is enough to prove the text is on screen.
    for (let index = 0; index < observed.length; index += 1) {
      const item = observed[index];
      if (item === undefined) continue;
      const exact = this.#displayed.get(item.key);
      if (exact === undefined) {
        deferred.push(index);
        continue;
      }
      unclaimed.delete(item.key);
      remembered[index] = exact;
    }

    for (const index of deferred) {
      const item = observed[index];
      if (item === undefined) continue;
      const recalled = this.#recall(item, unclaimed);
      if (recalled === null) continue;
      unclaimed.delete(recalled.key);
      remembered[index] = recalled.entry;
    }

    return {
      blocks: observed.map((item, index) => ({ ...item, remembered: remembered[index] })),
      absent: [...unclaimed.keys()],
    };
  }

  /**
   * The fallback half of {@link #resolve}: the same line, read slightly differently.
   *
   * See {@link RECALL_SIMILARITY} for why this exists at all. Both bounds must hold - a repeated
   * label on another part of the screen is text-identical and is not this entry.
   */
  #recall(
    item: ObservedBlock,
    unclaimed: ReadonlyMap<string, DisplayedEntry>,
  ): { key: string; entry: DisplayedEntry } | null {
    if (unclaimed.size === 0) return null;
    const text = normalizeForComparison(item.block.text);
    if (text.length === 0) return null;
    const digits = digitSignature(text);

    let best: { key: string; entry: DisplayedEntry } | null = null;
    let bestScore = RECALL_SIMILARITY;
    for (const [key, entry] of unclaimed) {
      if (Math.abs(entry.bbox.x - item.block.bbox.x) > RECALL_POSITION_TOLERANCE) continue;
      if (Math.abs(entry.bbox.y - item.block.bbox.y) > RECALL_POSITION_TOLERANCE) continue;
      // `dedup.ts` rule 2, and it has to be repeated here rather than inherited: dedup applied it
      // to the duplicates, and this path is the *fresh* blocks it let through. `wave 12 of 30` and
      // `wave 13 of 30` are one edit apart in a long string, so similarity alone would call the
      // new number a re-read of the old one and keep showing the old translation until the engine
      // answers. No character metric can separate a changed number from a slipped recogniser, and
      // the jitter this fallback exists for - o/O, I/1, a dropped space - carries no digits.
      if (digitSignature(key) !== digits) continue;
      const score = key === text ? 1 : similarity(text, key);
      if (score < bestScore) continue;
      bestScore = score;
      best = { key, entry };
    }
    return best;
  }

  /**
   * Take - and hold - the lines on this screen that frames still in flight have published (#78).
   *
   * Looked up by the same key `#displayed` uses, for both kinds of block: a duplicate's key is the
   * text dedup recorded when the earlier frame admitted it, and a fresh block's is its own
   * normalized text - the two agree whenever the earlier frame's line is the one being re-read.
   *
   * **Holding** is what keeps the line published after the frame that published it is done: this
   * frame is now carrying it, and until this frame has tried to deliver, a frame starting behind
   * it must be able to find it. Every hold is recorded in `held` and released exactly once.
   *
   * Two lines are not taken:
   *
   * - **A settled answer, for a line this frame is reading afresh.** Holding makes a line live as
   *   long as a chain of overlapping frames keeps seeing it, and a HUD timer that gives every frame
   *   a miss of its own is exactly such a chain. Taken, an answer could then outlive the reason it
   *   was right: an untranslated original from an outage would be handed to the frame that reads
   *   the line afresh to *retry* it, and the retry would never happen while the timer ran. A fresh
   *   line goes to the cache and the engine instead, and `#publish` replaces the stale answer. A
   *   *pending* answer is still taken - that is a request already on its way, and asking again
   *   would pay for it twice.
   * - **A failed one.** It carries nothing, and taking it would only fail this frame as well.
   */
  #share(observed: readonly ObservedBlock[], held: HeldLine[]): Map<string, SharedLine> {
    const sharing = new Map<string, SharedLine>();
    if (this.#inflight.size === 0) return sharing;

    const fresh = new Set<string>();
    for (const item of observed) {
      if (item.slot !== null) fresh.add(item.key);
    }

    for (const item of observed) {
      if (sharing.has(item.key)) continue;
      const line = this.#inflight.get(item.key);
      if (line === undefined) continue;
      if (line.outcome !== undefined && (line.outcome.failed || fresh.has(item.key))) continue;
      line.holders += 1;
      held.push([item.key, line]);
      sharing.set(item.key, line);
    }
    return sharing;
  }

  /**
   * The observed screen with every settled shared line standing in for what was remembered (#78).
   *
   * **A shared line outranks the displayed set**, and the case that decides it is the retry after
   * an outage: `#displayed` holds the untranslated English, an earlier frame is re-translating it
   * because dedup's window expired, and this frame sees it as a duplicate. Taking the remembered
   * English and emitting would overtake the retry and drop its Thai - on every retry, for as long
   * as anything else on the screen keeps changing.
   *
   * A line still pending keeps whatever was remembered, which is what the progressive half shows;
   * by the final payload every line in `sharing` has settled. The rectangle still comes from this
   * frame's block, in `#buildEntries`, so these count as `held` exactly like a remembered entry.
   */
  #applyShared(
    observed: readonly RecalledBlock[],
    sharing: ReadonlyMap<string, SharedLine>,
  ): readonly RecalledBlock[] {
    if (sharing.size === 0) return observed;
    return observed.map((item) => {
      const outcome = sharing.get(item.key)?.outcome;
      if (outcome === undefined || outcome.failed) return item;
      return { ...item, remembered: outcome.entry };
    });
  }

  /**
   * Make what this frame has resolved visible to frames that start before it has delivered (#78).
   *
   * Everything, not only the misses. A cache hit is not in `#displayed` either until this frame's
   * complete payload lands - `#displayed` never advances on the progressive half - so a frame that
   * starts in the meantime sees the hit as a duplicate with nothing to show, exactly as it would
   * a miss, and strands it the same way if it emits first.
   *
   * A *pending* line under the same key is never replaced: `#share` gave it to this frame instead,
   * so there is one request in flight per line. A *settled* one is: this frame read the line
   * afresh and its answer is the newer one (see `#share` on why a held answer can be stale). The
   * frames still holding the old line keep their own reference; `#release` only ever deletes the
   * line it holds, so replacing it cannot be undone by them.
   *
   * Each published line starts with this frame as its one holder, recorded in `held`.
   */
  #publish(
    blocks: readonly TextBlock[],
    keys: readonly (string | undefined)[],
    answered: readonly number[],
    translated: readonly (string | undefined)[],
    misses: readonly number[],
    translation: Promise<TranslationOutcome> | undefined,
    held: HeldLine[],
  ): void {
    const mine = new Set<string>();
    const publish = (index: number, line: () => SharedLine): void => {
      const key = keys[index];
      // An empty key is text that normalizes to nothing; two of those have nothing in common.
      if (key === undefined || key.length === 0 || mine.has(key)) return;
      const existing = this.#inflight.get(key);
      if (existing !== undefined && existing.outcome === undefined) return;
      const created = line();
      this.#inflight.set(key, created);
      held.push([key, created]);
      mine.add(key);
    };

    for (const index of answered) {
      const block = blocks[index];
      const text = translated[index];
      if (block === undefined || text === undefined) continue;
      publish(index, () => settledLine(freshEntry(block, text, 'cache')));
    }

    if (translation !== undefined) {
      misses.forEach((index, position) => {
        const block = blocks[index];
        if (block === undefined) return;
        // `position` is the block's row in the miss batch - the same scatter-back `#run` does,
        // for the same reason: the translator's answer is indexed by its input, not by ours.
        publish(index, () =>
          pendingLine(translation, (outcome) =>
            freshEntry(block, outcome.texts[position] ?? block.text, outcome.degraded ? 'degraded' : 'engine'),
          ),
        );
      });
    }
  }

  /**
   * Let go of every line one frame held (#78). Called once per frame, after its delivery attempt.
   *
   * A line leaves `#inflight` when its last holder lets go - by then every frame that was carrying
   * it has either put it in `#displayed` or been refused, and the frames that start afterwards
   * find it in the former or not at all. Identity-checked, so a line that `#publish` has since
   * replaced is left in place.
   */
  #release(held: readonly HeldLine[]): void {
    for (const [key, line] of held) {
      line.holders -= 1;
      if (line.holders === 0 && this.#inflight.get(key) === line) this.#inflight.delete(key);
    }
  }

  /**
   * Convert, group, and run every drop rule. Synchronous, and timed as one budget row.
   *
   * Returns the screen three ways, because three stages need three different views of it and
   * deriving any one from another is where the delta bug came from:
   *
   *   - `blocks` - what still needs translating. Dedup's `kept`, unchanged.
   *   - `observed` - every surviving block in reading order, each carrying dedup's verdict. The
   *     displayed set is rebuilt from this (#53).
   *   - `observedTexts` - the same list as plain strings, for #36's baseline.
   */
  #collect(
    frame: FrameEvent,
    display: DisplayGeometry,
    nowMs: number,
  ): {
    blocks: readonly TextBlock[];
    observed: readonly ObservedBlock[];
    observedTexts: readonly string[];
    counts: Omit<CollectStats, 'stableStreak'>;
  } {
    type Collected = {
      blocks: readonly TextBlock[];
      observed: readonly ObservedBlock[];
      observedTexts: readonly string[];
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

      let slot = 0;
      const observed: ObservedBlock[] = afterRecent.map((block, index) => {
        const decision = deduped.verdicts[index];
        if (decision !== undefined && decision.duplicate) {
          // The key is the *matched* entry's text, never this reading's. They differ exactly when
          // OCR jittered - which is the case the whole lookup exists for - and dedup does not
          // rewrite an entry on a match, so its text is the one stable name for this line.
          return { block, key: decision.matchedText, slot: null };
        }
        const fresh = { block, key: normalizeForComparison(block.text), slot };
        slot += 1;
        return fresh;
      });

      return {
        blocks: deduped.kept,
        observed,
        // **Before** dedup, on purpose (#36). Dedup removes precisely the lines that make a frame
        // look unchanged, so the post-dedup list describes what is new while this describes what
        // is on the screen - and "has the screen changed" can only be asked of the second one.
        observedTexts: afterRecent.map((block) => block.text),
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

  /**
   * Scatter this frame's own answers back to their blocks, cache them, and time the round trip.
   *
   * `outcome.texts` is dense and indexed by the miss batch; each `index` is where that miss sits
   * in the survivor list. Conflating the two is the row shift this module exists to avoid.
   */
  #takeAnswers(
    blocks: readonly TextBlock[],
    misses: readonly number[],
    translated: (string | undefined)[],
    origins: EntryOrigin[],
    outcome: TranslationOutcome,
    translateStartedAt: number,
  ): void {
    for (let slot = 0; slot < misses.length; slot += 1) {
      const index = misses[slot];
      if (index === undefined) continue;
      const block = blocks[index];
      if (block === undefined) continue;
      translated[index] = outcome.texts[slot] ?? block.text;
      origins[index] = outcome.degraded ? 'degraded' : 'engine';
    }

    if (!outcome.degraded && outcome.engine !== null && misses.length > 0) {
      this.#writeBack(blocks, misses, translated, outcome.engine);
    }

    if (misses.length > 0) {
      this.#metrics?.record('translate', this.#now() - translateStartedAt);
    }
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
   * Turn the observed screen into the whole displayed set (#53).
   *
   * Walks every observed block in reading order, not just the ones that were translated, so the
   * result describes the screen rather than the delta. Each block contributes at most one entry
   * and it comes from one of two places:
   *
   *   - **fresh** (`slot !== null`): this frame's translation, at the block's own index. A
   *     `undefined` result is a block still waiting on the engine (progressive half) or one the
   *     same-language skip took out. The first of those keeps whatever the box was showing, which
   *     is what stops a line whose words changed from blinking out for the length of the round
   *     trip; the second has nothing remembered and produces nothing.
   *   - **duplicate**: whatever that text was translated to when it was last translated. The
   *     rectangle comes from *this* frame, so a line that moved takes its box with it, while the
   *     `sourceText` identity stays as first read - see {@link DisplayedEntry}.
   *
   * `next` is the displayed set this payload would produce. It is returned rather than assigned
   * because a payload that never reaches the renderer must not change what we believe is on it.
   *
   * A `degraded` entry is held like any other. That is design doc section 7 seen from one stage
   * further on: if held entries excluded the untranslated originals, then the frame after an
   * outage - every block a duplicate, every lookup a miss - would draw nothing at all, which is
   * precisely the blank screen the exemption exists to prevent. `RecentOutputs` still must never
   * record them; the two memories have opposite rules on purpose.
   */
  #buildEntries(
    observed: readonly RecalledBlock[],
    translated: readonly (string | undefined)[],
    origins: readonly EntryOrigin[],
  ): {
    entries: OverlayEntry[];
    identical: number;
    held: number;
    /** Whether any entry in this set is an untranslated original, held or fresh. */
    degraded: boolean;
    next: Map<string, DisplayedEntry>;
  } {
    const entries: OverlayEntry[] = [];
    const next = new Map<string, DisplayedEntry>();
    let identical = 0;
    let held = 0;
    let degraded = false;

    const keep = (key: string, entry: DisplayedEntry, block: TextBlock): void => {
      entries.push({
        text: entry.text,
        sourceText: entry.sourceText,
        bbox: block.bbox,
        origin: entry.origin,
      });
      // The rectangle is refreshed, the identity is not: `#recall`'s position bound has to be
      // measured against where the box actually is, or a line drifting a few px a frame would
      // eventually fall outside a rectangle recorded minutes ago.
      next.set(key, { ...entry, bbox: block.bbox });
      if (entry.origin === 'degraded') degraded = true;
    };

    for (const item of observed) {
      const { block, key, slot, remembered } = item;
      const text = slot === null ? undefined : translated[slot];

      if (text === undefined) {
        // Nothing new for this block. Either it is a duplicate, or its translation has not come
        // back yet. Both mean "show what is already there", and nothing remembered means there is
        // nothing to show - a same-language skip, an identical translation, or a line whose entry
        // was retired. None of those is an error.
        if (remembered === undefined) continue;
        keep(key, remembered, block);
        held += 1;
        continue;
      }

      const entry = freshEntry(block, text, origins[slot ?? 0] ?? 'engine');
      if (entry === undefined) {
        identical += 1;
        continue;
      }

      keep(key, entry, block);
    }

    return { entries, identical, held, degraded, next };
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
   * @returns whether the payload reached the renderer - that it was not overtaken, that it was not
   *          read from a scene reset since (#78), and that the consumer did not refuse it.
   *
   * The second half matters more than it looks. `src/main/index.ts` hands the payload to
   * `WindowManager.sendOverlayPayload`, which sends nothing while the overlay document is still
   * starting up. Counting that as sent would advance #36's baseline to text nobody saw: the
   * screen would then look unchanged for the rest of the session, the retry that dedup's expiring
   * window produces would be suppressed, and the first subtitle of the session would never appear
   * - silently, which is the whole failure the emit-gated baseline exists to prevent.
   */
  #emit(ticket: FrameTicket, payload: OverlayPayload): boolean {
    if (ticket.generation !== this.#generation) {
      // #78. Read from a scene `resetScene` has since forgotten. Expected on every reset that
      // lands mid-translation, so debug; the reset itself is what the user asked for.
      this.#logger.debug('dropping a payload from before the screen memory was reset', {
        seq: ticket.seq,
        order: ticket.order,
        generation: ticket.generation,
        current: this.#generation,
        entries: payload.entries.length,
      });
      return false;
    }
    // `>=` on the way in, so a frame's own partial payload does not lock out its complete one.
    if (ticket.order < this.#lastEmittedOrder) {
      // A slow frame finished after a newer one already drew. Its text is stale by definition.
      // Since #78, a line it carried that the newer frame could see was either in `#displayed` or
      // still published when the newer frame started - a line stays published while any frame
      // holding it is in flight - so the newer frame carried it too. Lines the newer frame could
      // not see have left the screen. The one gap is a line nobody holds any more whose dedup
      // admission outlived its frame; that is dedup's, not this guard's.
      this.#logger.debug('dropping a payload overtaken by a newer frame', {
        seq: ticket.seq,
        order: ticket.order,
        lastEmittedOrder: this.#lastEmittedOrder,
        entries: payload.entries.length,
      });
      return false;
    }
    this.#lastEmittedOrder = ticket.order;
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
export type SceneResettable = Pick<TextPipeline, 'resetScene'>;

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
