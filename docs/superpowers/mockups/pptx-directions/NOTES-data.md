# Data-forward — build notes

**Palette** — ink `#141414`, muted `#6E7377`, hairline `#D6D9DB`, accent deep teal `#0F4C5C`;
semantic good `#1E7A4B` / warn `#8A6100` / bad `#B3261E`; doughnut ramp `#0F4C5C 2E6F7E 5B95A2 94B9C4 CBDDE2`.
**Fonts** — Leelawadee UI throughout (macOS falls back to Thonburi). Action titles 26pt bold, KPI numbers 44pt,
body 14–19pt, chart labels 11–13pt, footer 14pt.
**Aesthetic risk** — no fills, no cards, no gridlines anywhere: the whole deck is white space plus 0.75pt hairlines,
so a bar chart drawn wrong has nothing to hide behind. Slide 3 also colors bars by judgment (red below plan,
teal in band) instead of one flat series, which reads as an error state to anyone expecting a neutral chart.
**Charts** — plan band and bridge anchor lines are `addShape(line, dashType:"dash")` positioned by mapping the
value axis to inches; every chart sets an explicit manual plot `layout` plus `valAxisMinVal`/`valAxisMaxVal` so
that mapping is exact.
