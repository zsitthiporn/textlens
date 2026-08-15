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

ยังไม่มี product code — repo มีเอกสารออกแบบ กับ throwaway benchmark ของ spike S1 (`spikes/s1-ocr/`)

**Spike S1 ผ่านแล้ว** ([รายงาน](docs/spikes/2026-08-15-s1-ocr-engine.md)) — Windows.Media.Ocr เร็วกว่า PaddleOCR ~6 เท่า
(p50 99ms เต็มจอ / 30ms บน region เทียบกับ 580ms) และอ่านเนื้อหาเกมแม่นกว่า → สถาปัตยกรรม .NET sidecar ยืนยันแล้ว

ขั้นถัดไป: **spike S2** ยืนยันว่า Windows Graphics Capture เคารพ exclude-from-capture จริง — ดูหัวข้อ 10 ของ design doc

ข้อควรรู้จาก S1 ที่กระทบการเขียนโค้ด:
- ต้องมี **en-US OCR recognizer** ติดตั้งบนเครื่องผู้ใช้ ไม่งั้นใช้งานไม่ได้เลย → feature `O8` preflight check
- **region ที่ตัดโดนตัวอักษรทำให้ OCR พังทันที** → feature `R7` padding + edge warning
- เครื่อง dev ยังไม่มี .NET 10 (มี 2.2/6/8/9) → target `net9.0-windows10.0.19041.0` ไปก่อน
- ข้อผิดพลาดที่ Windows OCR ทำประจำ: `o`↔`O`, `I`↔`1`, ตกเลขลำดับ, ช่องว่างหายบางจุด — ไม่กระทบความหมาย ไม่ต้องพยายามแก้ที่ post-processing

<!-- เพิ่ม build/test/lint commands ที่นี่เมื่อเริ่มมีโค้ด -->
