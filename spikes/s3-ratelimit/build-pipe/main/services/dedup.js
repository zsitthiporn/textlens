/**
 * Suppressing text we have already translated (issue M3-05, feature A5).
 *
 * OCR does not read the same pixels the same way twice. A subtitle that sits still for three
 * seconds arrives six times with the box jittering a few px and the occasional character
 * different, and comparing strings exactly would retranslate it every single time. This is the
 * last stage before translation in design doc section 4, and its job is to answer one question:
 * *have we already handled this?*
 *
 * ## The two errors are not equally expensive, and this file is tuned around that
 *
 * A **false negative** - failing to recognise a duplicate - costs one redundant translation.
 * The user sees the right thing; we spent a little quota, and after M4 lands most of those are
 * cache hits anyway.
 *
 * A **false positive** - calling genuinely new text a duplicate - means that text is never
 * translated and never drawn. There is no error, no log entry the user would think to look
 * for, and nothing on screen. It is exactly the silent failure CLAUDE.md invariant 4 exists to
 * forbid, and the user's only symptom is a line that "sometimes doesn't work".
 *
 * So every threshold here is set at the end of its range that produces false negatives, and
 * three specific rules exist only to close false-positive holes:
 *
 * 1. **The similarity threshold is 0.95, not the ~0.85 that reads as a natural default.**
 *    `get to the port and secure the evacuation` against `...the extraction` scores 0.90 -
 *    a different word, a different instruction, and at 0.85 it would be silently swallowed.
 *    0.95 leaves room for roughly one changed character per twenty, which is the size of the
 *    error spike S1 actually measured (`o`/`O`, `I`/`1`, a dropped space), and no more.
 *
 * 2. **Differing digits disable every fuzzy path.** `40 minutes` and `39 minutes` are one edit
 *    apart and mean different things; so are `score 100` and `score 200`. No character-level
 *    metric can separate "the recognizer slipped" from "the number changed", so when the digit
 *    sequences differ the answer is simply *new*. The known cost is that an `o`->`0` misread
 *    inside a word now reads as new text and gets retranslated. That is the cheap error.
 *
 * 3. **The prefix rule is asymmetric.** A candidate that is a prefix of something already seen
 *    is a partial read of it - duplicate. A candidate that *extends* something already seen is
 *    not: it is more text than we had before. A subtitle that types itself out arrives as
 *    `do not shoot` and then `do not shoot the hostage`, and a symmetric prefix rule would
 *    suppress the complete sentence in favour of the fragment it already translated.
 *
 * ## Position
 *
 * Positions are snapped to a grid and entries are indexed by cell, per the issue. But the grid
 * is only the index: a match additionally requires the two boxes' top-left corners to be within
 * `positionTolerance` logical px (Chebyshev - within tolerance on both axes). Grid membership
 * alone gets both directions wrong, and asymmetrically: a 3px move across a cell boundary would
 * be a false negative (cheap), while a 20px move inside one large cell would be a false
 * positive (expensive). The search radius is derived from `ceil(tolerance / gridSize)` so the
 * two options cannot be configured into disagreement.
 *
 * ## Time
 *
 * Entries expire `windowMs` after they were recorded, and **a match does not refresh the
 * timestamp**. Refreshing would let a chain of slightly-drifting reads extend one entry's
 * suppression indefinitely, which is the false-positive direction. Not refreshing means a
 * subtitle that stays on screen longer than the window is retranslated once - the cheap error,
 * and one that anti-flicker (design doc section 5) absorbs before it reaches the screen.
 *
 * Text arrives here already filtered for noise (#14) and for Thai (#15), so the strings this
 * module compares are English. `levenshteinDistance` therefore works in UTF-16 code units,
 * which is correct for that input and would need revisiting for anything outside the BMP.
 */
import { normalizeForComparison } from './recent-outputs.js';
export const DEFAULT_WINDOW_MS = 3000;
export const DEFAULT_GRID_SIZE = 12;
export const DEFAULT_POSITION_TOLERANCE = 12;
export const DEFAULT_SIMILARITY_THRESHOLD = 0.95;
export const DEFAULT_FUZZY_MIN_LENGTH = 8;
export const DEFAULT_PREFIX_MIN_LENGTH = 6;
export const DEFAULT_PREFIX_MIN_RATIO = 0.5;
export const DEFAULT_MAX_ENTRIES = 256;
/**
 * Remembers what has been translated recently and where.
 *
 * The clock is a required argument to `admit` rather than a hidden `Date.now()`: the time
 * window is half the logic in here, and logic driven by an ambient clock is logic that can
 * only be tested by waiting.
 */
export class Deduplicator {
    #options;
    /** Grid cell key -> entries in that cell. See the module comment on why the grid is only an index. */
    #cells = new Map();
    constructor(options = {}) {
        const gridSize = options.gridSize ?? DEFAULT_GRID_SIZE;
        if (!(gridSize > 0) || !Number.isFinite(gridSize)) {
            throw new RangeError(`gridSize must be a positive finite number, got ${String(gridSize)}`);
        }
        this.#options = {
            windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
            gridSize,
            positionTolerance: options.positionTolerance ?? DEFAULT_POSITION_TOLERANCE,
            similarityThreshold: options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
            fuzzyMinLength: options.fuzzyMinLength ?? DEFAULT_FUZZY_MIN_LENGTH,
            prefixMinLength: options.prefixMinLength ?? DEFAULT_PREFIX_MIN_LENGTH,
            prefixMinRatio: options.prefixMinRatio ?? DEFAULT_PREFIX_MIN_RATIO,
            maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
        };
    }
    /** Number of live entries. Expired ones are swept on the next `admit`. */
    get size() {
        let total = 0;
        for (const entries of this.#cells.values())
            total += entries.length;
        return total;
    }
    reset() {
        this.#cells.clear();
    }
    /**
     * Decide whether this candidate has already been handled, and record it if it has not.
     *
     * A duplicate verdict deliberately records **nothing**: the entry it matched stays as it is,
     * with its original timestamp. See the module comment on why the window does not refresh.
     *
     * @param nowMs Monotonic-ish milliseconds. `Date.now()` in production, a counter in tests.
     */
    admit(candidate, nowMs) {
        this.#expire(nowMs);
        const text = normalizeForComparison(candidate.text);
        // Nothing to compare and nothing worth remembering. Not a duplicate - passing it through
        // lets the noise filter's decision stand rather than quietly overruling it here.
        if (text.length === 0)
            return { duplicate: false };
        const digits = digitSignature(text);
        const { x, y } = candidate.bbox;
        for (const entry of this.#nearbyEntries(x, y)) {
            const match = compare({ text, digits }, entry, this.#options);
            if (match !== undefined) {
                return { duplicate: true, reason: match.reason, matchedText: entry.text, similarity: match.similarity };
            }
        }
        this.#record({ text, digits, x, y, at: nowMs });
        this.#trim();
        return { duplicate: false };
    }
    #record(entry) {
        const key = this.#cellKey(entry.x, entry.y);
        const cell = this.#cells.get(key);
        if (cell === undefined)
            this.#cells.set(key, [entry]);
        else
            cell.push(entry);
    }
    /** Entries in the cells that could contain a box within `positionTolerance` of (x, y). */
    *#nearbyEntries(x, y) {
        const { gridSize, positionTolerance } = this.#options;
        // Derived, not assumed: with a grid finer than the tolerance the match could sit several
        // cells away, and a hard-coded 3x3 neighbourhood would miss it.
        const radius = Math.ceil(positionTolerance / gridSize);
        const centreX = Math.floor(x / gridSize);
        const centreY = Math.floor(y / gridSize);
        for (let cellX = centreX - radius; cellX <= centreX + radius; cellX += 1) {
            for (let cellY = centreY - radius; cellY <= centreY + radius; cellY += 1) {
                const cell = this.#cells.get(`${String(cellX)}:${String(cellY)}`);
                if (cell === undefined)
                    continue;
                for (const entry of cell) {
                    if (Math.abs(entry.x - x) <= positionTolerance && Math.abs(entry.y - y) <= positionTolerance) {
                        yield entry;
                    }
                }
            }
        }
    }
    #cellKey(x, y) {
        const cellX = Math.floor(x / this.#options.gridSize);
        const cellY = Math.floor(y / this.#options.gridSize);
        return `${String(cellX)}:${String(cellY)}`;
    }
    /**
     * Drop entries older than the window. Run before matching, so an expired entry can never
     * decide a verdict.
     *
     * The boundary is exclusive: an entry recorded at `t` is already gone at `t + windowMs`.
     *
     * A full pass over the map on every call, which is fine: the set is bounded by `maxEntries`
     * at 256 and the whole group-filter-dedup stage has a 5ms budget (design doc section 4).
     */
    #expire(nowMs) {
        const cutoff = nowMs - this.#options.windowMs;
        for (const [key, entries] of this.#cells) {
            const kept = entries.filter((entry) => entry.at > cutoff);
            if (kept.length === 0)
                this.#cells.delete(key);
            else if (kept.length !== entries.length)
                this.#cells.set(key, kept);
        }
    }
    /**
     * Enforce `maxEntries`, oldest first. Run after recording rather than before, so the cap is
     * exact rather than exceeded by one until the next call.
     *
     * The window normally keeps the set far below the cap; this is the backstop for a caller
     * whose clock does not advance, where nothing would ever expire.
     */
    #trim() {
        const live = [];
        for (const entries of this.#cells.values())
            live.push(...entries);
        const surplus = live.length - this.#options.maxEntries;
        if (surplus <= 0)
            return;
        const doomed = new Set(live.sort((a, b) => a.at - b.at).slice(0, surplus));
        for (const [key, entries] of this.#cells) {
            const kept = entries.filter((entry) => !doomed.has(entry));
            if (kept.length === 0)
                this.#cells.delete(key);
            else
                this.#cells.set(key, kept);
        }
    }
}
/**
 * Run a batch of blocks through one `Deduplicator`, in order.
 *
 * Order matters within a batch: two identical blocks in the same frame mean the second is a
 * duplicate of the first, which is the correct answer - the same sentence rendered twice on
 * one screen only needs translating once.
 */
export function dedupeBlocks(blocks, deduplicator, nowMs) {
    const kept = [];
    const dropped = [];
    for (const block of blocks) {
        const decision = deduplicator.admit({ text: block.text, bbox: block.bbox }, nowMs);
        if (decision.duplicate)
            dropped.push({ block, decision });
        else
            kept.push(block);
    }
    return { kept, dropped };
}
/**
 * The digits in a string, in order, with runs kept separate.
 *
 * `40 minutes` -> `40`, `39 minutes` -> `39`, `level 100` -> `100`, `hello world` -> ``.
 * Separated by a character that cannot appear in the value, so `1` followed by `2` is not
 * confusable with `12`.
 */
export function digitSignature(text) {
    return (text.match(/\d+/gu) ?? []).join('.');
}
/**
 * Levenshtein edit distance in UTF-16 code units.
 *
 * Two rolling rows rather than a full matrix: the strings here are subtitle-length, but this
 * runs on every block of every frame inside a 5ms stage budget.
 */
export function levenshteinDistance(a, b) {
    if (a === b)
        return 0;
    if (a.length === 0)
        return b.length;
    if (b.length === 0)
        return a.length;
    let previous = new Array(b.length + 1).fill(0);
    let current = new Array(b.length + 1).fill(0);
    for (let j = 0; j <= b.length; j += 1)
        previous[j] = j;
    for (let i = 1; i <= a.length; i += 1) {
        current[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const substitution = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + substitution);
        }
        [previous, current] = [current, previous];
    }
    return previous[b.length] ?? 0;
}
/** Edit distance as a 0..1 score against the longer string. 1 means identical. */
export function similarity(a, b) {
    const longest = Math.max(a.length, b.length);
    if (longest === 0)
        return 1;
    return 1 - levenshteinDistance(a, b) / longest;
}
/**
 * The whole matching rule, in the order the module comment argues for.
 *
 * Exact equality first and unconditionally - it is the only path that is not a judgement call.
 * Everything after it is gated on the strings being long enough to judge and on their digits
 * agreeing, and only then does either fuzzy rule get to speak.
 */
function compare(candidate, entry, options) {
    if (candidate.text === entry.text)
        return { reason: 'exact', similarity: 1 };
    // A one-character difference in a five-character string is not jitter, it is a different word.
    if (Math.min(candidate.text.length, entry.text.length) < options.fuzzyMinLength)
        return undefined;
    // The number changed, so the text changed. No similarity score gets to overrule this.
    if (candidate.digits !== entry.digits)
        return undefined;
    // Asymmetric on purpose: the candidate must be the *shorter* one, i.e. a partial read of
    // text we already have. A candidate that extends the entry is new text, not a repeat.
    if (entry.text.startsWith(candidate.text)) {
        const covered = candidate.text.length / entry.text.length;
        if (candidate.text.length >= options.prefixMinLength && covered >= options.prefixMinRatio) {
            return { reason: 'prefix', similarity: covered };
        }
    }
    const score = similarity(candidate.text, entry.text);
    if (score >= options.similarityThreshold)
        return { reason: 'similar', similarity: score };
    return undefined;
}
