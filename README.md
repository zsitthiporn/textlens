# Textlens

**แปลข้อความบนหน้าจอเป็นภาษาไทยแบบเรียลไทม์** — เลือกพื้นที่บนจอ แล้วคำแปลจะลอยขึ้นมาใต้ข้อความต้นฉบับ

> Pipeline วิ่งได้ครบเส้น (capture → OCR → แปล → overlay) มี installer ให้ build เอง — งานที่เหลือและสถานะล่าสุดดูที่ `gh issue list`

---

## มันทำอะไร

เลือกกรอบบนหน้าจอ (เช่นช่อง subtitle ของเกม) → Textlens จับภาพเฉพาะกรอบนั้น อ่านข้อความด้วย OCR แปลเป็นไทย แล้ววาดคำแปลเป็นกล่องลอยใต้ข้อความต้นฉบับแต่ละก้อน

คำแปลผูกกับตำแหน่งของข้อความเดิม เพื่อให้เทียบได้ว่า**ประโยคไหนแปลออกมาได้อะไร** ไม่ใช่แค่อ่านคำแปลรวมๆ

**Use case หลัก**: subtitle / เกม / วิดีโอ ที่เนื้อหาเปลี่ยนตลอด
**Use case รอง**: อ่านเอกสาร / เว็บ / UI โปรแกรมที่เนื้อหานิ่ง (Translate once mode)

---

## Architecture

Textlens แบ่งเป็นสอง process ตามหลัก **"pixel อยู่ฝั่งที่มี native API ดีที่สุด, text อยู่ฝั่งที่ render ภาษาไทยได้ดีที่สุด"**

```
┌──────────────────────────────────────────────┐
│ Electron + TypeScript          "โลกของ text"  │
│  translate · cache · dedup · overlay · config │
└──────────────────┬───────────────────────────┘
                   │  JSON lines over stdio
                   │  ⚠ ส่งแค่ text + bbox ไม่ส่ง pixel
┌──────────────────┴───────────────────────────┐
│ Textlens.Capture (.NET 10)    "โลกของ pixel"  │
│  Windows Graphics Capture · Windows.Media.Ocr │
└──────────────────────────────────────────────┘
```

- **Electron** ได้ Chromium มาด้วย → ได้ ICU Thai line breaking ฟรี ซึ่งจำเป็นเพราะภาษาไทยไม่เว้นวรรคระหว่างคำ และได้ transparent click-through overlay ที่พิสูจน์แล้วว่าทำงานได้
- **.NET sidecar** ได้ Windows Graphics Capture (เคารพ exclude-from-capture → กัน overlay อ่านตัวเอง — ยืนยันแล้วใน [spike S2](docs/spikes/2026-08-16-s2-content-protection.md)) และ Windows.Media.Ocr (ไม่ต้อง bundle OCR model)

รายละเอียดเต็มอยู่ใน [Architecture Design](docs/superpowers/specs/2026-08-15-textlens-design.md)

---

## Documentation

| เอกสาร | เนื้อหา |
|---|---|
| [feature-spec.md](docs/feature-spec.md) | Feature ทั้งหมดพร้อม priority (P0/P1/P2), MVP scope, improvement list |
| [architecture design](docs/superpowers/specs/2026-08-15-textlens-design.md) | Component boundary, IPC contract, data flow, latency budget, error handling, testing |
| [reference-analysis.md](docs/reference-analysis.md) | วิเคราะห์ open-source project ที่ทำเรื่องเดียวกัน — feature ที่แกะมา และจุดที่เราทำต่างออกไป |
| [spike S1](docs/spikes/2026-08-15-s1-ocr-engine.md) | วัด Windows.Media.Ocr เทียบ PaddleOCR — เหตุผลที่เลือก OCR engine ตัวนี้ และตัวเลข latency ที่ budget อ้างถึง |
| [spike S2](docs/spikes/2026-08-16-s2-content-protection.md) | ยืนยัน exclude-from-capture ทำงานจริง — และที่มาของกฎ "capture loop ต้องเป็น interval-driven" |

---

## การใช้งาน

เส้นทางนี้วิ่งได้ครบแล้ว:

```
เปิดโปรแกรม → tray ขึ้น
  → hotkey เลือก region: เลือกจอ + ลากกรอบคลุมช่อง subtitle
  → hotkey เปิด auto mode
  → subtitle เปลี่ยน → กล่องคำแปลไทยโผล่ใต้ข้อความอังกฤษ ไม่กระพริบ
  → hotkey Translate once: แปลครั้งเดียวค้างไว้จน dismiss
  → เปลี่ยน setting มีผลทันที
  → engine ล่ม → เห็นข้อความบอก ไม่ใช่เงียบ
```

งานที่เหลือและ backlog ดูที่ `gh issue list`

---

## Requirements

- **Windows 10/11** (โปรเจกต์นี้ Windows-only โดยตั้งใจ เพื่อใช้ native API ที่ดีกว่า)
- Node.js >= 22.12.0, npm >= 10
- .NET SDK 10 (สำหรับ build sidecar)

---

## Hotkeys

hotkey เป็น **global** — ทำงานขณะโฟกัสอยู่ที่โปรแกรมอื่น ซึ่งเป็นเหตุผลที่ต้องมี:
use case หลักคือเกม borderless fullscreen ที่สลับหน้าต่างไปกดปุ่มไม่ได้

| ค่าเริ่มต้น | ทำอะไร |
|---|---|
| `Control+Alt+A` | เปิด/ปิด auto mode |
| `Control+Alt+S` | Translate once — แปลครั้งเดียวแล้วค้างไว้จน dismiss (config key ยังชื่อ `snapshot`) |
| `Control+Alt+R` | เลือก region ใหม่ |
| `Control+Alt+H` | ซ่อน/แสดง overlay (**ไม่ใช่** การหยุดจับภาพ) |
| `Control+Alt+D` | dismiss — เคลียร์คำแปลที่ค้างบนจอ โดยไม่เปลี่ยนโหมด (ใช้ได้ทั้ง Auto และ Translate once) |

เปลี่ยนได้ที่ `%APPDATA%\textlens\config.json` ใต้คีย์ `hotkeys` — ใส่ `null` เพื่อปิด hotkey นั้น
เช่นเมื่อชนกับโปรแกรมอื่น:

```json
{ "hotkeys": { "snapshot": "Control+Shift+F9", "selectRegion": null } }
```

> **modifier ต้องสะกดให้ถูก** — `Command` `Cmd` `Control` `Ctrl` `CommandOrControl` `CmdOrCtrl`
> `Alt` `Option` `AltGr` `Shift` `Super` `Meta` เท่านั้น
> Electron **ไม่ฟ้อง** ถ้าสะกด modifier ผิด มันจะทิ้ง token นั้นแล้ว bind ปุ่มที่เหลือแทนเงียบๆ
> (วัดจริงแล้ว: `Contrl+Alt+A` → ได้ `Alt+A` · `Foo+Bar+A` → ได้ปุ่ม `A` เปล่าๆ ทั้งเครื่อง)
> Textlens จึงตรวจเองก่อนส่งให้ Electron และรายงานเป็น error แทนที่จะ bind ผิดตัว

ลงทะเบียนไม่สำเร็จ (โปรแกรมอื่นจองไว้ / สะกดผิด / ผูกซ้ำสองปุ่ม) จะขึ้นใน log พร้อมบอกว่า
**ตัวไหน**และ**เพราะอะไร** — hotkey ตัวที่เหลือยังทำงานปกติ

---

## Development

```bash
cp .env.example .env
npm install
npm run dev
```

> Electron 43 ไม่มี postinstall แล้ว — `npm install` **ไม่** โหลด binary
> ครั้งแรกที่รัน `npm run dev` / `npm start` จะโหลด Electron (~226MB) ให้เอง รอบแรกจึงช้า
> ถ้าอยากโหลดล่วงหน้า (เช่นใน CI) ใช้ `npx install-electron`

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run build` | compile ทั้งหมด — `tsc` ทำ `src/main` + `src/preload` → `dist/`, Vite ทำ `src/renderer` → `dist/renderer/` |
| `npm run build:sidecar` | publish `.NET` sidecar เป็น NativeAOT exe เดี่ยว (`scripts/build-sidecar.ps1`) — **rebuild ใหม่ทุกครั้งโดยตั้งใจ ไม่มี reuse-if-present** เพราะ exe เก่าพูดคนละ protocol กับ Node แล้วยังรันขึ้นเหมือนสำเร็จ แค่ไม่มีเฟรมส่งมาเลย |
| `npm run package` | `build` + `build:sidecar` แล้วให้ `electron-builder` ทำ installer (`--win`) |
| `npm run dev` | build แล้วเปิดแอป (ยังไม่มี HMR — renderer dev server จะมาทีหลัง) |
| `npm start` | เปิดแอปจาก `dist/` ที่ build ไว้แล้ว |
| `npm test` | unit test ด้วย vitest (`npm run test:watch` สำหรับ watch mode) |
| `npm run typecheck` | ตรวจ type ทั้งสาม config โดยไม่ emit |

### โครงสร้างโค้ด

```
src/main/       Electron main process — compile ด้วย tsc เป็น ESM
src/preload/    preload script — เป็น .cts เพราะ sandboxed preload ต้องเป็น CommonJS
src/renderer/   หน้าจอ — build ด้วย Vite
src/shared/     type + helper ที่ main กับ renderer ใช้ร่วมกัน
tests/          vitest
```

Build มีสอง compiler โดยตั้งใจ: `tsc` คุม process ฝั่ง Node (`tsconfig.json`) และ Vite คุม renderer
(`tsconfig.renderer.json` ใช้ type-check อย่างเดียว) — `tsconfig.test.json` มีไว้ type-check `tests/`
ที่ไม่ควรหลุดเข้า `dist/`

**ทุก BrowserWindow ต้องใช้ `BASE_WEB_PREFERENCES` ใน `src/main/index.ts`** — `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true` อย่าประกาศ `webPreferences` เองแยกต่างหาก

---

## License

Apache-2.0 — ดู [LICENSE](LICENSE)

โปรเจกต์นี้ศึกษา feature จาก open-source screen translator ตัวอื่น (ดู [reference-analysis.md](docs/reference-analysis.md)) แต่ **ไม่ได้คัดลอกโค้ดจากโปรเจกต์ใด** โค้ดทั้งหมดเขียนขึ้นใหม่
