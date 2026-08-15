# Textlens MVP — Issue Backlog

แตกจาก [feature-spec.md](../feature-spec.md) และ [architecture design](../superpowers/specs/2026-08-15-textlens-design.md)

- 43 issues / 10 milestones — ครอบคลุม P0 ครบทั้ง 44 features
- สร้างขึ้น GitHub ด้วย `scripts/create-issues.ps1`
- รูปแบบ: แต่ละ issue คั่นด้วย `<!-- ISSUE -->` และมี metadata block นำหน้า

## Global Constraints

ข้อกำหนดระดับโปรเจกต์ — ทุก issue อยู่ภายใต้ข้อเหล่านี้โดยปริยาย

| | |
|---|---|
| Platform | Windows 10/11 เท่านั้น — ห้ามเขียนโค้ด cross-platform "เผื่อไว้" |
| Node | >= 20 (เครื่อง dev: 20.20.2, npm 10.8.2) |
| .NET | target `net9.0-windows10.0.19041.0` (เครื่อง dev ยังไม่มี .NET 10) |
| Electron | 43.x |
| Source → Target | English → Thai |
| **pixel ไม่ข้าม IPC** | sidecar ส่งได้เฉพาะ text + bbox ยกเว้น `debugFrame` ที่ปิดเป็น default |
| **Text grouping อยู่ฝั่ง Node** | sidecar ทำแค่ capture + diff + OCR |
| **Coordinate conversion จุดเดียว** | physical px → logical px screen-global → CSS px |
| **ไม่มีความล้มเหลวที่เงียบ** | ทุก error path ต้องมีทางให้ผู้ใช้รู้ |
| Latency budget | capture+diff ~15ms · OCR ~40-80ms · translate ~300-500ms · render ~16ms · รวม ~1s |
| License | Apache-2.0 — ห้ามคัดโค้ดจาก reference ที่เป็น AGPL-3.0 |

## Milestones

| M | ชื่อ | ได้อะไรเมื่อจบ |
|---|---|---|
| M1 | Walking skeleton | แอปเปิดได้ sidecar spawn ได้ คุยกันได้ overlay โปร่งใสขึ้นจอ |
| M2 | Pixel side (sidecar) | รัน sidecar เดี่ยวๆ แล้วได้ JSON ข้อความ + bbox จากหน้าจอจริง |
| M3 | Text side (Node) | รับ frame → แปลงพิกัด → จัดกลุ่ม → กรอง → dedup ทดสอบได้ด้วย fixture |
| M4 | Translation | แปลเป็นไทยได้ มี cache, fallback, backoff |
| M5 | Overlay rendering | **เห็นคำแปลบนจอจริง — E2E ครบเส้น** |
| M6 | Region & monitor | เลือกจอและลากกรอบเองได้ จำได้ข้ามการเปิดปิด |
| M7 | Control surface | hotkey + tray + โหมด auto/snapshot/pause |
| M8 | Anti-flicker | subtitle เปลี่ยนแล้วไม่กระพริบ |
| M9 | Config & settings | เปลี่ยนค่าใน UI มีผลทันที |
| M10 | Robustness | sidecar ตายแล้วฟื้น error ถึงผู้ใช้ log ใช้ debug ได้ |

---

<!-- ISSUE -->
title: M1-01 Scaffold Electron + TypeScript build pipeline
milestone: M1 Walking skeleton
labels: setup, electron
depends:

## Context

Repo ยังไม่มีโค้ดเลย งานนี้วาง build pipeline ให้ทุก issue ถัดไปต่อยอดได้ ตาม repo layout ในหัวข้อ 9 ของ design doc

## Scope

- `package.json`, `tsconfig.json` (main/preload), `tsconfig.renderer.json`
- โครงโฟลเดอร์ `src/main/`, `src/preload/`, `src/renderer/`, `src/shared/`
- Electron entry point ที่เปิดหน้าต่างเปล่าได้
- vitest ตั้งค่าพร้อมรัน
- npm scripts: `build`, `dev`, `start`, `test`, `typecheck`

## Out of scope

- overlay window (→ M1-05)
- sidecar (→ M1-02)

## Acceptance criteria

- [ ] `npm run build` ผ่านโดยไม่มี TypeScript error
- [ ] `npm run dev` เปิดหน้าต่าง Electron ขึ้นมาได้
- [ ] `npm test` รันได้และผ่าน (มี test ตัวอย่างอย่างน้อย 1 ตัว)
- [ ] `npm run typecheck` ผ่าน strict mode
- [ ] `contextIsolation: true`, `nodeIntegration: false` ในทุก window

## Files

- Create: `package.json`, `tsconfig.json`, `tsconfig.renderer.json`, `vitest.config.ts`
- Create: `src/main/index.ts`, `src/shared/types.ts`
- Modify: `README.md` (เติมหัวข้อ Development ที่ยัง placeholder อยู่)

## Testing

smoke test ว่า build output มีไฟล์ครบ + typecheck ผ่าน

---

<!-- ISSUE -->
title: M1-02 Scaffold .NET sidecar project (Textlens.Capture)
milestone: M1 Walking skeleton
labels: setup, sidecar, dotnet
depends:

## Context

Sidecar เป็นเจ้าของ pixel pipeline ทั้งหมด (design doc หัวข้อ 2) งานนี้วางโครง project ให้ publish เป็น exe เดี่ยวได้

## Scope

- .NET console project `sidecar/Textlens.Capture/`
- TFM `net9.0-windows10.0.19041.0` (ดู Global Constraints — เครื่อง dev ยังไม่มี .NET 10)
- เปิด WinRT API access
- publish profile: self-contained, AOT, single file
- xunit test project

## Out of scope

- capture / OCR ของจริง (→ M2)

## Acceptance criteria

- [ ] `dotnet build` ผ่าน
- [ ] `dotnet publish -c Release` ได้ exe เดี่ยวขนาด < 20MB ที่รันบนเครื่องที่ไม่มี .NET runtime ได้
- [ ] exe รันแล้วพิมพ์ `{"ev":"ready","version":"..."}` ออก stdout แล้วรอ stdin
- [ ] `dotnet test` รันได้
- [ ] เรียก WinRT type ได้ (พิสูจน์ด้วย test ที่ resolve `Windows.Media.Ocr.OcrEngine`)

## Files

- Create: `sidecar/Textlens.Capture/Textlens.Capture.csproj`, `Program.cs`
- Create: `sidecar/Textlens.Capture.Tests/`
- Create: `sidecar/Textlens.sln`

## Testing

xunit: resolve WinRT type ได้ · publish output รันได้จริง (manual)

---

<!-- ISSUE -->
title: M1-03 Define IPC protocol schema (shared TS + C#)
milestone: M1 Walking skeleton
labels: protocol, sidecar, electron
depends: M1-01, M1-02

## Context

สัญญาระหว่าง Node กับ sidecar ตาม design doc หัวข้อ 3 ต้องนิยามครั้งเดียวแล้วสองฝั่งใช้ตรงกัน ผิดตรงนี้แล้วเจ็บทั้งโปรเจกต์

## Scope

Commands (Node → sidecar): `listMonitors`, `configure`, `start`, `stop`, `snapshot`, `debugFrame`
Events (sidecar → Node): `ready`, `frame`, `nochange`, `error`

`frame` ต้องมี `seq`, `timings{capture,diff,ocr}`, `monitor{id,scale,bounds}`, `region`, `lines[{text,bbox,conf}]`

- TypeScript types ใน `src/shared/protocol.ts`
- C# records ใน `sidecar/.../Protocol/`
- JSON serialization ทั้งสองฝั่งใช้ camelCase ตรงกัน

## Acceptance criteria

- [ ] ทุก command และ event มี type ทั้งฝั่ง TS และ C#
- [ ] `frame` event มี `scale` และ `monitor.bounds` เสมอ (บังคับใน type ไม่ใช่ optional) — ต้องมีเพื่อแปลงพิกัด
- [ ] round-trip test ฝั่ง C#: serialize → deserialize ได้ค่าเดิม
- [ ] มี golden JSON sample อย่างน้อย 1 ชุดต่อ event ที่ทั้งสองฝั่ง parse ผ่าน
- [ ] unknown event/command ไม่ทำให้ฝั่งใดฝั่งหนึ่ง crash — log แล้วข้าม

## Files

- Create: `src/shared/protocol.ts`
- Create: `sidecar/Textlens.Capture/Protocol/Commands.cs`, `Events.cs`
- Create: `tests/fixtures/protocol/*.json` (golden samples)

## Testing

vitest: parse golden JSON เข้า TS type ได้ · xunit: round-trip + parse golden เดียวกัน

---

<!-- ISSUE -->
title: M1-04 SidecarClient — spawn, JSON-lines codec, shutdown
milestone: M1 Walking skeleton
labels: electron, sidecar, ipc
depends: M1-03

## Context

ตัวกลางฝั่ง Node ที่คุยกับ sidecar เลือก stdio JSON lines เพราะ debug ได้ด้วยการรัน sidecar เดี่ยวแล้วพิมพ์คำสั่งใส่ stdin (design doc หัวข้อ 3)

## Scope

- spawn process, resolve path (dev ใช้ `TEXTLENS_SIDECAR_PATH`, prod ใช้ไฟล์ข้างแอป)
- encode command → stdout ของ Node, decode stdout ของ sidecar → event
- อ่านทีละบรรทัด รองรับ chunk ที่ขาดกลางบรรทัด
- typed event emitter
- shutdown ที่สะอาดตอน app quit

## Out of scope

- watchdog / restart (→ M10-01)

## Acceptance criteria

- [ ] spawn แล้วได้ `ready` event ภายใน 5 วินาที
- [ ] ส่ง command แล้ว sidecar ตอบกลับถูกต้อง
- [ ] บรรทัดที่มาไม่ครบใน chunk เดียวถูกประกอบกลับได้ถูกต้อง (มี test)
- [ ] บรรทัดที่ parse ไม่ได้ → log warn แล้วข้าม ไม่ crash
- [ ] app quit แล้ว sidecar process ตายตาม ไม่เหลือ orphan
- [ ] stderr ของ sidecar ถูก log แยกจาก stdout

## Files

- Create: `src/main/services/sidecar-client.ts`
- Test: `tests/main/sidecar-client.test.ts`

## Testing

vitest ด้วย fake child process: chunk แตกกลางบรรทัด · JSON เสีย · process ตายกะทันหัน

---

<!-- ISSUE -->
title: M1-05 Transparent click-through overlay window
milestone: M1 Walking skeleton
labels: electron, overlay
depends: M1-01

## Context

Feature U1 — หน้าต่างที่วาดทับจอโดยไม่ขวางการใช้งาน เป็นฐานของ M5 ทั้งหมด

## Scope

- BrowserWindow: `transparent`, `frame: false`, `alwaysOnTop`, `skipTaskbar`, `resizable: false`, `hasShadow: false`, `focusable: false`
- `setIgnoreMouseEvents(true, { forward: true })`
- ตั้ง always-on-top level ให้อยู่เหนือเกม fullscreen-windowed
- ปรับขนาดตามจอเมื่อ `display-metrics-changed`
- ใช้ `bounds` ไม่ใช่ `workArea` (ไม่งั้นเนื้อหาล่างจอโดน taskbar เบียด)

## Acceptance criteria

- [ ] overlay คลุมเต็มจอที่เลือก พื้นหลังโปร่งสนิท
- [ ] คลิกทะลุไปยังโปรแกรมข้างล่างได้ทุกจุด
- [ ] ไม่ขึ้นใน taskbar และไม่แย่ง focus จากเกม
- [ ] ยังอยู่บนสุดเมื่อเกมรันแบบ borderless fullscreen
- [ ] เปลี่ยนความละเอียดจอแล้ว overlay ปรับขนาดตาม
- [ ] วาดกล่องทดสอบสีทึบแล้วเห็นชัดบนพื้นหลังใดๆ

## Files

- Create: `src/main/services/window-manager.ts`
- Create: `src/renderer/overlay/index.html`, `overlay.css`, `overlay.ts`
- Create: `src/preload/index.ts`

## Testing

manual: ทดสอบทับเกม borderless จริง + ทดสอบคลิกทะลุ

---

<!-- ISSUE -->
title: M2-01 OCR preflight check — detect en-US recognizer
milestone: M2 Pixel side
labels: sidecar, ocr, P0-blocker
depends: M1-02

## Context

Feature O8 — พบใน [spike S1](../spikes/2026-08-15-s1-ocr-engine.md) ว่าเครื่องทดสอบมี recognizer แค่ `en-US` ตัวเดียว **ถ้าเครื่องผู้ใช้ไม่มี English language pack แอปใช้งานไม่ได้เลย** ต้องตรวจและบอกวิธีแก้ ไม่ใช่ล้มเงียบ

## Scope

- ตอน sidecar start เรียก `OcrEngine.AvailableRecognizerLanguages`
- ใส่รายการภาษาที่มีลงใน `ready` event
- ถ้าไม่มีภาษาต้นทางที่ต้องการ → ส่ง `error` code `OCR_LANGUAGE_MISSING` พร้อมข้อความบอกวิธีติดตั้ง

## Acceptance criteria

- [ ] `ready` event มี field `ocrLanguages: string[]`
- [ ] ไม่มี en-US → error code `OCR_LANGUAGE_MISSING` พร้อมคำแนะนำติดตั้ง (Settings → Time & Language → Language → English → Optional features → OCR)
- [ ] sidecar ไม่ crash เมื่อไม่มีภาษา — รายงานแล้วรออยู่ (ให้ผู้ใช้ติดตั้งแล้ว restart ได้)
- [ ] ฝั่ง Node แปลง error นี้เป็นข้อความที่ผู้ใช้อ่านรู้เรื่อง (เชื่อมกับ M10-02)

## Files

- Create: `sidecar/Textlens.Capture/Services/OcrPreflight.cs`
- Modify: `sidecar/Textlens.Capture/Program.cs`

## Testing

xunit: mock ผลลัพธ์ภาษาว่าง → ได้ error code ถูก · manual บนเครื่องจริง

---

<!-- ISSUE -->
title: M2-02 CaptureService — Windows Graphics Capture of a region
milestone: M2 Pixel side
labels: sidecar, capture
depends: M1-02

## Context

Feature C1 — จับเฉพาะ region ไม่ใช่ทั้งจอ [Spike S1](../spikes/2026-08-15-s1-ocr-engine.md) วัดได้ว่า region crop เร็วกว่าเต็มจอ 4 เท่าและแม่นกว่าด้วย

## Scope

- ใช้ Windows.Graphics.Capture จับจอที่ระบุ แล้ว crop เป็น region
- คืน frame เป็น BGRA buffer + ขนาด + scale factor ของจอนั้น
- enumerate จอ: id, bounds, scale factor (รองรับ `listMonitors`)
- reuse capture session ข้าม frame ไม่สร้างใหม่ทุกครั้ง

## Acceptance criteria

- [ ] จับ region ที่ระบุจากจอที่ระบุได้ถูกต้อง
- [ ] `listMonitors` คืนจอครบทุกตัวพร้อม bounds และ scale ที่ถูกต้อง
- [ ] จอที่ตั้ง scaling 125%/150% รายงาน scale factor ถูก
- [ ] จอที่อยู่ซ้ายของ primary (พิกัด x ติดลบ) จับได้ถูกต้อง
- [ ] capture + crop ใช้เวลา < 15ms (ตาม latency budget) — วัดแล้วรายงานใน `timings.capture`
- [ ] จับ 1000 เฟรมติดกันแล้ว memory ไม่โต (ไม่ leak texture)

## Files

- Create: `sidecar/Textlens.Capture/Services/CaptureService.cs`
- Create: `sidecar/Textlens.Capture/Services/MonitorEnumerator.cs`

## Testing

xunit สำหรับ crop math · manual สำหรับ capture จริง หลาย DPI หลายจอ

---

<!-- ISSUE -->
title: M2-03 ChangeDetector — 3-layer pixel diff
milestone: M2 Pixel side
labels: sidecar, performance
depends: M2-02

## Context

Feature C3 — ตัดงาน OCR ทิ้งเมื่อภาพไม่เปลี่ยน เป็นตัวที่ทำให้ auto mode ไม่กิน CPU

## Scope

3 ชั้นตาม design doc:
1. dimension เปลี่ยน → เปลี่ยนแน่นอน
2. byte-equal เทียบทั้ง buffer → เหมือนเป๊ะ = ไม่เปลี่ยน (fast path)
3. sampled pixel diff — สุ่มทุก N pixel, เทียบ RGB delta, early exit เมื่อเกิน threshold

## Acceptance criteria

- [ ] เฟรมเหมือนเดิมเป๊ะ → `false` และใช้เวลา < 2ms
- [ ] เฟรมต่างกันเยอะ → `true` และ early exit ไม่ scan จนจบ
- [ ] เปลี่ยนแค่ 1% ของ pixel (ต่ำกว่า threshold) → `false`
- [ ] ขนาด buffer ต่างกัน → `true` ทันทีไม่ scan
- [ ] threshold ปรับได้ผ่าน `configure` (ต้องใช้ค่าเข้มขึ้นตอน unlock — ดู M8)
- [ ] diff ใช้เวลารวมกับ capture < 15ms

## Files

- Create: `sidecar/Textlens.Capture/Services/ChangeDetector.cs`
- Test: `sidecar/Textlens.Capture.Tests/ChangeDetectorTests.cs`

## Testing

xunit ด้วย buffer สังเคราะห์: เหมือนเป๊ะ / ต่าง 0.5% / ต่าง 50% / ขนาดไม่เท่า / early exit ทำงานจริง

---

<!-- ISSUE -->
title: M2-04 OcrService — Windows.Media.Ocr to lines + bbox
milestone: M2 Pixel side
labels: sidecar, ocr
depends: M2-02, M2-01

## Context

Feature O1 — [Spike S1](../spikes/2026-08-15-s1-ocr-engine.md) ยืนยันแล้วว่า Windows.Media.Ocr เร็วกว่า PaddleOCR 6 เท่าและแม่นกว่าในเนื้อหาเกม

## Scope

- แปลง BGRA buffer → `SoftwareBitmap` → `OcrEngine.RecognizeAsync`
- คืนผลระดับ **บรรทัด** พร้อม bbox ที่รวมจาก word boxes และ confidence เฉลี่ย
- bbox เป็น **physical px อ้างอิงมุมซ้ายบนของ region**
- reuse `OcrEngine` instance ข้าม frame

## Out of scope

- text grouping — อยู่ฝั่ง Node ตาม architecture invariant (→ M3-02)
- noise filtering — ฝั่ง Node (→ M3-03)

## Acceptance criteria

- [ ] คืน `lines[]` ที่มี `text`, `bbox [x,y,w,h]`, `conf`
- [ ] bbox อ้างอิงมุมซ้ายบนของ region ไม่ใช่ของจอ
- [ ] OCR ใช้เวลา < 80ms บน region ขนาด ~1200×200 (spike วัดได้ 22-36ms)
- [ ] region ที่ไม่มีข้อความ → `lines: []` ไม่ error (spike วัดได้ 3ms)
- [ ] รัน 500 ครั้งติดกันแล้ว memory ไม่โต
- [ ] ไม่พยายามแก้ `o`↔`O` / `I`↔`1` ที่ OCR ทำผิดประจำ — spike สรุปว่าไม่กระทบความหมาย อย่าใส่ post-processing เดา

## Files

- Create: `sidecar/Textlens.Capture/Services/OcrService.cs`
- Test: `sidecar/Textlens.Capture.Tests/OcrServiceTests.cs`

## Testing

golden image: เก็บภาพ briefing/dialogue ไว้ในเครื่อง (ไม่ commit — มีลิขสิทธิ์) เทียบผลกับข้อความที่คาดหวัง

---

<!-- ISSUE -->
title: M2-05 AdaptiveTimer + capture loop
milestone: M2 Pixel side
labels: sidecar, performance
depends: M2-03, M2-04

## Context

Feature C2 — ปรับความถี่ตามความเคลื่อนไหวของจอ ประหยัด CPU ตอนเนื้อหานิ่ง

## Scope

- เปลี่ยนภาพ → interval active
- ไม่เปลี่ยนติดกัน 3 ครั้ง → interval idle
- ไม่เปลี่ยนติดกัน 10 ครั้ง → deep idle
- เปลี่ยนกะทันหันหลังนิ่งนาน → เร่งชั่วคราวแล้วกลับสู่ปกติเอง
- สร้าง timer ใหม่เฉพาะเมื่อ interval เปลี่ยนเกิน 200ms (กัน GC churn)
- `snapshot` command = จับ 1 ครั้งโดยข้าม change detection

## Acceptance criteria

- [ ] ภาพนิ่ง → interval ขยับขึ้นสู่ idle แล้ว deep idle ตามลำดับ
- [ ] ภาพเปลี่ยน → กลับสู่ active ทันที
- [ ] interval เปลี่ยนน้อยกว่า 200ms → ไม่สร้าง timer ใหม่
- [ ] `snapshot` คืน `frame` เสมอแม้ภาพไม่เปลี่ยน
- [ ] ไม่มีเปลี่ยนแปลง → ส่ง `nochange` (ไม่ใช่เงียบ) เพื่อให้ Node รู้ว่ายังมีชีวิต
- [ ] tick ซ้อนกันไม่ได้ — tick ก่อนยังไม่จบ tick ใหม่ถูกข้าม

## Files

- Create: `sidecar/Textlens.Capture/Services/AdaptiveTimer.cs`, `CaptureLoop.cs`
- Test: `sidecar/Textlens.Capture.Tests/AdaptiveTimerTests.cs`

## Testing

xunit ด้วย fake clock: ลำดับ change/no-change → interval ที่คาดหวัง · ทดสอบ tick ซ้อน

---

<!-- ISSUE -->
title: M2-06 Sidecar protocol wiring + timing metrics
milestone: M2 Pixel side
labels: sidecar, protocol, observability
depends: M2-05, M1-03

## Context

ต่อทุกชิ้นใน M2 เข้ากับ protocol ให้รัน sidecar เดี่ยวๆ แล้วใช้งานได้จริง — เป็นเงื่อนไขที่ทำให้ debug ง่ายตามที่ออกแบบไว้

## Scope

- อ่าน command จาก stdin ทีละบรรทัด เขียน event ออก stdout
- state machine: idle → configured → running → stopped
- ใส่ `timings{capture,diff,ocr}` ทุก `frame` (Feature L3)
- `debugFrame` คืน PNG base64 — **ปิดเป็น default ต้องเปิดผ่าน configure**

## Acceptance criteria

- [ ] รัน exe เดี่ยวๆ พิมพ์ `{"cmd":"configure",...}` แล้ว `{"cmd":"start"}` → ได้ `frame` ออกมาต่อเนื่อง
- [ ] `stop` แล้ว capture หยุดจริง (วัดจาก CPU)
- [ ] `configure` ระหว่างที่ running → ใช้ค่าใหม่โดยไม่ต้อง restart
- [ ] ทุก `frame` มี timings ครบสามค่า
- [ ] `debugFrame` ตอนไม่ได้เปิด → error ไม่ใช่ส่งภาพออกมา
- [ ] command ที่ไม่รู้จัก → `error` แล้วทำงานต่อ ไม่ตาย
- [ ] เขียน `docs/sidecar-protocol.md` พร้อมตัวอย่าง command ที่ copy ไปวางใน stdin ได้เลย

## Files

- Modify: `sidecar/Textlens.Capture/Program.cs`
- Create: `sidecar/Textlens.Capture/Protocol/Dispatcher.cs`
- Create: `docs/sidecar-protocol.md`

## Testing

xunit สำหรับ dispatcher · manual: รัน exe แล้วพิมพ์คำสั่งด้วยมือ

---

<!-- ISSUE -->
title: M3-01 Coordinate converter — physical to logical screen-global
milestone: M3 Text side
labels: electron, coordinates, correctness
depends: M1-03

## Context

Feature O6 — **จุดที่ reference พลาด** เขาเอาพิกัด physical px ไปใช้กับ CSS logical px ตรงๆ บนจอ scaling 100% ไม่มีปัญหา แต่ 125%/150% ตำแหน่งเพี้ยนทั้งหมด architecture invariant ข้อ 3 บังคับว่าการแปลงต้องมีที่เดียว

## Scope

ฟังก์ชันเดียวที่แปลง bbox จาก physical px (อ้างอิง region) → logical px (อ้างอิง virtual desktop)

```
logicalX = (regionX + bboxX) / scale + monitorBoundsX
```

- ห้ามมีการหาร/คูณ scale ที่อื่นในโค้ดเบสอีก

## Acceptance criteria

- [ ] scale 1.0 จอเดียว region ที่ (0,0) → พิกัดออกเท่าเดิม
- [ ] scale 1.5 → พิกัดถูกหารด้วย 1.5 ถูกต้อง
- [ ] scale 1.25 → ปัดเศษถูกต้อง ไม่มี off-by-one สะสม
- [ ] region ไม่ได้อยู่ที่ (0,0) → บวก offset ของ region ถูก
- [ ] จอรองที่อยู่ซ้ายของ primary (bounds.x ติดลบ) → พิกัดออกมาติดลบถูกต้อง
- [ ] จอสองตัว scale ต่างกัน (1.0 กับ 1.5) → แต่ละจอแปลงด้วย scale ของตัวเอง
- [ ] grep ทั้ง repo แล้วไม่มีการคำนวณ scale นอกไฟล์นี้

## Files

- Create: `src/main/utils/coordinates.ts`
- Test: `tests/main/coordinates.test.ts`

## Testing

vitest ครอบทุกเคสข้างบน — นี่คือไฟล์ที่ต้องมี test coverage สูงที่สุดในโปรเจกต์

---

<!-- ISSUE -->
title: M3-02 Text grouping — paragraph, column, sentence detection
milestone: M3 Text side
labels: electron, pipeline
depends: M3-01

## Context

Feature O5 — แปลทีละบรรทัดได้คำแปลที่ห่วย ต้องรวมเป็นย่อหน้าก่อนส่งไปแปล อยู่ฝั่ง Node ตาม architecture invariant ข้อ 2 เพื่อให้เปลี่ยน OCR engine ได้โดยไม่กระทบ

## Scope

- รวมบรรทัดที่ต่อเนื่องกันเป็น block
- ตัด block เมื่อช่องว่างแนวตั้งเกิน threshold (paragraph break)
- ตัด block เมื่ออยู่คนละคอลัมน์ (Y ซ้อนกันแต่ X ห่างกันมาก)
- คืน block ที่มี `lines[]`, `text` รวม, `bbox` ครอบ

## ตัวเลข threshold จาก spike S1

วัดจาก Helldivers 2 briefing จริง (gap ÷ line height):

| ความสัมพันธ์ | ratio |
|---|---|
| บรรทัดในย่อหน้าเดียวกัน | 0.08 |
| หัวข้อ → เนื้อความ | 0.92 |
| ข้ามย่อหน้า | 1.16 |

**ตั้ง default ที่ 0.4–0.5** — reference ใช้ 1.0 ซึ่งห่างจากจุดตัดจริงแค่ 16% และจะกลืนหัวข้อเข้ากับย่อหน้า

## Acceptance criteria

- [ ] บรรทัดชิดกัน (ratio 0.08) → รวมเป็น block เดียว
- [ ] ข้ามย่อหน้า (ratio 1.16) → แยก block
- [ ] หัวข้อกับเนื้อความ (ratio 0.92) → **แยก** block
- [ ] `MISSION` (x=187) กับ `40 MINUTES` (x=589) แถวเดียวกัน ห่าง 299px → แยกเป็นคนละ block
- [ ] threshold ปรับได้ผ่าน config
- [ ] block ที่มีหลายบรรทัด → `text` เชื่อมด้วยช่องว่าง, `bbox` ครอบทุกบรรทัด
- [ ] input ว่าง → `[]` ไม่ throw

## Files

- Create: `src/main/utils/text-grouping.ts`
- Test: `tests/main/text-grouping.test.ts`

## Testing

vitest ด้วย fixture จาก spike (12 บรรทัดของ Helldivers briefing พร้อม bbox จริง — อยู่ใน `spikes/s1-ocr/results/`)

---

<!-- ISSUE -->
title: M3-03 Noise filter — confidence, length, size, patterns
milestone: M3 Text side
labels: electron, pipeline
depends: M3-02

## Context

Feature O4 — OCR อ่านเจอขยะเสมอ (นาฬิกา ตัวเลข ไอคอน เศษ UI) ถ้าไม่กรองจะเปลืองโควต้าแปลและทำจอรก

## Scope

ตัดทิ้งเมื่อ:
- confidence ต่ำกว่า threshold
- ข้อความสั้นเกินไปหลังลอกอักขระพิเศษออก
- bbox แคบหรือเตี้ยเกินไป
- ตรง pattern ขยะ: เวลา (`12:34`), ตัวเลขล้วน, เปอร์เซ็นต์, สัญลักษณ์ล้วน

## Acceptance criteria

- [ ] conf ต่ำกว่า threshold → ตัด
- [ ] `"Ö"` (ไอคอนนาฬิกาที่ OCR อ่านเป็นตัวอักษร — เจอจริงใน spike) → ตัด
- [ ] `"12:34"`, `"85%"`, `"..."` → ตัด
- [ ] `"Get to the port and secure the evacuation"` → **ผ่าน**
- [ ] `"OK"` (สั้นแต่มีความหมาย) → ผ่าน หรือมีเหตุผลบันทึกไว้ว่าทำไมตัด
- [ ] ทุก threshold ปรับได้ผ่าน config
- [ ] filter ทำงานที่ระดับ block ไม่ใช่ระดับบรรทัด (บรรทัดขยะในย่อหน้าดีไม่ควรทำให้ทั้งย่อหน้าหาย)

## Files

- Create: `src/main/utils/noise-filter.ts`
- Test: `tests/main/noise-filter.test.ts`

## Testing

vitest: ตารางเคส pass/reject จากข้อความจริงที่ spike อ่านได้

---

<!-- ISSUE -->
title: M3-04 Feedback loop filters — Thai script + recent outputs
milestone: M3 Text side
labels: electron, pipeline, correctness
depends: M3-03

## Context

Features F2, F3 — overlay วาดคำแปลไทยใกล้ข้อความต้นฉบับ capture รอบถัดไปอาจอ่านคำแปลตัวเองแล้วแปลซ้ำวนไม่จบ

**F3 คือด่านจริง**: ข้อความต้นทางเป็นอังกฤษ อักษรไทย `U+0E00–0E7F` จึงไม่มีทางมาจากที่อื่นนอกจากคำแปลของเราเอง — แม่นเกือบ 100% ต่างจาก reference ที่เป้าหมายเป็นภาษาจีนซึ่งปนกับข้อความต้นทางได้

## Scope

- ตรวจสัดส่วนอักษรไทยในข้อความ เกิน threshold → ทิ้ง
- เก็บ set ของข้อความที่เพิ่งแสดง (ทั้งต้นฉบับและคำแปล) แล้วกรองที่ตรงกันออก
- จำกัดขนาด set ไม่ให้โตไม่จำกัด

## Acceptance criteria

- [ ] `"เจ้าต้องตามหากุญแจโบราณ"` → ทิ้ง
- [ ] `"You must find the ancient key"` → ผ่าน
- [ ] ข้อความปนไทย-อังกฤษที่มีไทยเกิน threshold → ทิ้ง
- [ ] ข้อความสั้นมาก (1-2 ตัวอักษร) ไม่ทำให้ ratio ตัดสินผิด
- [ ] ข้อความที่เพิ่ง emit ไปรอบก่อน → ถูกกรองด้วย F2
- [ ] set โตเกินเพดาน → ตัดตัวเก่าออก ไม่ leak
- [ ] เปิด auto mode ทิ้งไว้ 5 นาทีบนหน้าจอนิ่ง → ไม่มีการแปลซ้ำวน (manual)

## Files

- Create: `src/main/utils/thai-script-filter.ts`, `src/main/services/recent-outputs.ts`
- Test: `tests/main/thai-script-filter.test.ts`

## Testing

vitest: ข้อความไทยล้วน / อังกฤษล้วน / ปนกัน / สั้นมาก / มี emoji

---

<!-- ISSUE -->
title: M3-05 Dedup — fuzzy position match + time window
milestone: M3 Text side
labels: electron, pipeline
depends: M3-04

## Context

Feature A5 — OCR อ่านข้อความเดิมได้ไม่เหมือนกันเป๊ะทุกเฟรม ถ้า dedup ด้วยการเทียบตรงๆ จะแปลซ้ำไม่จบ

## Scope

- ชั้น 1: snap ตำแหน่งเข้า grid แล้วเทียบข้อความที่ตำแหน่งใกล้เคียงด้วย similarity (Levenshtein) + prefix match สำหรับกรณี OCR อ่านไม่ครบ
- ชั้น 2: time window — ข้อความเดิมไม่แปลซ้ำภายใน N วินาที
- normalize ข้อความก่อนเทียบ (ตัด punctuation/case/ช่องว่าง)

## Acceptance criteria

- [ ] `"Hello World"` แล้วเฟรมถัดมา `"Hello Wor"` ที่ตำแหน่งเดิม → ถือว่าซ้ำ ไม่แปลใหม่
- [ ] ข้อความเดิมย้ายไป 3px → ยังถือว่าซ้ำ
- [ ] ข้อความเดิมย้ายไปคนละที่ในจอ → ถือว่าใหม่
- [ ] ข้อความต่างกันจริงที่ตำแหน่งเดิม → ถือว่าใหม่
- [ ] ข้อความสั้นมากใช้การเทียบแบบตรงตัว ไม่ใช้ fuzzy (กัน false positive)
- [ ] ข้อความเดิมกลับมาหลัง time window หมด → แปลใหม่
- [ ] threshold ปรับได้ผ่าน config

## Files

- Create: `src/main/services/dedup.ts`
- Test: `tests/main/dedup.test.ts`

## Testing

vitest ด้วย fake clock สำหรับ time window

---

<!-- ISSUE -->
title: M3-06 Fake sidecar — record and replay protocol fixtures
milestone: M3 Text side
labels: testing, infra
depends: M1-04, M2-06

## Context

design doc หัวข้อ 8 — ทำให้ทดสอบ pipeline ฝั่ง Node ทั้งเส้นได้แบบ deterministic โดยไม่ต้องแตะ Windows API ทำให้ CI รันได้โดยไม่มีหน้าจอ และ reproduce บั๊กจาก session จริงได้ด้วยการเก็บ log

## Scope

- โหมดบันทึก: `SidecarClient` เขียน event ทุกตัวลงไฟล์ JSON-lines
- fake sidecar: สคริปต์ที่ replay ไฟล์นั้นออก stdout ตามจังหวะเวลาเดิม
- ใช้ `TEXTLENS_SIDECAR_PATH` ชี้มาที่ fake ได้เลย ไม่ต้องแก้โค้ด
- fixture ชุดแรกจากข้อมูลจริงของ spike S1

## Acceptance criteria

- [ ] ตั้ง env var แล้วแอปรันด้วย fake sidecar ได้โดยไม่แก้โค้ด
- [ ] replay รักษาลำดับและช่วงเวลาระหว่าง event
- [ ] มี fixture อย่างน้อย 3 ชุด: มีข้อความ / ไม่มีข้อความ / sidecar ส่ง error
- [ ] test ฝั่ง Node รันผ่านบนเครื่องที่ไม่มีจอ (CI)
- [ ] มีคำสั่งบันทึก session จริงเป็น fixture ใหม่ พร้อมเขียนวิธีไว้ใน README

## Files

- Create: `tests/fake-sidecar/index.mjs`
- Create: `tests/fixtures/sessions/*.jsonl`
- Modify: `src/main/services/sidecar-client.ts` (เพิ่มโหมดบันทึก)

## Testing

integration test ที่ใช้ fake sidecar ขับ pipeline ตั้งแต่ frame ถึง overlay payload

---

<!-- ISSUE -->
title: M4-01 TranslationEngine interface + registry + fallback chain
milestone: M4 Translation
labels: electron, translation, architecture
depends: M1-01

## Context

Features T1, T6 — ต้องมีตั้งแต่วันแรกเพราะแผนคือเริ่มที่ Google แล้วเพิ่ม LM Studio/Ollama ทีหลัง ซึ่ง API คนละ shape กัน

## Scope

```ts
interface TranslationEngine {
  readonly name: string
  translateBatch(texts: string[], src: string, tgt: string): Promise<string[]>
  healthCheck(): Promise<{ ok: boolean; detail?: string }>
}
```

- registry ที่ลงทะเบียน engine ตามชื่อ
- fallback chain: primary ล้ม → fallback → ล้มหมดคืนข้อความต้นฉบับ
- engine ที่ล้มไม่ทำให้ engine อื่นพัง (state แยกกัน)

## Acceptance criteria

- [ ] primary สำเร็จ → ไม่เรียก fallback เลย
- [ ] primary throw → เรียก fallback แล้วคืนผลของ fallback
- [ ] ทุก engine ล้ม → คืน**ข้อความต้นฉบับ** ไม่ throw ไม่คืน array ว่าง
- [ ] engine คืนจำนวนผลไม่ตรงกับ input → ถือว่าล้ม ไป fallback (กันผลเหลื่อมแถว)
- [ ] engine ที่ไม่รู้จักใน config → error ที่อ่านรู้เรื่อง ไม่ crash ตอน start
- [ ] เพิ่ม engine ใหม่ต้องแก้แค่ไฟล์ใหม่ 1 ไฟล์ + ลงทะเบียน 1 บรรทัด

## Files

- Create: `src/main/services/translator/index.ts`, `types.ts`, `registry.ts`
- Test: `tests/main/translator/fallback.test.ts`

## Testing

vitest ด้วย fake engine ที่สั่งให้สำเร็จ/ล้ม/คืนจำนวนผิดได้

---

<!-- ISSUE -->
title: M4-02 Google Translate adapter with batch support
milestone: M4 Translation
labels: electron, translation
depends: M4-01

## Context

Feature T2, T7 — engine หลักถาวรเพราะ latency ต่ำสุด (budget 300-500ms) ใช้ endpoint ฟรีที่ไม่ต้อง API key

## Scope

- ยิงหลายข้อความใน request เดียว
- ใช้ network stack ของ Electron เพื่อให้เคารพ proxy ของระบบ
- parse response หลายรูปแบบที่ endpoint คืนมาได้
- ผลลัพธ์ต้องเรียงตรงกับ input เสมอ

## Acceptance criteria

- [ ] แปล 5 ข้อความใน 1 request แล้วได้ผล 5 อันเรียงตรงกัน
- [ ] จำนวนผลไม่ตรง input → throw (ให้ M4-01 จัดการ fallback) ไม่ใช่คืนผลเหลื่อม
- [ ] HTTP != 200 → throw พร้อม status code ในข้อความ (M4-03 ต้องอ่าน 429 ได้)
- [ ] response ที่ parse ไม่ได้ → throw ไม่ใช่คืนข้อความว่าง
- [ ] `healthCheck()` ยิงคำขอเล็กๆ แล้วรายงานผลจริง
- [ ] แปล `"You must find the ancient key"` แล้วได้ภาษาไทยที่อ่านรู้เรื่อง (manual)

## Files

- Create: `src/main/services/translator/engines/google.ts`
- Test: `tests/main/translator/google.test.ts`

## Testing

vitest ด้วย mock fetch: สำเร็จ / 429 / 500 / body พัง / จำนวนผลไม่ตรง

---

<!-- ISSUE -->
title: M4-03 Rate limiting + exponential backoff per engine
milestone: M4 Translation
labels: electron, translation, resilience
depends: M4-02

## Context

Feature T9 — endpoint ฟรีของ Google มีโอกาสโดน rate limit ที่ cadence ของ subtitle (นี่คือความเสี่ยง S3 ที่ยังไม่ได้ spike) reference มี backoff เพราะโดนมาแล้ว

## Scope

- ระยะห่างขั้นต่ำระหว่าง request
- เจอ 429 → backoff แบบ exponential มีเพดาน
- network error → backoff สั้นกว่า
- สำเร็จ → reset ตัวนับ
- state แยกต่อ engine

## Acceptance criteria

- [ ] request ติดกันเร็วเกิน → ตัวหลังรอจนครบระยะขั้นต่ำ
- [ ] 429 ครั้งแรก → backoff สั้น, ครั้งถัดๆ ไป → ยาวขึ้นแบบ exponential
- [ ] backoff ไม่เกินเพดานที่ตั้งไว้
- [ ] ระหว่าง backoff → คืนข้อความต้นฉบับทันที ไม่ค้างรอ (subtitle รอไม่ได้)
- [ ] สำเร็จ 1 ครั้ง → ตัวนับ reset
- [ ] engine A โดน backoff ไม่กระทบ engine B
- [ ] ระหว่าง backoff มีสัญญาณให้ผู้ใช้เห็น (เชื่อมกับ M10-02)

## Files

- Create: `src/main/services/translator/rate-limiter.ts`
- Test: `tests/main/translator/rate-limiter.test.ts`

## Testing

vitest ด้วย fake clock

---

<!-- ISSUE -->
title: M4-04 SQLite translation cache with normalized keys
milestone: M4 Translation
labels: electron, cache, performance
depends: M4-01

## Context

Features K1, K2 — cache hit = 0ms ซึ่งสำคัญมากกับ latency budget

**K2 คือ improvement ของเรา**: reference hash จากข้อความดิบ ทำให้ OCR อ่านเพี้ยนนิดเดียวก็ miss เรา hash จากข้อความที่ normalize แล้ว (ตัดช่องว่าง/punctuation/case) ได้ประโยชน์คล้าย fuzzy cache โดยไม่ต้องมี trigram ที่ reference เขียนแล้วต้องปิดทิ้ง

## Scope

- SQLite schema: key = hash(normalized) + srcLang + tgtLang + engine
- batch read / batch write ใน transaction เดียว
- TTL cleanup
- WAL mode

## Acceptance criteria

- [ ] เขียนแล้วอ่านคืนได้
- [ ] `"Hello World"` กับ `"hello world!"` → cache key เดียวกัน (K2)
- [ ] `"Hello  World"` (ช่องว่างซ้ำ) → key เดียวกัน
- [ ] batch อ่าน 50 ข้อความ = 1 query ไม่ใช่ 50 query
- [ ] target language ต่างกัน → คนละ entry
- [ ] engine ต่างกัน → คนละ entry (คุณภาพคำแปลไม่เท่ากัน)
- [ ] entry เก่าเกิน TTL ถูกลบตอน cleanup
- [ ] เขียน 10,000 entry แล้วอ่าน batch ยังเร็วกว่า 10ms
- [ ] ไฟล์ DB พังหรือเปิดไม่ได้ → แอปยังทำงานต่อได้แบบไม่มี cache + แจ้งผู้ใช้

## Files

- Create: `src/main/services/cache.ts`
- Test: `tests/main/cache.test.ts`

## Testing

vitest ด้วย in-memory SQLite

---

<!-- ISSUE -->
title: M4-05 Skip same-language + pipeline integration
milestone: M4 Translation
labels: electron, translation, pipeline
depends: M4-03, M4-04, M3-05

## Context

Feature T10 + ต่อ M3 เข้ากับ M4 ให้ครบเส้น text pipeline

## Scope

- ถ้าข้อความเป็นภาษาไทยอยู่แล้ว → ไม่ส่งไปแปล
- ต่อ: block → cache lookup → uncached ไปแปล → เขียน cache → ส่งออกเป็น overlay payload

## Acceptance criteria

- [ ] ข้อความไทยล้วน → ไม่เรียก engine เลย
- [ ] cache hit ทั้งหมด → ไม่เรียก engine เลย
- [ ] cache hit บางส่วน → เรียก engine เฉพาะตัวที่ miss
- [ ] คำแปลที่เหมือนต้นฉบับเป๊ะ → ไม่ส่งไป render (ไม่มีประโยชน์)
- [ ] ผลลัพธ์ผูกกับ bbox ของ block ต้นทางถูกต้อง ไม่สลับแถว
- [ ] pipeline ทั้งเส้นวัดเวลาแยกขั้นได้ (ต่อกับ M10-03)

## Files

- Create: `src/main/services/text-pipeline.ts`
- Test: `tests/main/text-pipeline.test.ts`

## Testing

integration test ด้วย fake sidecar (M3-06) + fake engine ตั้งแต่ frame ถึง overlay payload

---

<!-- ISSUE -->
title: M5-01 Block-level box rendering with node pool
milestone: M5 Overlay rendering
labels: renderer, overlay
depends: M1-05, M4-05

## Context

Features U6, U5 — **U6 คือ improvement สำคัญกับภาษาไทย**: reference หั่นคำแปลกลับไปวางรายบรรทัดด้วยการนับสัดส่วนตัวอักษรและตัดที่ `。！？，` ภาษาไทยไม่มีเครื่องหมายจบประโยคและไม่เว้นวรรคระหว่างคำ วิธีนั้นจะตัดกลางคำแน่นอน

**เราไม่หั่นเลย — 1 block = 1 กล่อง**

## Scope

- pre-create DOM node pool ไม่สร้าง/ทำลายทุกเฟรม
- 1 text block = 1 กล่อง วางใต้ bbox ต้นฉบับ
- ใช้ `transform: translate()` ไม่ใช่ `left`/`top` (GPU)
- throttle การ render ด้วย `requestAnimationFrame`

## Acceptance criteria

- [ ] block ที่มี 3 บรรทัดต้นฉบับ → กล่องคำแปล **1 กล่อง** ไม่ใช่ 3
- [ ] จำนวน block เกินขนาด pool → แสดงเท่าที่ pool มี ไม่ crash
- [ ] render 30 กล่องไม่ทำให้ frame drop
- [ ] เปลี่ยนแปลงหลายครั้งใน 1 frame → render ครั้งเดียว
- [ ] ไม่มีการสร้าง DOM node ใหม่หลัง init (ตรวจด้วยการนับ children)
- [ ] กล่องใช้ `transform` ในการวางตำแหน่ง (ตรวจใน test)

## Files

- Modify: `src/renderer/overlay/overlay.ts`
- Create: `src/renderer/overlay/node-pool.ts`
- Test: `tests/renderer/node-pool.test.ts`

## Testing

vitest + jsdom สำหรับ pool logic · manual สำหรับผลบนจอ

---

<!-- ISSUE -->
title: M5-02 Thai typography — font, line-height, line breaking
milestone: M5 Overlay rendering
labels: renderer, thai, P0-blocker
depends: M5-01

## Context

Features H1, H2, H3, H5 — เหตุผลหลักที่เลือก Electron คือ Chromium มี ICU Thai line breaking ในตัว งานนี้คือการใช้ประโยชน์จากมันให้ถูก

ภาษาไทยไม่เว้นวรรคระหว่างคำ และมีสระบน + วรรณยุกต์ + สระล่างซ้อนกันได้ 3 ชั้น

## Scope

- bundle Noto Sans Thai หรือ Sarabun ไม่พึ่ง font ระบบ
- `lang="th"` บน element ที่มีคำแปล → Chromium ตัดคำไทยเอง
- `line-height >= 1.6`
- `word-break: normal` (ห้าม `break-all` จะตัดกลางคำ)
- **ไม่แปลง punctuation เป็น full-width** (H5 — นั่นเป็น logic ภาษาจีนของ reference)

## Acceptance criteria

- [ ] font ถูก bundle ไปกับแอป แสดงผลถูกบนเครื่องที่ไม่มี font ไทยติดตั้ง
- [ ] ข้อความไทยยาวขึ้นบรรทัดใหม่โดย**ไม่ตัดกลางคำ**
- [ ] คำที่มีสระบน+วรรณยุกต์+สระล่าง เช่น `ปุ่ม`, `ที่`, `หนึ่ง` แสดงครบไม่โดนตัดบนล่าง
- [ ] เครื่องหมาย `,` `.` `?` `!` แสดงเป็นแบบปกติ ไม่ใช่ full-width
- [ ] ตัวอักษรอังกฤษปนในข้อความไทยแสดงถูกต้อง ไม่เปลี่ยน font กลางคำจนอ่านยาก
- [ ] เทียบ screenshot กับข้อความอ้างอิงแล้วอ่านออกครบ (manual)

## Files

- Create: `src/renderer/overlay/fonts/` (ไฟล์ font + license)
- Modify: `src/renderer/overlay/overlay.css`
- Test: `tests/renderer/thai-typography.test.ts`

## Testing

vitest + jsdom ตรวจ attribute/CSS ที่ตั้ง · manual ตรวจการแสดงผลจริงด้วยข้อความไทยที่มีสระซ้อน

---

<!-- ISSUE -->
title: M5-03 Two-pass layout — measure then place
milestone: M5 Overlay rendering
labels: renderer, overlay
depends: M5-02

## Context

Feature U7 — reference **เดา**ความสูงกล่องจากจำนวนตัวอักษรหารด้วยความกว้าง ซึ่งผิดสำหรับภาษาไทยเป็นพิเศษเพราะความกว้างตัวอักษรไม่สม่ำเสมอและการตัดคำคาดเดาไม่ได้ เดาผิด → กล่องทับกัน

## Scope

- pass 1: ใส่ข้อความลงกล่อง วางแบบ `visibility: hidden` แล้ววัดความสูงจริงจาก DOM
- pass 2: เอาความสูงจริงไปคำนวณตำแหน่ง แล้วค่อยแสดง
- ทั้งสอง pass อยู่ใน frame เดียว ผู้ใช้ต้องไม่เห็นการกระตุก

## Acceptance criteria

- [ ] ความสูงที่ใช้คำนวณ = ความสูงจริงที่ render ออกมา
- [ ] ข้อความไทยยาวที่ขึ้น 3 บรรทัด → คำนวณด้วยความสูง 3 บรรทัดจริง
- [ ] ผู้ใช้ไม่เห็นกล่องกระพริบระหว่าง 2 pass
- [ ] layout reflow ไม่เกิน 1 ครั้งต่อ render (วัดด้วย performance mark)
- [ ] กล่อง 30 อันยังจบใน budget 16ms

## Files

- Create: `src/renderer/overlay/layout.ts`
- Test: `tests/renderer/layout.test.ts`

## Testing

vitest + jsdom ด้วย mock `getBoundingClientRect` · manual ตรวจการกระพริบ

---

<!-- ISSUE -->
title: M5-04 Anti-overlap placement with spatial hash
milestone: M5 Overlay rendering
labels: renderer, overlay
depends: M5-03

## Context

Feature U3 — กล่องคำแปลลอยตาม bbox หลายกล่องพร้อมกัน ถ้าไม่จัดการจะทับกันจนอ่านไม่ออก

## Scope

- ลองตำแหน่งตามลำดับ: ใต้ข้อความ → ขวา → บน → ดันลงทีละน้อย
- จำกัดระยะเลื่อนจากตำแหน่งต้นฉบับ (เลื่อนไกลไปจะไม่รู้ว่าคู่กับประโยคไหน — ขัดกับเจตนาที่จะเทียบต้นฉบับกับคำแปล)
- spatial hash ให้ collision detection เป็น O(n) ไม่ใช่ O(n²)
- หาที่ไม่ได้ → ข้ามกล่องนั้น ไม่วางทับ

## Acceptance criteria

- [ ] 2 กล่องที่จะทับกัน → กล่องที่สองถูกย้าย
- [ ] กล่องที่ย้ายแล้วยังอยู่ใกล้ต้นฉบับพอที่จะรู้ว่าคู่กัน (ภายในระยะที่กำหนด)
- [ ] กล่องที่ไม่มีที่วาง → ถูกข้าม ไม่วางทับกล่องอื่น
- [ ] กล่องไม่หลุดขอบจอทั้ง 4 ด้าน
- [ ] 30 กล่องคำนวณเสร็จใน < 5ms
- [ ] ผลลัพธ์ deterministic — input เดิมให้ตำแหน่งเดิมเสมอ (จำเป็นสำหรับ sticky placement ใน M8)

## Files

- Create: `src/renderer/overlay/placement.ts`, `spatial-hash.ts`
- Test: `tests/renderer/placement.test.ts`

## Testing

vitest: ชุด bbox ที่ทับกัน / ชิดขอบจอ / หนาแน่นมาก + benchmark 30 กล่อง

---

<!-- ISSUE -->
title: M5-05 Screen area budget + priority ordering
milestone: M5 Overlay rendering
labels: renderer, overlay
depends: M5-04

## Context

Feature U4 — ถ้าแปลทุกอย่างที่ OCR เจอ จอจะเละจนเล่นเกมไม่ได้ ต้องเลือกแสดงเฉพาะที่สำคัญ

## Scope

- จำกัดพื้นที่รวมของ overlay เป็นสัดส่วนของจอ
- เรียงความสำคัญด้วย area × confidence (ข้อความใหญ่และมั่นใจสูงมาก่อน)
- เกินโควตา → ตัดตัวท้ายทิ้ง
- เรียงลำดับการวางจากบนลงล่างเพื่อให้ผลคงที่

## Acceptance criteria

- [ ] พื้นที่รวมไม่เกินสัดส่วนที่ตั้งไว้
- [ ] ข้อความใหญ่ conf สูง ถูกเลือกก่อนข้อความเล็ก conf ต่ำ
- [ ] จำนวนน้อยกว่าโควตา → แสดงทั้งหมด
- [ ] โควตาปรับได้ผ่าน config
- [ ] มีการตัดทิ้ง → log ว่าตัดไปกี่อัน (ห้ามตัดเงียบ)
- [ ] ลำดับการวางไม่เปลี่ยนไปมาระหว่างเฟรมเมื่อ input เหมือนเดิม

## Files

- Modify: `src/renderer/overlay/placement.ts`
- Test: `tests/renderer/area-budget.test.ts`

## Testing

vitest: จำนวนเกิน/ไม่เกินโควตา · ตรวจลำดับความสำคัญ

---

<!-- ISSUE -->
title: M6-01 Monitor enumeration + picker UI
milestone: M6 Region and monitor
labels: electron, region
depends: M2-06, M3-01

## Context

Feature R6 — reference มี `getMonitorList()` แต่ไม่เคยทำ UI ให้เลือก จอที่ scale ต่างกันคือแหล่งบั๊กพิกัดที่ใหญ่ที่สุด

## Scope

- ขอรายการจอจาก sidecar (`listMonitors`)
- UI ให้เลือกจอ แสดงชื่อ ความละเอียด scale และตัวไหนคือ primary
- เลือกจอแล้ว overlay ย้ายไปจอนั้น
- จำค่าที่เลือก

## Acceptance criteria

- [ ] แสดงจอครบทุกตัวพร้อม resolution และ scale
- [ ] เลือกจอที่สอง → overlay ย้ายไปจอนั้นและวางพิกัดถูก
- [ ] จอที่ scale 150% → คำแปลวางตรงตำแหน่งข้อความจริง (ทดสอบด้วยตาบนจอจริง)
- [ ] เสียบ/ถอดจอระหว่างใช้งาน → รายการอัปเดต ไม่ crash
- [ ] จอที่จำไว้หายไป → fallback ไป primary + แจ้งผู้ใช้
- [ ] จอที่อยู่ซ้ายของ primary (x ติดลบ) ทำงานถูกต้อง

## Files

- Create: `src/main/services/monitor-service.ts`
- Modify: `src/renderer/settings/`
- Test: `tests/main/monitor-service.test.ts`

## Testing

vitest ด้วย mock monitor list · manual บนจอจริงหลายตัวที่ scale ต่างกัน

---

<!-- ISSUE -->
title: M6-02 Region picker — crosshair drag selection
milestone: M6 Region and monitor
labels: electron, renderer, region
depends: M6-01

## Context

Feature R1 — **reference โฆษณาว่ามีแต่ไม่มีจริง** เขาจับเต็มจอทุกครั้ง [Spike S1](../spikes/2026-08-15-s1-ocr-engine.md) วัดได้ว่า region crop เร็วกว่า 4 เท่าและแม่นกว่าด้วย นี่คือข้อได้เปรียบหลักของเรา

## Scope

- หน้าต่างคลุมจอที่เลือก พื้นหลังมืดโปร่ง + crosshair
- ลากเลือกกรอบ แสดงขนาดเป็น px ระหว่างลาก
- Enter/ปล่อยเมาส์ = ยืนยัน, Esc = ยกเลิก
- แปลงพิกัดที่เลือก (CSS px) → physical px ส่งให้ sidecar ผ่าน converter ตัวเดียวกัน (M3-01)

## Acceptance criteria

- [ ] ลากเลือกกรอบได้ เห็นขนาดระหว่างลาก
- [ ] Esc ยกเลิกแล้วกลับไปใช้กรอบเดิม
- [ ] กรอบที่เลือกบนจอ scale 150% → sidecar จับพื้นที่ตรงกับที่เห็นเป๊ะ
- [ ] ลากกลับทิศ (ขวาไปซ้าย / ล่างขึ้นบน) → ได้กรอบถูกต้อง
- [ ] กรอบเล็กกว่าขนาดต่ำสุด → ปฏิเสธพร้อมบอกเหตุผล
- [ ] เลือกเสร็จ → capture เริ่มใช้กรอบใหม่ทันทีโดยไม่ต้อง restart

## Files

- Create: `src/renderer/region-picker/index.html`, `region-picker.ts`, `region-picker.css`
- Modify: `src/main/services/window-manager.ts`

## Testing

vitest สำหรับ drag math (รวมลากกลับทิศ) · manual บนหลาย DPI

---

<!-- ISSUE -->
title: M6-03 Region padding + edge warning
milestone: M6 Region and monitor
labels: electron, region, ocr
depends: M6-02

## Context

Feature R7 — **ค้นพบจาก [spike S1](../spikes/2026-08-15-s1-ocr-engine.md)**: crop ที่กินขอบตัวอักษรทำให้ OCR พังทันที วัดได้จริงว่า `Logician` กลายเป็น `ogician`, `arithmetic` กลายเป็น `cithmetic`

## Scope

- เผื่อ margin รอบกรอบที่ผู้ใช้เลือกก่อนส่งให้ sidecar
- ตรวจว่ามี bbox ของข้อความแตะขอบ region ไหม → เตือนผู้ใช้ให้ขยายกรอบ
- margin ปรับได้ผ่าน config

## Acceptance criteria

- [ ] กรอบที่ส่งให้ sidecar กว้างกว่าที่ผู้ใช้ลากตาม margin ที่ตั้งไว้
- [ ] margin ไม่ทำให้กรอบล้นขอบจอ (clamp)
- [ ] มี bbox แตะขอบ region → แสดงคำเตือนที่ผู้ใช้เห็น
- [ ] ไม่มี bbox แตะขอบ → ไม่เตือน
- [ ] คำเตือนไม่ขึ้นรัวทุกเฟรม (throttle)
- [ ] regression test: crop ที่กินขอบ vs crop ที่มี margin → ยืนยันว่า margin ช่วยจริง

## Files

- Create: `src/main/services/region-guard.ts`
- Test: `tests/main/region-guard.test.ts`

## Testing

vitest: bbox แตะขอบ/ไม่แตะ, clamp ที่ขอบจอ · ใช้ harness `spikes/s1-ocr/crop-test.ps1` ยืนยันผล OCR จริง

---

<!-- ISSUE -->
title: M6-04 Region persistence bound to monitor
milestone: M6 Region and monitor
labels: electron, region, config
depends: M6-03, M9-01

## Context

Feature R2 — กรอบต้องผูกกับจอ ไม่งั้นเปลี่ยน setup จอแล้วกรอบไปโผล่ผิดที่

## Scope

- เก็บ region คู่กับ monitor id และ resolution ตอนที่เลือก
- ตอนโหลด: จอเดิมยังอยู่และความละเอียดเท่าเดิม → ใช้เลย
- จอหายหรือความละเอียดเปลี่ยน → ไม่ใช้ค่าเก่ามั่ว แจ้งให้เลือกใหม่

## Acceptance criteria

- [ ] เลือกกรอบ ปิดแอป เปิดใหม่ → กรอบเดิมยังอยู่
- [ ] จอที่ผูกไว้หายไป → แจ้งผู้ใช้ให้เลือกใหม่ ไม่ใช้ค่าเก่าเงียบๆ
- [ ] ความละเอียดจอเปลี่ยน → แจ้งเตือนว่ากรอบอาจไม่ตรงแล้ว
- [ ] ค่าที่เก็บไว้เสียหาย → ใช้ default + log ไม่ crash
- [ ] region ที่เก็บเป็น physical px พร้อม monitor id (ไม่ใช่ CSS px ที่ความหมายเปลี่ยนตาม DPI)

## Files

- Modify: `src/main/services/config.ts`, `region-guard.ts`
- Test: `tests/main/region-persistence.test.ts`

## Testing

vitest: จอหาย / resolution เปลี่ยน / ข้อมูลเสีย

---

<!-- ISSUE -->
title: M7-01 Global hotkeys
milestone: M7 Control surface
labels: electron, hotkey
depends: M1-01

## Context

Feature G1 — **reference ไม่มี hotkey เลย** (grep `globalShortcut` = 0 hits) ทั้งที่เป็นโปรแกรมที่ต้องใช้ตอนเล่นเกม fullscreen ที่สลับหน้าต่างไม่ได้

## Scope

hotkey เริ่มต้น 4 ตัว: toggle auto mode · snapshot ครั้งเดียว · เลือก region ใหม่ · ซ่อน/แสดง overlay

- ลงทะเบียนตอน start, ปลดตอน quit
- ลงทะเบียนไม่สำเร็จ (ชนกับโปรแกรมอื่น) → แจ้งผู้ใช้ว่าตัวไหนชน

## Acceptance criteria

- [ ] hotkey ทั้ง 4 ทำงานขณะโฟกัสอยู่ที่โปรแกรมอื่น
- [ ] ทำงานขณะเกมรัน borderless fullscreen
- [ ] ลงทะเบียนไม่สำเร็จ → แจ้งผู้ใช้ระบุตัวที่ชน ไม่ล้มเงียบ
- [ ] quit แล้ว hotkey ถูกปลดหมด ไม่ค้างในระบบ
- [ ] กด hotkey รัวๆ ไม่ทำให้ state เพี้ยน
- [ ] เขียนรายการ hotkey ไว้ใน README

## Files

- Create: `src/main/services/hotkey-service.ts`
- Test: `tests/main/hotkey-service.test.ts`

## Testing

vitest ด้วย mock globalShortcut · manual ทดสอบทับเกมจริง

---

<!-- ISSUE -->
title: M7-02 System tray + context menu
milestone: M7 Control surface
labels: electron, ui
depends: M7-01

## Context

Feature G6 — แอปไม่มีหน้าต่างหลัก tray คือทางเข้าเดียวที่มองเห็นได้

## Scope

- tray icon + tooltip บอกสถานะปัจจุบัน
- คลิกซ้าย: ซ่อน/แสดง overlay
- คลิกขวา: Select Region, Snapshot, Auto on/off, Pause, Settings, Quit
- icon สะท้อนสถานะ (running / paused / error)

## Acceptance criteria

- [ ] tray icon ขึ้นตอนเปิดแอป
- [ ] ทุกเมนูทำงานตามชื่อ
- [ ] เมนู Auto แสดงสถานะเปิด/ปิดปัจจุบัน (checkbox)
- [ ] icon เปลี่ยนเมื่อสถานะเปลี่ยน รวมถึงตอน error
- [ ] icon โหลดไม่ได้ → log แล้วทำงานต่อ ไม่ crash (reference มีบั๊กนี้)
- [ ] Quit ปิด sidecar และปลด hotkey เรียบร้อย

## Files

- Create: `src/main/services/tray-service.ts`
- Create: `build/icons/`
- Test: `tests/main/tray-service.test.ts`

## Testing

vitest ด้วย mock Tray · manual

---

<!-- ISSUE -->
title: M7-03 Mode orchestration — auto, snapshot, pause
milestone: M7 Control surface
labels: electron, architecture
depends: M7-02, M4-05

## Context

Features G3, G4, G5 — reference มีแค่ซ่อน overlay ซึ่ง pipeline ยังวิ่งกิน CPU อยู่ข้างหลัง เราต้องมี pause จริง

## Scope

state machine กลาง: `idle` → `auto` → `paused` → `snapshot`

- auto: sidecar วน capture ตาม adaptive interval
- snapshot: จับครั้งเดียว แสดงค้างจนกด dismiss
- pause: หยุด sidecar จริง overlay ค้างไว้
- ซ่อน overlay ≠ pause (คนละอย่าง)

## Acceptance criteria

- [ ] auto → pause → sidecar หยุด capture จริง (CPU ลดลงวัดได้)
- [ ] pause → auto → กลับมาทำงานต่อ
- [ ] snapshot ระหว่าง auto → จับ 1 ครั้งแล้วกลับเข้า auto
- [ ] snapshot ระหว่าง pause → จับ 1 ครั้งแล้วอยู่ pause ต่อ
- [ ] ซ่อน overlay ระหว่าง auto → pipeline ยังทำงาน (แค่ไม่แสดง)
- [ ] เปลี่ยน mode รัวๆ ไม่ทำให้ state เพี้ยนหรือ sidecar สับสน
- [ ] mode ปัจจุบันสะท้อนที่ tray tooltip และ icon

## Files

- Create: `src/main/services/app-orchestrator.ts`
- Test: `tests/main/app-orchestrator.test.ts`

## Testing

vitest ครอบทุก state transition รวมการสลับรัว

---

<!-- ISSUE -->
title: M8-01 Anchor snapping + sticky placement
milestone: M8 Anti-flicker
labels: renderer, anti-flicker
depends: M5-04

## Context

Features A7, A8 — **improvement ของเรา** สาเหตุกระพริบอันดับหนึ่งของ per-bbox rendering คือกล่องขยับตาม OCR ที่สั่น ±2-3px ทุกเฟรมทั้งที่ภาพไม่เปลี่ยน reference แก้ปลายเหตุด้วยการหน่วงเวลา เราแก้ที่ตำแหน่ง

## Scope

- **Anchor snapping**: snap bbox เข้า grid ก่อนใช้เป็นตำแหน่ง
- **Sticky placement**: ข้อความคล้ายเดิมเกิน threshold → ใช้ตำแหน่งที่คำนวณไว้แล้ว ไม่คำนวณใหม่
- ล้าง sticky cache เมื่อ region เปลี่ยนหรือ unlock

## Acceptance criteria

- [ ] bbox ขยับ 3px → ตำแหน่งกล่องหลัง snap ไม่เปลี่ยน
- [ ] bbox ขยับ 50px → ตำแหน่งเปลี่ยนตาม
- [ ] ข้อความเดิม bbox สั่นเล็กน้อย 10 เฟรมติด → กล่องไม่ขยับเลยสักครั้ง
- [ ] ข้อความเปลี่ยนจริง → คำนวณตำแหน่งใหม่
- [ ] sticky cache ไม่โตไม่จำกัด
- [ ] เปลี่ยน region → cache ถูกล้าง
- [ ] grid size ปรับได้ผ่าน config

## Files

- Create: `src/renderer/overlay/anchor.ts`
- Test: `tests/renderer/anchor.test.ts`

## Testing

vitest: จำลอง bbox jitter ±3px ข้าม 10 เฟรม ตรวจว่าตำแหน่งคงที่

---

<!-- ISSUE -->
title: M8-02 Content stability tracking + dynamic suppress
milestone: M8 Anti-flicker
labels: electron, anti-flicker
depends: M3-05, M7-03

## Context

Features A1, A3 — Dynamic คือ lock mode ที่ใช้จริงกับ subtitle: ไม่ lock แต่ไม่ emit ซ้ำถ้าผลลัพธ์คล้ายเดิม OCR อ่านข้อความเดิมได้ไม่เหมือนกันทุกเฟรม ต้องเทียบแบบ fuzzy ไม่ใช่เทียบตรง

## Scope

- เทียบ set ของข้อความข้ามเฟรมแบบ fuzzy (Jaccard-like ที่นับ match แบบใกล้เคียง)
- similarity เกิน threshold ติดกัน N เฟรม → ถือว่านิ่ง
- ผลลัพธ์คล้ายของเดิม → ไม่ emit ไปยัง renderer

## Acceptance criteria

- [ ] ข้อความชุดเดิมที่ OCR อ่านเพี้ยนต่างกันเล็กน้อย → ยังถือว่านิ่ง
- [ ] ข้อความเปลี่ยนยกชุด (subtitle เปลี่ยนประโยค) → ไม่นิ่ง emit ใหม่
- [ ] ข้อความเปลี่ยนบางส่วน → ตัดสินตาม threshold ไม่ใช่ all-or-nothing
- [ ] threshold และจำนวนเฟรมปรับได้ผ่าน config
- [ ] reset ได้เมื่อเปลี่ยน region หรือ mode
- [ ] subtitle ที่เปลี่ยนทุก 2 วินาที → emit ทุกครั้งที่เปลี่ยนจริง ไม่ตกหล่น (ห้าม suppress มากเกินจนพลาดประโยค)

## Files

- Create: `src/main/services/stability-tracker.ts`
- Test: `tests/main/stability-tracker.test.ts`

## Testing

vitest ด้วยลำดับ frame ที่จำลอง OCR jitter · integration ด้วย fixture subtitle จาก fake sidecar

---

<!-- ISSUE -->
title: M8-03 Min display time, layout stability, crossfade
milestone: M8 Anti-flicker
labels: renderer, anti-flicker
depends: M8-01

## Context

Features A4, A6, A9 — ชั้นสุดท้ายที่ renderer **A9 crossfade เป็น improvement ของเรา**: reference ซ่อนแล้วแสดงใหม่ ซึ่งตาเห็นเป็นกระพริบ เปลี่ยนข้อความในกล่องเดิมด้วย opacity transition แทน

## Scope

- **Min display time**: กล่องต้องอยู่ครบเวลาขั้นต่ำก่อนถูกแทน
- **Layout stability**: ชุดตำแหน่งใหม่ซ้ำของเดิมเกิน threshold → ข้าม render
- **Crossfade**: เปลี่ยนข้อความในกล่องเดิมด้วย opacity transition

## Acceptance criteria

- [ ] คำแปลใหม่มาก่อนครบเวลาขั้นต่ำ → รอจนครบแล้วค่อยเปลี่ยน (ไม่ทิ้ง)
- [ ] ชุดตำแหน่งซ้ำเดิมเกิน threshold → ไม่ render ซ้ำ
- [ ] เปลี่ยนข้อความ → fade ไม่ใช่หายแล้วโผล่
- [ ] กล่องที่ไม่มีในเฟรมใหม่ → fade out ไม่ใช่หายทันที
- [ ] เวลาทั้งหมดปรับได้ผ่าน config
- [ ] **ทดสอบจริง**: เปิด auto mode กับวิดีโอที่มี subtitle 3 นาที แล้วดูว่าไม่มีการกระพริบที่รบกวนสายตา

## Files

- Modify: `src/renderer/overlay/overlay.ts`, `overlay.css`
- Create: `src/renderer/overlay/transitions.ts`
- Test: `tests/renderer/transitions.test.ts`

## Testing

vitest ด้วย fake timer · **manual กับวิดีโอ subtitle จริงคือ acceptance test ตัวจริงของ issue นี้**

---

<!-- ISSUE -->
title: M9-01 ConfigService — two-layer, schema validation, hot reload
milestone: M9 Config and settings
labels: electron, config
depends: M1-01

## Context

Features ST1, ST2, ST3 — **ST2 เป็น improvement**: reference เขียน validator ด้วย `if` ทีละ field ซึ่งตกหล่นง่าย ใช้ schema library แทน

config พังต้องไม่ทำให้แอปเปิดไม่ขึ้น

## Scope

- ชั้น 1: default ที่ติดมากับแอป (read-only)
- ชั้น 2: user override ใน userData (persist)
- deep merge ชั้น 2 ทับชั้น 1
- validate ด้วย schema ก่อน apply
- แจ้ง subscriber เมื่อค่าเปลี่ยน (hot reload)

## Acceptance criteria

- [ ] ไม่มีไฟล์ user config → ใช้ default ทั้งหมด ไม่ error
- [ ] user config มีบาง field → merge ทับเฉพาะ field นั้น ที่เหลือใช้ default
- [ ] ค่าไม่ผ่าน schema → **ไม่ apply ทั้งก้อน** คงค่าเดิม + แจ้งว่า field ไหนผิด
- [ ] ไฟล์ config เป็น JSON/YAML ที่ parse ไม่ได้ → ใช้ default + log + แจ้งผู้ใช้ ไม่ crash
- [ ] เปลี่ยนค่า → subscriber ได้รับแจ้งพร้อมค่าใหม่
- [ ] เปลี่ยนค่าแล้วเขียนลงดิสก์ อ่านกลับได้ค่าเดิม
- [ ] เขียนดิสก์ไม่ได้ (permission) → ค่ายังมีผลใน session + แจ้งผู้ใช้ว่าจะไม่ถูกจำ

## Files

- Create: `src/main/services/config.ts`, `src/shared/config-schema.ts`
- Test: `tests/main/config.test.ts`

## Testing

vitest: ไฟล์หาย / merge บางส่วน / ค่าผิด schema / ไฟล์พัง / เขียนไม่ได้

---

<!-- ISSUE -->
title: M9-02 Settings window UI
milestone: M9 Config and settings
labels: electron, renderer, ui
depends: M9-01, M6-01

## Context

Feature ST4 + PR1 — ทางเดียวที่ผู้ใช้ทั่วไปจะปรับค่าได้

**PR1 บังคับ**: ต้องบอกให้ชัดว่าใช้ Google = ข้อความบนหน้าจอถูกส่งออกนอกเครื่อง ผู้ใช้ต้องรู้ก่อนตัดสินใจ

## Scope

หมวดที่ต้องมี: Translation (engine, target lang) · Capture (monitor, region, mode) · Appearance (font size, opacity, display mode) · Hotkeys (แสดงค่าปัจจุบัน) · About/Privacy

- เปลี่ยนค่าแล้วมีผลทันที ไม่ต้อง restart
- แสดงสถานะ pipeline และ sidecar

## Acceptance criteria

- [ ] ทุกค่าใน P0 ปรับได้จาก UI
- [ ] เปลี่ยน font size / opacity → overlay เปลี่ยนทันทีโดยไม่ต้อง restart
- [ ] เปลี่ยน engine → คำแปลถัดไปใช้ engine ใหม่
- [ ] **มีข้อความชัดเจนว่าใช้ Google แปลว่าข้อความบนจอถูกส่งไปยัง Google** (PR1)
- [ ] แสดงสถานะ sidecar (running / stopped / error) แบบ real-time
- [ ] ค่าที่ไม่ผ่าน validation → แสดง error ที่ field นั้น ไม่ใช่ error รวมกำกวม
- [ ] ปิดหน้าต่าง settings แล้วเปิดใหม่ → ค่าที่บันทึกไว้แสดงถูกต้อง

## Files

- Create: `src/renderer/settings/index.html`, `settings.ts`, `settings.css`
- Create: `src/main/ipc-handlers.ts`
- Test: `tests/renderer/settings.test.ts`

## Testing

vitest + jsdom สำหรับ form logic · manual สำหรับ hot reload

---

<!-- ISSUE -->
title: M10-01 Sidecar supervision — watchdog and restart backoff
milestone: M10 Robustness
labels: electron, resilience
depends: M1-04, M7-03

## Context

design doc หัวข้อ 7 — sidecar เป็น process แยก มันตายได้ และถ้าตายเงียบผู้ใช้จะเห็นแค่ overlay ว่างเปล่าโดยไม่รู้สาเหตุ ซึ่งขัด architecture invariant ข้อ 4

## Scope

- ตรวจจับ process exit → restart แบบ backoff สูงสุด 3 ครั้งใน 60 วินาที
- เกินโควตา → หยุด restart แล้วรายงานผู้ใช้
- watchdog: ไม่มี event (`frame` หรือ `nochange`) เกิน N เท่าของ interval → kill แล้ว restart
- restart แล้วส่ง `configure` ค่าเดิมกลับไปให้อัตโนมัติ

## Acceptance criteria

- [ ] kill sidecar จากภายนอก → restart อัตโนมัติภายใน 5 วินาที และทำงานต่อด้วย config เดิม
- [ ] sidecar ตายซ้ำ 4 ครั้งใน 60 วินาที → หยุด restart + แจ้งผู้ใช้พร้อมเหตุผล
- [ ] sidecar ค้าง (ไม่ส่ง event) → watchdog kill แล้ว restart
- [ ] restart สำเร็จ 1 ครั้งแล้วอยู่รอดเกิน 60 วินาที → ตัวนับ reset
- [ ] ระหว่าง restart overlay ไม่หายวูบ (ค้างของเดิมไว้)
- [ ] pause อยู่แล้ว sidecar ตาย → ไม่ restart จนกว่าจะกลับเข้า auto

## Files

- Modify: `src/main/services/sidecar-client.ts`
- Create: `src/main/services/sidecar-supervisor.ts`
- Test: `tests/main/sidecar-supervisor.test.ts`

## Testing

vitest ด้วย fake process ที่สั่งให้ตาย/ค้างได้ + fake clock

---

<!-- ISSUE -->
title: M10-02 User-facing error surface
milestone: M10 Robustness
labels: electron, ux, resilience
depends: M10-01, M7-02

## Context

Feature L5 + architecture invariant ข้อ 4 — **reference เงียบเมื่อ engine ล่ม** ผู้ใช้เห็นแค่ overlay ว่างเปล่าแล้วไม่รู้ว่าเน็ตมีปัญหา engine ตาย หรือ OCR อ่านไม่เจอ

## Scope

รวม error ทุกทางมาที่เดียวแล้วแปลงเป็นข้อความที่ผู้ใช้เข้าใจ + ทางแก้:

| สาเหตุ | ข้อความ + ทางแก้ |
|---|---|
| ไม่มี en-US OCR recognizer | บอกวิธีติดตั้ง language pack (M2-01) |
| sidecar ตายเกินโควตา | บอกให้ดู log และวิธี restart |
| engine ล้มทั้งหมด | แยกว่าไม่มีเน็ต / โดน rate limit / config ผิด |
| กำลัง backoff | บอกว่ารอกี่วินาที |
| region ไม่ได้ตั้ง | ชวนให้เลือก region |

- แสดงที่ overlay (มุมจอ) + tray icon + settings
- error ที่หายเองได้ → ข้อความหายเองเมื่อกลับมาปกติ

## Acceptance criteria

- [ ] ทุก error ในตารางแสดงข้อความที่บอก**สาเหตุและทางแก้** ไม่ใช่ stack trace
- [ ] error ระดับ fatal (ไม่มี OCR) แสดงค้างจนกว่าจะแก้
- [ ] error ชั่วคราว (backoff) หายเองเมื่อกลับมาปกติ
- [ ] tray icon เปลี่ยนเป็นสถานะ error
- [ ] error หลายตัวพร้อมกัน → แสดงตัวที่ร้ายแรงที่สุด ไม่ซ้อนกันรก
- [ ] ข้อความ error ไม่บังพื้นที่อ่าน subtitle
- [ ] **ทดสอบ**: ถอดสาย LAN ระหว่าง auto mode → ผู้ใช้เห็นข้อความบอกภายใน 10 วินาที

## Files

- Create: `src/main/services/error-reporter.ts`
- Modify: `src/renderer/overlay/overlay.ts`, `src/main/services/tray-service.ts`
- Test: `tests/main/error-reporter.test.ts`

## Testing

vitest สำหรับการจัดลำดับความสำคัญ · manual: ถอดเน็ต / kill sidecar / ลบ region

---

<!-- ISSUE -->
title: M10-03 Logging with rotation + timing metrics
milestone: M10 Robustness
labels: electron, observability
depends: M1-01

## Context

Features L1, L3 — reference override `console.*` เองซึ่งไม่มี rotation (log โตไม่จำกัด) และ log ทุกบรรทัดที่ OCR อ่านได้ ซึ่งเป็นทั้งปัญหา privacy และ performance

**L3 จำเป็นเพราะเรามี latency budget เป็นตัวเลข** ถ้าวัดไม่ได้ก็ไม่รู้ว่าเกินตรงไหน

## Scope

- logging library ที่มี rotation และ level
- เก็บ timing แยกขั้น: capture, diff, ocr (จาก sidecar) + group, filter, dedup, cache, translate, render (ฝั่ง Node)
- สรุป p50/p90 ต่อขั้นเป็นระยะ
- **default ไม่ log เนื้อหาข้อความจริง** log เฉพาะ metrics (PR3)

## Acceptance criteria

- [ ] log เขียนลงไฟล์ใน userData
- [ ] ไฟล์โตเกินขนาดที่กำหนด → หมุนไฟล์ ไม่โตไม่จำกัด
- [ ] level ปรับได้ผ่าน config และ `LOG_LEVEL` env
- [ ] level `info` (default) → **ไม่มีข้อความบนหน้าจอผู้ใช้ปรากฏใน log**
- [ ] level `debug` → log ข้อความได้ พร้อมคำเตือนใน settings ว่าจะมีเนื้อหาหน้าจอ
- [ ] timing ครบทุกขั้นของ pipeline
- [ ] มีสรุป p50/p90 ที่อ่านได้ เทียบกับ budget ใน design doc
- [ ] logging ไม่บล็อก main thread (async/buffered)

## Files

- Create: `src/main/services/logger.ts`, `src/main/services/metrics.ts`
- Test: `tests/main/metrics.test.ts`

## Testing

vitest: rotation, level filtering, ตรวจว่า level info ไม่มีเนื้อหาข้อความหลุด

---

<!-- ISSUE -->
title: M10-04 Overlay content protection (exclude from capture)
milestone: M10 Robustness
labels: electron, overlay, correctness
depends: M1-05, M2-02

## Context

Feature F1 — ชั้นแรกของการกัน feedback loop ตั้ง flag ให้ overlay ถูกกันออกจาก screen capture

**ยังไม่ยืนยัน** — นี่คือความเสี่ยง S2 ที่ยังไม่ได้ spike reference ก็ไม่มั่นใจ (เขาเขียน comment ไว้เองว่าถ้าไม่ได้ผลให้พึ่ง layer 2)

ถ้าไม่ได้ผล ไม่ใช่หายนะ เพราะ F3 (Thai script filter) แม่นเกือบ 100% อยู่แล้ว

## Scope

- ตั้ง content protection บน overlay window
- ยืนยันด้วยการทดสอบจริงว่า capture ของ sidecar ไม่เห็น overlay
- ถ้าไม่ได้ผล → บันทึกไว้ใน design doc แล้วพึ่ง F2/F3

## Acceptance criteria

- [ ] overlay ตั้ง content protection เรียบร้อย
- [ ] **ทดสอบยืนยัน**: แสดงคำแปลไทยบน overlay ทับ region แล้วสั่ง `debugFrame` → ภาพที่ได้**ไม่มี**คำแปลไทย
- [ ] ถ้าเห็นคำแปลในภาพ → บันทึกผลจริงลง design doc หัวข้อ 6 พร้อมระบุว่า F3 คือด่านหลัก
- [ ] ผลการทดสอบเขียนเป็นรายงาน spike S2 ใน `docs/spikes/`
- [ ] เปิด auto mode ทิ้งไว้ 10 นาทีบนหน้าจอนิ่ง → จำนวนคำขอแปลไม่โตขึ้นเรื่อยๆ (พิสูจน์ว่าไม่มี feedback loop)

## Files

- Modify: `src/main/services/window-manager.ts`
- Create: `docs/spikes/2026-XX-XX-s2-content-protection.md`

## Testing

manual + `debugFrame` — นี่คือ acceptance test ตัวจริง

---

## Dependency graph (ระดับ milestone)

```
M1 Walking skeleton
 ├─→ M2 Pixel side ──┐
 └─→ M3 Text side ←──┘
        │
        ├─→ M4 Translation
        │      │
        │      └─→ M5 Overlay rendering  ← E2E ครบเส้นตรงนี้
        │             │
        │             ├─→ M6 Region and monitor
        │             ├─→ M8 Anti-flicker
        │             └─→ M10 Robustness
        │
        └─→ M7 Control surface
               │
               └─→ M9 Config and settings
```

**เส้นทางสั้นที่สุดสู่ของที่ใช้งานได้จริง**: M1 → M2 → M3 → M4 → M5 (22 issues)
หลังจากนั้นเห็นคำแปลบนจอได้แล้ว M6-M10 คือทำให้ใช้งานได้จริงในชีวิตประจำวัน

## P0 coverage map

ตรวจแล้วว่า P0 ทั้ง 44 features มี issue รองรับครบ

| Feature | Issue | Feature | Issue |
|---|---|---|---|
| R1 | M6-02 | A1 | M8-02 |
| R2 | M6-04 | A3 | M8-02 |
| R6 | M6-01 | A4 | M8-03 |
| R7 | M6-03 | A5 | M3-05 |
| C1 | M2-02 | A6 | M8-03 |
| C2 | M2-05 | A7 | M8-01 |
| C3 | M2-03 | A8 | M8-01 |
| G1 | M7-01 | A9 | M8-03 |
| G3 | M7-03 | F1 | M10-04 |
| G4 | M7-03 | F2 | M3-04 |
| G5 | M7-03 | F3 | M3-04 |
| G6 | M7-02 | U1 | M1-05 |
| O1 | M2-04 | U2 | M5-01 |
| O4 | M3-03 | U3 | M5-04 |
| O5 | M3-02 | U4 | M5-05 |
| O6 | M3-01 | U5 | M5-01 |
| O8 | M2-01 | U6 | M5-01 |
| T1 | M4-01 | U7 | M5-03 |
| T2 | M4-02 | H1 H2 H3 H5 | M5-02 |
| T6 | M4-01 | ST1 ST2 ST3 | M9-01 |
| T7 | M4-02 | ST4 | M9-02 |
| T9 | M4-03 | L1 | M10-03 |
| T10 | M4-05 | L3 | M2-06, M10-03 |
| K1 K2 | M4-04 | L5 | M10-02 |
| | | PR1 | M9-02 |

## หมายเหตุ

- ตัวเลข threshold ทุกตัวที่อ้างในนี้มาจาก [spike S1](../spikes/2026-08-15-s1-ocr-engine.md) ซึ่งวัดจากภาพจริง ไม่ใช่ค่าที่เดาหรือลอกจาก reference
- ความเสี่ยง S2 (content protection) และ S3 (Google rate limit) ยังไม่ได้ spike — S2 ฝังอยู่ใน M10-04 ส่วน S3 จะรู้ผลตอนทดสอบ M8-03 กับวิดีโอจริง
- ทุก issue ที่แตะพิกัดต้องใช้ converter จาก M3-01 เท่านั้น (architecture invariant ข้อ 3)
