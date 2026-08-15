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

ยังไม่มีโค้ด — repo มีแต่เอกสารออกแบบ

ขั้นถัดไปคือ **spike S1**: วัดว่า Windows.Media.Ocr อ่าน subtitle เกม (font ตกแต่ง / anti-alias / พื้นหลังโปร่ง) ได้ดีพอไหม เทียบกับ PaddleOCR
ถ้าไม่ผ่าน ต้องเปลี่ยน OCR engine ก่อนลงมือเขียนของจริง — ดูรายละเอียด S1/S2/S3 ในหัวข้อ 10 ของ design doc

<!-- เพิ่ม build/test/lint commands ที่นี่เมื่อเริ่มมีโค้ด -->
