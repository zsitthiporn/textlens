/**
 * How much of the ~600ms is the network, and how much is the translation service?
 *
 * The load run measures a full translate round trip. That number alone cannot distinguish
 * "this machine is far from Google" from "the free endpoint takes half a second to think",
 * and the two have opposite consequences: the first is a property of the tester's connection
 * and would not generalise, the second is a property of the product's chosen engine and would.
 *
 * So: fire a request at the *same host*, over the same TLS session, that does no translation
 * work - a path that 404s. Whatever is left is transport. The difference is the service.
 *
 * Deliberately small (n=12 each, interleaved) - this runs after the load phase and is not
 * meant to add meaningful traffic.
 */

import { sentence, THAI } from './corpus.mjs';
import { GoogleTranslateEngine } from './build/engines/google.js';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function pct(values, p) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(Math.max(Math.ceil((p / 100) * s.length), 1), s.length) - 1];
}

const engine = new GoogleTranslateEngine();
const floor = [];
const full = [];
let n = 900_000;

for (let i = 0; i < 12; i += 1) {
  // Transport-only: same host, same keep-alive pool, no translation performed.
  const t0 = performance.now();
  try {
    await fetch('https://translate.googleapis.com/textlens-s3-floor-probe', {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    });
    floor.push(performance.now() - t0);
  } catch {
    // A rejected probe tells us nothing about the floor; leave it out rather than record a 5s timeout.
  }

  await sleep(1500);

  n += 1;
  const t1 = performance.now();
  try {
    const [result] = await engine.translateBatch([sentence(n)], 'en', 'th');
    if (THAI.test(result ?? '')) full.push(performance.now() - t1);
  } catch {
    // Same reasoning.
  }
  await sleep(1500);
}

const fmt = (v) => (Number.isFinite(v) ? String(Math.round(v)) : 'n/a');
console.log(`transport only (404 on same host): n=${String(floor.length)}  p50=${fmt(pct(floor, 50))}ms  min=${fmt(Math.min(...floor))}ms  p95=${fmt(pct(floor, 95))}ms`);
console.log(`full translate:                    n=${String(full.length)}  p50=${fmt(pct(full, 50))}ms  min=${fmt(Math.min(...full))}ms  p95=${fmt(pct(full, 95))}ms`);
console.log(`=> attributable to the translation service: ~${fmt(pct(full, 50) - pct(floor, 50))}ms at p50`);
