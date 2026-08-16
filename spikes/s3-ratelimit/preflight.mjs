/**
 * Spike S3 preflight - prove the harness is really calling out before trusting 35 minutes of it.
 *
 * A load run that reports 100% success and flat latency looks identical whether the endpoint is
 * healthy or the harness never sent anything. These four checks are what separate the two, and
 * they run through the same `GoogleTranslateEngine` object and the same code path as the load.
 *
 *   1. real request  -> 200, and the result actually contains Thai script (not just "did not throw")
 *   2. bad host      -> must throw `network`; if this "succeeds", nothing else here means anything
 *   3. 5xx-ish path  -> a real host that answers with a non-200, so the status-carrying path is exercised
 *   4. batch of 3    -> 3 results back, in order, still Thai
 */

import { GoogleTranslateEngine } from './build/engines/google.js';
import { TranslationError } from './build/types.js';
import { sentence, THAI } from './corpus.mjs';

let failures = 0;
function report(name, pass, detail) {
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

// 1. A real request through the real adapter.
{
  const engine = new GoogleTranslateEngine();
  const t0 = performance.now();
  try {
    const [result] = await engine.translateBatch([sentence(1)], 'en', 'th');
    const ms = Math.round(performance.now() - t0);
    report('real request returns Thai', THAI.test(result ?? ''), `${String(ms)}ms, thai=${String(THAI.test(result ?? ''))}, len=${String((result ?? '').length)}`);
  } catch (error) {
    report('real request returns Thai', false, `threw ${String(error)}`);
  }
}

// 2. Bad host through the identical code path. This is the control: it must fail.
{
  const engine = new GoogleTranslateEngine({
    endpoint: 'https://textlens-s3-no-such-host.invalid/translate_a/t',
    timeoutMs: 4000,
  });
  try {
    await engine.translateBatch([sentence(2)], 'en', 'th');
    report('bad host errors', false, 'it returned a result - the harness is not really calling out');
  } catch (error) {
    const ok = error instanceof TranslationError && error.kind === 'network';
    report('bad host errors', ok, `kind=${String(error?.kind)} message="${String(error?.message)}"`);
  }
}

// 3. A real host that answers non-200, so the status branch is exercised for real.
{
  const engine = new GoogleTranslateEngine({ endpoint: 'https://httpbin.org/status/429', timeoutMs: 8000 });
  try {
    await engine.translateBatch([sentence(3)], 'en', 'th');
    report('non-200 is surfaced', false, 'a 429 endpoint produced a result');
  } catch (error) {
    const ok = error instanceof TranslationError && error.status !== undefined;
    report('non-200 is surfaced', ok, `kind=${String(error?.kind)} status=${String(error?.status)}`);
  }
}

// 4. Batch shape at the size the load run uses.
{
  const engine = new GoogleTranslateEngine();
  try {
    const texts = [sentence(11), sentence(12), sentence(13)];
    const results = await engine.translateBatch(texts, 'en', 'th');
    const ok = results.length === 3 && results.every((r) => THAI.test(r));
    report('batch of 3 comes back as 3', ok, `n=${String(results.length)} allThai=${String(results.every((r) => THAI.test(r)))}`);
  } catch (error) {
    report('batch of 3 comes back as 3', false, `threw ${String(error)}`);
  }
}

console.log(failures === 0 ? '\nPREFLIGHT OK' : `\nPREFLIGHT FAILED (${String(failures)})`);
process.exit(failures === 0 ? 0 : 1);
