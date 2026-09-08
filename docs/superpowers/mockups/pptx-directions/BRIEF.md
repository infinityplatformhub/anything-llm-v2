# Brief — one design direction, real .pptx via pptxgenjs

Goal: a deck a CEO would call beautiful. The previous attempt was rejected as "template garbage:
small type, boxes in a row, weak charts". Do not repeat it.

Hard constraints (this mockup defines the ceiling of a real tool that will later generate decks):
- Node script `build.js` in this folder, run with `node build.js` from this folder. Require pptxgenjs from
  `../../../../server/node_modules/pptxgenjs`. Output `<direction>.pptx` in this folder.
- Everything must be pptxgenjs-native: `addText`, `addShape` (rect, roundRect, ellipse, line), `addChart`
  (bar, line, doughnut, pie, area), `addTable`. No external images, no SVG, no raster.
- Content from `./data.js` only. 8 slides: cover · KPI summary · monthly revenue vs plan band ·
  expense structure · profit bridge (bar with pos/neg colors; native waterfall does not exist) ·
  risks · decisions · closing/annualized. Fewer slides is fine if a slide is empty of purpose.
- Layout LAYOUT_16x9 (10 × 5.625 in). Thai + English text: fontFace "Leelawadee UI" for everything
  (macOS falls back to Thonburi/Sarabun — acceptable).
- Minimum body text 14pt, chart labels 11pt, titles 26pt+. KPI numbers 40pt+. Read from across a room.
- One idea per slide. A slide is: one big statement (the title IS the conclusion), one visual, at most
  one supporting line. No bullet lists longer than 3. No "Created with" watermark.
- Semantic colors for good/warn/bad separate from the accent. Chart series colors from your palette,
  passed via `chartColors`. Set `showValue`, `catAxisLabelFontSize`, `valAxisLabelFontSize`,
  `dataLabelFontSize`, `showLegend` deliberately on every chart; hide gridlines or make them faint
  (`valGridLine: { style: "none" }` or a light color). Never leave a chart on pptxgenjs defaults.
- Consistent chrome: the same tiny footer (page number + source) in the same place on every content slide.
- Forbidden: colored left-border accent strips on cards, takeaway boxes in a corner, emoji, gradients as
  a default wash, everything centered, `rounded` cards with shadow on every block.

Deliver: `build.js`, the `.pptx`, and a 5-line `NOTES.md` stating the palette (hex), fonts, and the one
aesthetic risk you took. Run the build and confirm the file exists and is > 30 KB. Do not open the file.
