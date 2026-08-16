/**
 * Build a realistic subtitle stream for the S3 cache measurement.
 *
 * The point of this file is that **the repetition in the stream is not chosen by us.** A cache
 * hit rate computed over a list where we picked how often lines repeat measures our own
 * assumption, not the endpoint. So:
 *
 * - **Text**: the dialogue of a real play - Oscar Wilde, *The Importance of Being Earnest*
 *   (1895, public domain, Project Gutenberg #844). Real dialogue is the closest freely-available
 *   analogue of subtitle content: short conversational turns, and whatever natural repetition
 *   English dialogue actually has ("Yes.", "I beg your pardon?", a name repeated) rather than
 *   whatever we would have invented.
 * - **Card splitting**: long speeches are broken at word boundaries into ~84-character cards,
 *   the two-line x 42-character convention subtitling has used for decades.
 * - **Dwell time**: derived from the card's own length by the standard reading-speed rule,
 *   17 characters per second, clamped to 1.2s..6.0s. That is an external convention applied to
 *   real text, not a dwell we picked to produce a nice number.
 *
 * Continuous back-to-back dialogue with no silent gaps is the worst case, and the worst case is
 * the right one for sizing a rate limiter.
 *
 * Usage: node spikes/s3-ratelimit/build-stream.mjs <path-to-gutenberg-text-json>
 */

import { readFileSync, writeFileSync } from 'node:fs';

const source = process.argv[2];
if (!source) {
  console.error('usage: node build-stream.mjs <path-to-page-text-json>');
  process.exit(1);
}

const raw = readFileSync(source, 'utf8');
let text;
try {
  const parsed = JSON.parse(raw);
  text = Array.isArray(parsed) ? parsed.map((p) => p.text ?? '').join('\n') : String(parsed.text ?? parsed);
} catch {
  text = raw;
}

// Trim Gutenberg's front and back matter so licence boilerplate does not become "dialogue".
const startMark = text.indexOf('FIRST ACT');
const endMark = text.indexOf('*** END OF THE PROJECT GUTENBERG');
const body = text.slice(startMark > 0 ? startMark : 0, endMark > 0 ? endMark : text.length);

// In this edition the speaker's name sits on a line of its own (`ALGERNON.`) and the speech runs
// on the lines below it until a blank line. Stage directions are bracketed and are not spoken, so
// they are not subtitle content.
const SPEAKER = /^([A-Z][A-Z .'’]{1,24})\.$/;

const speeches = [];
let current = null;
for (const line of body.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    if (current !== null) { speeches.push(current); current = null; }
    continue;
  }
  if (SPEAKER.test(trimmed)) {
    if (current !== null) speeches.push(current);
    current = '';
  } else if (current !== null) {
    current = current.length === 0 ? trimmed : current + ' ' + trimmed;
  }
}
if (current !== null) speeches.push(current);

/** Drop stage directions and normalise whitespace. */
function clean(speech) {
  return speech
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/_/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Break a speech into subtitle cards at word boundaries. 84 chars = 2 lines x 42. */
const MAX_CARD = 84;
function toCards(speech) {
  const words = speech.split(' ');
  const cards = [];
  let card = '';
  for (const word of words) {
    if (card.length === 0) card = word;
    else if (card.length + 1 + word.length <= MAX_CARD) card += ' ' + word;
    else { cards.push(card); card = word; }
  }
  if (card.length > 0) cards.push(card);
  return cards;
}

/** Standard subtitle reading speed: 17 characters per second, clamped. */
const CPS = 17;
const MIN_DWELL_MS = 1200;
const MAX_DWELL_MS = 6000;
function dwellMs(card) {
  return Math.round(Math.min(MAX_DWELL_MS, Math.max(MIN_DWELL_MS, (card.length / CPS) * 1000)));
}

const cards = [];
let at = 0;
for (const speech of speeches) {
  const cleaned = clean(speech);
  if (cleaned.length < 2) continue;
  for (const card of toCards(cleaned)) {
    const dwell = dwellMs(card);
    cards.push({ text: card, startMs: at, endMs: at + dwell, dwellMs: dwell });
    at += dwell;
  }
}

const out = 'spikes/s3-ratelimit/results/stream.json';
writeFileSync(out, JSON.stringify({
  source: 'Project Gutenberg #844, The Importance of Being Earnest (Oscar Wilde, 1895, public domain)',
  rule: `cards <= ${String(MAX_CARD)} chars at word boundaries; dwell = length/${String(CPS)} cps clamped ${String(MIN_DWELL_MS)}..${String(MAX_DWELL_MS)}ms; continuous, no gaps`,
  cards,
}, null, 0), 'utf8');

const totalMs = at;
const distinct = new Set(cards.map((c) => c.text)).size;
console.log(`speeches      ${String(speeches.length)}`);
console.log(`cards         ${String(cards.length)}`);
console.log(`distinct text ${String(distinct)}  (${(100 * (1 - distinct / cards.length)).toFixed(1)}% are literal repeats of an earlier card)`);
console.log(`duration      ${(totalMs / 60000).toFixed(1)} min`);
console.log(`mean dwell    ${String(Math.round(totalMs / cards.length))} ms`);
console.log(`cards/min     ${(cards.length / (totalMs / 60000)).toFixed(1)}`);
console.log(`wrote         ${out}`);
