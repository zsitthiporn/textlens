# Spike S1 harness — OCR engine benchmark

> ⚠️ **Throwaway code ไม่ใช่ product code** — ไม่ต้อง review คุณภาพ ไม่ต้อง maintain
> เก็บไว้เพราะต้องรันซ้ำเมื่อได้ภาพ capture จริงจากผู้ใช้
>
> ผลและข้อสรุป: [docs/spikes/2026-08-15-s1-ocr-engine.md](../../docs/spikes/2026-08-15-s1-ocr-engine.md)

## ไฟล์

| ไฟล์ | ทำอะไร |
|---|---|
| `win-ocr.ps1` | รัน Windows.Media.Ocr (ผ่าน WinRT จาก PowerShell) ทับทั้งโฟลเดอร์ → JSON |
| `paddle-ocr.mjs` | รัน PaddleOCR (`ppu-paddle-ocr`) ทับโฟลเดอร์เดียวกัน → JSON |
| `compare.mjs` | เทียบสองผลลัพธ์: latency percentile + agreement rate |
| `crop-test.ps1` | crop เป็น region ขนาดจริงแล้ววัด latency/accuracy เทียบกับเต็มจอ |
| `results/` | ผลดิบจากการรันเมื่อ 2026-08-15 (92 ภาพ) |

## รันซ้ำ

```bash
npm install ppu-paddle-ocr onnxruntime-node
```

```bash
powershell -File win-ocr.ps1 -ImageDir ./images -OutJson ./results/win-ocr-results.json
```

```bash
node paddle-ocr.mjs ./images ./results/paddle-results.json
```

```bash
node compare.mjs .
```

## ข้อควรรู้

- `win-ocr.ps1` ต้องใช้ **Windows PowerShell 5.1** (WinRT interop) ไม่ใช่ PowerShell 7
- ต้องมี **en-US OCR recognizer** ติดตั้งอยู่ ตรวจด้วย:

```bash
powershell -Command "[Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | % { $_.LanguageTag }"
```

- PowerShell เขียน JSON พร้อม BOM — `compare.mjs` ตัด BOM ให้แล้ว
- PaddleOCR ดาวน์โหลด model ครั้งแรก ~50 วินาที แล้ว cache ที่ `~/.cache/ppu-paddle-ocr`
- ชุดภาพเดิมดึงจาก Steam store API (official screenshot) ไม่ได้ commit ไว้เพราะเป็นภาพลิขสิทธิ์ของผู้พัฒนาเกม
