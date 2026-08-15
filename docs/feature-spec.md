# Textlens — Feature Spec

**Real-time screen translation overlay → ภาษาไทย**

- สถานะ: v2 (อัปเดตหลัง architecture brainstorm)
- วันที่: 2026-08-15
- ที่มา: แกะ feature จาก [reference-analysis.md](reference-analysis.md) (Translation-Overlay, AGPL-3.0) — **ใช้แนวคิด ไม่ใช้โค้ด**
- Architecture: [superpowers/specs/2026-08-15-textlens-design.md](superpowers/specs/2026-08-15-textlens-design.md)

---

## 0. เป้าหมาย & ขอบเขต

**Goal**: เลือกพื้นที่บนหน้าจอ → OCR → แปลเป็นไทย → แสดงผลทับบนจอแบบ transparent overlay

**Primary use case**: **subtitle / เกม / วิดีโอ** — เนื้อหาเปลี่ยนตลอด ต้องแปลตามอัตโนมัติ
**Secondary use case**: อ่านเอกสาร / เว็บ / UI โปรแกรม — เนื้อหานิ่ง

**Display**: คำแปลเป็น **กล่องลอยใต้ข้อความต้นฉบับแต่ละก้อน (per-bbox anchored)** เพื่อให้เทียบได้ว่าประโยคไหนแปลได้อะไร — เป็นความตั้งใจเชิงการเรียนรู้ ไม่ใช่แค่เรื่อง UI

**Source language**: อังกฤษเป็นหลัก (เผื่อขยายภาษาอื่นทีหลัง)
**Target language**: ไทย

**Translation engine**: Google Translate เป็นหลักถาวร (latency ต่ำพอสำหรับ subtitle) → local LLM (LM Studio / Ollama) สำหรับโหมดอ่านเอกสารที่ยอมรอได้

**Platform**: Windows เท่านั้น

### Non-goals
- แปลไฟล์ / PDF / รูปจาก disk
- Text hooking จาก process memory
- แปลเสียง / subtitle จาก audio track
- Mobile / web version, multi-user, cloud sync
- Linux / macOS

---

## 1. Feature List

Legend — **P0** = MVP / **P1** = รอบถัดไป / **P2** = อนาคต
Source — 🔵 = แกะจาก reference / 🟢 = improvement ของเรา / 🔴 = reference ไม่มี

### 1.1 Region & Capture

| ID | Feature | P | Src | รายละเอียด |
|----|---------|---|-----|-----------|
| R1 | **Region selection** | P0 | 🔴 | hotkey → overlay คลุมจอ + crosshair → ลากเลือกกรอบ |
| R2 | Region persistence | P0 | 🔴 | จำกรอบล่าสุด (เก็บคู่กับ monitor id) |
| R3 | Multiple saved regions | P2 | 🔴 | preset ตั้งชื่อได้ เช่น "ช่อง subtitle" |
| R4 | Region resize / move | P1 | 🔴 | ลากขอบปรับได้โดยไม่ต้องเลือกใหม่ |
| R5 | Full-screen mode | P1 | 🔵 | ไม่เลือกกรอบ = ทั้งจอ |
| R6 | **Monitor picker** | P0 | 🔴 | เลือกจอ + overlay ไปโผล่จอนั้น รองรับ DPI ต่างกันต่อจอ |
| R7 | **Region padding + edge warning** | P0 | 🟢 | เผื่อ margin รอบกรอบ และเตือนเมื่อข้อความชิดขอบ — [spike S1](spikes/2026-08-15-s1-ocr-engine.md) วัดได้ว่า crop ที่กินขอบตัวอักษรทำให้ OCR พังทันที (`Logician`→`ogician`) |
| C1 | Region capture | P0 | 🔵 | จับเฉพาะ region bounds |
| C2 | Adaptive interval | P0 | 🔵 | active / idle / deep-idle ปรับตามความถี่ที่ภาพเปลี่ยน |
| C3 | Change detection | P0 | 🔵🟢 | dimension → byte-equal → sampled pixel diff. 🟢 diff เฉพาะ region |

### 1.2 Trigger & Control

| ID | Feature | P | Src | รายละเอียด |
|----|---------|---|-----|-----------|
| G1 | **Global hotkey** | P0 | 🔴 | toggle auto / snapshot ครั้งเดียว / เลือก region ใหม่ / ซ่อน-แสดง overlay |
| G2 | Hotkey ตั้งค่าได้ | P1 | 🔴 | เปลี่ยน binding + detect ชนกับโปรแกรมอื่น |
| G3 | Auto mode (loop) | P0 | 🔵 | **โหมดหลัก** — วนจับตาม adaptive interval |
| G4 | Snapshot mode | P0 | 🔴 | จับครั้งเดียว ค้างไว้จน dismiss — โหมดรอง สำหรับอ่านเอกสาร (ต้นทุนแทบศูนย์ เพราะเป็นแค่ tick เดียว) |
| G5 | Pause / Resume | P0 | 🔴 | หยุด pipeline จริง ไม่ใช่แค่ซ่อน overlay |
| G6 | System tray | P0 | 🔵 | toggle overlay + menu: Select Region, Snapshot, Auto on/off, Settings, Quit |

### 1.3 OCR

| ID | Feature | P | Src | รายละเอียด |
|----|---------|---|-----|-----------|
| O1 | OCR engine + fallback | P0 | 🔵 | Windows.Media.Ocr เป็นหลัก (ดู S1) |
| O2 | Downscale ก่อน OCR | P1 | 🔵 | region เล็กอยู่แล้ว — วัดก่อนค่อยทำ |
| O3 | Image preprocessing | P1 | 🔵 | grayscale / normalize / contrast — เผื่อ subtitle พื้นหลังโปร่ง |
| O4 | Confidence + noise filter | P0 | 🔵 | ตัด conf ต่ำ / สั้นเกิน / bbox แคบเกิน / pattern ขยะ |
| O5 | **Text grouping** | P0 | 🔵 | paragraph gap + column detection + sentence boundary (อยู่ฝั่ง Node) |
| O6 | **Coordinate space handling** | P0 | 🟢 | physical px → logical px ผ่าน converter ตัวเดียวที่มี test |
| O7 | Source language config | P1 | 🔵 | เลือกภาษาต้นทาง |
| O8 | **OCR preflight check** | P0 | 🟢 | ตรวจตอนเปิดแอปว่ามี en-US recognizer ไหม ถ้าไม่มีบอกวิธีติดตั้ง language pack — **ถ้าไม่มี แอปใช้งานไม่ได้เลย** (พบใน [spike S1](spikes/2026-08-15-s1-ocr-engine.md)) |

> OCR อ่าน **ภาษาต้นทาง** ไม่ใช่ปลายทาง → en→th ไม่ต้องมี Thai OCR model

### 1.4 Translation

| ID | Feature | P | Src | รายละเอียด |
|----|---------|---|-----|-----------|
| T1 | **Engine abstraction** | P0 | 🔵🟢 | `TranslationEngine` interface + adapter registry |
| T2 | Google Translate | P0 | 🔵 | endpoint ฟรี — **primary ถาวร** เพราะ latency ต่ำสุด |
| T3 | **Google Cloud API key (optional)** | P1 | 🔴 | ทางออกเมื่อ endpoint ฟรีโดน rate limit ที่ cadence ของ subtitle (ดู S3) |
| T4 | **OpenAI-compatible adapter** | P1 | 🟢 | ตัวเดียวคุมทั้ง LM Studio + Ollama — สำหรับโหมดอ่านเอกสาร |
| T5 | DeepL | P2 | 🔵 | |
| T6 | Fallback chain | P0 | 🔵 | primary ล้ม → fallback → ล้มหมดแสดงต้นฉบับ |
| T7 | Batch translation | P0 | 🔵 | หลายข้อความใน request เดียว |
| T8 | **LLM batch แบบ JSON** | P1 | 🟢 | numbered JSON array in/out — เร็วกว่ายิงทีละอันหลายเท่า |
| T9 | Rate limit + backoff | P0 | 🔵 | min interval + exponential backoff แยกต่อ engine |
| T10 | Skip same-language | P0 | 🔵 | เป็นไทยอยู่แล้ว → ไม่แปล |
| T11 | Prompt tuning สำหรับ LLM | P1 | 🟢 | system prompt เฉพาะงานแปล + บอกบริบท (subtitle / เอกสาร / UI) |
| T12 | Glossary | P2 | 🔴 | คำแปลตายตัวสำหรับชื่อเฉพาะ / ศัพท์เทคนิค |

### 1.5 Cache

| ID | Feature | P | Src | รายละเอียด |
|----|---------|---|-----|-----------|
| K1 | Translation cache | P0 | 🔵 | SQLite, key = hash + src + tgt + engine, batch read/write, TTL |
| K2 | **Normalized cache key** | P0 | 🟢 | hash จาก normalized text — OCR เพี้ยนนิดหน่อยยัง hit |
| K3 | Cache stats + clear | P1 | 🔴 | hit rate / ขนาด / ล้าง จาก settings |
| ~~K4~~ | ~~Fuzzy trigram cache~~ | ❌ | 🔵 | **ไม่ทำ** — reference เขียนแล้วปิดใช้เอง |

### 1.6 Anti-flicker & Stability — **หมวดหลักของ MVP**

> subtitle เปลี่ยนทุก 2-3 วินาที + per-bbox anchored → กระพริบคือปัญหาอันดับหนึ่ง

| ID | Feature | P | Src | รายละเอียด |
|----|---------|---|-----|-----------|
| A1 | **Lock Mode: Dynamic** | P0 | 🔵 | ไม่ lock แต่ suppress emit ถ้าผลลัพธ์คล้ายเดิม — โหมดที่ใช้จริงกับ subtitle |
| A2 | Lock Mode: Document | P1 | 🔵 | เนื้อหานิ่ง → ค้างคำแปล หยุด process |
| A3 | Content stability | P0 | 🔵 | เทียบ set ข้อความข้ามเฟรมแบบ fuzzy |
| A4 | Min display time | P0 | 🔵 | กล่องอยู่ครบเวลาขั้นต่ำก่อนถูกแทน |
| A5 | Text dedup 2 ชั้น | P0 | 🔵 | fuzzy match ตามตำแหน่ง + time window |
| A6 | Layout stability | P0 | 🔵 | ตำแหน่งซ้ำเดิมเกิน threshold → ไม่ re-render |
| A7 | **Anchor snapping** | P0 | 🟢 | snap bbox เข้า grid ก่อนใช้เป็นตำแหน่ง → OCR สั่น ±3px ไม่ทำให้กล่องขยับ |
| A8 | **Sticky placement** | P0 | 🟢 | ข้อความคล้ายเดิม → ใช้ตำแหน่งเดิมซ้ำ ไม่คำนวณ layout ใหม่ |
| A9 | **Crossfade** | P0 | 🟢 | เปลี่ยนข้อความในกล่องเดิมด้วย opacity transition แทน hide/show |

### 1.7 Feedback Loop Prevention

> overlay วาดคำแปลใกล้ region → capture รอบถัดไปอาจอ่านคำแปลตัวเอง

| ID | Feature | P | Src | รายละเอียด |
|----|---------|---|-----|-----------|
| F1 | Exclude overlay from capture | P0 | 🔵 | WGC + content protection flag — [spike S2](spikes/2026-08-16-s2-content-protection.md) ยืนยันว่า WGC เคารพจริง ต้องตั้ง flag **ก่อน** หน้าต่างถูก show |
| F2 | Recent output filter | P0 | 🔵 | เก็บข้อความที่เพิ่งแสดง แล้วกรอง OCR ที่ตรงกัน |
| F3 | **Thai script filter** | P0 | 🔵🟢 | เจอ U+0E00–0E7F = อ่านคำแปลตัวเอง → ทิ้ง. **แม่นเกือบ 100% เพราะอักษรไทยไม่ปนกับ Latin** — ตัวนี้คือด่านจริง |

### 1.8 Overlay UI

| ID | Feature | P | Src | รายละเอียด |
|----|---------|---|-----|-----------|
| U1 | Transparent click-through window | P0 | 🔵 | frameless, always-on-top, ไม่รับ mouse, ไม่แย่ง focus, ไม่โผล่ taskbar |
| U2 | **Side-by-side (per-bbox)** | P0 | 🔵 | กล่องคำแปลใต้ข้อความต้นฉบับแต่ละก้อน — **โหมดหลักที่เลือก** |
| U3 | Anti-overlap placement | P0 | 🔵 | ใต้ → ขวา → บน → ดันลง, จำกัดระยะเลื่อน, spatial hash |
| U4 | Screen area budget | P0 | 🔵 | จำกัดพื้นที่รวม + เรียงตาม area × confidence |
| U5 | Node pooling + GPU transform | P0 | 🔵 | pre-create element, ใช้ transform, throttle ด้วย rAF |
| U6 | **Block-level rendering** | P0 | 🟢 | 1 text block = 1 กล่อง **ไม่หั่นกลับเป็นรายบรรทัด** |
| U7 | **Two-pass layout** | P0 | 🟢 | วาด hidden → วัดความสูงจริง → จัดตำแหน่ง แทนการเดาจากจำนวนตัวอักษร |
| U8 | **Progressive render** | P1 | 🟢 | cache hit แสดงทันที → ผลจาก API เติมทีหลัง |
| U9 | **Interactive mode toggle** | P1 | 🟢 | hotkey ปิด click-through ชั่วคราว → เลือก/คัดลอกคำแปลได้ |
| U10 | Status indicator | P1 | 🔴 | มุมจอ: กำลังแปล / engine / จำนวน / 🔒 |
| U11 | Display: Replace/Cover | P2 | 🔴 | ทับข้อความเดิม |
| U12 | Display: Hover marker | P2 | 🔵 | จุด + tooltip |
| U13 | Display: Panel | P2 | 🔴 | รวมคำแปลในหน้าต่างข้างๆ |

> **🟢 U6 Block-level rendering สำคัญกับภาษาไทยเป็นพิเศษ**
> Reference หั่นคำแปลกลับไปวางรายบรรทัดด้วยการนับสัดส่วน + ตัดที่ `。！？，`
> ไทยไม่มีเครื่องหมายจบประโยคและไม่เว้นวรรคระหว่างคำ → จะตัดกลางคำแน่นอน
> แก้โดยไม่หั่นเลย แล้วให้ Chromium ตัดบรรทัดไทยเอง (ICU Thai line breaking, แค่ใส่ `lang="th"`)

### 1.9 Thai Language Support

| ID | Feature | P | Src | รายละเอียด |
|----|---------|---|-----|-----------|
| H1 | **Thai font stack** | P0 | 🟢 | bundle Noto Sans Thai / Sarabun ไม่พึ่ง font ระบบ |
| H2 | **Thai line-height** | P0 | 🟢 | ≥1.6 เพราะสระบน + วรรณยุกต์ + สระล่าง ซ้อน 3 ชั้น |
| H3 | **Thai line breaking** | P0 | 🟢 | `lang="th"` ให้ engine ตัดคำเอง |
| H4 | Thai text normalization | P1 | 🟢 | ตัดช่องว่างซ้ำ, normalize สระ/วรรณยุกต์ซ้ำจากการแปล |
| H5 | ไม่ทำ punctuation conversion | P0 | 🟢 | ไทยใช้ `,.?!` ปกติ — ตัด logic full-width ของจีนทิ้ง |
| H6 | UI ภาษาไทย | P1 | 🔴 | |

### 1.10 Config & Settings

| ID | Feature | P | Src | รายละเอียด |
|----|---------|---|-----|-----------|
| ST1 | Config 2 ชั้น | P0 | 🔵 | default (ติดมากับ app) + user override (persist) |
| ST2 | **Schema validation** | P0 | 🔵🟢 | validate ด้วย schema library — config พังแล้วไม่ล่ม fallback default |
| ST3 | Hot-reload | P0 | 🔵 | เปลี่ยนแล้วมีผลทันที |
| ST4 | Settings UI | P0 | 🔵 | engine, lang, display, font, opacity, hotkey, region, monitor, mode |
| ST5 | Engine health check | P1 | 🔵🟢 | ปุ่มทดสอบการเชื่อมต่อ + สถานะ — สำคัญตอนต่อ LM Studio |
| ST6 | Import / Export settings | P2 | 🔴 | |

### 1.11 Observability

| ID | Feature | P | Src | รายละเอียด |
|----|---------|---|-----|-----------|
| L1 | File logging + rotation | P0 | 🔵🟢 | ใช้ library แทน override `console.*` |
| L2 | Log level config | P1 | 🟢 | production ไม่ควร log ทุกบรรทัดที่ OCR อ่านได้ |
| L3 | Timing metrics | P0 | 🟢 | capture / OCR / translate / render แยกกัน — **จำเป็นเพราะมี latency budget** |
| L4 | **Debug view** | P1 | 🟢 | โชว์ภาพที่ capture + bbox + ข้อความก่อน-หลังแปล |
| L5 | Error → user-facing | P0 | 🟢 | engine ล่ม / ไม่มีเน็ต / sidecar ตาย → บอกผู้ใช้ ไม่ใช่เงียบ |

### 1.12 Privacy & Security

| ID | Feature | P | Src | รายละเอียด |
|----|---------|---|-----|-----------|
| PR1 | บอกให้ชัดว่าข้อมูลไปไหน | P0 | 🟢 | ใช้ Google = ข้อความบนจอถูกส่งออกนอกเครื่อง |
| PR2 | Local-only mode | P1 | 🟢 | บังคับ local engine + block network |
| PR3 | ไม่ log ข้อความจริงใน production | P1 | 🟢 | default log แค่ metrics |
| PR4 | API key เก็บปลอดภัย | P1 | 🔴 | ไม่เก็บ plaintext ใน config ที่ backup ได้ |

### 1.13 Build & Distribution

| ID | Feature | P | Src | รายละเอียด |
|----|---------|---|-----|-----------|
| B1 | Package Electron + sidecar ด้วยกัน | P1 | 🟢 | sidecar เป็น self-contained AOT exe แนบไปกับ installer |
| B2 | Installer + Portable | P1 | 🔵 | |
| B3 | Auto-update | P2 | 🔴 | |
| B4 | CI build on tag | P2 | 🔵 | |

---

## 2. MVP Scope

**เส้นทางผู้ใช้ที่ต้องวิ่งได้ครบ:**

```
เปิดโปรแกรม → tray icon ขึ้น
  → hotkey เลือก region: เลือกจอ + ลากกรอบคลุมช่อง subtitle
  → hotkey เปิด auto mode
  → subtitle เปลี่ยน → กล่องคำแปลไทยโผล่ใต้ข้อความอังกฤษแต่ละก้อน ไม่กระพริบ
  → hotkey pause / ซ่อน overlay
  → hotkey snapshot: แปลครั้งเดียวค้างไว้ (โหมดอ่านเอกสาร)
  → เปลี่ยน setting มีผลทันที
  → engine ล่ม → เห็นข้อความบอก ไม่ใช่เงียบ
```

**P0**: R1 R2 R6 R7 C1 C2 C3 · G1 G3 G4 G5 G6 · O1 O4 O5 O6 O8 · T1 T2 T6 T7 T9 T10 · K1 K2 · A1 A3 A4 A5 A6 A7 A8 A9 · F1 F2 F3 · U1 U2 U3 U4 U5 U6 U7 · H1 H2 H3 H5 · ST1 ST2 ST3 ST4 · L1 L3 L5 · PR1

> **หมายเหตุเรื่อง ID**: `S1`–`S3` สงวนไว้สำหรับ **spike ในหัวข้อ 5** เท่านั้น — feature ของ settings ใช้ `ST*` และ privacy ใช้ `PR*` เพื่อไม่ให้ชนกับ spike ID และ priority label (P0/P1/P2)

---

## 3. Improvement เหนือ reference

| # | Improvement | เหตุผล |
|---|-------------|--------|
| 1 | **Region selection** (R1) | ลด pixel ~20 เท่า → เร็ว/แม่น/ถูก ทุกด้าน + ทำให้ latency budget เป็นไปได้ |
| 2 | **แยก .NET sidecar** | pixel อยู่ฝั่งที่มี native API ดีที่สุด, text อยู่ฝั่งที่ render ไทยได้ดีที่สุด |
| 3 | **Anchor snapping + sticky placement** (A7/A8) | กระพริบส่วนใหญ่เกิดจากกล่องขยับตาม OCR jitter — reference แก้ปลายเหตุ เราแก้ที่ตำแหน่ง |
| 4 | **Crossfade** (A9) | เปลี่ยนข้อความในกล่องเดิม แทน hide/show ที่ตาเห็นเป็นกระพริบ |
| 5 | **Block-level rendering** (U6) | ตัดโค้ดหั่นบรรทัดทิ้ง + ให้ engine ตัดคำไทยเอง = ถูกต้องกว่า โค้ดน้อยกว่า |
| 6 | **Thai script filter** (F3) | อักษรไทยไม่ปนกับ Latin → กัน feedback loop ได้เกือบ 100% |
| 7 | **Coordinate space contract** (O6) | จุดที่ reference ไม่ได้จัดการ จะพังบนจอ scaling 125%+ |
| 8 | **OpenAI-compatible adapter เดียว** (T4) | คุมทั้ง LM Studio + Ollama |
| 9 | **LLM batch JSON** (T8) | เร็วกว่ายิงทีละข้อความหลายเท่า |
| 10 | **Normalized cache key** (K2) | ได้ประโยชน์ fuzzy โดยไม่ต้องมี trigram ที่ reference ทำแล้วต้องปิดทิ้ง |
| 11 | **Two-pass layout** (U7) | วัดความสูงจริงแทนเดา → กล่องไม่ทับกัน |
| 12 | **Progressive render** (U8) | cache hit เห็นผลทันที |
| 13 | **Interactive mode** (U9) | คัดลอกคำแปลได้ |
| 14 | **Timing metrics + debug view** (L3/L4) | มี latency budget ต้องวัดได้ |
| 15 | **Fake sidecar fixtures** | ทดสอบ pipeline ฝั่ง Node ทั้งเส้นโดยไม่แตะ Windows API |
| 16 | **ตัด fuzzy trigram cache ทิ้ง** (K4) | reference พิสูจน์แล้วว่าไม่เวิร์ก |
| 17 | **Error ที่ผู้ใช้เห็น** (L5) | reference เงียบเมื่อ engine ล่ม |

---

## 4. การตัดสินที่สรุปแล้ว

| เรื่อง | สรุป |
|---|---|
| Tech stack | Electron + TypeScript |
| Platform | Windows เท่านั้น |
| Capture + OCR | .NET sidecar (self-contained NativeAOT), Windows Graphics Capture + Windows.Media.Ocr — target `net10.0-windows10.0.19041.0` (ยืนยันแล้ว 2026-08-16: SDK 10 ติดตั้งอยู่ AOT+WinRT publish ผ่าน) |
| IPC | JSON lines over stdio — **pixel ไม่ข้าม wire** |
| Text grouping | ฝั่ง Node |
| Primary use case | subtitle / เกม |
| Display mode | per-bbox anchored side-by-side |
| Primary engine | Google Translate |

## 5. ความเสี่ยงที่ต้อง spike

| # | ความเสี่ยง | สถานะ | ผล |
|---|-----------|-------|-----|
| **S1** | Windows.Media.Ocr อ่าน subtitle เกมได้ไม่ดี | ✅ **ผ่าน** — [รายงาน](spikes/2026-08-15-s1-ocr-engine.md) | เร็วกว่า PaddleOCR 6 เท่า (p50 99ms vs 580ms เต็มจอ / 30ms บน region) และแม่นกว่าในเนื้อหาเกม → คงสถาปัตยกรรม .NET sidecar. **เหลือช่องว่าง**: ยังไม่ได้ทดสอบ subtitle ตัวอักษรขาวลอยบนวิดีโอที่ไม่มีกล่องพื้นหลัง |
| **S2** | WGC capture region + exclude-from-capture ไม่ทำงานตามคาด | ✅ **ผ่าน** — [รายงาน](spikes/2026-08-16-s2-content-protection.md) | `setContentProtection` ได้ affinity `WDA_EXCLUDEFROMCAPTURE` และ WGC path ของเราเห็นหน้าต่างข้างหลัง overlay ไม่ใช่ overlay — ครบทั้ง 3 จอ ไม่ใช่การทาดำทับ → F1 ใช้ได้จริง. **เหลือช่องว่าง**: ทดสอบได้บน OS build เดียว (26200.9168) และยังไม่ได้ลองกับเกม fullscreen exclusive → **ยังคง F2/F3 ไว้ทั้งคู่** |
| **S3** | Google free endpoint โดน rate limit ที่ cadence ของ subtitle | ⬜ | ต้องเร่ง T3 (API key) ขึ้นมาเป็น P0 |
