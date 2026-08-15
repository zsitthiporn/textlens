// S1 spike (throwaway): run PaddleOCR over the same image set as win-ocr.ps1.
import { PaddleOcrService, V5_EN_MOBILE_MODEL } from 'ppu-paddle-ocr';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const imageDir = process.argv[2];
const outJson = process.argv[3];
const probeOnly = process.argv[4] === '--probe';

const svc = new PaddleOcrService({
  model: V5_EN_MOBILE_MODEL,
  recognition: { strategy: 'cross-line' },
});

const t0 = Date.now();
await svc.initialize();
console.log(`init: ${Date.now() - t0}ms`);

const files = readdirSync(imageDir).filter((f) => /\.(jpg|png)$/i.test(f)).sort();
const targets = probeOnly ? files.slice(0, 1) : files;
const results = [];

for (const f of targets) {
  const buf = readFileSync(join(imageDir, f));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  try {
    const t = Date.now();
    const r = await svc.recognize(ab);
    const ms = Date.now() - t;

    if (probeOnly) {
      console.log('--- raw result shape ---');
      console.log('top-level keys:', Object.keys(r));
      console.log(JSON.stringify(r, null, 2).slice(0, 1500));
      break;
    }

    // Normalise: v6 may expose either `lines` (array of word arrays) or a flattened form.
    const lines = [];
    const src = Array.isArray(r.lines) ? r.lines : [];
    for (const entry of src) {
      const words = Array.isArray(entry) ? entry : [entry];
      const text = words.map((w) => w.text).join(' ').trim();
      if (!text) continue;
      const conf = words.reduce((s, w) => s + (w.confidence ?? 0), 0) / words.length;
      lines.push({ text, conf: Number(conf.toFixed(3)) });
    }
    const text = lines.map((l) => l.text).join(' ');
    results.push({
      file: f,
      ocrMs: ms,
      lineCount: lines.length,
      charCount: text.replace(/\s/g, '').length,
      text,
      lines,
    });
    console.log(
      `${f.padEnd(28)} ocr=${String(ms).padStart(5)}ms lines=${String(lines.length).padStart(3)} chars=${String(text.replace(/\s/g, '').length).padStart(5)}`,
    );
  } catch (err) {
    console.log(`FAIL ${f}: ${err.message}`);
    results.push({ file: f, error: String(err.message) });
  }
}

if (!probeOnly) {
  writeFileSync(outJson, JSON.stringify(results, null, 2), 'utf8');
  console.log(`wrote ${outJson} (${results.length} results)`);
}
await svc.destroy?.();
