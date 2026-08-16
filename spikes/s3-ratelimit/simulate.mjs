/**
 * What the translate stage actually sees, per minute (spike S3, issue #44).
 *
 * The load harness answers "can the endpoint take 30 requests/minute". This file answers the
 * question that decides whether that even matters: **how many requests/minute does the product
 * actually make?** It walks the real subtitle stream from `build-stream.mjs` through the real
 * pipeline stages and counts what comes out the far end.
 *
 * ## The chain, in the order design doc section 4 puts it
 *
 *   capture tick -> sidecar pixel diff -> OCR -> group -> filter -> dedup -> cache -> translate
 *
 * Three of those stages remove work before a request is made, and conflating them is the easy
 * way to get a flattering number:
 *
 * 1. **The sidecar's pixel diff** (`diffThreshold`, protocol section 3) emits `nochange` and
 *    never runs OCR when the region's pixels did not move. Whether it fires is entirely a
 *    property of what is *behind* the text, so this is the run's main axis:
 *      - `static`  - a still background (visual novel, menu, letterboxed bar). The diff only
 *                    fires when the subtitle itself changes. One block per card.
 *      - `moving`  - video or gameplay behind the text. The diff fires every single tick even
 *                    though the words did not change. One block per tick. **This is the worst
 *                    case and the one a rate limiter must be sized for.**
 * 2. **Dedup** (`dedup.ts`, real code, imported not reimplemented) with its real 3000ms window.
 * 3. **The cache** (`cache.ts` keying, `normalizeForComparison` + src + tgt + engine). A `Set`
 *    is used rather than the SQLite class because for hit/miss within one session they are the
 *    same function, and this way the simulation does not need a database file.
 *
 * ## OCR wobble
 *
 * A clean stream understates the request count: every real OCR read differs slightly, and a
 * difference is what turns a would-be dedup hit into a miss. The `--wobble` arm injects the
 * error classes S1 actually observed (`o`<->`O`, `I`<->`1`, a dropped space) at a given
 * per-character rate, so the sensitivity of the answer to that is visible rather than assumed.
 *
 * Usage: node spikes/s3-ratelimit/simulate.mjs
 */

import { readFileSync } from 'node:fs';

import { Deduplicator } from './build-pipe/main/services/dedup.js';
import { normalizeForComparison } from './build-pipe/main/services/recent-outputs.js';

const stream = JSON.parse(readFileSync('spikes/s3-ratelimit/results/stream.json', 'utf8'));
const cards = stream.cards;
const durationMs = cards[cards.length - 1].endMs;

/** Deterministic PRNG so an arm is reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The three error classes S1 measured. Applied per character at `rate`. */
function wobble(text, rate, rand) {
  if (rate <= 0) return text;
  let out = '';
  for (const ch of text) {
    if (rand() >= rate) { out += ch; continue; }
    if (ch === 'o') out += 'O';
    else if (ch === 'O') out += 'o';
    else if (ch === 'I') out += '1';
    else if (ch === '1') out += 'I';
    else if (ch === ' ') { /* dropped space */ }
    else out += ch;
  }
  return out;
}

/** The card on screen at time t, or undefined. */
function cardAt(t) {
  // Cards are contiguous and sorted, so a walking index would do; a binary search keeps this
  // honest if the stream ever gains gaps.
  let lo = 0, hi = cards.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < cards[mid].startMs) hi = mid - 1;
    else if (t >= cards[mid].endMs) lo = mid + 1;
    else return cards[mid];
  }
  return undefined;
}

function run({ regime, tickMs, wobbleRate, seed = 7 }) {
  const rand = rng(seed);
  const dedup = new Deduplicator();
  const cache = new Set();

  let ticks = 0;
  let blocks = 0;          // reached the text pipeline (i.e. the diff let it through, OCR ran)
  let dedupSurvivors = 0;
  let cacheHits = 0;
  let cacheMisses = 0;     // = strings actually sent
  let requests = 0;        // = HTTP requests: one per frame that had at least one miss
  let previousCard;

  for (let t = 0; t < durationMs; t += tickMs) {
    ticks += 1;
    const card = cardAt(t);
    if (card === undefined) { previousCard = undefined; continue; }

    // Stage 1: the sidecar's pixel diff.
    const pixelsChanged = regime === 'moving' || card !== previousCard;
    previousCard = card;
    if (!pixelsChanged) continue;

    // Stage 2: OCR. Same words, never quite the same characters; the box jitters a few px.
    const text = wobble(card.text, wobbleRate, rand);
    const bbox = { x: 400 + Math.floor(rand() * 7) - 3, y: 900 + Math.floor(rand() * 7) - 3, width: 600, height: 40 };
    blocks += 1;

    // Stage 3: dedup, real code, real window.
    if (dedup.admit({ text, bbox }, t).duplicate) continue;
    dedupSurvivors += 1;

    // Stage 4: cache, real key derivation.
    const normalized = normalizeForComparison(text);
    const key = `${normalized}|en|th|google`;
    if (normalized.length > 0 && cache.has(key)) { cacheHits += 1; continue; }
    cache.add(key);
    cacheMisses += 1;
    // One card per frame in this stream, so a miss is a request. Real frames carrying two
    // blocks would batch them into one request, so this is the pessimistic direction.
    requests += 1;
  }

  const minutes = durationMs / 60000;
  const lookups = cacheHits + cacheMisses;
  return {
    regime, tickMs, wobbleRate,
    ticks, blocks, dedupSurvivors, cacheHits, cacheMisses, requests,
    dedupDropRate: blocks === 0 ? 0 : 1 - dedupSurvivors / blocks,
    cacheHitRate: lookups === 0 ? 0 : cacheHits / lookups,
    requestsPerMin: requests / minutes,
    secondsPerRequest: (durationMs / 1000) / Math.max(requests, 1),
  };
}

const arms = [];
for (const regime of ['moving', 'static']) {
  for (const wobbleRate of [0, 0.01, 0.05]) {
    arms.push(run({ regime, tickMs: 800, wobbleRate }));
  }
}
// The idle interval, to show the answer is not an artefact of one tick rate.
arms.push(run({ regime: 'moving', tickMs: 2000, wobbleRate: 0.01 }));
arms.push(run({ regime: 'moving', tickMs: 300, wobbleRate: 0.01 }));

console.log(`stream: ${String(cards.length)} cards, ${(durationMs / 60000).toFixed(1)} min, mean dwell ${String(Math.round(durationMs / cards.length))}ms`);
console.log(`        ${stream.source}`);
console.log('');
const header = ['regime', 'tick', 'wob', 'blocks', 'postDedup', 'cHit', 'cMiss', 'req', 'dedupDrop', 'cacheHit', 'req/min', 's/req'];
console.log(header.join('\t'));
for (const a of arms) {
  console.log([
    a.regime, a.tickMs, a.wobbleRate, a.blocks, a.dedupSurvivors, a.cacheHits, a.cacheMisses, a.requests,
    (100 * a.dedupDropRate).toFixed(1) + '%',
    (100 * a.cacheHitRate).toFixed(1) + '%',
    a.requestsPerMin.toFixed(1),
    a.secondsPerRequest.toFixed(1),
  ].join('\t'));
}
