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

**กำลังวางราง** — M1-01 (Electron + TS pipeline) และ M1-02 (.NET sidecar scaffold) เสร็จแล้ว
ยังไม่มี capture / OCR / แปล ของจริง · ลำดับงานที่ใช้อยู่คือหัวข้อ **Execution order** ใน [backlog](docs/backlog/mvp-issues.md)

**Spike S1 ผ่านแล้ว** ([รายงาน](docs/spikes/2026-08-15-s1-ocr-engine.md)) — Windows.Media.Ocr เร็วกว่า PaddleOCR ~6 เท่า
(p50 99ms เต็มจอ / 30ms บน region เทียบกับ 580ms) และอ่านเนื้อหาเกมแม่นกว่า → สถาปัตยกรรม .NET sidecar ยืนยันแล้ว

ขั้นถัดไป: **spike S2** ยืนยันว่า Windows Graphics Capture เคารพ exclude-from-capture จริง — ดูหัวข้อ 10 ของ design doc

ข้อควรรู้จาก S1 ที่กระทบการเขียนโค้ด:
- ต้องมี **en-US OCR recognizer** ติดตั้งบนเครื่องผู้ใช้ ไม่งั้นใช้งานไม่ได้เลย → feature `O8` preflight check
- **region ที่ตัดโดนตัวอักษรทำให้ OCR พังทันที** → feature `R7` padding + edge warning
- ~~เครื่อง dev ยังไม่มี .NET 10~~ → **เครื่องนี้มี .NET 10 SDK แล้ว (10.0.111/303/400) sidecar target `net10.0-windows10.0.19041.0`** ตามที่ design doc §2 ตั้งใจไว้แต่แรก · NativeAOT + WinRT publish ผ่านแล้วจริง ได้ exe เดี่ยว 1.64MB
- ข้อผิดพลาดที่ Windows OCR ทำประจำ: `o`↔`O`, `I`↔`1`, ตกเลขลำดับ, ช่องว่างหายบางจุด — ไม่กระทบความหมาย ไม่ต้องพยายามแก้ที่ post-processing

---

## Toolchain — กับดักที่เสียเวลาไปแล้ว อย่าไปเสียซ้ำ

| เรื่อง | ต้องรู้ |
|---|---|
| **NativeAOT publish ล้มใน agent shell** | `NoDefaultCurrentDirectoryInExePath=1` ถูก set ที่ process scope (ไม่ใช่ User/Machine ไม่ใช่ profile — มาจาก process chain ของ terminal) มันทำให้ `VsDevCmd.bat` หา `vswhere.exe` ไม่เจอ แล้ว error text ถูก MSBuild splice เข้าไปใน `$(CppLinker)` โผล่เป็น `MSB3073 ... exited with code 123` ซึ่งไม่บอกอะไรเลย **แก้: เคลียร์ตัวแปรก่อน publish** หรือใส่ `C:\Program Files (x86)\Microsoft Visual Studio\Installer` ลง PATH — ไม่ใช่บั๊กของ csproj |
| **Node เวอร์ชัน** | ต้อง **≥ 22.12.0** — Electron 43 บังคับผ่าน `engines` เครื่องนี้ใช้ **22.22.3 ผ่าน nvm** (`nvm use 22.22.3`) ถ้าหล่นไป Node 20 จะได้ `EBADENGINE` และ `npm ci` จะพังทันทีบน CI ที่ตั้ง `engine-strict=true` |
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
