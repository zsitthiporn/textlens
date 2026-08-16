# Textlens — Project Instructions

Real-time screen translation overlay: จับภาพพื้นที่บนจอ → OCR → แปลเป็นไทย → วาดคำแปลเป็นกล่องลอยใต้ข้อความต้นฉบับ

---

## อ่านก่อนเริ่มงาน

| ไฟล์ | เมื่อไหร่ |
|---|---|
| `docs/superpowers/specs/2026-08-15-textlens-design.md` | ก่อนแตะ architecture, IPC, หรือ component boundary ใดๆ |
| `docs/feature-spec.md` | ก่อนเพิ่ม/ตัด feature หรือถามว่าอะไรอยู่ใน MVP |
| `docs/reference-analysis.md` | เมื่อสงสัยว่า "โปรเจกต์อื่นแก้ปัญหานี้ยังไง" |

ทั้งสามไฟล์เป็นผลจาก brainstorming ที่ผ่านการอนุมัติแล้ว **อย่าตัดสินใจขัดกับมันโดยไม่ถามก่อน**

---

## Architecture invariants

กฎที่ห้ามละเมิดโดยไม่คุยกันก่อน — ทุกข้อมีเหตุผลบันทึกไว้ใน design doc

1. **pixel ไม่ข้าม IPC** — sidecar (.NET) เป็นเจ้าของ capture → diff → OCR ทั้งหมด และส่งออกมาเฉพาะ text + bbox ข้อยกเว้นเดียวคือ `debugFrame` ที่ปิดเป็น default
2. **Text grouping อยู่ฝั่ง Node ไม่ใช่ sidecar** — เพื่อให้เปลี่ยน OCR engine ได้โดยกระทบไฟล์เดียว (มีความเสี่ยง S1 ค้างอยู่)
3. **Coordinate conversion มีที่เดียว** — physical px (sidecar) → logical px screen-global (Node) → CSS px (renderer) ทุกการแปลงผ่าน converter ตัวเดียวที่มี test ครอบ อย่าแปลงพิกัดกระจายตามที่ต่างๆ
4. **ไม่มีความล้มเหลวไหนที่เงียบ** — engine ล่ม / sidecar ตาย / config พัง ต้องมีทางให้ผู้ใช้รู้เสมอ
5. **Windows-only โดยตั้งใจ** — อย่าเพิ่มโค้ด cross-platform "เผื่อไว้" การเลือก Windows คือสิ่งที่ปลดล็อก WGC + Windows.Media.Ocr

---

## Latency budget

Use case หลักคือ subtitle ที่เปลี่ยนทุก 2-3 วินาที → pipeline ทั้งเส้นต้องจบใน ~1 วินาที

| ขั้น | เป้า |
|---|---|
| capture + diff | ~15ms |
| OCR | ~40-80ms |
| translate (cache miss) | ~300-500ms |
| render | ~16ms |

**ก่อนเพิ่มอะไรที่อยู่ใน hot path ให้คิดถึง budget นี้เสมอ** — งานที่ทำได้นอก hot path ให้ย้ายออกไป

---

## ภาษาไทย — ข้อควรระวัง

- ภาษาไทย**ไม่เว้นวรรคระหว่างคำ** → ห้ามหั่นข้อความด้วยการนับสัดส่วนตัวอักษรหรือ split ด้วย whitespace จะตัดกลางคำ ให้ Chromium ตัดบรรทัดเองผ่าน `lang="th"`
- สระบน + วรรณยุกต์ + สระล่างซ้อนกันได้ 3 ชั้น → `line-height` ต้อง ≥ 1.6 ไม่งั้นสระโดนตัด
- ห้ามแปลง punctuation เป็น full-width (นั่นเป็น logic ของภาษาจีนที่ reference ทำ) ไทยใช้ `,.?!` ปกติ
- Thai script range `U+0E00–0E7F` ใช้เป็นตัวกรอง feedback loop ได้แม่นเกือบ 100% เพราะไม่ปนกับข้อความต้นทางภาษาอังกฤษ

---

## License boundary

Reference project ที่ศึกษา (`D:\Project\OtherSource\Translation-Overlay`) เป็น **AGPL-3.0** ส่วน Textlens เป็น **Apache-2.0**

**แกะ feature และแนวคิดได้ ห้ามคัดลอกโค้ด** — ถ้าคัดโค้ดมา Textlens จะติด AGPL ไปด้วย
เวลาอ้างถึง reference ให้อธิบายว่า "เขาแก้ปัญหานี้ด้วยแนวคิดอะไร" แล้วเขียนขึ้นใหม่ ไม่ใช่ port ไฟล์มา

---

## สถานะปัจจุบัน

**Phase 0–4 เสร็จแล้ว (2026-08-16) — text pipeline ครบเส้นจนถึงคำแปล ยังไม่มีอะไรขึ้นจอ**

**26/47 issues ปิดแล้ว · 397 vitest + 210 xunit เขียว · ทุกอย่างอยู่บน main**

ที่ทำงานได้จริงแล้ว:
- sidecar รันเดี่ยวได้ — พิมพ์ `configure` แล้ว `start` ใส่ stdin ได้ `frame` ต่อเนื่อง (ดู [docs/sidecar-protocol.md](docs/sidecar-protocol.md))
- ฝั่ง Node: `TextPipeline` ต่อครบ frame → พิกัด → จัดกลุ่ม → กรอง noise/ไทย/feedback → dedup → cache → แปล → payload
- **ยังไม่มี renderer** — payload ถูกสร้างแล้วแต่ไม่มีอะไรวาดมันขึ้นจอ นั่นคือ Phase 5

**ลำดับงานที่ใช้คือหัวข้อ Execution order ใน [backlog](docs/backlog/mvp-issues.md)** ไม่ใช่การไล่ตามกลุ่ม M1→M10

### เหลืออะไร (21 issues)

| Phase | Issues | ได้อะไร |
|---|---|---|
| **5 · render** | #23 #24 #25 #26 | **เห็นคำแปลบนจอครั้งแรก** |
| **6 · control** | #32 #33 #34 | hotkey · tray · auto/snapshot/pause |
| **7 · region** | #38 #28 #29 #30 #31 | 🎯 **เลือกจอ+ลากกรอบเองได้ = ใช้งานจริงได้** |
| **8 · anti-flicker** | #35 #36 #37 | 🎯 **subtitle ไม่กระพริบ = use case หลักใช้ได้** |
| **9 · robustness** | #40 #41 | watchdog · error ถึงผู้ใช้ |
| **10 · ที่เหลือ** | #27 #39 #45 | area budget · settings UI · installer |
| **ค้าง** | #44 | spike S3 ยิงไม่ครบ (ดูด้านล่าง) |

### [#44](https://github.com/zsitthiporn/textlens/issues/44) spike S3 — ยิงไป 1055 requests แล้วหยุดกลางคัน

ข้อมูลอยู่ใน `spikes/s3-ratelimit/results/` แล้ว (commit `2604264`) **รันใหม่ไม่ต้องเริ่มจากศูนย์**

**0 failures แต่ p50 596ms / p95 1108ms — เกิน budget 300-500ms** และช้ากว่าที่ [#19](https://github.com/zsitthiporn/textlens/issues/19) วัดตอนยิง 6 ครั้ง (139-176ms) ราว 3-4 เท่า
รูปแบบนี้เหมือน **soft throttling** มากกว่าการตัดแบบแข็ง — "zero failures" กลบเรื่องนี้ไว้ **ยังไม่สรุปจนกว่าจะแยก cold-start และรู้ขนาด batch**

ถ้าสรุปว่าไม่ผ่าน → ต้องเปิดงาน **T3 (Google Cloud API key) และดันเป็น P0**

### สิ่งที่ตัดสินไปแล้วและห้ามย้อนโดยไม่คุย

- **`conf` ไม่มีและจะไม่มี** — `Windows.Media.Ocr` ไม่ส่ง confidence เลย ([#47](https://github.com/zsitthiporn/textlens/issues/47) ปิดแล้ว) O4/U4 ตัดเกณฑ์นั้นออก **ห้ามประดิษฐ์ค่าขึ้นมาแทน**
- **`monitor.bounds` บน wire เป็น physical px** — logical origin มาจาก Electron `Display` เท่านั้น (design doc §3)
- **capture loop เป็น interval-driven** ห้ามเปลี่ยนเป็น frame-driven (spike S2)
- **`degraded` ได้รับการยกเว้นจาก identical-suppression** ไม่งั้น engine ล่ม = จอว่าง (design doc §7)
- **endpoint ของ Google ต้องเป็น `translate_a/t?client=dict-chrome-ex`** — `translate_a/single?client=gtx` คืนผลไม่ตรงจำนวนแบบเงียบๆ

ข้อควรรู้จาก S1 ที่กระทบการเขียนโค้ด:
- ต้องมี **en-US OCR recognizer** ติดตั้งบนเครื่องผู้ใช้ ไม่งั้นใช้งานไม่ได้เลย → feature `O8` preflight check
- **region ที่ตัดโดนตัวอักษรทำให้ OCR พังทันที** → feature `R7` padding + edge warning
- ~~เครื่อง dev ยังไม่มี .NET 10~~ → **เครื่องนี้มี .NET 10 SDK แล้ว (10.0.111/303/400) sidecar target `net10.0-windows10.0.19041.0`** ตามที่ design doc §2 ตั้งใจไว้แต่แรก · NativeAOT + WinRT publish ผ่านแล้วจริง ได้ exe เดี่ยว 1.64MB
- ข้อผิดพลาดที่ Windows OCR ทำประจำ: `o`↔`O`, `I`↔`1`, ตกเลขลำดับ, ช่องว่างหายบางจุด — ไม่กระทบความหมาย ไม่ต้องพยายามแก้ที่ post-processing

ข้อควรรู้จาก S2 ที่กระทบการเขียนโค้ด:
- **overlay ที่ถูก exclude จาก capture ยังคงกระตุ้นการส่งเฟรมอยู่** — จอนิ่ง + overlay นิ่ง = 3 เฟรมใน 13.2 วิ แต่จอนิ่ง + **overlay ขยับ** = 120 เฟรมใน 2.6 วิ (~46fps) ทุกเฟรมเนื้อหาเหมือนกันเป๊ะ
  → **capture loop ต้องเป็น interval-driven เท่านั้น** ถ้าเป็น frame-driven พอ M5 ใส่ crossfade เข้ามา overlay ของเราเองจะขับ capture+diff ที่ 60fps ตลอดเวลาโดยไม่เจออะไร กินคอร์ทิ้งแบบเงียบๆ
  → `CaptureService.WaitForFrame` ยังอยู่แต่ production ไม่ใช้แล้ว (เหลือไว้ให้ `CaptureProbe`) **อย่าเอากลับมาต่อ**

---

## Toolchain — กับดักที่เสียเวลาไปแล้ว อย่าไปเสียซ้ำ

| เรื่อง | ต้องรู้ |
|---|---|
| **NativeAOT publish ล้มใน agent shell** | `NoDefaultCurrentDirectoryInExePath=1` ถูก set ที่ process scope (ไม่ใช่ User/Machine ไม่ใช่ profile — มาจาก process chain ของ terminal) มันทำให้ `VsDevCmd.bat` หา `vswhere.exe` ไม่เจอ แล้ว error text ถูก MSBuild splice เข้าไปใน `$(CppLinker)` โผล่เป็น `MSB3073 ... exited with code 123` ซึ่งไม่บอกอะไรเลย **แก้: เคลียร์ตัวแปรก่อน publish** หรือใส่ `C:\Program Files (x86)\Microsoft Visual Studio\Installer` ลง PATH — ไม่ใช่บั๊กของ csproj |
| **Node เวอร์ชัน** | ต้อง **≥ 22.12.0** — Electron 43 บังคับผ่าน `engines` เครื่องนี้ใช้ **22.22.3 ผ่าน nvm** (`nvm use 22.22.3`) ถ้าหล่นไป Node 20 จะได้ `EBADENGINE` และ `npm ci` จะพังทันทีบน CI ที่ตั้ง `engine-strict=true` |
| **⚠️ test กับ production รันคนละ runtime** | vitest รันโค้ด main process ด้วย **Node 22.22.3** แต่ของจริงรันใน **Electron 43.4.0 ที่ bundle Node 24.18.1** มาเอง (ยืนยันด้วย `process.versions.node`) → **`node:` API ที่ผ่าน test อาจไม่มีใน production หรือกลับกัน** เช่น `node:sqlite` เป็น experimental บน Node 22 แต่ไม่ใช่บน Node 24 ของ Electron · อะไรที่พึ่ง built-in module ใหม่ๆ ต้องยืนยันใน Electron จริง ไม่ใช่แค่ให้ vitest ผ่าน |
| **Node/npm ใน Git Bash** | `node -v` ล้มด้วย `stdin is not a tty` → รัน node/npm ผ่าน PowerShell |
| **WinRT interop จาก PowerShell** | ต้อง Windows PowerShell 5.1 เท่านั้น ไม่ใช่ pwsh 7 |
| **Electron binary** | Electron 43 ไม่มี postinstall — `npm install` **ไม่** โหลด binary มาให้ มันโหลดตอนเรียกครั้งแรก (~226MB) CI ควร warm ด้วย `npx install-electron` |
| **Electron ESM main + top-level await** | main entry ที่เป็น ESM แล้วมี top-level `await` จะ**ค้าง** — message loop ไม่เริ่มจนกว่า entry module จะ evaluate จบ |
| **bounds ของ BrowserWindow บนจอรอง** | ขนาดที่ส่งใน constructor **เชื่อไม่ได้บนจอที่ไม่ใช่ primary** — ขอ 1080×1920 บน `DISPLAY2` ได้กลับมา 1080×**1872** (เท่ากับ workArea พอดี) จอ primary ไม่เป็น → บั๊กแบบนี้หลุดไปได้ง่าย **ต้อง `setBounds` ซ้ำหลังสร้าง แล้วตรวจผล** |
| **winston ใช้ไม่ได้กับงานนี้** | วัดจริงแล้ว: File transport + `maxsize` เขียนได้ **0 byte** เมื่อ burst ใน tick เดียว (ข้อมูลหายหมด) · `winston-daily-rotate-file` ไม่เคารพ `maxFiles` เหลือ 28 ไฟล์ทั้งที่ขอ 3 → ใช้ `pino` + `pino-roll` แบบ direct destination stream (ไม่ใช่ `pino.transport()` เพราะ worker thread หา path ใน asar ไม่เจอ) |
| **TypeScript** | pin ไว้ที่ 5.9.3 · `latest` บน npm ตอนนี้คือ 7.0.2 (native port) — `npm i -D typescript` เปล่าๆ จะดึง TS 7 มาทั้งโปรเจกต์ |

## Commands

```bash
npm run build      # tsc (main+preload) + vite (renderer)
npm run typecheck  # ทั้งสาม tsconfig
npm test           # vitest
npm run dev        # build แล้วเปิด Electron
```

```bash
dotnet build sidecar/Textlens.sln
dotnet test sidecar/Textlens.sln
```
