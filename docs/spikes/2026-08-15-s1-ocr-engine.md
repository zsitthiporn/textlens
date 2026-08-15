# Spike S1 — Windows.Media.Ocr อ่านข้อความในเกมได้ดีพอไหม

- วันที่: 2026-08-15
- คำถาม: **Windows.Media.Ocr อ่านข้อความในเกมได้ดีพอที่จะยึดสถาปัตยกรรม .NET sidecar ไว้หรือไม่ หรือต้องกลับไปใช้ PaddleOCR ONNX**
- ผล: **ผ่าน — ใช้ Windows.Media.Ocr ต่อ สถาปัตยกรรม .NET sidecar ยังถูกต้อง**
- Harness: `spikes/s1-ocr/` (throwaway benchmark ไม่ใช่ product code)

---

## 1. วิธีทดสอบ

| | |
|---|---|
| ชุดภาพ | 92 official screenshot จาก Steam store API — 12 เกมเนื้อเรื่อง (Disco Elysium, Pentiment, Baldur's Gate 3, Cyberpunk 2077, The Witcher 3, Mass Effect, Detroit, Death Stranding, RDR2, Firewatch, Life is Strange, Helldivers 2) |
| ภาพที่มีข้อความจริง | 25 จาก 92 (promo shot ส่วนใหญ่จงใจไม่มี UI) |
| Engine A | Windows.Media.Ocr ผ่าน WinRT — เรียกจาก PowerShell ได้โดยตรง ไม่ต้อง build project |
| Engine B | PaddleOCR `ppu-paddle-ocr` 6.4.0 + onnxruntime-node 1.27, model `V5_EN_MOBILE` |
| Ground truth | เปิดดูภาพแล้วถอดข้อความเองสำหรับภาพอ้างอิง |

---

## 2. Latency

**ภาพเต็มจอ 1920×1080 (92 ภาพ)**

| Engine | min | p50 | p90 | max | mean |
|---|---|---|---|---|---|
| Windows.Media.Ocr | 32ms | **99ms** | 156ms | 269ms | 107ms |
| PaddleOCR | 391ms | **580ms** | 1001ms | 12606ms | 830ms |

**Windows OCR เร็วกว่า ~6 เท่า** และไม่มี tail ยาว (Paddle มีภาพหนึ่งใช้ 12.6 วินาที)

**ภาพ crop ระดับ region จริง** (วัดแบบ warm, best of 3)

| region | ขนาด | เวลา |
|---|---|---|
| Disco Elysium dialogue panel | 520×430 | **30ms** |
| Disco Elysium dialogue panel | 540×600 | **36ms** |
| Pentiment text panel | 800×400 | **28ms** |
| region ที่ไม่มีข้อความ | 1200×150 | **3ms** |

Budget ใน design doc ตั้งไว้ที่ 40–80ms สำหรับ OCR → **อยู่ใต้ budget**

---

## 3. Accuracy

### ตัวอย่างอ้างอิง — Disco Elysium dialogue panel (crop 520×430)

Ground truth (ถอดจากภาพเอง):

> PERCEPTION (SIGHT) – A crumpled billboard reading "SAMARAN BUTTER" soaks in the canal. Two ugly lines mar the bright countenance of the blonde boy depicted.
> INTERFACING [Medium: Success] – The sign billboard has fallen on the water lock, keeping it open -- and thus out of order.
> VISUAL CALCULUS [Medium: Success] – Judging by the size of the impact and the parallel lines of burnt rubber, the cause was probably a motor vehicle.

Windows.Media.Ocr อ่านได้ทุกคำ ผิดเฉพาะ:

| ประเภทข้อผิดพลาด | ตัวอย่าง | กระทบการแปลไหม |
|---|---|---|
| สับสน o ↔ O | `of` → `Of`, `open` → `Open` | ไม่ |
| สับสน I ↔ 1 | `I like this guy` → `1 like this guy` | เล็กน้อย |
| ตกเลขลำดับ | `1. - Look at` → `. - Look at` | ไม่ |
| ช่องว่างหาย | `at the roof` → `at.the roof` | ไม่ |
| ตัวพิมพ์ใหญ่-เล็ก | `Success` → `success` | ไม่ |

**ไม่มีข้อผิดพลาดไหนที่ทำให้ประโยคแปลผิดความหมาย**

### PaddleOCR แย่กว่าในงานนี้

Disco Elysium Thought Cabinet (UI หนาแน่น) — Paddle ใช้ 12.6 วินาที แล้วได้ผลแตกเป็นตัวอักษรเรียง:

```
Paddle : "A uth Ority: - 1 I Z Es P rit d e C OI PS: + 1 Z X Z N A TI O N H OO D"
Windows: "Authority: -1 Esprit de Corps: +1 ... NATIONHOOD"
```

เคสที่ Windows อ่านไม่ได้แต่ Paddle อ่านได้ (Witcher 3 หลายภาพ) ตรวจแล้วพบว่า**เป็นโลโก้และแบนเนอร์โฆษณา** ไม่ใช่ข้อความในเกม:

```
Paddle : "THE WITCHER WILD HUNT FREE NEXT-GEN CAPTURED ON PC UP DATELES"
Windows: (ว่าง)
```

Paddle เองก็อ่านเพี้ยน (`UP DATELES`) — การที่ Windows ข้ามโลโก้ตกแต่งไปเลยเป็น**ข้อดี**สำหรับเรา เพราะนั่นคือ noise ที่ไม่ต้องแปล

---

## 4. สิ่งที่ค้นพบเพิ่มและกระทบ product

### 4.1 Region crop ทำให้ทั้งเร็วขึ้นและแม่นขึ้น

ภาพเดียวกัน อ่านเต็มจอกับอ่านเฉพาะ panel:

| | full frame | crop |
|---|---|---|
| เวลา | 119ms | 30ms |
| `I like this guy` | อ่านเป็น `- 1 like this guy` | **อ่านถูก** |
| ประโยคท้าย | ตัดขาดกลางคัน | อ่านครบ |

ยืนยันสมมติฐานหลักของ design ว่า region selection คือตัวคูณให้ทุกอย่างดีขึ้น — และเป็นเหตุผลเพิ่มเติมว่าทำไมมันควรอยู่ใน P0

### 4.2 ถ้า region ตัดโดนตัวอักษร ผลแย่ลงทันที

ทดลอง crop ที่กินขอบข้อความ ได้ผล:

```
"ogician .ndreas excelled at logic, geometry, and cithmetic in university...
 can Isil perform complicated calculations"
```

→ **ต้องมี margin รอบ region และ/หรือเตือนเมื่อข้อความชิดขอบ** (feature ใหม่ ดูข้อ 5)

### 4.3 Windows OCR ต้องมี language pack

เครื่องทดสอบมี recognizer แค่ตัวเดียวคือ `en-US` ซึ่งพอสำหรับ en→th แต่ถ้าเครื่องผู้ใช้ไม่มี English language pack ติดตั้ง **OCR จะใช้ไม่ได้เลย**

→ ต้องมี **preflight check ตอนเปิดแอป** พร้อมบอกวิธีติดตั้ง (feature ใหม่ ดูข้อ 5)

### 4.4 Windows ไม่มี Thai OCR recognizer แต่ PaddleOCR มี

`Get-WinUserLanguageList` มี `th` แต่ `OcrEngine::AvailableRecognizerLanguages` มีแค่ `en-US`
ส่วน PaddleOCR มี `V5_THAI_MOBILE_MODEL` และ model ภาษาอื่นครบ (ja, ko, latin, cyrillic, ...)

ไม่กระทบตอนนี้ (เราอ่านภาษาต้นทาง = อังกฤษ) แต่ถ้าจะขยายไป **ja/ko→th** ในอนาคต ต้องกลับมาดูจุดนี้
เป็นเหตุผลว่าทำไม `OcrService` ต้องอยู่หลัง interface และ text grouping ต้องอยู่ฝั่ง Node ตามที่ออกแบบไว้

### 4.5 เครื่อง dev ยังไม่มี .NET 10

มี SDK 2.2 / 6.0 / 8.0 / 9.0 — design doc ระบุ .NET 10
→ ติดตั้ง .NET 10 SDK หรือปรับ target เป็น `net9.0-windows10.0.19041.0` (WinRT API ใช้ได้เหมือนกัน)

---

## 5. ผลต่อ spec

| การเปลี่ยนแปลง | เหตุผล |
|---|---|
| เพิ่ม **O8 — OCR preflight check** (P0) | ถ้าไม่มี en-US recognizer แอปใช้งานไม่ได้เลย ต้องตรวจตอนเปิดและบอกวิธีแก้ |
| เพิ่ม **R7 — region padding + edge warning** (P0) | crop ที่กินขอบตัวอักษรทำให้ OCR พังทันที |
| ยืนยัน **R1 region selection** อยู่ใน P0 ถูกแล้ว | วัดได้ว่าเร็วขึ้น 4 เท่าและแม่นขึ้นด้วย |
| ยืนยัน **O1 / .NET sidecar** ไม่ต้องเปลี่ยน | Windows OCR เร็วกว่า 6 เท่าและแม่นกว่าในงานนี้ |
| แก้ target framework | `net9.0-windows10.0.19041.0` จนกว่าจะติดตั้ง .NET 10 |

---

## 6. ข้อจำกัดของการทดสอบนี้

**ยังไม่ได้ทดสอบเคสที่ยากที่สุด**: subtitle ตัวอักษรขาวลอยบนวิดีโอที่เคลื่อนไหว **โดยไม่มีกล่องพื้นหลัง**

ภาพทั้ง 92 ที่ใช้เป็น official promo shot ซึ่งเป็น**กล่องข้อความ/หน้าจอ UI** ทั้งหมด — เป็นเนื้อหาประเภทเดียวกับ Helldivers 2 briefing panel ที่เป็นตัวอย่างตั้งต้น แต่ไม่ครอบคลุม subtitle แบบลอยบนภาพ

ยังไม่ได้ทดสอบ:
- ข้อความขาวไม่มีพื้นหลัง บนฉากสว่าง (contrast ต่ำ)
- ข้อความที่มี drop shadow / outline
- subtitle ที่เคลื่อนไหวหรือ fade in-out ระหว่าง capture
- ภาพจากการ capture จริง (ชุดนี้เป็น JPEG ที่ถูกบีบอัด — ของจริงจะเป็น PNG ที่คมกว่า น่าจะได้ผลดีกว่า)

**ต้องการภาพ capture จริงของผู้ใช้ 5–10 ภาพเพื่อปิดช่องว่างนี้** — harness พร้อมรันซ้ำได้ทันที
