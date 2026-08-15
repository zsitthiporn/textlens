# Reference Analysis — Translation-Overlay (asitass)

วิเคราะห์เพื่อแกะ **feature** เท่านั้น ไม่คัดลอกโค้ด (ต้นทางเป็น AGPL-3.0)

- Source: `D:\Project\OtherSource\Translation-Overlay`
- Stack: Electron 33 + TypeScript, ~7.3k LOC
- วันที่วิเคราะห์: 2026-08-15

---

## 1. Architecture ของเขา

```
Main Process (Node)
├── ScreenCapturer      node-screenshots → PNG buffer (primary monitor เต็มจอ)
├── ChangeDetector      pixel diff + text dedup + stability tracking
├── OcrService          PaddleOCR (ONNX) → Tesseract.js (fallback)
│   └── groupOcrLines() รวมบรรทัด → paragraph/column blocks
├── TranslatorService   bergamot / google / ollama / deepl + fallback chain
├── TranslationCache    better-sqlite3 (exact hash) + FuzzyCache (ปิดใช้อยู่)
├── Pipeline            tick loop: capture → detect → OCR → filter → translate → emit
└── ConfigService       YAML default + user override, hot-reload

Renderer
├── Overlay Window      transparent, alwaysOnTop, click-through, DOM node pool
└── Settings Window     engine/lang/appearance/lock-mode
```

Pipeline tick (`src/main/services/pipeline.ts:184`):
`capture → pixel diff → OCR grouped → stability check (lock?) → filter feedback → filter target-lang → dedup → filter noise → translate (batch) → postprocess → split to lines → emit IPC`

---

## 2. Feature ที่แกะได้

| # | Feature | เขาทำยังไง (file:line) | เอาไหม | หมายเหตุสำหรับ Textlens (ไทย) |
|---|---------|------------------------|--------|-------------------------------|
| **Capture** |
| C1 | Screen capture | `node-screenshots` จับ primary monitor เต็มจอ ทุก tick — `capturer.ts:22` | ✅ MVP | Windows-first ก็พอ |
| C2 | Adaptive interval | active 1.5s / idle 3s / deep-idle 6s / fast-detect 1s หลัง idle >15s — `adaptive-timer.ts:64` | ✅ MVP | ประหยัด CPU มาก คุ้มค่าทำ |
| C3 | Change detection 3 ชั้น | dimension → `Buffer.equals` → sampled pixel diff (ทุก 4 px, RGB delta >30, early exit) — `change-detector.ts:55` | ✅ MVP | ตัดงาน OCR ทิ้งได้ >80% |
| **OCR** |
| O1 | Dual engine + auto fallback | Paddle (ONNX, ~190ms) → Tesseract.js (WASM, 5-6s) — `ocr.ts:71` | ✅ MVP | source = อังกฤษ → Paddle en model ใช้ได้เลย |
| O2 | Downscale ก่อน OCR | 0.65x แล้ว scale bbox กลับ — `paddle-engine.ts:238` | ✅ MVP | เร็วขึ้นชัดเจน |
| O3 | Image preprocessing | grayscale / normalize / upscale (ใช้กับ Tesseract) — `image-preprocessing.ts` | ⚠️ Phase 2 | Paddle ไม่ต้องใช้ |
| O4 | Confidence + noise filter | conf <60 ตัด, ข้อความ <3 ตัวตัด, bbox width <30 ตัด, regex กรองเวลา/ตัวเลข — `pipeline.ts:342` | ✅ MVP | |
| O5 | Text grouping ฉลาด | รวมบรรทัดเป็น block: paragraph gap (2x line height), sentence boundary, column detection (Y ซ้อน + X ห่าง >50px) — `text-grouping.ts:68` | ✅ MVP | **สำคัญมาก** — แปลทีละบรรทัดคุณภาพแย่ |
| **Translation** |
| T1 | Multi-engine + fallback chain | primary ล้ม → fallback engine อัตโนมัติ → ล้มหมด = คืนต้นฉบับ — `translator.ts:230` | ✅ MVP | เริ่ม google → เพิ่ม LM Studio/Ollama ทีหลัง |
| T2 | Batch translation | ส่ง `q` หลายตัวใน request เดียว (Google), DeepL ก็ batch, Ollama ยิงทีละอัน — `translator.ts:367` | ✅ MVP | ลด request 10x |
| T3 | Rate limit + backoff | min 500ms/request, exponential backoff 5→30s เมื่อเจอ 429, 3→15s เมื่อ network error — `translator.ts:316` | ✅ MVP | จำเป็น เพราะ Google endpoint เป็นตัวฟรี unofficial |
| T4 | Language detection | นับ CJK vs Latin codepoint (หยาบมาก) — `translator.ts:70` | ⚠️ ปรับ | ของไทยต้องรองรับ U+0E00–0E7F |
| T5 | Skip same-language | src == tgt → ข้าม ไม่ยิง API | ✅ MVP | |
| T6 | Quality score + retry | Bergamot คืน score, <0.3 → ยิง fallback engine ซ้ำเฉพาะตัวนั้น — `translator.ts:182` | ⚠️ Phase 2 | ใช้ได้กับ local LLM เหมือนกัน |
| T7 | Proxy support | `HTTPS_PROXY` env + Electron session proxy + `net.fetch` — `index.ts:242` | ❌ ข้าม | ไทยไม่ต้อง (เขาทำเพื่อผู้ใช้จีน) |
| **Cache** |
| K1 | SQLite translation cache | better-sqlite3, WAL, key = sha256(text)+src+tgt, bulkGet/putBatch, TTL 168h — `cache.ts` | ✅ MVP | ประหยัด API เยอะมาก |
| K2 | Fuzzy cache (trigram) | มีโค้ด `fuzzy-cache.ts` แต่ **ปิดใช้งานอยู่** — TODO บอกว่า OCR คุณภาพต่ำเกินจะ match ได้ — `translator.ts:138` | ❌ ข้าม | เขาลองแล้วไม่เวิร์ก อย่าเสียเวลาซ้ำ |
| **Anti-flicker (จุดขายจริงของเขา)** |
| A1 | Lock Mode: Document | เนื้อหานิ่ง → lock ค้างคำแปลไว้ หยุด process, มี 🔒 indicator, ปลดล็อกเมื่อ pixel เปลี่ยน >15% — `pipeline.ts:283` | ✅ MVP | โหมดอ่านเอกสาร/เว็บ |
| A2 | Lock Mode: Dynamic | ไม่ lock, แปลทุกเฟรม แต่ suppress emit ถ้าผลลัพธ์คล้ายเดิม (Levenshtein ≥0.85) — `pipeline.ts:438` | ✅ MVP | โหมดเกม/วิดีโอ |
| A3 | Content stability (Jaccard) | เทียบ set ของข้อความข้ามเฟรมแบบ fuzzy, similarity ≥0.4 นับเป็นนิ่ง — `change-detector.ts:178` | ✅ MVP | ทนต่อ OCR ที่อ่านไม่เหมือนเดิมทุกเฟรม |
| A4 | Min lock time | lock แล้วต้องค้าง ≥5s ห้ามปลด กัน lock/unlock กระพริบ — `pipeline.ts:235` | ✅ MVP | |
| A5 | Min display time | overlay ต้องแสดง ≥3s ก่อนถูกแทน — `overlay.ts:103` | ✅ MVP | |
| A6 | Dedup 2 ชั้น | Layer 1: fuzzy match ตามตำแหน่ง grid 3x3 (Levenshtein ≥0.85 + prefix match กัน OCR ตัดคำ) / Layer 2: time window 10s ต่อ text hash — `change-detector.ts:259` | ✅ MVP | |
| A7 | Layout stability (renderer) | ถ้าตำแหน่งใหม่ซ้ำของเดิม ≥70% (grid 40px) → ไม่ re-render — `overlay.ts:64` | ✅ MVP | |
| **Feedback loop prevention (overlay ถูก OCR อ่านซ้ำ)** |
| F1 | Content protection | `setContentProtection(true)` → `WDA_EXCLUDEFROMCAPTURE` บน Windows — `index.ts:152` | ✅ MVP | ชั้นแรก แต่เขาเองก็ไม่มั่นใจว่าได้ผล 100% |
| F2 | recentOutputs set | เก็บข้อความที่เพิ่ง emit (cap 200/trim 150) แล้วกรอง OCR ที่ตรงกัน — `pipeline.ts:296` | ✅ MVP | |
| F3 | Target-language script filter | ตรวจ script ของข้อความ OCR — ถ้าเป็นภาษาปลายทาง (zh/ja/ko) แปลว่าอ่านจาก overlay ตัวเอง → ทิ้ง — `target-lang-detector.ts:148` | ✅ MVP | **ต้องเขียนใหม่สำหรับไทย** (ดูข้อ 4) |
| **Overlay UI** |
| U1 | Transparent click-through window | frameless, alwaysOnTop 'screen-saver', `setIgnoreMouseEvents(true, {forward})`, skipTaskbar, focusable:false — `index.ts:121` | ✅ MVP | |
| U2 | Display mode: Side-by-side | กล่องคำแปลใต้ข้อความเดิม 2px | ✅ MVP | |
| U3 | Display mode: Hover | จุด marker เล็ก + tooltip ตอน hover | ⚠️ Phase 2 | จอสะอาดกว่า แต่ click-through ทำให้ hover ยาก |
| U4 | Anti-overlap placement | ลอง 3 ตำแหน่ง (ใต้/ขวา/บน) → ถ้าชนก็ดันลงทีละ 4px, จำกัด displacement 20px, ใช้ SpatialHash O(n) — `overlay.ts:347` | ✅ MVP | |
| U5 | Screen area budget | รวมพื้นที่ overlay ไม่เกิน 30% ของจอ, เรียงลำดับตาม area × confidence — `overlay.ts:359` | ✅ MVP | กันจอเละ |
| U6 | DOM node pool | pre-create 50 nodes, ใช้ `transform` translate (GPU) แทน left/top, throttle ด้วย rAF — `overlay.ts:141` | ✅ MVP | |
| U7 | Multi-line split | บล็อกหลายบรรทัด → หั่นคำแปลกลับไปวางตามตำแหน่งแต่ละบรรทัด (sentence-aware) — `translation-postprocess.ts:65` | ⚠️ ปรับ | ตัวหั่นเป็น logic ภาษาจีน ต้องเขียนใหม่ |
| **Config / UX** |
| G1 | YAML config 2 ชั้น | `config/default.yaml` + `userData/user-config.yaml` override, deep merge, snake_case ↔ camelCase — `config.ts:173` | ✅ MVP | |
| G2 | Config validation | ตรวจ range/enum ก่อน apply, throw `ConfigError` — `config.ts:12` | ✅ MVP | |
| G3 | Hot-reload ไม่ต้อง restart | Settings → IPC → update config → rebuild timer / ส่ง overlay config — `pipeline.ts:102` | ✅ MVP | |
| G4 | Settings window | engine, fallback, target lang, font size, opacity, display mode, lock mode, ollama url/model | ✅ MVP | |
| G5 | System tray | left-click toggle overlay, right-click menu (Show/Hide/Settings/Quit) — `index.ts:204` | ✅ MVP | |
| G6 | File logging | override console.*, buffered async append (flush 2s หรือ 50 บรรทัด) → `app.log` — `index.ts:47` | ✅ MVP | จำเป็นตอน debug packaged app |
| G7 | Engine status indicator | poll สถานะ engine ทุก 3s แสดงใน settings — `settings.ts:47` | ⚠️ Phase 2 | จะมีประโยชน์มากตอนต่อ LM Studio |
| **Build / Dist** |
| B1 | electron-builder | NSIS installer + portable exe + AppImage, `asarUnpack` native modules | ✅ ทีหลัง | |
| B2 | Model auto-download | `postinstall` โหลด model ~260MB, ล้มก็ยัง run ได้ (graceful fallback) | ⚠️ ถ้าใช้ local model | |
| B3 | CI/CD | GitHub Actions build win + linux → release ตอน push tag `v*` | ⚠️ ทีหลัง | |

---

## 3. สิ่งที่ README เขาโฆษณา แต่ **โค้ดไม่มีจริง** (ตรวจแล้ว)

| อ้างใน README | ความจริงในโค้ด | โอกาสของเรา |
|---------------|-----------------|-------------|
| "Select any region on your screen" | ไม่มี region selection เลย — จับ primary monitor เต็มจอทุกครั้ง (`capturer.ts:22`) | ⭐ ทำ region select ได้เปรียบทันที (ลด OCR load + แม่นขึ้น) |
| — | ไม่มี global hotkey (grep `globalShortcut` = 0 hits) | ⭐ hotkey toggle/capture |
| Cross-platform | มี `getMonitorList()` แต่ไม่มี UI ให้เลือกจอ | ⭐ multi-monitor picker |
| — | ไม่มี manual trigger (แปลตอนกด) — วน loop อย่างเดียว | ⭐ โหมด on-demand ประหยัด quota |
| — | ไม่มี copy คำแปล / history / export | ⭐ optional |
| — | ไม่มี pause/resume จาก tray (มีแค่ show/hide overlay) | ⭐ |

---

## 4. งานเฉพาะภาษาไทย (ของเขาใช้ไม่ได้ ต้องเขียนใหม่)

| หัวข้อ | ปัญหา | ทางแก้ |
|--------|-------|--------|
| Feedback filter | `target-lang-detector.ts` รองรับแค่ zh/ja/ko | เพิ่ม Thai script U+0E00–0E7F — **ง่ายกว่าและแม่นกว่า zh** เพราะไทยไม่ปนกับ Latin |
| Punctuation postprocess | `postProcessTranslation()` แปลง `,.?!` → `，。？！` (ภาษาจีนล้วน) | ไทยไม่ใช้ full-width punctuation → ตัดทิ้ง เขียน normalizer ของไทยแทน |
| Line splitting | `splitTranslationToLines()` หั่นที่ `。！？；，` | ไทยไม่มีเครื่องหมายจบประโยค + **ไม่เว้นวรรคระหว่างคำ** → ต้องใช้ `Intl.Segmenter('th', {granularity:'word'})` หรือ dictionary-based wrap ไม่งั้นตัดกลางคำ |
| Font rendering | overlay ใช้ font default | ไทยมีสระบน/ล่าง/วรรณยุกต์ → ต้องใช้ Noto Sans Thai / Sarabun + เพิ่ม `line-height` ไม่งั้นสระโดนตัด |
| OCR language | — | **OCR อ่านภาษาต้นทาง ไม่ใช่ปลายทาง** → en→th ใช้ Paddle en model ได้เลย ไม่ต้องมี Thai OCR model. จะต้องใช้ Thai/JP/KR OCR ก็ต่อเมื่ออยากแปล ja/ko→th ทีหลัง |
| Bergamot en→th | — | **ต้อง verify** ว่า `mozilla/firefox-translations-models` มี pair `en-th` หรือไม่ (ดู registry.json) — ถ้าไม่มี offline path ต้องพึ่ง local LLM แทน. ไม่ block เพราะแผนคือเริ่มที่ Google |
| Google endpoint | ใช้ `translate.google.com/translate_a/single?client=at` (unofficial, ไม่ต้อง API key) | ใช้ได้แต่เสี่ยงโดน rate limit/block → backoff logic ของเขาเป็น feature ที่ต้องมี |

---

## 5. ผลต่อการออกแบบ

1. **Engine abstraction ต้องมีตั้งแต่แรก** — เพราะแผนคือ Google → LM Studio/Ollama. Ollama ใช้ `/api/generate`, ส่วน LM Studio เป็น OpenAI-compatible `/v1/chat/completions` (API shape คนละแบบ) → ต้องมี `TranslationEngine` interface + adapter ต่อเจ้า
2. **Local LLM ช้ากว่ามาก** (2-5s/batch) → lock mode + cache + on-demand mode ยิ่งสำคัญ
3. **License** — ต้นทางเป็น AGPL-3.0 → แกะ feature/แนวคิดได้ ไม่มีปัญหา แต่ห้ามคัดลอกโค้ด ไม่งั้น Textlens ติด AGPL ไปด้วย
