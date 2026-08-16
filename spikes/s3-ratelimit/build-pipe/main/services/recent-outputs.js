/**
 * Layer 2 of feedback loop prevention (issue M3-04, feature F2, design doc section 6).
 *
 * Every string the overlay puts on screen - both the English it echoed and the Thai it drew -
 * goes in here. When OCR reads one of them back on a later frame, it is recognised as our own
 * output and dropped instead of translated.
 *
 * The design doc rates this layer "medium" confidence, and the reason is worth being honest
 * about: OCR does not read our own text back perfectly either, so a translation rendered as
 * `เจ้าต้องตามหากุญแจ` can come back with a character wrong and miss a lookup here. That is
 * why layer 3 (`thai-script-filter.ts`) exists and why this one is not allowed to be the only
 * defence. What this layer *does* catch that layer 3 cannot is the English source text echoed
 * back - which carries no Thai at all.
 *
 * ## The set is bounded
 *
 * An unbounded set of every string ever displayed is a leak in a process the user leaves
 * running for hours. Entries are held in insertion order and the oldest is evicted once the
 * capacity is reached.
 *
 * ## `has` does not refresh recency
 *
 * Looking a string up is a query, not a sighting. Only `remember` - which the render stage
 * calls when it actually puts something on screen - moves an entry to the newest position.
 * If lookups refreshed, a single string that OCR kept re-reading would pin itself at the head
 * of the queue forever and evict genuinely recent output around it.
 */
/**
 * Reduce a string to the form two stages compare on: NFC, lower case, punctuation and symbols
 * removed, whitespace runs collapsed.
 *
 * It lives here rather than in `dedup.ts` because both stages must agree on what "the same
 * string" means, and issue order puts this module first. If they disagreed, a string could be
 * remembered in one form and looked up in another, and F2 would report a miss on text it had
 * definitely displayed - a silent hole in a filter that looks like it is working.
 *
 * Punctuation is deleted rather than replaced with a space, so `don't` and `dont` collapse
 * together. That is the right call for OCR output, where an apostrophe is exactly the kind of
 * mark that comes and goes between frames.
 */
export function normalizeForComparison(text) {
    return text
        .normalize('NFC')
        .toLowerCase()
        .replace(/[\p{P}\p{S}]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}
export const DEFAULT_RECENT_OUTPUTS_CAPACITY = 128;
/**
 * A bounded, insertion-ordered set of recently displayed strings.
 *
 * Backed by a `Map`, whose iteration order is insertion order - so the first key is always the
 * oldest and eviction is one `delete`.
 */
export class RecentOutputs {
    #capacity;
    /** Normalized text -> nothing. A `Map` rather than a `Set` only for the re-insert semantics. */
    #entries = new Map();
    constructor(capacity = DEFAULT_RECENT_OUTPUTS_CAPACITY) {
        if (!Number.isInteger(capacity) || capacity < 1) {
            // Invariant 4: a capacity of 0 would make `remember` a no-op and `has` always false,
            // i.e. a feedback filter that is silently switched off.
            throw new RangeError(`capacity must be a positive integer, got ${String(capacity)}`);
        }
        this.#capacity = capacity;
    }
    get capacity() {
        return this.#capacity;
    }
    get size() {
        return this.#entries.size;
    }
    /**
     * Record a string as displayed. Re-remembering an existing string moves it to the newest
     * position, because it was displayed again and is therefore more recent, not less.
     *
     * Strings that normalize to nothing - whitespace, a lone bullet - are ignored. Storing the
     * empty string would make `has('')` true, and then anything that also normalized to nothing
     * would be filtered as feedback. Harmless-looking, and wrong.
     */
    remember(text) {
        const key = normalizeForComparison(text);
        if (key.length === 0)
            return;
        // Delete before set so an existing key moves to the end of the iteration order.
        this.#entries.delete(key);
        this.#entries.set(key, true);
        while (this.#entries.size > this.#capacity) {
            const oldest = this.#entries.keys().next();
            if (oldest.done === true)
                break;
            this.#entries.delete(oldest.value);
        }
    }
    /** True when this string was displayed recently enough to still be held. */
    has(text) {
        const key = normalizeForComparison(text);
        if (key.length === 0)
            return false;
        return this.#entries.has(key);
    }
    clear() {
        this.#entries.clear();
    }
    /** Held strings in normalized form, oldest first. For tests and diagnostics. */
    snapshot() {
        return [...this.#entries.keys()];
    }
}
