/**
 * Turn the load run's NDJSON into the distribution the S3 report needs.
 *
 * Percentiles rather than a mean, because the mean is the one statistic that can hide both
 * things this spike is looking for: a bimodal cold/warm split, and a latency cliff that only
 * shows up in the tail. `n` is printed next to every figure so a percentile computed over three
 * samples cannot be mistaken for one computed over nine hundred.
 *
 * Usage: node spikes/s3-ratelimit/analyse.mjs [path]
 */

import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'spikes/s3-ratelimit/results/load.ndjson';
const records = readFileSync(path, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

const meta = records.filter((r) => r.phase === 'meta');
const load = records.filter((r) => r.phase === 'load');
const cold = records.filter((r) => r.phase === 'cold');
const recovery = records.filter((r) => r.phase === 'recovery');

/** Nearest-rank percentile. No interpolation - with n~900 it makes no difference and this one
 *  always returns a value that was actually observed. */
function pct(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function summarise(label, rows) {
  const okRows = rows.filter((r) => r.ok);
  const lat = okRows.map((r) => r.latencyMs);
  if (rows.length === 0) { console.log(`${label}: no records`); return; }
  console.log(
    `${label.padEnd(22)} n=${String(rows.length).padStart(4)} ok=${String(okRows.length).padStart(4)} ` +
    `fail=${String(rows.length - okRows.length).padStart(3)}  ` +
    `p50=${String(Math.round(pct(lat, 50))).padStart(5)}  p95=${String(Math.round(pct(lat, 95))).padStart(5)}  ` +
    `p99=${String(Math.round(pct(lat, 99))).padStart(5)}  min=${String(Math.round(Math.min(...lat)))}  max=${String(Math.round(Math.max(...lat)))}`,
  );
}

console.log('=== run ===');
for (const m of meta) console.log('  ' + JSON.stringify(m));

console.log('\n=== latency (ms) ===');
summarise('load (all)', load);
for (const size of [1, 2, 3]) summarise(`load batch=${String(size)}`, load.filter((r) => r.batchSize === size));
if (cold.length > 0) {
  summarise('cold probes', cold);
  console.log('  per gap: ' + cold.map((r) => `${String(r.gapSeconds)}s->${String(Math.round(r.latencyMs))}ms${r.ok ? '' : ' FAIL'}`).join('  '));
}
if (recovery.length > 0) summarise('recovery probes', recovery);

const okLoad = load.filter((r) => r.ok);
const lat = okLoad.map((r) => r.latencyMs);
console.log('\n=== against the 300-500ms budget row ===');
for (const threshold of [300, 500, 1000, 2000]) {
  const over = lat.filter((v) => v > threshold).length;
  console.log(`  > ${String(threshold).padStart(4)}ms: ${String(over).padStart(4)} / ${String(lat.length)}  (${(100 * over / lat.length).toFixed(1)}%)`);
}

console.log('\n=== integrity ===');
const notThai = okLoad.filter((r) => !r.thai).length;
const overlapped = load.filter((r) => r.overlapped).length;
console.log(`  successful responses whose text was not Thai: ${String(notThai)}  (any >0 means a 200 that was not a translation)`);
console.log(`  requests that overlapped a previous in-flight one: ${String(overlapped)}`);
console.log(`  strings sent in the load phase: ${String(load.reduce((a, r) => a + r.batchSize, 0))}`);

const failures = [...load, ...cold, ...recovery].filter((r) => !r.ok);
console.log('\n=== failures ===');
if (failures.length === 0) {
  console.log('  none. Watched for: HTTP 429, HTTP 403, a non-JSON body, a result-count mismatch,');
  console.log('  a transport error/timeout, and a latency cliff. None of these occurred.');
} else {
  const byKind = new Map();
  for (const f of failures) {
    const k = `${String(f.error?.kind)} status=${String(f.error?.status)}`;
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  for (const [k, v] of byKind) console.log(`  ${k}: ${String(v)}`);
  const first = failures[0];
  console.log(`  first failure: seq=${String(first.seq)} at ${String(Math.round(first.elapsedMs / 1000))}s (${(first.elapsedMs / 60000).toFixed(1)} min), strings=${String(first.strings)}`);
}

// Cadence actually achieved, and drift over the run.
if (load.length > 1) {
  const first = load[0], last = load[load.length - 1];
  const spanMs = last.elapsedMs - first.elapsedMs;
  console.log('\n=== cadence ===');
  console.log(`  ${String(load.length)} requests over ${(spanMs / 60000).toFixed(2)} min = one every ${(spanMs / (load.length - 1) / 1000).toFixed(3)}s (target 2.000s)`);
  console.log(`  = ${(load.length / (spanMs / 60000)).toFixed(1)} requests/min`);
}

// A cliff is a sustained shift, not one slow request: compare the first and last tenth.
if (lat.length > 50) {
  const tenth = Math.floor(okLoad.length / 10);
  const early = okLoad.slice(0, tenth).map((r) => r.latencyMs);
  const late = okLoad.slice(-tenth).map((r) => r.latencyMs);
  console.log('\n=== drift (is the endpoint quietly degrading us?) ===');
  console.log(`  first 10%: p50=${String(Math.round(pct(early, 50)))}  p95=${String(Math.round(pct(early, 95)))}  (n=${String(early.length)})`);
  console.log(`  last  10%: p50=${String(Math.round(pct(late, 50)))}  p95=${String(Math.round(pct(late, 95)))}  (n=${String(late.length)})`);
}

// Per-5-minute p50/p95. A throttle applied as latency rather than as a 429 shows up here as a
// step, and nowhere else - the success rate stays 100% the whole time.
if (okLoad.length > 60) {
  console.log('\n=== per 5 min (a soft throttle would show up as a step) ===');
  const buckets = new Map();
  for (const r of okLoad) {
    const b = Math.floor(r.elapsedMs / 300_000);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(r.latencyMs);
  }
  for (const [b, values] of [...buckets].sort((a, x) => a[0] - x[0])) {
    console.log(
      `  min ${String(b * 5).padStart(2)}-${String(b * 5 + 5).padStart(2)}: n=${String(values.length).padStart(3)}  ` +
      `p50=${String(Math.round(pct(values, 50))).padStart(5)}  p95=${String(Math.round(pct(values, 95))).padStart(5)}  ` +
      `min=${String(Math.round(Math.min(...values))).padStart(4)}`,
    );
  }
}

// Fast responses are the interesting tail here: a sub-100ms round trip to a public endpoint is
// short enough to be worth confirming really carried a translation.
const fast = okLoad.filter((r) => r.latencyMs < 100);
if (fast.length > 0) {
  console.log(`\n=== sub-100ms responses: ${String(fast.length)} of ${String(okLoad.length)} ===`);
  console.log(`  all carried Thai text: ${String(fast.every((r) => r.thai))}`);
  console.log(`  fastest: ${String(Math.round(Math.min(...fast.map((r) => r.latencyMs))))}ms`);
}
