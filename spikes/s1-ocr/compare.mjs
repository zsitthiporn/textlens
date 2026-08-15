// S1 spike (throwaway): compare Windows.Media.Ocr vs PaddleOCR outputs.
import { readFileSync } from 'node:fs';

const dir = process.argv[2];
// PowerShell's Out-File -Encoding utf8 emits a BOM; Node's JSON.parse chokes on it.
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
const win = readJson(`${dir}/win-ocr-results.json`);
const pad = readJson(`${dir}/paddle-results.json`);

const padBy = new Map(pad.map((r) => [r.file, r]));

const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const sim = (a, b) => {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - lev(a, b) / m;
};

const rows = [];
for (const w of win) {
  const p = padBy.get(w.file);
  if (!p) continue;
  const wc = w.charCount ?? 0;
  const pc = p.charCount ?? 0;
  rows.push({
    file: w.file,
    winChars: wc,
    padChars: pc,
    winMs: w.ocrMs ?? 0,
    padMs: p.ocrMs ?? 0,
    agree: Math.max(wc, pc) > 40 ? sim(norm(w.text), norm(p.text)) : null,
  });
}

// Latency across all images
const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    min: s[0],
    p50: s[Math.floor(s.length * 0.5)],
    p90: s[Math.floor(s.length * 0.9)],
    max: s[s.length - 1],
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
};

console.log('=== LATENCY (ms, full 1920x1080 frame) ===');
console.log('Windows.Media.Ocr:', JSON.stringify(stat(rows.map((r) => r.winMs))));
console.log('PaddleOCR        :', JSON.stringify(stat(rows.map((r) => r.padMs))));

const textRows = rows.filter((r) => Math.max(r.winChars, r.padChars) > 40).sort((a, b) => b.padChars - a.padChars);
console.log(`\n=== TEXT-BEARING IMAGES (${textRows.length} of ${rows.length}) ===`);
console.log('file'.padEnd(24), 'winChars'.padStart(9), 'padChars'.padStart(9), 'winMs'.padStart(6), 'padMs'.padStart(6), 'agree'.padStart(7));
for (const r of textRows) {
  console.log(
    r.file.padEnd(24),
    String(r.winChars).padStart(9),
    String(r.padChars).padStart(9),
    String(r.winMs).padStart(6),
    String(r.padMs).padStart(6),
    (r.agree == null ? '-' : r.agree.toFixed(3)).padStart(7),
  );
}
