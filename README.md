# Textlens

**แปลข้อความบนหน้าจอเป็นภาษาไทยแบบเรียลไทม์** — เลือกพื้นที่บนจอ แล้วคำแปลจะลอยขึ้นมาใต้ข้อความต้นฉบับ

> 🚧 **สถานะ: ออกแบบเสร็จ ยังไม่เริ่มเขียนโค้ด** — ดู [Roadmap](#roadmap)

---

## มันทำอะไร

เลือกกรอบบนหน้าจอ (เช่นช่อง subtitle ของเกม) → Textlens จับภาพเฉพาะกรอบนั้น อ่านข้อความด้วย OCR แปลเป็นไทย แล้ววาดคำแปลเป็นกล่องลอยใต้ข้อความต้นฉบับแต่ละก้อน

คำแปลผูกกับตำแหน่งของข้อความเดิม เพื่อให้เทียบได้ว่า**ประโยคไหนแปลออกมาได้อะไร** ไม่ใช่แค่อ่านคำแปลรวมๆ

**Use case หลัก**: subtitle / เกม / วิดีโอ ที่เนื้อหาเปลี่ยนตลอด
**Use case รอง**: อ่านเอกสาร / เว็บ / UI โปรแกรมที่เนื้อหานิ่ง (Snapshot mode)

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
- **.NET sidecar** ได้ Windows Graphics Capture (เคารพ exclude-from-capture → กัน overlay อ่านตัวเอง — *รอยืนยันใน spike S2*) และ Windows.Media.Ocr (ไม่ต้อง bundle OCR model)

รายละเอียดเต็มอยู่ใน [Architecture Design](docs/superpowers/specs/2026-08-15-textlens-design.md)

---

## Documentation

| เอกสาร | เนื้อหา |
|---|---|
| [feature-spec.md](docs/feature-spec.md) | Feature ทั้งหมดพร้อม priority (P0/P1/P2), MVP scope, improvement list |
| [architecture design](docs/superpowers/specs/2026-08-15-textlens-design.md) | Component boundary, IPC contract, data flow, latency budget, error handling, testing |
| [reference-analysis.md](docs/reference-analysis.md) | วิเคราะห์ open-source project ที่ทำเรื่องเดียวกัน — feature ที่แกะมา และจุดที่เราทำต่างออกไป |

---

## Roadmap

| ระยะ | สถานะ |
|---|---|
| วิเคราะห์ reference project | ✅ เสร็จ |
| Feature spec | ✅ เสร็จ |
| Architecture design | ✅ เสร็จ |
| **Spike S1** — วัดว่า Windows.Media.Ocr อ่าน subtitle เกมได้ดีพอไหม | ⬜ ถัดไป |
| Spike S2 — ยืนยัน exclude-from-capture ทำงานจริง | ⬜ |
| Spike S3 — Google endpoint ทนโหลด subtitle ไหม | ⬜ |
| Implementation plan | ⬜ |
| MVP | ⬜ |

**MVP คือเส้นทางนี้วิ่งได้ครบ:**

```
เปิดโปรแกรม → tray ขึ้น
  → hotkey เลือก region: เลือกจอ + ลากกรอบคลุมช่อง subtitle
  → hotkey เปิด auto mode
  → subtitle เปลี่ยน → กล่องคำแปลไทยโผล่ใต้ข้อความอังกฤษ ไม่กระพริบ
  → hotkey snapshot: แปลครั้งเดียวค้างไว้
  → เปลี่ยน setting มีผลทันที
  → engine ล่ม → เห็นข้อความบอก ไม่ใช่เงียบ
```

---

## Requirements

- **Windows 10/11** (โปรเจกต์นี้ Windows-only โดยตั้งใจ เพื่อใช้ native API ที่ดีกว่า)
- Node.js >= 20, npm >= 10
- .NET SDK 10 (สำหรับ build sidecar)

---

## Development

> คำสั่งจะเพิ่มเมื่อเริ่มเขียนโค้ด — ตอนนี้ repo มีแต่เอกสารออกแบบ

```bash
cp .env.example .env
```

---

## License

Apache-2.0 — ดู [LICENSE](LICENSE)

โปรเจกต์นี้ศึกษา feature จาก open-source screen translator ตัวอื่น (ดู [reference-analysis.md](docs/reference-analysis.md)) แต่ **ไม่ได้คัดลอกโค้ดจากโปรเจกต์ใด** โค้ดทั้งหมดเขียนขึ้นใหม่
