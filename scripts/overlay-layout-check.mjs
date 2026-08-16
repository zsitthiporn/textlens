/**
 * Acceptance checks for #24 (Thai typography) and #25 (two-pass layout), against real Chromium.
 *
 * ## Why this is not a vitest file
 *
 * Both issues turn on things only a layout engine knows. #24's criterion is that Thai wraps
 * *without cutting a word in half*, and Thai has no spaces - the break opportunities come from
 * ICU's Thai dictionary, which is in Chromium and in nothing else this project can run. #25's
 * criterion is that the height used for placement is the height that actually rendered, which
 * needs real font metrics. `jsdom` supplies neither: it never breaks a line, and
 * `getBoundingClientRect` returns zeroes. A jsdom test of either would pass while asserting
 * nothing, which is why jsdom was removed in `f911f26` and why `vitest.config.ts` stays
 * `environment: 'node'`.
 *
 * ## Running it
 *
 *     npm run build          # the harness loads dist/, not src/
 *     node scripts/overlay-layout-check.mjs
 *
 * Needs: a built `dist/`, the Electron binary in `node_modules` (Electron 43 downloads it on
 * first use, not on install), and a free debugging port. Nothing else - no sidecar, no config,
 * no network, no translation engine.
 *
 * A pass prints `PASS` for every check and exits 0. Any failure prints the measured numbers
 * beside the expected ones and exits 1. It always kills the Electron child it started; if it is
 * ever interrupted anyway, the harness has its own 120s self-destruct.
 *
 * ## What "proof" means here
 *
 * Every check is written so that the obvious wrong implementation fails it. A line-breaking
 * check that passes when no line breaks proves nothing, so the number of rendered lines is
 * asserted first and the break offsets are read from the live layout, not assumed. A height
 * check comparing zero to zero proves nothing, so the measured height is compared against the
 * same box's live rectangle *and* against the line count it should imply.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env['CHECK_PORT'] ?? '9445');

// ---------------------------------------------------------------------------------------------
// Fixtures
//
// Real Thai, from this app's own domain (game and subtitle text), and chosen for what each one
// exercises rather than for length. `ปุ่ม`, `ที่` and `หนึ่ง` are the three the issue names: each
// stacks an upper vowel, a tone mark and a lower vowel on one base, which is the combination that
// gets clipped when line-height is too small.
// ---------------------------------------------------------------------------------------------

/** Stacked-mark words. `หนึ่ง` carries sara uee + mai ek; `ปุ่ม` carries sara u below + mai ek above. */
const STACKED = ['ปุ่ม', 'ที่', 'หนึ่ง', 'ที่นั่ง', 'ผู้เล่น'];

/**
 * Long enough to produce several breaks in a subtitle-width box.
 *
 * Length is the point: one break is a sample of one, and "the break landed on a word boundary"
 * is as likely to be luck as merit at that size. This yields five or six.
 */
const LONG_THAI =
  'กดปุ่มที่อยู่ทางขวามือเพื่อเปิดประตูบานหนึ่งแล้วเดินไปที่ท่าเรือ'
  + 'ผู้เล่นคนหนึ่งกำลังรออยู่ตรงนั้นเพื่อบอกทางไปยังเมืองถัดไป'
  + 'อย่าลืมเก็บกุญแจที่วางอยู่บนโต๊ะในห้องใต้ดินก่อนออกเดินทาง';

/** Thai with embedded Latin and ASCII punctuation - H5 and the mixed-script criterion. */
const MIXED = 'กดปุ่ม Start, แล้วเลือก Options ที่เมนูหลัก. พร้อมหรือยัง? ไปกันเลย!';

// ---------------------------------------------------------------------------------------------
// CDP plumbing. Node 22 has global `fetch` and global `WebSocket`, so this needs no dependency.
// ---------------------------------------------------------------------------------------------

async function overlayTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const overlay = targets.find(
        (target) => target.type === 'page' && String(target.url).includes('overlay'),
      );
      if (overlay !== undefined) return overlay;
    } catch {
      /* the browser is not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no overlay target appeared on port ${PORT}; is dist/ built?`);
}

class Session {
  #socket;
  #next = 1;
  #pending = new Map();

  static async open(url) {
    const session = new Session();
    session.#socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      session.#socket.addEventListener('open', resolve, { once: true });
      session.#socket.addEventListener('error', reject, { once: true });
    });
    session.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const settle = session.#pending.get(message.id);
      if (settle === undefined) return;
      session.#pending.delete(message.id);
      settle(message);
    });
    return session;
  }

  send(method, params = {}) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (message) => {
        if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails !== undefined) {
      const detail =
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails);
      throw new Error(`page threw: ${detail}`);
    }
    return result.result.value;
  }

  /** Chromium's own layout counter, not ours. The only unfakeable answer to "how many reflows". */
  async layoutCount() {
    const { metrics } = await this.send('Performance.getMetrics');
    return metrics.find((metric) => metric.name === 'LayoutCount')?.value ?? null;
  }

  close() {
    this.#socket.close();
  }
}

// ---------------------------------------------------------------------------------------------
// In-page helpers, injected as source into every evaluate that needs them.
// ---------------------------------------------------------------------------------------------

const HELPERS = `
  const overlay = window.__textlensOverlay;

  // fontSize and opacity are part of OverlayRenderConfig and are NOT optional: overlay.ts writes
  // them into CSS custom properties on every payload, so omitting them writes an invalid value and
  // the box silently falls back to the browser's 16px default instead of the configured 17px.
  // These are DEFAULT_CONFIG.render's values, so the harness measures what the app measures.
  const message = (entries, opts = {}) => ({
    payload: { seq: opts.seq ?? 1, complete: true, entries, degraded: false },
    origin: { x: 0, y: 0 },
    config: {
      anchorGrid: 8, anchorTolerance: 6, stickyMaxEntries: 128,
      // maxAreaRatio 1 = no area quota, so the typography and layout checks below measure the
      // renderer rather than the budget. #27's own check re-states this explicitly.
      minDisplayMs: 0, fadeMs: 0, fontSize: 17, opacity: 0.82, maxAreaRatio: 1,
    },
    epoch: opts.epoch ?? 1,
  });

  const entry = (text, source, x, y, width = 620, height = 40) => ({
    text, sourceText: source, bbox: { x, y, width, height }, origin: 'engine',
  });

  /** The box's real type metrics, read from the element rather than assumed. */
  const typeMetrics = (box) => {
    const style = getComputedStyle(box);
    return {
      fontSize: parseFloat(style.fontSize),
      lineHeight: parseFloat(style.lineHeight),
      font: style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily,
      padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
    };
  };

  const visibleBoxes = () =>
    [...document.querySelectorAll('.box')].filter((b) => b.style.display !== 'none');

  /**
   * The offsets at which the browser actually broke a line, read off the live layout.
   *
   * Walks the text node one character at a time with a Range and watches for the client
   * rectangle's top edge to jump. That is the only honest source: the break positions are
   * decided by ICU inside the engine and are not exposed anywhere else. Returns character
   * indices, so 'the line after this one starts at index N'.
   */
  const breakOffsets = (element) => {
    const node = element.firstChild;
    if (node === null || node.nodeType !== Node.TEXT_NODE) return null;
    const range = document.createRange();
    const offsets = [];
    let previousTop = null;
    for (let i = 0; i < node.length; i += 1) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rect = range.getClientRects()[0];
      if (rect === undefined) continue;
      const top = Math.round(rect.top);
      if (previousTop !== null && top > previousTop) offsets.push(i);
      previousTop = top;
    }
    return offsets;
  };

  /** Distinct line-box tops in an element - how many lines the engine actually laid out. */
  const lineCount = (element) => {
    const node = element.firstChild;
    if (node === null || node.nodeType !== Node.TEXT_NODE) return 0;
    const range = document.createRange();
    range.selectNodeContents(node);
    const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
    return tops.size;
  };

  /** Word-boundary indices per ICU, via the same segmentation data the line breaker uses. */
  const wordBoundaries = (text) => {
    const segmenter = new Intl.Segmenter('th', { granularity: 'word' });
    const boundaries = new Set([0, text.length]);
    for (const segment of segmenter.segment(text)) boundaries.add(segment.index);
    return boundaries;
  };

  const measureInk = (text, font) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    const m = ctx.measureText(text);
    return {
      width: m.width,
      ascent: m.actualBoundingBoxAscent,
      descent: m.actualBoundingBoxDescent,
      ink: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
    };
  };
`;

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

const results = [];
const check = (issue, name, passed, detail) => {
  results.push({ issue, name, passed, detail });
};

async function thaiTypography(session) {
  // --- #24 a: the bundled face is loaded, and is the face doing the drawing ------------------
  const font = await session.evaluate(`
    ${HELPERS}
    await document.fonts.ready;
    const faces = [...document.fonts].map((f) => ({ family: f.family, status: f.status }));
    overlay.render(message([entry(${JSON.stringify(LONG_THAI)}, 'src', 200, 300)], { seq: 1 }));
    const box = visibleBoxes()[0];
    const used = getComputedStyle(box).fontFamily;

    // Compared against a family name that cannot resolve, NOT against sans-serif: Windows'
    // default Thai face has near-identical metrics to Noto Sans Thai (measured: 41.90px vs
    // 41.47px for the same word), so a sans-serif comparison is within noise of a real
    // difference and would report a missing font as present. An unresolvable family falls back
    // to the canvas default, so a difference here means 'Textlens Thai' resolved to something.
    // Measured over the whole long fixture rather than one word: two Thai faces differ by a
    // fraction of a pixel per glyph, which is inside measurement noise on six characters and
    // unmistakable over a hundred and eighty.
    const bundled = measureInk(${JSON.stringify(LONG_THAI)}, '500 17px "Textlens Thai"');
    const fallback = measureInk(${JSON.stringify(LONG_THAI)}, '500 17px "__textlens_no_such_family__"');
    // Latin coverage: Noto Sans Thai carries printable ASCII, so a Thai sentence with an English
    // word in it is drawn by one face throughout rather than switching mid-string.
    const latinBundled = measureInk('Start Options', '500 17px "Textlens Thai"');
    const latinFallback = measureInk('Start Options', '500 17px sans-serif');

    return {
      faces,
      checkLoaded: document.fonts.check('500 17px "Textlens Thai"'),
      used,
      bundledWidth: bundled.width,
      fallbackWidth: fallback.width,
      latinBundledWidth: latinBundled.width,
      latinFallbackWidth: latinFallback.width,
      lineHeight: getComputedStyle(box).lineHeight,
      fontSize: getComputedStyle(box).fontSize,
      wordBreak: getComputedStyle(box).wordBreak,
    };
  `);

  const face = font.faces.find((entry) => entry.family.includes('Textlens Thai'));
  check(
    24,
    'the bundled font is registered and loaded',
    face !== undefined && face.status === 'loaded' && font.checkLoaded === true,
    `faces=${JSON.stringify(font.faces)} check=${font.checkLoaded}`,
  );
  check(
    24,
    'the bundled face draws the Thai text, not a system fallback',
    Math.abs(font.bundledWidth - font.fallbackWidth) > 2,
    `over ${String(LONG_THAI.length)} chars: bundled=${font.bundledWidth.toFixed(2)}px `
      + `unresolvable-family fallback=${font.fallbackWidth.toFixed(2)}px `
      + `(delta ${Math.abs(font.bundledWidth - font.fallbackWidth).toFixed(2)}px)`,
  );
  check(
    24,
    'the same face supplies the Latin glyphs, so no mid-string font switch',
    Math.abs(font.latinBundledWidth - font.latinFallbackWidth) > 0.5,
    `bundled=${font.latinBundledWidth.toFixed(2)}px fallback=${font.latinFallbackWidth.toFixed(2)}px`,
  );
  check(
    24,
    'line-height is at least 1.6x the font size',
    parseFloat(font.lineHeight) / parseFloat(font.fontSize) >= 1.6,
    `${font.lineHeight} / ${font.fontSize} = ${(parseFloat(font.lineHeight) / parseFloat(font.fontSize)).toFixed(2)}`,
  );
  check(24, 'word-break is normal, never break-all', font.wordBreak === 'normal', font.wordBreak);

  // --- #24 b: Thai wraps, and every break lands on a word boundary ---------------------------
  //
  // The order matters. A break-offset assertion over a string that never wrapped is vacuously
  // true, so the line count is asserted first and the offsets are only meaningful after it.
  // A narrow box on purpose: 300px of a 17px face is roughly the width a subtitle translation
  // occupies, and it forces four or five breaks out of this fixture instead of one. One break is
  // a sample size of one, and a boundary check over it would pass by luck as often as by merit.
  const wrap = await session.evaluate(`
    ${HELPERS}
    const text = ${JSON.stringify(LONG_THAI)};
    overlay.render(message([entry(text, 'src', 200, 200, 240)], { seq: 2 }));
    const box = visibleBoxes()[0];
    const layer = box.querySelector('.box-in');

    const lines = lineCount(layer);
    const offsets = breakOffsets(layer);
    const boundaries = wordBoundaries(text);
    const bad = offsets.filter((offset) => !boundaries.has(offset));

    // The discriminating mutation. \`word-break: break-all\` is exactly what overlay.css warns
    // against, and it breaks at any character - so if the boundary check above cannot fail, it
    // will fail here. Without this, "all breaks are on boundaries" might only mean the walk
    // found nothing to complain about.
    box.style.wordBreak = 'break-all';
    layer.offsetHeight;
    const brokenOffsets = breakOffsets(layer);
    const brokenBad = brokenOffsets.filter((offset) => !boundaries.has(offset));
    box.style.wordBreak = '';

    // Separately, and NOT as a pass/fail: does the lang attribute change the breaking at all?
    // layout.ts claims it is what selects ICU's Thai breaker. Measured rather than assumed.
    box.setAttribute('lang', 'en');
    layer.offsetHeight;
    const enOffsets = breakOffsets(layer);
    const enBad = enOffsets.filter((offset) => !boundaries.has(offset));
    box.removeAttribute('lang');
    layer.offsetHeight;
    const noLangOffsets = breakOffsets(layer);
    box.setAttribute('lang', 'th');

    return {
      lines,
      offsets,
      bad,
      sample: offsets.slice(0, 4).map((o) => text.slice(Math.max(0, o - 6), o) + '|' + text.slice(o, o + 6)),
      brokenOffsets,
      brokenBad,
      enOffsets,
      enBad,
      noLangOffsets,
    };
  `);

  check(
    24,
    'the long Thai string actually wrapped (without this, the next check is vacuous)',
    wrap.lines >= 4,
    `${wrap.lines} rendered lines, ${wrap.offsets.length} breaks at ${JSON.stringify(wrap.offsets)}`,
  );
  check(
    24,
    'every line break lands on a Thai word boundary - no word is cut in half',
    wrap.offsets.length >= 3 && wrap.bad.length === 0,
    wrap.bad.length === 0
      ? `${wrap.offsets.length} breaks, all on boundaries; e.g. ${JSON.stringify(wrap.sample)}`
      : `breaks off-boundary at ${JSON.stringify(wrap.bad)} of ${JSON.stringify(wrap.offsets)}`,
  );
  check(
    24,
    'MUTATION: word-break:break-all on the same string breaks mid-word, so the check above can fail',
    wrap.brokenBad.length > 0,
    `break-all produced ${wrap.brokenBad.length} off-boundary breaks `
      + `(${JSON.stringify(wrap.brokenOffsets.slice(0, 8))}); normal produced ${wrap.bad.length}`,
  );

  // Reported, not asserted. See the note in the summary: this contradicts a code comment.
  console.log(
    `\nOBSERVED (not a pass/fail): break offsets with lang="th" = ${JSON.stringify(wrap.offsets)}, `
      + `with lang="en" = ${JSON.stringify(wrap.enOffsets)} (${wrap.enBad.length} off-boundary), `
      + `with no lang attribute = ${JSON.stringify(wrap.noLangOffsets)}`,
  );

  // --- #24 c: stacked marks fit inside the line box ------------------------------------------
  //
  // "Not clipped" means the ink of a three-level stack fits within one line box; if it does not,
  // the mark collides with the line above. Measured from the real font's own metrics, and
  // compared against a mark-free string so the assertion is not trivially true for any text.
  const stacks = await session.evaluate(`
    ${HELPERS}
    // Metrics read off the live box, not hardcoded: the font size is a user setting (#39), so a
    // constant here would measure a configuration nobody is running.
    overlay.render(message([entry(${JSON.stringify(LONG_THAI)}, 'src', 200, 300)], { seq: 4 }));
    const metrics = typeMetrics(visibleBoxes()[0]);
    const font = metrics.font;
    const lineBox = metrics.lineHeight;
    const plain = measureInk('กมน', font);
    const words = ${JSON.stringify(STACKED)}.map((w) => {
      const m = measureInk(w, font);
      return { word: w, ink: m.ink, ascent: m.ascent, descent: m.descent, fits: m.ink <= lineBox };
    });
    return { lineBox, fontSize: metrics.fontSize, font, plainInk: plain.ink, words };
  `);

  const tallest = stacks.words.reduce((a, b) => (a.ink > b.ink ? a : b));
  check(
    24,
    'stacked-mark words really are taller than plain ones (the check below is not trivial)',
    tallest.ink > stacks.plainInk,
    `tallest '${tallest.word}' ink=${tallest.ink.toFixed(2)}px vs plain 'กมน' ink=${stacks.plainInk.toFixed(2)}px`,
  );
  check(
    24,
    'every stacked-mark word fits inside the line box, so nothing is clipped',
    stacks.words.every((word) => word.fits),
    `fontSize=${stacks.fontSize}px lineBox=${stacks.lineBox.toFixed(2)}px; `
      + stacks.words.map((w) => `${w.word}=${w.ink.toFixed(2)}`).join(' '),
  );

  // --- #24 d: punctuation stays ASCII --------------------------------------------------------
  const punctuation = await session.evaluate(`
    ${HELPERS}
    const text = ${JSON.stringify(MIXED)};
    overlay.render(message([entry(text, 'src', 200, 300)], { seq: 3 }));
    const layer = visibleBoxes()[0].querySelector('.box-in');
    const rendered = layer.textContent;
    const font = '500 17px "Textlens Thai"';
    return {
      identical: rendered === text,
      rendered,
      // Full-width forms are visibly wider. If anything rewrote the punctuation these would match.
      commaWidth: measureInk(',', font).width,
      fullWidthCommaWidth: measureInk('\\uFF0C', font).width,
      hasFullWidth: /[\\uFF01\\uFF0C\\uFF0E\\uFF1F\\uFF1A\\uFF1B]/.test(rendered),
    };
  `);

  check(
    24,
    'the rendered string is the string it was given - nothing rewrites punctuation',
    punctuation.identical && !punctuation.hasFullWidth,
    `identical=${punctuation.identical} fullWidthPresent=${punctuation.hasFullWidth}`,
  );
  check(
    24,
    'the comma is drawn at ASCII width, not a full-width form',
    punctuation.commaWidth < punctuation.fullWidthCommaWidth,
    `',' = ${punctuation.commaWidth.toFixed(2)}px vs '，' = ${punctuation.fullWidthCommaWidth.toFixed(2)}px`,
  );
}

async function twoPassLayout(session) {
  // --- #25 a: the height used for placement is the height that rendered ----------------------
  const heights = await session.evaluate(`
    ${HELPERS}
    const short = 'ไปทางขวา';
    const long = ${JSON.stringify(LONG_THAI)};
    // 300px wide, so the long fixture genuinely wraps past three lines. The whole point of #25
    // is that a multi-line height is measured rather than guessed, and a fixture that fits on
    // one line cannot tell a correct implementation from the character-count arithmetic the
    // reference project used.
    overlay.render(message([
      entry(short, 'a', 100, 200, 240),
      entry(long, 'b', 100, 700, 240),
    ], { seq: 10 }));

    const stats = overlay.stats();
    const boxes = visibleBoxes();
    const live = boxes.map((b) => b.getBoundingClientRect().height);
    const lines = boxes.map((b) => lineCount(b.querySelector('.box-in')));
    const metrics = typeMetrics(boxes[0]);
    return {
      measured: stats.measuredHeights,
      live,
      lines,
      drawn: stats.drawn,
      lineHeight: metrics.lineHeight,
      padding: metrics.padding,
      phaseLog: stats.phaseLog,
    };
  `);

  const nonZero = heights.measured.length > 0 && heights.measured.every((height) => height > 0);
  check(
    25,
    'measured heights are real numbers, not the zeroes jsdom would have produced',
    nonZero,
    `measured=${JSON.stringify(heights.measured)}`,
  );
  check(
    25,
    'every measured height equals the live rendered height of its own box',
    nonZero
      && heights.measured.length === heights.live.length
      && heights.measured.every((height, index) => Math.abs(height - heights.live[index]) < 0.5),
    `measured=${JSON.stringify(heights.measured.map((h) => h.toFixed(2)))} `
      + `live=${JSON.stringify(heights.live.map((h) => h.toFixed(2)))}`,
  );

  const multi = heights.lines.findIndex((count) => count >= 3);
  const expected = multi < 0 ? null : heights.lines[multi] * heights.lineHeight + heights.padding;
  check(
    25,
    'a Thai string that wraps to 3+ lines is measured at its real multi-line height',
    multi >= 0 && Math.abs(heights.measured[multi] - expected) < 1.5,
    multi < 0
      ? 'no box wrapped to 3 lines; fixture is not exercising the case'
      : `${heights.lines[multi]} lines x ${heights.lineHeight}px + ${heights.padding}px padding `
        + `= ${expected.toFixed(2)}px, measured ${heights.measured[multi].toFixed(2)}px`,
  );
  check(
    25,
    'a one-line box and a wrapped box are measured differently',
    new Set(heights.measured.map((h) => Math.round(h))).size > 1,
    `measured=${JSON.stringify(heights.measured.map((h) => h.toFixed(2)))} lines=${JSON.stringify(heights.lines)}`,
  );
  check(
    25,
    'phases run write -> read -> write, so all reads share one reflow',
    JSON.stringify(heights.phaseLog) === JSON.stringify(['write', 'read', 'write']),
    JSON.stringify(heights.phaseLog),
  );

  // --- #25 b: one reflow per render, counted by Chromium ------------------------------------
  //
  // The self-reported phaseLog above says the code is *shaped* to force one; this says the engine
  // actually performed one. The layout-thrashing bug it guards against would show up here as one
  // reflow per box.
  await session.send('Performance.enable');
  const before = await session.layoutCount();
  await session.evaluate(`
    ${HELPERS}
    const text = ${JSON.stringify(LONG_THAI)};
    const entries = [];
    for (let i = 0; i < 30; i += 1) {
      entries.push(entry(text.slice(0, 40 + i), 'src' + i, 40 + (i % 5) * 300, 40 + Math.floor(i / 5) * 150));
    }
    overlay.render(message(entries, { seq: 20, epoch: 3 }));
    return overlay.stats().claimed;
  `);
  const after = await session.layoutCount();
  const layouts = after - before;
  check(
    25,
    '30 boxes cost a small constant number of reflows, not one per box',
    layouts <= 3,
    `Chromium LayoutCount delta = ${layouts} across a 30-box render (thrashing would be ~30)`,
  );

  // --- #25 c: 30 boxes inside the 16ms frame budget -----------------------------------------
  const timing = await session.evaluate(`
    ${HELPERS}
    const text = ${JSON.stringify(LONG_THAI)};
    const samples = [];
    for (let round = 0; round < 12; round += 1) {
      const entries = [];
      for (let i = 0; i < 30; i += 1) {
        entries.push(entry(
          text.slice(0, 40 + i) + ' ' + round,
          'src' + i + '-' + round,
          40 + (i % 5) * 300,
          40 + Math.floor(i / 5) * 150,
        ));
      }
      performance.clearMeasures('textlens:render');
      overlay.render(message(entries, { seq: 100 + round, epoch: 4 }));
      const entry_ = performance.getEntriesByName('textlens:render').at(-1);
      if (entry_ !== undefined) samples.push(entry_.duration);
    }
    samples.sort((a, b) => a - b);
    return {
      samples: samples.map((s) => Number(s.toFixed(3))),
      p50: samples[Math.floor(samples.length / 2)],
      worst: samples.at(-1),
      drawn: overlay.stats().drawn,
      claimed: overlay.stats().claimed,
    };
  `);

  check(
    25,
    '30 boxes render inside the 16ms frame budget',
    timing.worst < 16,
    `p50 ${timing.p50.toFixed(2)}ms, worst ${timing.worst.toFixed(2)}ms over ${timing.samples.length} renders `
      + `(${timing.drawn} drawn of ${timing.claimed} claimed)`,
  );

  // --- #25 d: the hidden pass is never left on screen ---------------------------------------
  //
  // The strong claim in layout.ts is that the hidden pass is unobservable *by construction*: both
  // passes are inside one synchronous call from one rAF callback, and the browser cannot paint
  // mid-task. That is not directly measurable from here. What is measurable is the observable
  // consequence: when the synchronous call returns, no box is left in the intermediate state.
  const reveal = await session.evaluate(`
    ${HELPERS}
    overlay.render(message([entry(${JSON.stringify(LONG_THAI)}, 'reveal', 300, 400)], { seq: 200, epoch: 5 }));
    const stuck = [...document.querySelectorAll('.box')].filter(
      (b) => b.style.display === 'block' && b.style.visibility === 'hidden',
    );
    const drawn = visibleBoxes().map((b) => ({
      visibility: b.style.visibility,
      opacity: b.style.opacity,
      transform: b.style.transform,
    }));
    return { stuck: stuck.length, drawn };
  `);

  check(
    25,
    'no box is left displayed-but-hidden after a render returns',
    reveal.stuck === 0 && reveal.drawn.every((box) => box.visibility === 'visible'),
    `stuck=${reveal.stuck} drawn=${JSON.stringify(reveal.drawn)}`,
  );
}

/**
 * #27 end to end, in the renderer, with the real 48-box pool.
 *
 * The unit tests cover the selection arithmetic. What only a live render can show is that the
 * budget sits in the pipeline without breaking the two things that depend on the entry list being
 * stable: A6's unchanged-payload skip, and the slot identity the crossfade keys on.
 */
async function areaBudget(session) {
  const result = await session.evaluate(`
    ${HELPERS}
    // 54 blocks against the 48-box pool - the shape from the run that filed the issue. Areas rise
    // with index and the payload is in reading order, so "drop the tail" and "drop the smallest"
    // give opposite answers.
    const build = (seq) => {
      const entries = [];
      for (let i = 0; i < 54; i += 1) {
        const width = 60 + i * 8;
        entries.push({
          text: 'คำแปลบรรทัดที่ ' + i,
          sourceText: 'line ' + i,
          bbox: { x: (i % 6) * 300, y: Math.floor(i / 6) * 130, width, height: 30 },
          origin: 'engine',
        });
      }
      return message(entries, { seq, epoch: 12 });
    };

    overlay.render(build(700));
    const first = overlay.stats();

    // The identical payload again. If the budget made selection depend on anything unstable, the
    // signature would differ and this would repaint - which is how A6 dies quietly.
    overlay.render(build(701));
    const second = overlay.stats();

    return {
      requested: first.requested,
      claimed: first.claimed,
      drawn: first.drawn,
      overCapacity: first.overCapacity,
      budgetDropped: first.budgetDropped,
      truncated: first.truncated,
      droppedIndices: first.budgetDrops.map((d) => d.index),
      droppedAreas: first.budgetDrops.map((d) => Math.round(d.area)),
      droppedReasons: [...new Set(first.budgetDrops.map((d) => d.reason))],
      keptArea: Math.round(first.budgetKeptArea),
      budgetArea: Math.round(first.budgetArea),
      // Areas of everything, so 'the dropped ones were the smallest' is checkable rather than
      // asserted.
      smallestAreas: [0,1,2,3,4,5].map((i) => (60 + i * 8) * 30),
      repeatUnchanged: second.unchanged,
      poolCapacity: overlay.poolCapacity(),
    };
  `);

  check(
    27,
    'more blocks than the pool holds are dropped, and the count is reported',
    result.requested === 54 && result.overCapacity + result.budgetDropped > 0,
    `requested=${result.requested} pool=${result.poolCapacity} overCapacity=${result.overCapacity} `
      + `budgetDropped=${result.budgetDropped} truncated=${result.truncated} drawn=${result.drawn}`,
  );
  // Asserted on indices, not on areas. The renderer snaps every anchor to `anchorGrid` before it
  // gets here (#35), so a predicted area computed from the raw bbox is wrong by up to a grid cell
  // in each dimension - it read 2048 where the payload said 1800. The fixture's areas rise
  // monotonically with index, so the index set is the same claim without the arithmetic: 0..5 are
  // the smallest, and arrival-order truncation would have produced 48..53 instead.
  check(
    27,
    'the blocks dropped are the SMALLEST ones, not the last to arrive',
    JSON.stringify(result.droppedIndices) === JSON.stringify([0, 1, 2, 3, 4, 5]),
    `dropped payload indices ${JSON.stringify(result.droppedIndices)} `
      + `(areas ${JSON.stringify(result.droppedAreas)}); `
      + 'arrival-order truncation would have dropped [48..53], the six largest',
  );
  check(
    27,
    'an identical payload still counts as unchanged, so A6 survives the budget',
    result.repeatUnchanged === true,
    `second render unchanged=${result.repeatUnchanged}`,
  );
}

/**
 * The contract hole this harness found, kept as a check so it cannot come back.
 *
 * A render config arriving without `fontSize` used to write `"undefinedpx"` into the custom
 * property. That is invalid at computed-value time, so `var(--textlens-font-size, 17px)` drops
 * the whole declaration rather than using its fallback, and every box silently rendered at the
 * browser's inherited 16px. No error anywhere; the only symptom was wrong pixels.
 */
async function configGaps(session) {
  const result = await session.evaluate(`
    ${HELPERS}
    const errors = [];
    const original = console.error;
    console.error = (...args) => { errors.push(args.join(' ')); };
    try {
      // Deliberately malformed: exactly the message a hand-built fake or driver produces.
      const holed = message([entry('ทดสอบขนาดตัวอักษร', 'src', 200, 300)], { seq: 900, epoch: 6 });
      delete holed.config.fontSize;
      delete holed.config.opacity;
      overlay.render(holed);
    } finally {
      console.error = original;
    }
    const box = visibleBoxes()[0];
    const style = getComputedStyle(box);
    return {
      fontSize: parseFloat(style.fontSize),
      lineHeight: parseFloat(style.lineHeight),
      reported: errors.filter((line) => line.includes('render config arrived without')),
    };
  `);

  check(
    'contract',
    'a config missing fontSize falls back to the documented 17px, not the browser default',
    result.fontSize === 17,
    `computed font-size ${String(result.fontSize)}px (the silent-failure value was 16)`,
  );
  check(
    'contract',
    'and it says so rather than degrading quietly (invariant 4)',
    result.reported.length > 0 && result.reported[0].includes('fontSize'),
    result.reported.length > 0 ? result.reported[0] : 'nothing was reported',
  );
}

// ---------------------------------------------------------------------------------------------

const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(
  electron,
  [path.join(root, 'scripts', 'overlay-harness'), `--remote-debugging-port=${String(PORT)}`],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
);

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

let session = null;
let exitCode = 0;
try {
  const target = await overlayTarget();
  session = await Session.open(target.webSocketDebuggerUrl);
  await session.send('Runtime.enable');

  // Polled, not asked once. The page target appears in `/json/list` as soon as the document
  // exists, which is strictly before its module has finished evaluating and installed the seam -
  // so a single probe here fails intermittently, on timing, with a message blaming the build.
  let seam = false;
  for (let attempt = 0; attempt < 60 && !seam; attempt += 1) {
    seam = await session.evaluate('return typeof window.__textlensOverlay === "object";');
    if (!seam) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!seam) {
    throw new Error('window.__textlensOverlay never appeared; run `npm run build` and retry');
  }
  // The bundled face is fetched from disk after the document loads, and every typography
  // measurement below is meaningless until it has arrived.
  await session.evaluate('await document.fonts.ready; return true;');

  await thaiTypography(session);
  await twoPassLayout(session);
  await areaBudget(session);
  await configGaps(session);
} catch (error) {
  console.error(`\nHARNESS ERROR: ${error.message}`);
  if (stderr.trim() !== '') console.error(`electron stderr:\n${stderr}`);
  exitCode = 1;
} finally {
  session?.close();
  child.kill();
}

for (const issue of [24, 25, 27, 'contract']) {
  console.log(`\n--- ${issue === 'contract' ? 'render config contract' : `#${String(issue)}`} ---`);
  for (const result of results.filter((entry) => entry.issue === issue)) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.name}`);
    console.log(`      ${result.detail}`);
  }
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
process.exit(failed.length > 0 || exitCode !== 0 ? 1 : 0);
