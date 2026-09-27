/**
 * Issue #21 / M4-04, features K1 (translation cache) + K2 (normalized cache key). Key
 * normalization narrowed by #87 - see the collision table in that issue and in cache.ts's module
 * doc.
 *
 * Three things get more scrutiny than "does get return what set stored":
 *
 *   - K2 itself: `"Hello World"`, `"hello world"` and `"Hello  World"` must resolve to the exact
 *     same cache entry, because that is the entire benefit this feature buys over the reference
 *     project's raw-text hash. But (#87) `"Hello World"` and `"Hello World!"` must NOT - the
 *     exclamation mark is meaning, not OCR noise, and folding it away is exactly what silently
 *     served a 14-day-stale wrong translation in the issue's collision table.
 *   - "one query, not fifty": a batch read of many lookups is proved with a spy on the sqlite
 *     driver's own `StatementSync.prototype.all`, not by eyeballing the `IN (...)` clause in
 *     cache.ts. A prepared-statement-per-lookup implementation would fail this loudly.
 *   - The corrupt-database path (invariant 4): a real file with a clobbered header, opened for
 *     real, must disable the cache instead of throwing - and something reachable (the injected
 *     logger, `status`, `lastError`) must say so.
 *
 * TTL tests use an injected clock (`now: () => number`), a plain counter - nothing here sleeps.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LogFields, Logger } from '../../src/main/services/logger.js';
import {
  DEFAULT_CLEANUP_INTERVAL_MS,
  TranslationCache,
  normalizeForCacheKey,
  startCacheCleanup,
  type CacheLookup,
  type CacheWrite,
} from '../../src/main/services/cache.js';
import { normalizeForComparison } from '../../src/main/services/recent-outputs.js';

function collectingLogger(): {
  logger: Logger;
  lines: Array<{ level: string; message: string; fields?: LogFields }>;
} {
  const lines: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    };
  const logger: Logger = {
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    sensitive() {},
    isDebugEnabled: false,
    level: 'info',
    child: () => logger,
  };
  return { logger, lines };
}

const dirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textlens-cache-'));
  dirs.push(dir);
  return path.join(dir, 'cache.db');
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('TranslationCache: basic read/write', () => {
  it('write then read returns the value', () => {
    const cache = new TranslationCache(tempDbPath());
    cache.set('Hello World', 'en', 'th', 'google', 'สวัสดีชาวโลก');

    expect(cache.get('Hello World', 'en', 'th', 'google')).toBe('สวัสดีชาวโลก');
    cache.close();
  });

  it('a lookup that was never written is a miss, not an error', () => {
    const cache = new TranslationCache(tempDbPath());
    expect(cache.get('never written', 'en', 'th', 'google')).toBeUndefined();
    cache.close();
  });
});

describe('normalizeForCacheKey (#87)', () => {
  it('folds case', () => {
    expect(normalizeForCacheKey('Hello World')).toBe('hello world');
  });

  it('collapses internal whitespace runs and trims leading/trailing whitespace', () => {
    expect(normalizeForCacheKey('  Hello   World  ')).toBe('hello world');
  });

  it('is NFC-normalized: precomposed and decomposed forms of the same character match', () => {
    const precomposed = 'café'; // é as a single code point
    const decomposed = 'café'; // e + combining acute accent
    expect(precomposed).not.toBe(decomposed); // sanity: genuinely different code unit sequences
    expect(normalizeForCacheKey(precomposed)).toBe(normalizeForCacheKey(decomposed));
    expect(normalizeForCacheKey(precomposed)).toBe('café');
  });

  it('keeps punctuation, signs, and currency symbols - unlike normalizeForComparison', () => {
    expect(normalizeForCacheKey('Temperature -10')).toBe('temperature -10');
    expect(normalizeForCacheKey('Discount 50%')).toBe('discount 50%');
    expect(normalizeForCacheKey('Cost: $5')).toBe('cost: $5');
    expect(normalizeForCacheKey('Level +3')).toBe('level +3');
    expect(normalizeForCacheKey('You are leaving?')).toBe('you are leaving?');
  });

  it('whitespace-only text normalizes to the empty string', () => {
    expect(normalizeForCacheKey('   ')).toBe('');
  });

  it('bare punctuation does NOT normalize to the empty string (unlike normalizeForComparison)', () => {
    expect(normalizeForCacheKey('!!!')).toBe('!!!');
    expect(normalizeForComparison('!!!')).toBe(''); // the old behaviour, for contrast
  });
});

describe('TranslationCache: K2 normalized key', () => {
  it('case difference resolves to the same entry', () => {
    const cache = new TranslationCache(tempDbPath());
    cache.set('Hello World', 'en', 'th', 'google', 'สวัสดีชาวโลก');
    expect(cache.get('hello world', 'en', 'th', 'google')).toBe('สวัสดีชาวโลก');
    cache.close();
  });

  it('a doubled internal space resolves to the same entry', () => {
    const cache = new TranslationCache(tempDbPath());
    cache.set('Hello World', 'en', 'th', 'google', 'สวัสดีชาวโลก');
    expect(cache.get('Hello  World', 'en', 'th', 'google')).toBe('สวัสดีชาวโลก');
    cache.close();
  });

  it('an NFC/NFD variant of the same text resolves to the same entry', () => {
    const cache = new TranslationCache(tempDbPath());
    cache.set('café', 'en', 'th', 'google', 'translation of café');
    expect(cache.get('café', 'en', 'th', 'google')).toBe('translation of café');
    cache.close();
  });

  it('whitespace-only text is never stored and never hits', () => {
    // Only whitespace normalizes to empty under the #87 key (bare punctuation no longer does -
    // see the next describe block). If two different whitespace-only strings shared a key the
    // way two real strings should, one would silently return the other's translation - the same
    // trap RecentOutputs.remember() already guards against.
    const cache = new TranslationCache(tempDbPath());
    cache.set('   ', 'en', 'th', 'google', 'should never be stored');
    expect(cache.get('    ', 'en', 'th', 'google')).toBeUndefined();
    expect(cache.get('   ', 'en', 'th', 'google')).toBeUndefined();
    cache.close();
  });

  it('a different target language is a different entry', () => {
    const cache = new TranslationCache(tempDbPath());
    cache.set('Hello', 'en', 'th', 'google', 'สวัสดี');
    cache.set('Hello', 'en', 'ja', 'google', 'こんにちは');

    expect(cache.get('Hello', 'en', 'th', 'google')).toBe('สวัสดี');
    expect(cache.get('Hello', 'en', 'ja', 'google')).toBe('こんにちは');
    cache.close();
  });

  it('a different engine is a different entry, because translation quality differs', () => {
    const cache = new TranslationCache(tempDbPath());
    cache.set('Hello', 'en', 'th', 'google', 'สวัสดี (google)');
    cache.set('Hello', 'en', 'th', 'deepl', 'สวัสดี (deepl)');

    expect(cache.get('Hello', 'en', 'th', 'google')).toBe('สวัสดี (google)');
    expect(cache.get('Hello', 'en', 'th', 'deepl')).toBe('สวัสดี (deepl)');
    cache.close();
  });
});

describe('TranslationCache: punctuation and signs are meaningful, not noise (#87)', () => {
  // The collision table from the issue, run for real against this cache. Each pair used to
  // resolve to the same entry under K2's old `normalizeForComparison`-based key; whichever text
  // reached the translator first silently served its translation to the other for up to the
  // full TTL. Now: set one, look up the other, and it must be a clean miss - and the original
  // text must still resolve to its own translation, proving the lookup path itself still works.
  it.each<[string, string]>([
    ['Temperature -10', 'Temperature 10'],
    ['Discount 50%', 'Discount 50'],
    ['Cost: $5', 'Cost 5'],
    ['Level +3', 'Level 3'],
    ['You are leaving.', 'You are leaving?'],
  ])('%j and %j do not share a cache entry', (a, b) => {
    const cache = new TranslationCache(tempDbPath());
    cache.set(a, 'en', 'th', 'google', `translation of ${a}`);

    expect(cache.get(b, 'en', 'th', 'google')).toBeUndefined();
    expect(cache.get(a, 'en', 'th', 'google')).toBe(`translation of ${a}`);
    cache.close();
  });

  it('bare punctuation strings do not share a cache entry with each other', () => {
    // Companion to the "whitespace-only" case above: now that punctuation is kept, "!!!" and
    // "???" are two distinct (non-empty) cache keys, not two aliases for "nothing".
    const cache = new TranslationCache(tempDbPath());
    cache.set('!!!', 'en', 'th', 'google', 'translation of !!!');
    expect(cache.get('???', 'en', 'th', 'google')).toBeUndefined();
    expect(cache.get('!!!', 'en', 'th', 'google')).toBe('translation of !!!');
    cache.close();
  });
});

describe('TranslationCache: rows keyed the old (pre-#87) way are simply misses', () => {
  /**
   * Writes a row the way `TranslationCache` used to before #87 - `sha256(normalizeForComparison
   * (text))|src|tgt|engine` - directly via `node:sqlite`, bypassing the class entirely. This is
   * what an on-disk DB from before this change actually looks like.
   */
  function seedOldStyleRow(
    dbPath: string,
    text: string,
    srcLang: string,
    tgtLang: string,
    engineName: string,
    translated: string,
  ): void {
    const oldNormalized = normalizeForComparison(text);
    const oldKey = `${createHash('sha256').update(oldNormalized).digest('hex')}|${srcLang}|${tgtLang}|${engineName}`;

    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec(
        `CREATE TABLE IF NOT EXISTS cache_entries (
          cache_key TEXT PRIMARY KEY,
          translated TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )`,
      );
      seed
        .prepare(
          `INSERT INTO cache_entries (cache_key, translated, created_at, expires_at)
           VALUES (?, ?, 0, ?)`,
        )
        .run(oldKey, translated, Number.MAX_SAFE_INTEGER);
    } finally {
      seed.close();
    }
  }

  it('a row seeded under the old punctuation-stripping key is not found, does not throw, and does not disable the cache', () => {
    const dbPath = tempDbPath();
    const text = 'Cost: $5'; // old key hashed "cost 5" (stripped); new key hashes "cost: $5"
    seedOldStyleRow(dbPath, text, 'en', 'th', 'google', 'stale translation under the old key scheme');

    const { logger, lines } = collectingLogger();
    const cache = new TranslationCache(dbPath, { logger });

    expect(() => cache.get(text, 'en', 'th', 'google')).not.toThrow();
    expect(cache.get(text, 'en', 'th', 'google')).toBeUndefined();

    // An ordinary miss, not a corruption/error path - the cache stays fully usable.
    expect(cache.status).toBe('ready');
    expect(lines.some((l) => l.level === 'error')).toBe(false);

    // And it keeps working going forward: a fresh write/read round-trips under the new key.
    cache.set(text, 'en', 'th', 'google', 'new translation under the new key scheme');
    expect(cache.get(text, 'en', 'th', 'google')).toBe('new translation under the new key scheme');

    cache.close();
  });

  it('a row for text with nothing to strip hashes identically under both schemes and keeps hitting', () => {
    // The migration cost is narrower than "every old row is unreachable": normalizeForComparison
    // and normalizeForCacheKey agree whenever there is no punctuation/symbol for the old function
    // to strip. This is the boundary of what #87 actually breaks.
    const dbPath = tempDbPath();
    seedOldStyleRow(dbPath, 'Hello World', 'en', 'th', 'google', 'สวัสดีชาวโลก');

    const cache = new TranslationCache(dbPath);
    expect(cache.get('Hello World', 'en', 'th', 'google')).toBe('สวัสดีชาวโลก');
    cache.close();
  });
});

describe('TranslationCache: batching', () => {
  it('reads 50 texts in exactly one query', () => {
    const cache = new TranslationCache(tempDbPath());
    const writes: CacheWrite[] = Array.from({ length: 50 }, (_, i) => ({
      text: `text number ${i}`,
      srcLang: 'en',
      tgtLang: 'th',
      engineName: 'google',
      translated: `แปล ${i}`,
    }));
    cache.setBatch(writes);

    const spy = vi.spyOn(StatementSync.prototype, 'all');
    try {
      const lookups: CacheLookup[] = writes.map((w) => ({
        text: w.text,
        srcLang: w.srcLang,
        tgtLang: w.tgtLang,
        engineName: w.engineName,
      }));
      const results = cache.getBatch(lookups);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(results).toEqual(writes.map((w) => w.translated));
    } finally {
      spy.mockRestore();
      cache.close();
    }
  });

  it('all 20 writes land after a single setBatch call', () => {
    const cache = new TranslationCache(tempDbPath());
    const writes: CacheWrite[] = Array.from({ length: 20 }, (_, i) => ({
      text: `atomic ${i}`,
      srcLang: 'en',
      tgtLang: 'th',
      engineName: 'google',
      translated: `atomic-translated ${i}`,
    }));
    cache.setBatch(writes);

    const lookups: CacheLookup[] = writes.map((w) => ({
      text: w.text,
      srcLang: w.srcLang,
      tgtLang: w.tgtLang,
      engineName: w.engineName,
    }));
    expect(cache.getBatch(lookups)).toEqual(writes.map((w) => w.translated));
    cache.close();
  });

  it('a 50-entry setBatch wraps the whole write in exactly one BEGIN/COMMIT pair', () => {
    // Mechanical proof of "batch write in a single transaction" - counting the driver's own
    // exec() calls that carry transaction control statements, not reading the SQL string in
    // cache.ts and trusting it. A per-row-transaction implementation would fail this loudly
    // (50 BEGINs instead of 1).
    const cache = new TranslationCache(tempDbPath());
    const writes: CacheWrite[] = Array.from({ length: 50 }, (_, i) => ({
      text: `txn ${i}`,
      srcLang: 'en',
      tgtLang: 'th',
      engineName: 'google',
      translated: `txn-translated ${i}`,
    }));

    const spy = vi.spyOn(DatabaseSync.prototype, 'exec');
    try {
      cache.setBatch(writes);

      const sqlCalls = spy.mock.calls.map((call) => String(call[0]).trim().toUpperCase());
      expect(sqlCalls.filter((sql) => sql === 'BEGIN')).toHaveLength(1);
      expect(sqlCalls.filter((sql) => sql === 'COMMIT')).toHaveLength(1);
      expect(sqlCalls.filter((sql) => sql === 'ROLLBACK')).toHaveLength(0);
    } finally {
      spy.mockRestore();
      cache.close();
    }
  });
});

describe('TranslationCache: WAL mode', () => {
  it('the on-disk database is opened in WAL journal mode', () => {
    const dbPath = tempDbPath();
    const cache = new TranslationCache(dbPath);
    cache.set('touch the file', 'en', 'th', 'google', 'แตะไฟล์');
    cache.close();

    const check = new DatabaseSync(dbPath);
    try {
      const row = check.prepare('PRAGMA journal_mode').get() as Record<string, unknown> | undefined;
      expect(row?.['journal_mode']).toBe('wal');
    } finally {
      check.close();
    }
  });
});

describe('TranslationCache: TTL', () => {
  it('an expired entry is a miss on read even before cleanup runs, and cleanup removes it', () => {
    let now = 1_000_000;
    const cache = new TranslationCache(tempDbPath(), { ttlMs: 1_000, now: () => now });

    cache.set('stale', 'en', 'th', 'google', 'เก่า');
    now += 2_000; // past the 1000ms TTL
    cache.set('fresh', 'en', 'th', 'google', 'ใหม่');

    // Read-side filtering: correctness does not depend on cleanup() having run yet.
    expect(cache.get('stale', 'en', 'th', 'google')).toBeUndefined();
    expect(cache.get('fresh', 'en', 'th', 'google')).toBe('ใหม่');

    const removed = cache.cleanup();
    expect(removed).toBe(1);

    // And it stays gone.
    expect(cache.get('stale', 'en', 'th', 'google')).toBeUndefined();
    expect(cache.get('fresh', 'en', 'th', 'google')).toBe('ใหม่');

    cache.close();
  });

  it('cleanup on a cache with nothing expired removes nothing', () => {
    const cache = new TranslationCache(tempDbPath(), { ttlMs: 60_000, now: () => 0 });
    cache.set('alive', 'en', 'th', 'google', 'มีชีวิต');
    expect(cache.cleanup()).toBe(0);
    expect(cache.get('alive', 'en', 'th', 'google')).toBe('มีชีวิต');
    cache.close();
  });
});

describe('TranslationCache: performance', () => {
  it('batch-reads 50 of 10,000 entries in well under 10ms', () => {
    const cache = new TranslationCache(tempDbPath());
    const writes: CacheWrite[] = Array.from({ length: 10_000 }, (_, i) => ({
      text: `bulk text ${i}`,
      srcLang: 'en',
      tgtLang: 'th',
      engineName: 'google',
      translated: `t${i}`,
    }));
    cache.setBatch(writes);

    const lookups: CacheLookup[] = Array.from({ length: 50 }, (_, i) => ({
      text: `bulk text ${i * 137}`, // scattered across the 10,000 rows, not the first 50
      srcLang: 'en',
      tgtLang: 'th',
      engineName: 'google',
    }));

    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      cache.getBatch(lookups);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const min = samples[0] ?? Number.POSITIVE_INFINITY;
    const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;

    // Warm: same process that wrote the 10,000 rows, best-of-5 to dodge scheduler noise.
    console.log(
      `[cache perf] 50-of-10000 batch read: min=${min.toFixed(3)}ms median=${median.toFixed(3)}ms`,
    );
    expect(min).toBeLessThan(10);

    cache.close();
  });
});

describe('TranslationCache: corrupt or unopenable database (invariant 4)', () => {
  it('a file with a clobbered header disables the cache instead of throwing', () => {
    const dbPath = tempDbPath();

    // Seed a real, valid database, then corrupt its header bytes in place.
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE t (a INTEGER)');
    seed.close();
    const fd = fs.openSync(dbPath, 'r+');
    fs.writeSync(fd, Buffer.from('GARBAGEHEADERBYTESXX'), 0);
    fs.closeSync(fd);

    const { logger, lines } = collectingLogger();
    let cache!: TranslationCache;

    expect(() => {
      cache = new TranslationCache(dbPath, { logger });
    }).not.toThrow();

    expect(cache.status).toBe('disabled');
    expect(cache.lastError).toBeInstanceOf(Error);
    expect(lines.some((l) => l.level === 'error' && l.message.includes('disabled'))).toBe(true);

    // The app keeps working: neither call throws, and reads are clean misses.
    expect(() => cache.set('a', 'en', 'th', 'google', 'b')).not.toThrow();
    expect(cache.get('a', 'en', 'th', 'google')).toBeUndefined();
    expect(() => cache.getBatch([{ text: 'a', srcLang: 'en', tgtLang: 'th', engineName: 'google' }])).not.toThrow();
    expect(() => cache.cleanup()).not.toThrow();
  });

  it('an unopenable path (missing parent directory) disables the cache the same way', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textlens-cache-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'missing', 'nested', 'cache.db');

    const { logger, lines } = collectingLogger();
    const cache = new TranslationCache(dbPath, { logger });

    expect(cache.status).toBe('disabled');
    expect(lines.some((l) => l.level === 'error')).toBe(true);
    expect(cache.get('a', 'en', 'th', 'google')).toBeUndefined();
  });

  it('a zero-length file is treated as a fresh database, not corruption', () => {
    // SQLite's own semantics, verified directly: a 0-byte file is a valid empty database, not
    // an error. Confirming that here so nobody "fixes" this into a false-positive failure later.
    const dbPath = tempDbPath();
    fs.writeFileSync(dbPath, Buffer.alloc(0));

    const cache = new TranslationCache(dbPath);
    expect(cache.status).toBe('ready');
    cache.set('a', 'en', 'th', 'google', 'b');
    expect(cache.get('a', 'en', 'th', 'google')).toBe('b');
    cache.close();
  });

  it('a connection that goes bad mid-session during cleanup() specifically - not just open() - disables the cache', () => {
    // The existing corrupt-file cases above all fail at open(). This is the other half the class
    // doc promises ("a connection can go bad mid-session too") and the one #66's cleanup() call
    // newly exercises in a way nothing did before: a healthy cache whose *cleanup* query is what
    // hits the sqlite error.
    const dbPath = tempDbPath();
    const { logger, lines } = collectingLogger();
    const cache = new TranslationCache(dbPath, { logger });
    cache.set('alive', 'en', 'th', 'google', 'มีชีวิต');
    expect(cache.status).toBe('ready');

    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(() => {
      throw new Error('simulated sqlite failure mid-session');
    });
    try {
      // The class's own contract (see cache.ts's Invariant 4 doc): this must not throw to the
      // caller even though the query underneath it just did.
      expect(() => cache.cleanup()).not.toThrow();
    } finally {
      spy.mockRestore();
    }

    expect(cache.status).toBe('disabled');
    expect(lines.some((l) => l.level === 'error' && l.fields?.['phase'] === 'cleanup')).toBe(true);
    // Reads keep working - as a clean miss, not a second failure.
    expect(cache.get('alive', 'en', 'th', 'google')).toBeUndefined();
    cache.close();
  });
});

describe('startCacheCleanup (#66)', () => {
  it('deletes rows past TTL from disk at startup, and logs how many it removed', () => {
    // Physical proof, not the read-side filter `getBatch` already relies on: this is the thing
    // #66 exists because nothing was doing - actual DELETE, actual bytes freed.
    let now = 1_000_000;
    const dbPath = tempDbPath();
    const seed = new TranslationCache(dbPath, { ttlMs: 1_000, now: () => now });
    seed.set('stale one', 'en', 'th', 'google', 'เก่า1');
    seed.set('stale two', 'en', 'th', 'google', 'เก่า2');
    now += 2_000; // past the 1000ms TTL for the two entries above
    seed.set('fresh', 'en', 'th', 'google', 'ใหม่');
    seed.close();

    const cache = new TranslationCache(dbPath, { now: () => now });
    const { logger, lines } = collectingLogger();
    const stop = startCacheCleanup(cache, logger, 60_000);
    stop();
    cache.close();

    const swept = lines.find((l) => l.message === 'cache cleanup swept expired rows');
    expect(swept?.fields?.['removed']).toBe(2);

    const check = new DatabaseSync(dbPath);
    try {
      const row = check.prepare('SELECT COUNT(*) as n FROM cache_entries').get() as
        | Record<string, unknown>
        | undefined;
      expect(row?.['n']).toBe(1);
    } finally {
      check.close();
    }
  });

  it('sweeps immediately, again every intervalMs, and stops when told (mirrors startMetricsSummary)', () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fakeCache = { cleanup: (): number => { calls += 1; return 0; } };
      const { logger, lines } = collectingLogger();

      const stop = startCacheCleanup(fakeCache, logger, 1_000);
      // Startup call happens synchronously, before any timer fires.
      expect(calls).toBe(1);
      expect(lines).toHaveLength(1);

      vi.advanceTimersByTime(999);
      expect(calls).toBe(1);
      vi.advanceTimersByTime(1);
      expect(calls).toBe(2);

      vi.advanceTimersByTime(2_000);
      expect(calls).toBe(4);

      stop();
      vi.advanceTimersByTime(10_000);
      expect(calls).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cache whose cleanup() disables mid-sweep does not crash the caller, and is logged distinctly from a clean sweep', () => {
    // The trap the issue names: cleanup() failing must cost the cache, never startup. The real
    // TranslationCache never throws (previous describe block), but this proves the wiring itself
    // survives one that does - the same defensive stance text-pipeline.ts takes with
    // PipelineTranslator, because `cache` here is a structural type, not a guarantee.
    const { logger, lines } = collectingLogger();
    const throwingCache = {
      cleanup: (): number => {
        throw new Error('boom');
      },
    };

    let stop: (() => void) | undefined;
    expect(() => {
      stop = startCacheCleanup(throwingCache, logger, 1_000);
    }).not.toThrow();

    expect(lines.some((l) => l.level === 'error' && l.message.includes('threw'))).toBe(true);
    // And a sweep that did *not* throw is never confused with one that did.
    expect(lines.some((l) => l.message === 'cache cleanup swept expired rows')).toBe(false);

    stop?.();
  });

  it('a mid-session cleanup-phase disable is logged by the cache itself, tagged by phase, and the sweep still logs cleanly', () => {
    const dbPath = tempDbPath();
    const { logger, lines } = collectingLogger();
    const cache = new TranslationCache(dbPath, { logger });
    cache.set('alive', 'en', 'th', 'google', 'มีชีวิต');

    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(() => {
      throw new Error('simulated sqlite failure mid-session');
    });
    let stop: (() => void) | undefined;
    try {
      stop = startCacheCleanup(cache, logger, 60_000);
    } finally {
      spy.mockRestore();
    }

    expect(cache.status).toBe('disabled');
    // TranslationCache's own #disable() logged this, tagged by which phase disabled it - proof
    // that a cleanup-triggered disable is distinguishable in the log from an open/read/write one.
    expect(lines.some((l) => l.level === 'error' && l.fields?.['phase'] === 'cleanup')).toBe(true);
    // The sweep function itself did not treat the disable as a throw: `cleanup()` returned 0
    // cleanly, so its own line still fired.
    expect(lines.some((l) => l.message === 'cache cleanup swept expired rows')).toBe(true);

    stop?.();
    cache.close();
  });

  it('defaults to a 6-hour interval', () => {
    expect(DEFAULT_CLEANUP_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });
});
