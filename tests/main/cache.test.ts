/**
 * Issue #21 / M4-04, features K1 (translation cache) + K2 (normalized cache key).
 *
 * Three things get more scrutiny than "does get return what set stored":
 *
 *   - K2 itself: `"Hello World"`, `"hello world!"` and `"Hello  World"` must resolve to the
 *     exact same cache entry, because that is the entire benefit this feature buys over the
 *     reference project's raw-text hash.
 *   - "one query, not fifty": a batch read of many lookups is proved with a spy on the sqlite
 *     driver's own `StatementSync.prototype.all`, not by eyeballing the `IN (...)` clause in
 *     cache.ts. A prepared-statement-per-lookup implementation would fail this loudly.
 *   - The corrupt-database path (invariant 4): a real file with a clobbered header, opened for
 *     real, must disable the cache instead of throwing - and something reachable (the injected
 *     logger, `status`, `lastError`) must say so.
 *
 * TTL tests use an injected clock (`now: () => number`), a plain counter - nothing here sleeps.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LogFields, Logger } from '../../src/main/services/logger.js';
import {
  TranslationCache,
  type CacheLookup,
  type CacheWrite,
} from '../../src/main/services/cache.js';

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

describe('TranslationCache: K2 normalized key', () => {
  it('case difference resolves to the same entry', () => {
    const cache = new TranslationCache(tempDbPath());
    cache.set('Hello World', 'en', 'th', 'google', 'สวัสดีชาวโลก');
    expect(cache.get('hello world', 'en', 'th', 'google')).toBe('สวัสดีชาวโลก');
    cache.close();
  });

  it('a trailing exclamation mark resolves to the same entry', () => {
    const cache = new TranslationCache(tempDbPath());
    cache.set('Hello World', 'en', 'th', 'google', 'สวัสดีชาวโลก');
    expect(cache.get('hello world!', 'en', 'th', 'google')).toBe('สวัสดีชาวโลก');
    cache.close();
  });

  it('a doubled internal space resolves to the same entry', () => {
    const cache = new TranslationCache(tempDbPath());
    cache.set('Hello World', 'en', 'th', 'google', 'สวัสดีชาวโลก');
    expect(cache.get('Hello  World', 'en', 'th', 'google')).toBe('สวัสดีชาวโลก');
    cache.close();
  });

  it('text that normalizes to nothing is never stored and never hits', () => {
    // "!!!" and "???" both normalize (strip punctuation) to the empty string. If they shared
    // a key the way two real strings should, one would silently return the other's
    // translation - the same trap RecentOutputs.remember() already guards against.
    const cache = new TranslationCache(tempDbPath());
    cache.set('!!!', 'en', 'th', 'google', 'should never be stored');
    expect(cache.get('???', 'en', 'th', 'google')).toBeUndefined();
    expect(cache.get('!!!', 'en', 'th', 'google')).toBeUndefined();
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
});
