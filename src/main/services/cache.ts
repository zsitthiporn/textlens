/**
 * Translation cache (issue #21 / M4-04, features K1 + K2).
 *
 * A cache hit costs 0ms against a 300-500ms translate budget (design doc latency table), so this
 * sits directly in the hot path every frame that reaches the translate stage.
 *
 * ## K2 - normalized cache key
 *
 * The reference project hashed raw OCR text, so a single wobbled character - `o` read as `O`, a
 * dropped space - missed the cache entirely even though the text meant the same thing. K2 hashes
 * `normalizeForComparison(text)` instead: NFC, lower case, punctuation/symbols stripped, whitespace
 * collapsed. `"Hello World"`, `"hello world!"` and `"Hello  World"` all hash to the same key. This
 * buys most of the benefit of the reference's fuzzy trigram cache (K4) without building the
 * trigram machinery they wrote and then switched off - see feature-spec.md 1.5.
 *
 * `normalizeForComparison` is imported from `recent-outputs.ts` rather than re-implemented here.
 * That module already owns the answer to "is this the same string" for the feedback-loop dedup
 * layer, and `dedup.ts` already imports it for the same reason (matching output display against
 * recently-seen text). The cache is asking a related question - "have I already paid to translate
 * this" - with the same OCR-wobble tolerance, so reusing it means both stages agree on what counts
 * as "the same text" and a future tweak to the normalization rules cannot silently drift between
 * them. The K2 acceptance cases below are pinned as literal tests here, so if that assumption ever
 * stops holding, this suite - not just recent-outputs.test.ts - will say so.
 *
 * Text whose normalized form is empty (bare punctuation, whitespace) is never stored and never
 * looked up, for the same reason `RecentOutputs.remember` skips it: an empty key would make every
 * other empty-normalizing string collide with whatever was stored first.
 *
 * ## Driver: node:sqlite
 *
 * Built into Node (and, verified directly, into Electron 43's bundled Node 24.18.1 runtime - both
 * via `ELECTRON_RUN_AS_NODE` and inside a real `app.whenReady()` main process). No native module,
 * no Electron rebuild step, nothing added to package.json. `better-sqlite3` was the fallback and
 * was not needed. Plain Node 22.22.3 (the dev/test runtime, `vitest`) still prints the "SQLite is
 * an experimental feature" warning on first use; the Electron 43 runs above did not - Electron's
 * bundled Node 24.18.1 no longer flags it, which is the runtime this actually ships on.
 *
 * ## Invariant 4 - no silent failure
 *
 * A corrupt or unopenable database file must not take translation down with it. `node:sqlite`
 * opens lazily - `new DatabaseSync(path)` does not throw for a corrupt file, the first real
 * statement does (`ERR_SQLITE_ERROR: file is not a database`), confirmed empirically against a
 * file with a clobbered header. So the constructor runs the schema-creation statement immediately
 * to force that check, and every query path (read, write, cleanup) is wrapped the same way, since
 * a connection can go bad mid-session too. On any sqlite error the cache logs once via the
 * injected `Logger.error`, closes the connection, and flips to a disabled state where `getBatch`
 * reports every lookup as a miss and `setBatch` is a no-op - the app keeps translating, just
 * without a cache. `status` and `lastError` are exposed so a caller can surface this to the user;
 * this module logs and makes the failure observable, it does not itself own UI notification.
 *
 * A zero-length file is deliberately *not* treated as corruption - confirmed empirically that
 * SQLite treats it as a fresh, empty database, which is correct and not a failure.
 */

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { nullLogger, type Logger } from './logger.js';
import { normalizeForComparison } from './recent-outputs.js';

export interface CacheLookup {
  readonly text: string;
  readonly srcLang: string;
  readonly tgtLang: string;
  readonly engineName: string;
}

export interface CacheWrite extends CacheLookup {
  readonly translated: string;
}

export interface TranslationCacheOptions {
  /** How long an entry lives before `cleanup()` removes it. Default 14 days. */
  readonly ttlMs?: number;
  readonly logger?: Logger;
  /** Injectable clock. Defaults to `Date.now`; tests use a plain counter. */
  readonly now?: () => number;
}

export type CacheStatus = 'ready' | 'disabled';

/**
 * Translations rarely go stale in the way live web content does, but nothing should accumulate
 * forever in a process users leave running across many sessions. 14 days is a generous default
 * that bounds growth without discarding recently-useful entries; callers may override it.
 */
export const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface CacheRow {
  cache_key: string;
  translated: string;
}

/**
 * `sha256(normalizeForComparison(text))` combined with the three fields that make a translation
 * specific to a context (K1: "src + tgt + engineName"). `undefined` when the text normalizes to
 * nothing - see the module doc comment.
 */
function computeCacheKey(
  text: string,
  srcLang: string,
  tgtLang: string,
  engineName: string,
): string | undefined {
  const normalized = normalizeForComparison(text);
  if (normalized.length === 0) return undefined;
  const hash = createHash('sha256').update(normalized).digest('hex');
  return `${hash}|${srcLang}|${tgtLang}|${engineName}`;
}

/**
 * SQLite-backed translation cache. Batch-first: `get`/`set` are one-item convenience wrappers
 * over `getBatch`/`setBatch`, because the real caller (the translate stage) has a frame's worth
 * of text blocks to look up or store at once, and that is the shape the acceptance criteria and
 * the latency budget care about.
 */
export class TranslationCache {
  #db: DatabaseSync | null;
  #status: CacheStatus = 'ready';
  #lastError: Error | undefined;
  readonly #logger: Logger;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(dbPath: string, options: TranslationCacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#logger = (options.logger ?? nullLogger()).child('cache');

    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath);
      // WAL is a file-format property; harmless (and a no-op-ish "memory") on :memory: dbs,
      // and lets concurrent readers proceed while a write transaction is open on the real file.
      db.exec('PRAGMA journal_mode = WAL');
      // node:sqlite opens lazily - this is the statement that actually proves the file is a
      // valid (or freshly-created) SQLite database. A corrupt file throws here, not above.
      db.exec(
        `CREATE TABLE IF NOT EXISTS cache_entries (
          cache_key TEXT PRIMARY KEY,
          translated TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )`,
      );
    } catch (err) {
      this.#disable(err, db, 'open');
      db = null;
    }
    this.#db = db;
  }

  /** `'disabled'` once any sqlite error has been hit - open, read, write, or cleanup. */
  get status(): CacheStatus {
    return this.#status;
  }

  /** The error that disabled the cache, if any. Never contains screen text. */
  get lastError(): Error | undefined {
    return this.#lastError;
  }

  #disable(err: unknown, db: DatabaseSync | null, phase: 'open' | 'read' | 'write' | 'cleanup'): void {
    this.#status = 'disabled';
    this.#lastError = err instanceof Error ? err : new Error(String(err));
    if (db) {
      try {
        db.close();
      } catch {
        // The connection is already broken; there is nothing left to release cleanly.
      }
    }
    this.#db = null;
    this.#logger.error('translation cache disabled; continuing without a cache', {
      phase,
      error: this.#lastError.message,
    });
  }

  /**
   * Looks up every entry in one query (`WHERE cache_key IN (...)`), not one query per lookup -
   * that is the entire point of taking a batch. Results line up positionally with `lookups`;
   * a miss (not cached, expired, or the cache is disabled) is `undefined` at that position.
   */
  getBatch(lookups: readonly CacheLookup[]): (string | undefined)[] {
    const keys = lookups.map((l) => computeCacheKey(l.text, l.srcLang, l.tgtLang, l.engineName));
    const results: (string | undefined)[] = keys.map(() => undefined);

    if (this.#db === null || lookups.length === 0) return results;

    const present: { index: number; key: string }[] = [];
    keys.forEach((key, index) => {
      if (key !== undefined) present.push({ index, key });
    });
    if (present.length === 0) return results;

    const db = this.#db;
    try {
      const placeholders = present.map(() => '?').join(',');
      const stmt = db.prepare(
        `SELECT cache_key, translated FROM cache_entries WHERE cache_key IN (${placeholders}) AND expires_at > ?`,
      );
      const rows = stmt.all(...present.map((p) => p.key), this.#now()) as unknown as CacheRow[];
      const found = new Map(rows.map((r) => [r.cache_key, r.translated]));
      for (const { index, key } of present) {
        results[index] = found.get(key);
      }
      return results;
    } catch (err) {
      this.#disable(err, db, 'read');
      return keys.map(() => undefined);
    }
  }

  get(text: string, srcLang: string, tgtLang: string, engineName: string): string | undefined {
    return this.getBatch([{ text, srcLang, tgtLang, engineName }])[0];
  }

  /** Writes every entry in one transaction. Entries that normalize to nothing are skipped. */
  setBatch(writes: readonly CacheWrite[]): void {
    if (this.#db === null || writes.length === 0) return;
    const db = this.#db;
    const now = this.#now();
    const expiresAt = now + this.#ttlMs;

    let began = false;
    try {
      db.exec('BEGIN');
      began = true;
      const stmt = db.prepare(
        `INSERT INTO cache_entries (cache_key, translated, created_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           translated = excluded.translated,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      );
      for (const write of writes) {
        const key = computeCacheKey(write.text, write.srcLang, write.tgtLang, write.engineName);
        if (key === undefined) continue;
        stmt.run(key, write.translated, now, expiresAt);
      }
      db.exec('COMMIT');
    } catch (err) {
      if (began) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Connection is already broken; there is nothing left to roll back.
        }
      }
      this.#disable(err, db, 'write');
    }
  }

  set(
    text: string,
    srcLang: string,
    tgtLang: string,
    engineName: string,
    translated: string,
  ): void {
    this.setBatch([{ text, srcLang, tgtLang, engineName, translated }]);
  }

  /**
   * Deletes rows whose TTL has passed and returns how many were removed. Reads already filter
   * `expires_at > now` on their own, so correctness never depends on how often this runs - it
   * only bounds disk use.
   */
  cleanup(): number {
    if (this.#db === null) return 0;
    const db = this.#db;
    try {
      const result = db.prepare('DELETE FROM cache_entries WHERE expires_at <= ?').run(this.#now());
      return Number(result.changes);
    } catch (err) {
      this.#disable(err, db, 'cleanup');
      return 0;
    }
  }

  close(): void {
    if (this.#db) {
      try {
        this.#db.close();
      } catch {
        // Best-effort close.
      }
      this.#db = null;
    }
  }
}
