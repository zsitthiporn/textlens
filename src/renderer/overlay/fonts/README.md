# Bundled fonts

## NotoSansThai-VF.ttf

| | |
|---|---|
| Upstream name | `NotoSansThai[wdth,wght].ttf` |
| Source | https://github.com/google/fonts/tree/main/ofl/notosansthai |
| Retrieved | 2026-08-16 |
| Size | 214 KB |
| SHA-256 | `5A1C559BB539583C8A1FD99D1C5B9491E5E14478C9CD2BD0970D5C3096CC9EF8` |
| License | SIL Open Font License 1.1 — see `OFL.txt` |

**Renamed on the way in.** Upstream ships a variable font whose filename carries the
axis list in square brackets. `[` and `]` are glob metacharacters and need escaping
inside CSS `url()`, so the file is stored under a plain name and the original is
recorded here instead. Nothing about the font itself was modified — the SHA-256 above
is of the upstream bytes.

It is a **variable** font (`wdth`, `wght` axes), so one file covers every weight the
overlay needs; do not add static cuts alongside it.

## Why bundle at all

Windows ships Leelawadee UI, so a Thai font is in practice always present. It is
bundled anyway because [#24](https://github.com/zsitthiporn/textlens/issues/24)
requires the overlay to render correctly without depending on what the host machine
happens to have installed — the rendering of stacked Thai marks (สระบน + วรรณยุกต์ +
สระล่าง) differs between fonts, and the line-height and layout work in M5 is measured
against this one.

OFL 1.1 is compatible with the project's Apache-2.0 license as long as `OFL.txt`
travels with the font. Keep them together, including in the packaged installer.
