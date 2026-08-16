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

| ขั้น | เป้า | วัดจริงแล้ว |
|---|---|---|
| capture + diff | ~15ms | 7.5–13.5ms ✅ |
| **OCR** | 40–80ms | 30ms บน region (S1) · 99ms @1920×1080 (S1, n=92) · **86.5ms @3440×1440 (n=130)** · ~305ms @3440×1440 (จอมีข้อความเยอะ, n น้อย) |
| translate (cache miss) | ~300-500ms | **485ms** (n=12 ยิงห่างๆ) · **897ms ขณะ pipeline ทำงานจริง** ⚠️ เกิน — และ ~408ms ในนั้นเป็นเวลาที่ Google ใช้คิด (transport floor แค่ 77ms) เราคุมไม่ได้ |
| render | ~16ms | ยังไม่ได้วัดแยก |

**⚠️ ตัวเลข OCR สามชุดขัดกันเอง และยังไม่มีใครแยกตัวแปรออก** — 86.5ms บน 3440×1440 **เร็วกว่า** 99ms บน 1920×1080 ทั้งที่พื้นที่มากกว่า 2.4 เท่า แปลว่า**พื้นที่ไม่ใช่ตัวขับหลัก** ตัวที่น่าจะใช่คือ**ปริมาณข้อความบนจอ** (ชุด 305ms วัดตอนจอมีข้อความ 54 ก้อน) แต่ยังพิสูจน์ไม่ได้ ทุกการวัดที่มีเปลี่ยนทั้งขนาดและเนื้อหาพร้อมกัน → [#49](https://github.com/zsitthiporn/textlens/issues/49)

**อย่าอ้าง budget โดยไม่บอกทั้งขนาดกรอบและปริมาณข้อความ** — การเทียบข้ามเงื่อนไขทำให้สรุปผิดมาแล้วสองครั้งใน session เดียว

**translate เกิน budget อย่างถาวร** — T3 (Google Cloud แบบเสียเงิน) ถูกตัดออกแล้ว ([#48](https://github.com/zsitthiporn/textlens/issues/48)) เราจะไม่เสียเงิน ดังนั้น**คันโยกที่เหลืออยู่ฝั่ง OCR กับ cache เท่านั้น** — การครอบ region ให้เล็กประหยัดได้ ~275ms ซึ่งมากกว่าที่ฝั่ง translate จะทำได้ทั้งหมด

**ก่อนเพิ่มอะไรที่อยู่ใน hot path ให้คิดถึง budget นี้เสมอ** — งานที่ทำได้นอก hot path ให้ย้ายออกไป

---

## ภาษาไทย — ข้อควรระวัง

- ภาษาไทย**ไม่เว้นวรรคระหว่างคำ** → ห้ามหั่นข้อความด้วยการนับสัดส่วนตัวอักษรหรือ split ด้วย whitespace จะตัดกลางคำ **ให้ Chromium ตัดเอง** — วัดแล้วมันตัดตรงขอบคำจริง (จุดตัด 5 จุดตรงกับ `Intl.Segmenter('th')` ทั้งหมด)
  - **⚠️ แต่ไม่ใช่เพราะ `lang="th"`** — วัดบน Electron 43: จุดตัดเหมือนกันเป๊ะทั้งตอนใส่ `lang="th"`, ใส่ `lang="en"`, และไม่ใส่เลย **Blink ตรวจ Thai script แล้วใช้ dictionary breaker เอง** ไม่ได้ดูจาก attribute
  - ยัง**ควรใส่ `lang="th"` ต่อไป** (font selection, shaping, accessibility และไม่มีต้นทุน) แต่**อย่าเชื่อว่ามันคือสิ่งที่ทำให้การตัดคำทำงาน** — คนที่ถอดมันออกจะไม่เห็น test พังสักตัว และคนที่เก็บอย่างอื่นไว้เพราะเข้าใจผิดข้อนี้จะเก็บผิดตัว
  - สิ่งที่**ห้ามถอด**คือ `word-break: normal` — เปลี่ยนเป็น `break-all` แล้วจุดตัดเลื่อนไปอยู่นอกขอบคำทั้ง 5 จุดทันที (นี่คือ mutation ที่พิสูจน์ว่า test ตรวจได้จริง)
- สระบน + วรรณยุกต์ + สระล่างซ้อนกันได้ 3 ชั้น → `line-height` ต้อง ≥ 1.6 ไม่งั้นสระโดนตัด
- ห้ามแปลง punctuation เป็น full-width (นั่นเป็น logic ของภาษาจีนที่ reference ทำ) ไทยใช้ `,.?!` ปกติ
- Thai script range `U+0E00–0E7F` ใช้เป็นตัวกรอง feedback loop ได้แม่นเกือบ 100% เพราะไม่ปนกับข้อความต้นทางภาษาอังกฤษ

---

## License boundary

Reference project ที่ศึกษา (`D:\Project\OtherSource\Translation-Overlay`) เป็น **AGPL-3.0** ส่วน Textlens เป็น **Apache-2.0**

**แกะ feature และแนวคิดได้ ห้ามคัดลอกโค้ด** — ถ้าคัดโค้ดมา Textlens จะติด AGPL ไปด้วย
เวลาอ้างถึง reference ให้อธิบายว่า "เขาแก้ปัญหานี้ด้วยแนวคิดอะไร" แล้วเขียนขึ้นใหม่ ไม่ใช่ port ไฟล์มา

---

## งานค้างอยู่ที่ไหน

> **ไฟล์นี้ไม่ใช่ที่เก็บสถานะงาน** — จำนวน issue ที่ปิดแล้ว จำนวน test อะไรกำลังทำอยู่ **ห้ามเขียนไว้ที่นี่**
> มันเก่าทุกครั้งที่มีงานเสร็จ และไฟล์นี้ถูกโหลดเข้า context ทุก session จึงถูกอ่านแบบเชื่อโดยไม่ตรวจ **board ที่โกหกแย่กว่าไม่มี board**

| อยากรู้อะไร | ดูที่ไหน |
|---|---|
| เหลืออะไรบ้าง / อะไรปิดแล้ว | `gh issue list` — สดเสมอ ไม่มีวันเก่า |
| ลำดับที่ควรทำ | หัวข้อ **Execution order** ใน [backlog](docs/backlog/mvp-issues.md) ไม่ใช่การไล่ตามกลุ่ม M1→M10 |
| รายละเอียด/ผลของงานที่ปิดไปแล้ว | comment ในแต่ละ issue — มีหลักฐานการ verify แนบไว้ |
| ทำไมถึงตัดสินใจแบบนั้น | commit message และหัวข้อด้านล่าง |

ที่นี่เก็บเฉพาะ **ความรู้ที่หาใหม่แล้วแพง** — กับดัก toolchain ข้อจำกัดภาษาไทย และการตัดสินใจที่เผลอย้อนได้ง่าย

---

## สิ่งที่ตัดสินไปแล้วและห้ามย้อนโดยไม่คุย

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
| **⚠️ NUL byte ในไฟล์ source ทำให้ ripgrep/grep ข้ามไฟล์นั้นทั้งไฟล์แบบเงียบ** | เจอจริง 2 ไฟล์ที่เขียน `join('<NUL ตัวจริง>')` แทนที่จะเขียน escape `'\0'` — **grep และ ripgrep จัดว่าเป็น binary แล้วข้าม ไม่มี warning** ผลคือ `renderSignature` ที่นิยามใน `transitions.ts` ค้นเจอเฉพาะที่ `layout.ts` ซึ่งเรียกใช้ ราวกับไม่มีนิยาม · **การ rename ทั้งโปรเจกต์จะพลาดไฟล์พวกนี้เงียบๆ** และ `Select-String` ของ PowerShell **หาเจอ** จึงยิ่งหลอกว่าไม่มีปัญหา · เขียน `'\0'` เสมอ ให้ผลเหมือนกันทุกประการ · ตรวจทั้ง repo: `node -e "..."` อ่านไฟล์แล้วนับ ` ` — อย่าใช้ grep หาสิ่งที่ grep มองไม่เห็น |
| **เปลี่ยนชื่อ config key = migration ไม่ใช่งานเปลี่ยนคำ** | schema เป็น `strictObject` → config ที่ยังมี key เก่าจะถูกปฏิเสธ **ทั้งไฟล์** ไม่ใช่แค่ field นั้น (ตามเจตนาของ #38 คือไม่ apply ครึ่งๆ) ดังนั้นการ rename ทำให้ค่าที่ผู้ใช้ตั้งไว้ **หายทั้งก้อน** ไม่ใช่หายทีละตัว · เสียงดังไม่เงียบ (invariant 4 ทำงาน) แต่ต้องรู้ก่อนตัดสินใจ **ตรวจ blast radius ก่อน rename เสมอ** — มี config อยู่บนเครื่องไหน ชื่อเก่าโผล่ใน docs/README ไหม |
| **⚠️ `Display.nativeOrigin` เป็นกับดักที่เครื่องนี้เปิดโปงไม่ได้** | มันเท่ากับ physical origin พอดีบนเครื่องนี้ — และ .d.ts ของ Electron เขียนไว้เองว่า *"Only available on windowing systems like X11"* **มันบังเอิญตรงเพราะจอทุกตัวที่นี่ scaleFactor 1.0** พอเจอเครื่องที่ DPI ผสมกันจะผิดทันที และ**ไม่มี test ไหนที่รันบนเครื่องนี้จับได้** · จับได้ด้วยการอ่าน type definition ไม่ใช่ด้วยการทดสอบ ซึ่งเป็นทางเดียวที่จับได้ที่นี่ · การจับคู่ monitor↔Display ต้องใช้ property ที่พึ่งพาได้: primary-at-(0,0) + `size × scaleFactor` เทียบ physical bounds (เผื่อ ±2px จาก DIP rounding) + ลำดับบนแกนเดียวกันสำหรับจอรุ่นเดียวกัน |
| **`Display.label` บน Windows ไม่ใช่ device name** | ได้ชื่อ EDID เช่น `Dell AW3423DW` ไม่ใช่ `\\.\DISPLAY1` ที่ sidecar ส่งมา — เอามา match กันตรงๆ ไม่ได้ |
| **⚠️ Electron accelerator กลืน modifier ที่พิมพ์ผิดแบบเงียบๆ** | วัดจริงบน runtime: **key** ที่ไม่รู้จัก → throw แต่ **modifier** ที่ไม่รู้จัก → **ทิ้งเงียบแล้ว bind ส่วนที่เหลือ** · `register('Contrl+Alt+A')` คืน `true` แล้ว bind `Alt+A` · `Foo+Bar+A` **bind ปุ่ม `A` เปล่าๆ ทั้งระบบ** → ทุกตัว `A` ที่พิมพ์ที่ไหนก็ตามใน Windows ถูกกลืนหมด **ห่างแค่พิมพ์ผิดตัวเดียวใน config ที่ผู้ใช้แก้เอง** · ต้องตรวจ modifier เองก่อนส่งให้ Electron (`hotkey-service.ts` ทำแล้ว) · และ `register` ตัวที่สองของ accelerator เดิมคืน `false` ไม่ใช่ "แย่งไปเงียบๆ" ซึ่งแยกไม่ออกจากการชนกับโปรแกรมอื่น |
| **UTF-8 BOM จาก PowerShell/Notepad** | `Out-File -Encoding utf8` บน Windows PowerShell 5.1 ใส่ **BOM** มาให้ และ Notepad ก็ทำเหมือนกัน · `fs.readFile(...,'utf8')` decode BOM เป็นตัวอักษร `U+FEFF` จริงๆ แล้ว `JSON.parse` ก็ปฏิเสธ → ไฟล์ JSON ที่เปิดดูในโปรแกรมไหนก็ถูกต้องทุกอย่าง กลับรายงานว่า "ไม่ใช่ JSON ที่ถูกต้อง" ซึ่งโทษผู้ใช้ทั้งที่เป็นความผิดของ default ใน tooling · **ทุกที่ที่อ่านไฟล์ที่ผู้ใช้แก้เองได้ ต้องตัด BOM ทิ้งก่อน** (`config.ts` ทำแล้ว มี test ยึดไว้) |

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
