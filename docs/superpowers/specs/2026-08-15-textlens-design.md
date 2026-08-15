# Textlens — Architecture Design

- วันที่: 2026-08-15
- สถานะ: approved (จาก brainstorming session)
- Feature scope: [../../feature-spec.md](../../feature-spec.md)
- Reference analysis: [../../reference-analysis.md](../../reference-analysis.md)

---

## 1. บริบทและข้อจำกัด

Textlens จับภาพพื้นที่บนหน้าจอ อ่านข้อความด้วย OCR แปลเป็นไทย แล้ววาดคำแปลทับบนจอเป็นกล่องลอยใต้ข้อความต้นฉบับแต่ละก้อน

ข้อจำกัดที่กำหนดรูปร่างของ architecture:

| ข้อจำกัด | ผล |
|---|---|
| **subtitle เปลี่ยนทุก 2-3 วินาที** | pipeline ทั้งเส้นต้องจบใน ~1 วินาที มี latency budget เป็นตัวเลขจริง |
| **คำแปลลอยตาม bbox** | ตำแหน่งกล่องขึ้นกับ OCR ที่สั่นทุกเฟรม → ต้องมีกลไกกันกระพริบเป็นเรื่องหลัก |
| **ภาษาไทย** | ต้องการ ICU line breaking + font ที่รองรับสระซ้อน → renderer ต้องเป็น Chromium |
| **Windows เท่านั้น** | ใช้ Windows Graphics Capture + Windows.Media.Ocr ได้ |
| **overlay อยู่ใกล้ region** | capture รอบถัดไปอาจอ่านคำแปลตัวเอง → ต้องมี feedback loop prevention |

---

## 2. Component architecture

```
┌───────────────────────────────────────────────────────────┐
│ Electron  (TypeScript)                    "โลกของ text"    │
│                                                            │
│ Main process                                               │
│  ├── AppOrchestrator    lifecycle, mode (auto/snapshot)   │
│  ├── SidecarClient      spawn + supervise + JSON-lines    │
│  ├── TextPipeline       group → dedup → translate → emit  │
│  ├── TranslatorService  engine registry + fallback chain  │
│  │     └── engines/     google | openai-compat | deepl    │
│  ├── TranslationCache   SQLite                            │
│  ├── ConfigService      schema validation + hot reload    │
│  ├── HotkeyService      globalShortcut                    │
│  └── WindowManager      overlay / region-picker / settings│
│                                                            │
│ Renderer                                                   │
│  ├── overlay/           transparent click-through          │
│  ├── region-picker/     crosshair drag                     │
│  └── settings/                                             │
└──────────────────────────┬────────────────────────────────┘
                           │  JSON lines over stdio
                           │  ⚠ text + bbox เท่านั้น
┌──────────────────────────┴────────────────────────────────┐
│ Textlens.Capture  (.NET 10 AOT)          "โลกของ pixel"    │
│  ├── CaptureService   Windows.Graphics.Capture (region)   │
│  ├── ChangeDetector   pixel diff เฉพาะ region             │
│  ├── OcrService       Windows.Media.Ocr                   │
│  └── Protocol         stdin commands / stdout events      │
└───────────────────────────────────────────────────────────┘
```

### หลักการแบ่ง

**pixel ไม่ข้าม wire** — sidecar เป็นเจ้าของ pixel pipeline ทั้งหมด (capture → diff → OCR) และส่งออกมาเฉพาะข้อความกับพิกัด ข้อยกเว้นเดียวคือ debug view ที่ขอ frame เดี่ยวเป็น base64 ได้ ซึ่งปิดเป็น default

เหตุผล: ถ้า Node เป็นคนตัดสินใจว่าเฟรมไหนเปลี่ยน จะต้องรับ bitmap มาทุก tick — ส่ง PNG ขนาดเมกะไบต์ผ่าน stdio ทุก 800ms ไม่ไหว การให้ sidecar ตัดสินใจเองทำให้ traffic ตกเหลือไม่กี่ KB เฉพาะตอนที่มีอะไรเปลี่ยนจริง

**Text grouping อยู่ฝั่ง Node** — เป็น geometry กับ string logic ล้วน ไม่ต้องใช้ Windows API เลย เอาไว้ฝั่ง TypeScript ทำให้ unit test ง่ายและทำให้ sidecar เหลือหน้าที่แค่ capture+OCR ซึ่งแปลว่าถ้าต้องเปลี่ยน OCR engine (ดู S1) จะกระทบแค่ไฟล์เดียว

### หน้าที่ของแต่ละ unit

| Unit | ทำอะไร | ขึ้นกับอะไร |
|---|---|---|
| `AppOrchestrator` | ตัดสินใจว่าตอนนี้อยู่โหมดไหน ควร start/stop อะไร | SidecarClient, TextPipeline, WindowManager |
| `SidecarClient` | spawn process, encode/decode protocol, watchdog, restart | ไม่ขึ้นกับ business logic |
| `TextPipeline` | รับ OCR lines → group → dedup → translate → ส่ง frame ให้ overlay | OcrGrouping, ChangeFilter, TranslatorService |
| `TranslatorService` | เลือก engine, fallback chain, rate limit, cache | engines/*, TranslationCache |
| `TranslationCache` | อ่าน/เขียน SQLite, normalize key, TTL | — |
| `ConfigService` | โหลด/merge/validate/persist, แจ้ง subscriber เมื่อเปลี่ยน | — |
| `WindowManager` | สร้างและจัดการ BrowserWindow ทั้งสามตัว | ConfigService |

---

## 3. IPC contract (Node ↔ sidecar)

รูปแบบ: **JSON lines over stdio** — หนึ่งบรรทัดหนึ่ง message

เลือก stdio แทน named pipe เพราะ: debug ได้ด้วยการรัน sidecar เดี่ยวๆ แล้วพิมพ์คำสั่งใส่ stdin, ไม่มีปัญหาชื่อ pipe ชนกัน, process ตายพร้อมกันโดยอัตโนมัติ throughput ไม่กี่ KB ต่อเฟรมเพียงพอมาก

### Commands (Node → sidecar)

| cmd | payload | ตอบกลับ |
|---|---|---|
| `listMonitors` | — | รายการจอ + bounds + scale |
| `configure` | region, monitorId, intervalActive, intervalIdle, diffThreshold, ocrLanguage | ack |
| `start` / `stop` | — | ack |
| `snapshot` | — | `frame` หนึ่งครั้งโดยไม่สนใจ change detection |
| `debugFrame` | — | `frame` + `imagePng` (base64) |

### Events (sidecar → Node)

```jsonc
{"ev":"ready","version":"1.0.0","ocrLanguages":["en-US","th-TH"]}

{"ev":"frame","seq":42,
 "timings":{"capture":12,"diff":3,"ocr":58},
 "monitor":{"id":"\\\\.\\DISPLAY1","scale":1.5,"bounds":[0,0,3840,2160]},
 "region":[400,1800,1200,150],
 "lines":[{"text":"You must find the key","bbox":[120,80,540,32],"conf":0.93}]}

{"ev":"nochange","seq":43}

{"ev":"error","code":"CAPTURE_FAILED","message":"..."}
```

### Coordinate contract

จุดที่ reference พลาด: เอาพิกัด physical px ไปใช้กับ CSS logical px โดยตรง บนจอ scaling 100% ไม่มีปัญหา แต่ 125%/150% ตำแหน่งเพี้ยน

| ชั้น | หน่วย | origin |
|---|---|---|
| sidecar | physical px | มุมซ้ายบนของ **region** |
| wire | physical px + `scale` + `monitor.bounds` + `region` มาด้วยเสมอ — **`monitor.bounds` เป็น physical px ดิบจาก Win32** | |
| Node | แปลงเป็น **logical px, screen-global** ที่จุดเดียว | มุมซ้ายบนของ virtual desktop |
| renderer | CSS px | มุมซ้ายบนของ overlay window |

**logical origin ของจอมาจาก Electron ไม่ใช่จาก wire** (ตัดสิน 2026-08-16 หลัง M1-03 ชี้ความกำกวมนี้)

```ts
logicalX = (regionX + bboxX) / scale + display.bounds.x   // display = Electron Display ที่ M6-01 เลือกไว้
```

เหตุผล: เมื่อจอมี DPI ต่างกัน **คำนวณ logical origin จาก physical origin ไม่ได้** เพราะ Chromium จัด DIP layout ให้จอติดกันในพื้นที่ logical ไม่ใช่หาร physical ด้วย scale ของจอตัวเอง

> จอ A 3840×2160 @200% ที่ physical (0,0) · จอ B 1920×1080 @100% ที่ physical (3840,0)
> → Electron รายงาน B อยู่ที่ DIP x = **1920** ไม่ใช่ `3840 / 1.0 = 3840`

`monitor.bounds` บน wire จึงเป็นข้อมูลประกอบ/diagnostic — sidecar ไม่คำนวณ scale เลย (invariant #1) และ scale math ทั้งหมดยังอยู่ใน `coordinates.ts` ไฟล์เดียว (invariant #3)

มี converter ตัวเดียว มี unit test ครอบทุกกรณี (scale 1.0 / 1.25 / 1.5, จอเดี่ยว / หลายจอ / จอซ้ายของ primary ที่ x ติดลบ)

---

## 4. Data flow — หนึ่งรอบ

```
[sidecar] capture region
    → pixel diff เทียบเฟรมก่อน
    → ไม่เปลี่ยน? ส่ง "nochange" จบรอบ
    → เปลี่ยน: OCR → ส่ง "frame" พร้อม lines + timings
         │
[Node]   → แปลงพิกัด physical → logical
         → group lines เป็น text blocks (paragraph / column / sentence)
         → กรอง noise (conf ต่ำ, สั้นเกิน, แคบเกิน, pattern ขยะ)
         → กรอง feedback (recentOutputs + Thai script filter)
         → dedup (fuzzy ตามตำแหน่ง + time window)
         → ไม่เหลืออะไรใหม่? จบรอบ
         → cache lookup แบบ batch
              ├─ hit  → ส่งเข้า render ทันที        (progressive render)
              └─ miss → translate batch → เขียน cache → ส่งเข้า render
         │
[renderer] → anchor snapping
           → sticky placement (ข้อความคล้ายเดิม = ใช้ตำแหน่งเดิม)
           → two-pass layout: วาด hidden → วัดความสูงจริง → แก้ตำแหน่ง
           → anti-overlap: ใต้ → ขวา → บน → ดันลง
           → area budget: ตัดตัวที่เกินโควตาพื้นที่จอ
           → crossfade เข้าที่กล่องเดิม
```

### Latency budget (region ~1200×150)

| ขั้น | เป้า |
|---|---|
| capture + diff | ~15ms |
| OCR | ~40-80ms |
| IPC → Node | ~5ms |
| group + filter + dedup | ~5ms |
| translate (cache miss, Google batch) | ~300-500ms |
| render | ~16ms |
| **รวม** | **~400-600ms** |

`L3 timing metrics` เก็บตัวเลขจริงทุกขั้นเพื่อเทียบกับ budget นี้ — ถ้าเกินต้องรู้ว่าเกินตรงไหน

---

## 5. Anti-flicker

per-bbox anchored ทำให้กล่องคำแปลผูกกับพิกัดที่ OCR คืนมา ซึ่งสั่นทุกเฟรมแม้ภาพจะเหมือนเดิม กลไกกันกระพริบจึงเป็นงานหลักไม่ใช่งานเสริม

| กลไก | แก้อะไร |
|---|---|
| **Anchor snapping** | snap bbox เข้า grid ก่อนใช้เป็นตำแหน่ง — OCR สั่น ±3px ไม่ทำให้กล่องขยับ |
| **Sticky placement** | ข้อความคล้ายเดิมเกิน threshold → ใช้ตำแหน่งที่คำนวณไว้แล้ว ไม่ layout ใหม่ |
| **Layout stability** | ชุดตำแหน่งใหม่ซ้ำของเดิมเกิน threshold → ข้าม render ไปเลย |
| **Min display time** | กล่องต้องอยู่ครบเวลาขั้นต่ำก่อนถูกแทน |
| **Dynamic suppress** | ผลแปลคล้ายเดิม → ไม่ emit |
| **Crossfade** | เปลี่ยนข้อความในกล่องเดิมด้วย opacity transition แทน hide/show |

ลำดับการทำงาน: กรองที่ pipeline ก่อน (dedup, suppress) แล้วค่อยกันที่ renderer (snapping, sticky, stability) — สองชั้นนี้แก้คนละสาเหตุ ชั้นแรกกันการแปลซ้ำ ชั้นหลังกันการวาดซ้ำ

---

## 6. Feedback loop prevention

overlay วาดคำแปลใต้ข้อความต้นฉบับ ซึ่งอาจอยู่ในหรือชิด region → capture รอบถัดไปอ่านคำแปลตัวเองแล้วแปลซ้ำวนไม่จบ

| ชั้น | กลไก | ความมั่นใจ |
|---|---|---|
| 1 | overlay window ตั้ง content protection → WGC ไม่เห็น | **ยืนยันแล้ว ([S2](../../spikes/2026-08-16-s2-content-protection.md))** |
| 2 | recentOutputs — เก็บข้อความที่เพิ่งแสดง กรอง OCR ที่ตรงกัน | ปานกลาง (OCR อ่านเพี้ยนแล้วไม่ตรง) |
| 3 | **Thai script filter — เจอ U+0E00–0E7F ทิ้งทันที** | **เกือบ 100%** |

ชั้น 3 คือด่านจริง เพราะข้อความต้นทางเป็นอังกฤษ อักษรไทยจึงไม่มีทางโผล่จากแหล่งอื่นนอกจากคำแปลของเราเอง — ต่างจาก reference ที่เป้าหมายเป็นภาษาจีนซึ่งปนกับข้อความต้นทางได้

S2 วัดชั้น 1 บน Windows 11 25H2 build 26200.9168 ได้ผลเด็ดขาด: `setContentProtection(true)` ทำให้ HWND ได้ affinity `WDA_EXCLUDEFROMCAPTURE` (`0x11`) และ WGC path ของเราเองเห็น**หน้าต่างที่อยู่ข้างหลัง overlay** ไม่ใช่ overlay — ครบทั้ง 3 จอ ไม่ใช่การทาดำทับ (สำคัญ เพราะ overlay กินเต็มจอ ถ้าเป็นการทาดำ capture จะพังทั้งใบ)

**แต่ยังคงชั้น 2 กับ 3 ไว้ทั้งคู่**: ทดสอบได้บน build เดียว และ `WDA_EXCLUDEFROMCAPTURE` ต้องการ Windows 10 2004+ เครื่องที่เก่ากว่านั้นจะ degrade เงียบ ๆ → ตอน runtime ควรอ่าน `GetWindowDisplayAffinity` กลับมายืนยันว่าได้ `0x11` จริง และแจ้งผู้ใช้ถ้าไม่ได้ (ข้อ 7 — ไม่มีความล้มเหลวไหนที่เงียบ)

---

## 7. Error handling

| เหตุ | พฤติกรรม |
|---|---|
| sidecar ตาย | restart แบบ backoff สูงสุด 3 ครั้งใน 60 วินาที → เกินนั้นหยุดและแจ้งผู้ใช้ที่ tray + overlay |
| sidecar ค้าง | watchdog — ไม่มี event เกิน N เท่าของ interval → kill แล้ว restart ตามกฎข้างบน |
| sidecar เปิดไม่ได้ตั้งแต่แรก | แจ้ง error พร้อมทางแก้ ไม่ปิดแอป (settings ยังเปิดได้) |
| OCR ไม่เจอข้อความ | ไม่ใช่ error — no-op |
| engine ล้ม | fallback chain → ล้มหมดแสดงต้นฉบับพร้อมสัญญาณเตือน |
| 429 / network error | exponential backoff แยกต่อ engine ไม่ให้ engine หนึ่งล้มไปกระทบอีกตัว |
| config พัง | log + ใช้ default + แจ้งใน settings ว่า field ไหนไม่ผ่าน |

หลักการ: **ไม่มีความล้มเหลวไหนที่เงียบ** — reference เงียบเมื่อ engine ล่ม ผู้ใช้เห็นแค่ overlay ว่างเปล่าโดยไม่รู้สาเหตุ

---

## 8. Testing

| ระดับ | ครอบอะไร |
|---|---|
| **Node unit** | text grouping, dedup, coordinate conversion, cache key normalization, Thai script filter, engine fallback (mock HTTP), anti-flicker decision logic |
| **Sidecar unit** | change detector, protocol serialization/deserialization |
| **Sidecar OCR** | golden images — เก็บภาพ subtitle จริงไว้ชุดหนึ่ง เทียบผลที่คาดหวัง |
| **Integration (fake sidecar)** | สคริปต์ที่ replay JSON-lines ที่อัดจาก sidecar จริง → ทดสอบ pipeline ฝั่ง Node ทั้งเส้นแบบ deterministic โดยไม่ต้องแตะ Windows API |
| **Manual** | debug view (L4) |

fake sidecar เป็นตัวสำคัญ: ทำให้ CI รันได้โดยไม่ต้องมีหน้าจอจริง และทำให้ reproduce บั๊กจาก session จริงได้ด้วยการเก็บ log ของ protocol ไว้เป็น fixture

---

## 9. Repo layout

```
Textlens/
├── src/                    Electron app (TypeScript)
│   ├── main/
│   │   ├── services/
│   │   └── utils/
│   ├── preload/
│   ├── renderer/
│   │   ├── overlay/
│   │   ├── region-picker/
│   │   └── settings/
│   └── shared/             types + protocol ที่ใช้ร่วมกัน
├── sidecar/                .NET 10 project (Textlens.Capture)
├── docs/
│   ├── feature-spec.md
│   ├── reference-analysis.md
│   └── superpowers/specs/
├── tests/
│   └── fixtures/           JSON-lines ที่อัดจาก sidecar จริง
└── config/
```

---

## 10. ความเสี่ยงและ spike

| # | ความเสี่ยง | ทดสอบยังไง | ผลถ้าเป็นจริง |
|---|-----------|-----------|---------------|
| **S1** | Windows.Media.Ocr อ่าน subtitle เกมได้ไม่ดี — font ตกแต่ง, anti-alias, พื้นหลังโปร่ง | เก็บภาพ subtitle จริง 10-15 ภาพจากเกม/วิดีโอที่จะใช้ → รัน Windows.Media.Ocr เทียบกับ PaddleOCR | เหตุผลหลักของ .NET sidecar หายไปครึ่งหนึ่ง → เปลี่ยน OcrService เป็น PaddleOCR ONNX (กระทบไฟล์เดียวเพราะ grouping อยู่ฝั่ง Node แล้ว) |
| ~~**S2**~~ **ปิดแล้ว 2026-08-16** | WGC capture region + exclude-from-capture ไม่ทำงานตามคาด | สร้าง overlay window ตั้ง content protection แล้วดูว่า WGC เห็นไหม | **ความเสี่ยงไม่เกิด** — F1 ใช้ได้จริง ([รายงาน](../../spikes/2026-08-16-s2-content-protection.md)) แต่ยังคง F2/F3 ไว้ เพราะทดสอบได้บน OS build เดียว |
| **S3** | Google free endpoint โดน rate limit ที่ cadence ของ subtitle | รัน auto mode กับวิดีโอจริง 30 นาที นับ request และ 429 | เร่ง T3 (Google Cloud API key) ขึ้นเป็น P0 |

**ลำดับ: S1 → S2 → S3** — S1 กระทบการตัดสินใจมากที่สุด ควรทำก่อนเขียนอะไรจริงจัง
