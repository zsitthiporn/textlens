/**
 * Spike S3 load harness - can Google's free endpoint carry subtitle cadence? (issue #44)
 *
 * Throwaway. Nothing in `src/` imports this and nothing here is imported by product code; it
 * imports the product adapter, never the other way round.
 *
 * Design notes that the report depends on:
 *
 * - **Ticks are scheduled on an absolute clock** (`start + n * periodMs`), not `sleep(period)`
 *   after each response. With the latter, a 900ms response silently turns a 2s cadence into a
 *   2.9s one and the run quietly becomes a shorter, gentler run than the one being reported.
 * - **A tick fires even if the previous request is still in flight.** The adapter's own 5s
 *   timeout bounds it. Skipping would, again, lower the real cadence exactly when the endpoint
 *   is under stress - which is the moment the measurement matters.
 * - **Every string is unique** (see `corpus.mjs`), so nothing can be answered from a cache
 *   between here and Google.
 * - **Batch sizes cycle 1, 2, 3** and both request count and cumulative string count are
 *   recorded, so a limit that turns out to be counted in strings rather than requests is still
 *   visible afterwards.
 * - **Results are appended to NDJSON as they happen**, so a crash at minute 29 still leaves 29
 *   minutes of evidence on disk.
 *
 * Usage (PowerShell):
 *   node spikes/s3-ratelimit/load.mjs --minutes=35 --out=spikes/s3-ratelimit/results/load.ndjson
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { GoogleTranslateEngine } from './build/engines/google.js';
import { TranslationError } from './build/types.js';
import { sentence, THAI } from './corpus.mjs';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);

const MINUTES = Number(args.get('minutes') ?? 35);
const PERIOD_MS = Number(args.get('period') ?? 2000);
const OUT = args.get('out') ?? 'spikes/s3-ratelimit/results/load.ndjson';
/** Consecutive failures that mean "blocked", not "a blip". Switches the run into recovery mode. */
const BLOCK_THRESHOLD = Number(args.get('blockAfter') ?? 10);
/** How often to poke the endpoint once blocked. This is the resolution of the recovery number. */
const RECOVERY_PROBE_MS = Number(args.get('probeEvery') ?? 30_000);
/** Consecutive successes needed to call recovery real rather than a lucky single request. */
const RECOVERY_CONFIRM = 3;

mkdirSync(dirname(OUT), { recursive: true });

const engine = new GoogleTranslateEngine();
const started = Date.now();

function write(record) {
  appendFileSync(OUT, JSON.stringify(record) + '\n', 'utf8');
}

function describe(error) {
  if (error instanceof TranslationError) {
    return { kind: error.kind, status: error.status ?? null, message: error.message };
  }
  return { kind: 'unknown', status: null, message: error?.name ?? String(error) };
}

let stringCounter = 0;
let seq = 0;
let ok = 0;
let failed = 0;
let consecutiveFailures = 0;
let inFlight = 0;
let blockedAt = null;

/** One request. Returns nothing; everything lands in the NDJSON. */
async function fire(phase, batchSize) {
  seq += 1;
  const mySeq = seq;
  const texts = [];
  for (let i = 0; i < batchSize; i += 1) {
    stringCounter += 1;
    texts.push(sentence(stringCounter));
  }

  const overlapped = inFlight > 0;
  inFlight += 1;
  const t0 = performance.now();
  const elapsedMs = Date.now() - started;

  try {
    const results = await engine.translateBatch(texts, 'en', 'th');
    const latencyMs = performance.now() - t0;
    inFlight -= 1;
    ok += 1;
    consecutiveFailures = 0;

    // A 200 with the right array length is not proof of a translation - a block page that
    // happened to parse would look the same. Checking for Thai script on every request means
    // "success rate" in the report means "really translated", not "did not throw".
    const thai = results.every((r) => THAI.test(r));
    write({
      phase, seq: mySeq, elapsedMs, batchSize, strings: stringCounter,
      ok: true, latencyMs: Math.round(latencyMs * 100) / 100, thai, overlapped,
    });
  } catch (error) {
    const latencyMs = performance.now() - t0;
    inFlight -= 1;
    failed += 1;
    consecutiveFailures += 1;
    write({
      phase, seq: mySeq, elapsedMs, batchSize, strings: stringCounter,
      ok: false, latencyMs: Math.round(latencyMs * 100) / 100, overlapped,
      error: describe(error), consecutiveFailures,
    });
  }
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function loadPhase() {
  const totalTicks = Math.ceil((MINUTES * 60_000) / PERIOD_MS);
  write({ phase: 'meta', event: 'start', at: new Date().toISOString(), minutes: MINUTES, periodMs: PERIOD_MS, totalTicks });

  for (let tick = 0; tick < totalTicks; tick += 1) {
    // Absolute schedule: drift in one request never shortens the run or lowers the cadence.
    const dueAt = started + tick * PERIOD_MS;
    const wait = dueAt - Date.now();
    if (wait > 0) await sleep(wait);

    void fire('load', (tick % 3) + 1);

    if (consecutiveFailures >= BLOCK_THRESHOLD) {
      blockedAt = { seq, elapsedMs: Date.now() - started, strings: stringCounter };
      write({ phase: 'meta', event: 'blocked', ...blockedAt, consecutiveFailures });
      return true;
    }

    if (tick % 30 === 0) {
      write({ phase: 'meta', event: 'heartbeat', elapsedMs: Date.now() - started, seq, ok, failed, inFlight });
    }
  }

  // Let anything still in flight land before the phase is declared over.
  for (let i = 0; i < 10 && inFlight > 0; i += 1) await sleep(500);
  return false;
}

/**
 * Blocked: stop the load and find out, by observation, when the endpoint takes us back.
 * One small request every `RECOVERY_PROBE_MS` - that interval is the resolution of the answer.
 */
async function recoveryPhase() {
  write({ phase: 'meta', event: 'recovery-start', at: new Date().toISOString(), probeEveryMs: RECOVERY_PROBE_MS });
  const recoveryStart = Date.now();
  let streak = 0;

  // ~40 minutes of probing. If it has not come back by then, that is itself the finding.
  for (let probe = 0; probe < 80; probe += 1) {
    await sleep(RECOVERY_PROBE_MS);
    const before = ok;
    await fire('recovery', 1);
    if (ok > before) {
      streak += 1;
      if (streak === 1) {
        write({ phase: 'meta', event: 'first-success-after-block', sinceBlockMs: Date.now() - recoveryStart, probe });
      }
      if (streak >= RECOVERY_CONFIRM) {
        write({ phase: 'meta', event: 'recovered', sinceBlockMs: Date.now() - recoveryStart, probe });
        return;
      }
    } else {
      streak = 0;
    }
  }
  write({ phase: 'meta', event: 'recovery-gave-up', sinceBlockMs: Date.now() - recoveryStart });
}

/**
 * Cold-start phase. A sustained 2s cadence keeps the TCP/TLS connection warm, so the load phase
 * contains almost no cold samples - but cold is the case that already broke the budget once
 * (1212ms), and real use has gaps. Idle for a gap, then fire one request.
 */
async function coldPhase() {
  const gaps = [30, 60, 120, 30, 60, 120, 180, 30];
  write({ phase: 'meta', event: 'cold-start', at: new Date().toISOString(), gaps });
  for (const gapSeconds of gaps) {
    await sleep(gapSeconds * 1000);
    seq += 1;
    stringCounter += 1;
    const text = sentence(stringCounter);
    const t0 = performance.now();
    try {
      const results = await engine.translateBatch([text], 'en', 'th');
      write({
        phase: 'cold', seq, gapSeconds, ok: true,
        latencyMs: Math.round((performance.now() - t0) * 100) / 100,
        thai: THAI.test(results[0] ?? ''),
      });
    } catch (error) {
      write({
        phase: 'cold', seq, gapSeconds, ok: false,
        latencyMs: Math.round((performance.now() - t0) * 100) / 100,
        error: describe(error),
      });
    }
  }
}

const blocked = await loadPhase();
if (blocked) await recoveryPhase();
else await coldPhase();

write({
  phase: 'meta', event: 'done', at: new Date().toISOString(),
  totalMs: Date.now() - started, seq, ok, failed, strings: stringCounter, blockedAt,
});
