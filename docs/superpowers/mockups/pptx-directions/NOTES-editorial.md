# Bold editorial — notes

**Palette.** Ink `#0E1116` and warm paper `#F7F5F2` alternate full-bleed; one saturated lime accent `#E3FF4F` appears on at most one element per slide. Semantics are two-tier so contrast survives both grounds: on ink `#FF6B6B` / `#FFC53D` / `#4ADE80`, on paper `#C42B2B` / `#B26A00` / `#12805C`, with muted greys `#39414E` (ink) and `#C7CBD1` (paper) for non-focus bars.

**Fonts.** Leelawadee UI throughout. Bold 44–88pt for numbers, bold 30pt titles, regular 14–18pt labels, 11pt footer chrome only.

**Aesthetic risk.** The lime is loud enough to look wrong next to conservative accounting figures, and the deck leans on empty space hard — the closing slide is one 88pt number on black with roughly two-thirds of the canvas deliberately bare. A CEO who wants density will read it as unfinished.

**pptxgenjs workarounds.** Per-bar colors only render when a single series is passed, since the library emits `<c:dPt>` blocks only for one-series bar charts, so every chart is one series with a colour array. Charts default to a white plot area that punches a hole in the ink slides, so `chartArea.fill` and `plotArea.fill` are repainted to the slide ground on every chart. The bridge has no native waterfall, so it is a signed bar chart with `invertedColors` set to the same index-aligned array, otherwise the two negative bars would fall back to the default palette. Its category labels are pushed to `catAxisLabelPos: "low"` to stop them printing across the negative bars.

**Build.** `node build-editorial.js` writes `editorial.pptx`, 208 KB, 8 slides, no watermark.
