# Spike S2 — WGC เคารพ content protection บน overlay จริงไหม

- วันที่: 2026-08-16
- คำถาม: **overlay ที่ตั้ง `setContentProtection` แล้ว หายไปจากภาพที่ sidecar (WGC) จับได้จริงหรือไม่** — คือชั้นที่ 1 ของ feedback loop prevention (design doc §6) มีอยู่จริงหรือเปล่า
- ผล: **ผ่าน — WGC มองไม่เห็น overlay เลย ชั้นที่ 1 มีจริงและใช้ได้**
- Harness: `spikes/s2-content-protection/` (throwaway ไม่ใช่ product code)
- เครื่องที่ทดสอบ: **Windows 11 Pro 25H2 build 26200.9168** — พฤติกรรมนี้ขึ้นกับเวอร์ชัน OS อย่ายืนยันแทนเครื่องอื่น

---

## 1. ทำไมต้องออกแบบการทดลองแบบมี control

"จับภาพแล้วไม่เห็น overlay" **ไม่ได้พิสูจน์อะไรเลยด้วยตัวมันเอง** เพราะคำอธิบายที่เข้ากันได้มีอย่างน้อย 5 ข้อ:

1. content protection ทำงาน
2. overlay ยังไม่ทันวาด
3. crop ผิดตำแหน่ง
4. frame ที่ได้มาเก่ากว่า overlay
5. WGC starve แล้วคืน frame ค้าง (ground truth: จอนิ่ง 24 วินาทีได้แค่ 2 frame)

ทั้งห้าข้อ **หน้าตาเหมือน "สำเร็จ" หมด** — false positive ที่นี่แพงกว่าผลลบมาก เพราะทั้ง design จะไปวางอยู่บนของที่ไม่มีอยู่จริง

วิธีแก้คือทำ region ที่ทดสอบให้เป็น **แซนด์วิชของสีที่เราทาเองทุกชั้น**:

| ชั้น | สี | หน้าต่าง |
|---|---|---|
| บน | `#CB1159` | overlay ตัวจริงจาก `WindowManager.openOverlay()` (screen-saver topmost) |
| ล่าง | `#1FC77A` | underlay — หน้าต่างธรรมดาตำแหน่งเดียวกัน (floating topmost) |

- protection **OFF** → sidecar ต้องเห็น `CB1159`
- protection **ON** → sidecar ต้องเห็น `1FC77A` — **ไม่ใช่แค่ "ไม่เห็น CB1159"**

สีชั้นล่างคือสิ่งที่เปลี่ยน "ความว่างเปล่า" ให้เป็นหลักฐาน เพราะมันพิสูจน์พร้อมกันว่า crop ถูกตำแหน่ง frame สดจริง และตัวแปรเดียวที่เปลี่ยนคือ flag

องค์ประกอบอื่นที่จำเป็น:

- **beacon** — หน้าต่างเล็กนอก region ที่เปลี่ยนสีทุก 16ms กัน WGC starve (`backgroundThrottling: false` เพราะหน้าต่างที่ถูกบังโดน throttle จนหยุดวาด ซึ่งหน้าตาเหมือน capture พังเป๊ะ)
- **probe rect เว้าเข้าไปข้างใน** ทั้ง overlay patch และ underlay ไม่ให้ไปโดนมุมโค้งของ Windows 11 หรือขอบหน้าต่าง
- **`--force-color-profile=srgb`** ไม่ให้ colour management เปลี่ยนค่า RGB ระหว่างทางจนเทียบแบบตรงตัวไม่ได้
- probe รายงาน **min/max/last ข้ามหลาย frame** ไม่ใช่ frame เดียว — frame เดียวแยกไม่ออกจาก frame ค้าง

เครื่องมือ: `Textlens.Capture --probe-colors` (โหมดใหม่ใน `CaptureProbe.cs`) นับเฉพาะสีที่ผู้เรียกระบุ ไม่เคยรายงานเนื้อหาหน้าจอ

---

## 2. ผล — รอบ A/B/A (toggle ตอน runtime)

ลำดับ OFF → ON → OFF ในโปรเซสเดียว 20 frame ต่อ arm ต่อจอ
ตัวเลขคือ **สัดส่วนพื้นที่ของ probe region (720×320 px) ที่ตรงกับสีนั้นแบบเป๊ะ**

| จอ | arm | `GetWindowDisplayAffinity` | `CB1159` (overlay) | `1FC77A` (underlay) | starved |
|---|---|---|---|---|---|
| DISPLAY1 3440×1440 | A OFF | `0x0` | **1.0000** | 0.0000 | 0 |
| DISPLAY1 | B ON | `0x11` | **0.0000** | **1.0000** | 0 |
| DISPLAY1 | C OFF | `0x0` | **1.0000** | 0.0000 | 0 |
| DISPLAY3 1920×1080 | A OFF | `0x0` | **1.0000** | 0.0000 | 0 |
| DISPLAY3 | B ON | `0x11` | **0.0000** | **1.0000** | 0 |
| DISPLAY3 | C OFF | `0x0` | **1.0000** | 0.0000 | 0 |
| DISPLAY2 1080×1920 (portrait, x ติดลบ) | A OFF | `0x0` | **1.0000** | 0.0000 | 0 |
| DISPLAY2 | B ON | `0x11` | **0.0000** | **1.0000** | 0 |
| DISPLAY2 | C OFF | `0x0` | **1.0000** | 0.0000 | 0 |

min = max = last ทุกช่อง และ `framesOver50` เป็น 20/20 หรือ 0/20 เสมอ — **ไม่มี frame ไหนก้ำกึ่งเลย**

`0x11` คือ `WDA_EXCLUDEFROMCAPTURE` อ่านจาก `GetWindowDisplayAffinity` ตรงจาก HWND ไม่ได้เชื่อค่า return ของ Electron
นี่สำคัญเพราะมันแยก "Electron ไม่ได้ตั้ง flag" ออกจาก "ตั้งแล้วแต่ WGC ไม่สน" ได้

**สีดำ `000000` เป็น 0.0000 ทุก arm** — ยืนยันว่า Windows ใช้กลไก *ตัดหน้าต่างออก* ไม่ใช่ *ทาดำทับ* (`WDA_MONITOR`)
ข้อนี้ไม่ใช่รายละเอียด: overlay กินเต็มจอ ถ้าเป็นแบบทาดำ capture ทั้งจอจะกลายเป็นสีดำและ **product พังทั้งใบ**

---

## 3. ผล — ลำดับที่ product ใช้จริง (ตั้ง flag ก่อน show)

รอบ A/B/A ข้างบนพิสูจน์ว่า toggle ได้ผล แต่ product ไม่ toggle — มันตั้ง flag ตอนสร้างหน้าต่าง ก่อน `showInactive()`
รอบนี้จึงเริ่ม probe **ก่อน** แล้วค่อยเปิด overlay ระหว่างที่ probe กำลังจับอยู่ 300 frame (~5 วินาที)

| จอ | arm | `CB1159` min / max | `1FC77A` frames>50% |
|---|---|---|---|
| DISPLAY1 | control (เคลียร์ flag ก่อน show) | 0.0000 / **1.0000** | 73/300 |
| DISPLAY1 | production (flag ก่อน show) | 0.0000 / **0.0000** | **300/300** |
| DISPLAY3 | control | 0.0000 / **1.0000** | 80/300 |
| DISPLAY3 | production | 0.0000 / **0.0000** | **300/300** |

control arm มี `CB1159` min=0 max=1 → **probe คร่อมจังหวะที่ overlay โผล่จริง** (73 frame แรกเห็นแต่ underlay แล้ว 220 frame หลังเห็น overlay)
นี่คือสิ่งที่ทำให้ arm ที่เปิด protection มีความหมาย: โค้ดเส้นเดียวกัน จังหวะเดียวกัน overlay โผล่ในช่วงเดียวกัน แต่ **ไม่มี pixel เดียวใน ~69 ล้าน pixel sample ที่ตรงกับสี overlay**

→ ตั้ง flag ก่อน `show` แล้วไม่มีช่วงรอยต่อที่ capture เห็น overlay เลย

---

## 4. ผลข้างเคียงที่ไม่ได้ตั้งใจหา — overlay ที่ถูกซ่อน **ยังปลุก capture อยู่**

overlay ไม่อยู่ *ใน* frame แล้ว แต่มันยัง **ทำให้ frame ถูกส่งมา** หรือเปล่า
ทดสอบบน DISPLAY3 โดย **ไม่มี beacon** — สิ่งเดียวที่ขยับได้คือ overlay ที่ถูก exclude ไปแล้ว

| arm (protection ON ทั้งคู่) | frames | เวลา | starved | เนื้อหาที่จับได้ |
|---|---|---|---|---|
| overlay **นิ่ง** | **3** | 13,165ms | 6 (ยอมแพ้) | underlay 100% |
| overlay **animate ทุก 16ms** | **120** | 2,585ms (~46fps) | 0 | underlay 100% ทุก frame |

**frame ทั้ง 120 มีเนื้อหาเหมือนกันเป๊ะ** (`1FC77A` min=max=1.0000) แต่ WGC ก็ยังส่งมาครบที่ ~46fps
ส่วน arm ที่ overlay นิ่งได้ 3 frame ใน 13 วินาที → **frame ทั้ง 120 นั้นมาจากการที่ overlay ตัวเองวาดใหม่ ไม่ใช่จากอะไรอื่น**

### ทำไมเรื่องนี้สำคัญ

ถ้า capture loop เป็นแบบ **frame-driven** (`WaitForFrame()` → diff → OCR ตามที่ `CaptureService` เชิญชวนให้เขียน)
crossfade ของ overlay เอง (§5 anti-flicker, feature M5) จะปลุก pipeline ที่ ~60fps บนจอที่**ไม่มีอะไรเปลี่ยนเลย**
เป็นงาน capture+diff ที่ไม่มีวันเจออะไร — และมันกินงบ 15ms/รอบ ในลูปที่ควรจะหลับ

ไม่ใช่ feedback loop (pixel ของ overlay ไม่มีอยู่จริงในภาพ diff จึงบอกว่าไม่เปลี่ยน) แต่เป็น **busy loop**
สมมติฐานว่า "จอนิ่ง = WGC หลับ = แทบไม่กินอะไร" ที่ latency budget พึ่งอยู่ **ถูก overlay ของเราเองทำลาย**

→ ข้อเสนอ: capture loop ต้องเป็น **interval-driven** (tick ตาม config แล้วค่อยหยิบ frame ล่าสุด) ไม่ใช่ frame-driven
เป็นการตัดสินใจของ M2-06 และควรตัดสินโดยรู้ข้อนี้

---

## 5. ผลต่อ spec

| การเปลี่ยนแปลง | เหตุผล |
|---|---|
| §6 ชั้นที่ 1 เปลี่ยนจาก "สูง แต่ต้องยืนยันด้วย S2" → **"ยืนยันแล้ว (S2)"** | วัดได้บน 3 จอ ทั้ง toggle และลำดับ production |
| §10 S2 ปิด | ความเสี่ยงไม่เกิดขึ้นจริง |
| `window-manager.ts` เรียก `setContentProtection(true)` **ก่อน show และไม่ toggle อีกเลย** | control arm แสดงว่าไม่มี flag = เห็นเต็ม ๆ ทุก frame |
| ชั้นที่ 3 (Thai script filter) **ยังต้องมีเหมือนเดิม** | ดูข้อ 6 |
| M2-06 capture loop ควรเป็น **interval-driven ไม่ใช่ frame-driven** | ดูข้อ 4 |
| เพิ่มการอ่าน `GetWindowDisplayAffinity` กลับมายืนยัน `0x11` ตอน runtime | `setContentProtection` คืนค่า `void` — ถ้าตั้งไม่สำเร็จบน OS เก่า ชั้นที่ 1 หายไปแบบ**เงียบ** ผิด invariant 4 |

---

## 6. ข้อจำกัดของการทดสอบนี้ — อย่าถอดชั้นที่ 2/3 ออก

ผลนี้ **ไม่ใช่** ใบอนุญาตให้ตัด `recentOutputs` หรือ Thai script filter ทิ้ง สิ่งที่ยังไม่ได้พิสูจน์:

- ทดสอบบน **build เดียว** (26200.9168) `WDA_EXCLUDEFROMCAPTURE` ต้องการ Windows 10 2004+ และเครื่องผู้ใช้ที่เก่ากว่านั้นจะ degrade เงียบ ๆ เป็น `WDA_MONITOR` (ทาดำ) หรือไม่มีผลเลย → ควรอ่าน `GetWindowDisplayAffinity` กลับมาตอน runtime แล้วแจ้งถ้าไม่ได้ `0x11` (invariant 4)
- ยังไม่ได้ทดสอบกับ **เกม fullscreen exclusive** ซึ่งเป็น use case จริง — desktop ธรรมดาเท่านั้น
- ยังไม่ได้ทดสอบตอน **จอสลับ HDR / เปลี่ยน scale / hot-plug** ระหว่างที่ overlay เปิดอยู่
- ยังไม่ได้ทดสอบว่ามี path อื่นในตัว product เองที่จับภาพ overlay ได้ไหม (เช่น `debugFrame` — ยังไม่มี, issue M2-05)
- ไม่ได้ยืนยันว่าเปิด flag แล้ว **ไม่กระทบ latency budget** ของ capture — งาน compositing เปลี่ยนไปแต่ยังไม่ได้วัด

### ยังพิสูจน์ไม่ได้: auto-capture 10 นาทีแล้ว translation-request count ไม่ไต่ขึ้น

**เกณฑ์นี้รันไม่ได้ตอนนี้ และไม่ได้แกล้งทำ** — สิ่งที่จำเป็นยังไม่มีสองอย่าง:

- **auto-capture loop** = command dispatcher M2-06 ยังไม่ได้เขียน sidecar ยังอ่าน stdin ทิ้งเปล่า ๆ
- **translation pipeline** = issue #18 เป็นต้นไป ยังไม่มี ไม่มี counter ให้นับ

ต้องกลับมาทำเกณฑ์นี้เมื่อ M2-06 กับ translation engine พร้อมแล้ว

---

## 7. วิธีรันซ้ำ

```
npm run build
dotnet build sidecar/Textlens.sln
npx electron spikes/s2-content-protection --displays=1,3,2                 # รอบ A/B/A
npx electron spikes/s2-content-protection --displays=1,3 --first-paint     # ลำดับ production
npx electron spikes/s2-content-protection --displays=3   --frame-drive     # overlay ปลุก capture ไหม
```

ทุกอย่างออก stderr และเป็นสถิติของสีที่เราทาเองเท่านั้น ไม่มี pixel ของหน้าจอผู้ใช้ออกมา
