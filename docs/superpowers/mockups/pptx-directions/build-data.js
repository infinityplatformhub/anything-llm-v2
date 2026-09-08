// Direction: DATA-FORWARD — consulting-grade, chart-led.
// Run: node build-data.js   (from this folder)
const PptxGenJS = require("../../../../server/node_modules/pptxgenjs");
const D = require("./data.js");

// ---------------------------------------------------------------- palette
const FONT  = "Leelawadee UI";
const INK   = "141414"; // near-black
const MUTED = "6E7377"; // secondary text
const HAIR  = "D6D9DB"; // 0.75pt hairline rules
const ACC   = "0F4C5C"; // deep teal — the single accent
const GOOD  = "1E7A4B";
const BAD   = "B3261E";
const WARN  = "8A6100";
const RAMP  = ["0F4C5C", "2E6F7E", "5B95A2", "94B9C4", "CBDDE2"]; // teal ramp, doughnut only

const M   = (n) => (n / 1e6).toFixed(2);
const TH  = (n) => n.toLocaleString("en-US");
const SEM = { bad: BAD, warn: WARN, good: GOOD };

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_16x9"; // 10 x 5.625 in
pptx.author = "Infinity Platform";
pptx.title  = "INFI Executive Report 2569";

// ---------------------------------------------------------------- chrome
const L = 0.55, R = 9.45, W = R - L;

function rule(s, y, x = L, w = W, color = HAIR, width = 0.75) {
  s.addShape(pptx.ShapeType.line, { x, y, w, h: 0, line: { color, width } });
}
function title(s, text) {
  s.addText(text, {
    x: L, y: 0.38, w: W, h: 0.92, fontFace: FONT, fontSize: 26, bold: true,
    color: INK, align: "left", valign: "top", lineSpacingMultiple: 1.12,
  });
}
function footer(s, note, page) {
  rule(s, 5.0);
  s.addText(note, { x: L, y: 5.06, w: W - 0.9, h: 0.32, fontFace: FONT, fontSize: 14, color: MUTED, valign: "top" });
  s.addText(String(page), { x: R - 0.9, y: 5.06, w: 0.9, h: 0.32, fontFace: FONT, fontSize: 14, color: MUTED, align: "right", valign: "top" });
}

// Map a value-axis value to an absolute inch position on the slide.
// Only reliable because every chart below sets `layout` (manual inner plot area)
// AND explicit valAxisMinVal / valAxisMaxVal.
function axisMapper({ x, y, w, h }, layout, min, max) {
  const plotX = x + layout.x * w;
  const plotY = y + layout.y * h;
  const plotW = layout.w * w;
  const plotH = layout.h * h;
  return {
    plotX, plotY, plotW, plotH,
    yOf: (v) => plotY + plotH * ((max - v) / (max - min)),
  };
}

// ================================================================ 1 · cover
{
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  s.addText(D.company, { x: L, y: 1.15, w: W, h: 0.35, fontFace: FONT, fontSize: 16, color: MUTED, valign: "top" });
  s.addText("รายงานผลประกอบการ ผู้บริหาร", {
    x: L, y: 1.62, w: W, h: 0.62, fontFace: FONT, fontSize: 40, bold: true, color: INK, valign: "top",
  });
  s.addText(`${D.period} · ${D.compare}`, {
    x: L, y: 2.34, w: W, h: 0.44, fontFace: FONT, fontSize: 22, color: ACC, valign: "top",
  });
  rule(s, 3.05, L, 2.2, ACC, 2);
  s.addText("กำไรสุทธิ 2.54 ล้านบาท ลดลง 67.5% ต้นทุนไม่ได้ลดตามรายได้", {
    x: L, y: 3.32, w: 7.6, h: 0.5, fontFace: FONT, fontSize: 18, color: INK, valign: "top",
  });
  s.addText(`${D.source} · ${D.unit}`, {
    x: L, y: 4.95, w: W, h: 0.32, fontFace: FONT, fontSize: 14, color: MUTED, valign: "top",
  });
}

// ================================================================ 2 · KPI
{
  const s = pptx.addSlide();
  title(s, "รายได้หด 36.5% แต่กำไรหด 67.5% — ต้นทุนไม่ได้ลดตามรายได้");
  const cols = [
    { k: D.kpis[0], big: M(D.kpis[0].value), unit: "ล้านบาท", prev: `ปี 2568 · ${M(D.kpis[0].prev)} ล้านบาท` },
    { k: D.kpis[1], big: M(D.kpis[1].value), unit: "ล้านบาท", prev: `ปี 2568 · ${M(D.kpis[1].prev)} ล้านบาท` },
    { k: D.kpis[2], big: M(D.kpis[2].value), unit: "ล้านบาท", prev: `ปี 2568 · ${M(D.kpis[2].prev)} ล้านบาท` },
    { k: D.kpis[3], big: String(D.kpis[3].value), unit: "ของรายได้", prev: `ปี 2568 · ${D.kpis[3].prev}` },
  ];
  const cw = W / 4;
  rule(s, 1.5);
  cols.forEach((c, i) => {
    const x = L + i * cw;
    if (i > 0) s.addShape(pptx.ShapeType.line, { x: x - 0.16, y: 1.72, w: 0, h: 2.35, line: { color: HAIR, width: 0.75 } });
    s.addText(c.k.label, { x, y: 1.66, w: cw - 0.3, h: 0.3, fontFace: FONT, fontSize: 16, color: MUTED, valign: "top" });
    s.addText(c.big, { x, y: 2.02, w: cw - 0.3, h: 0.72, fontFace: FONT, fontSize: 44, bold: true, color: INK, valign: "top" });
    s.addText(c.unit, { x, y: 2.76, w: cw - 0.3, h: 0.3, fontFace: FONT, fontSize: 14, color: MUTED, valign: "top" });
    s.addText(c.k.delta, { x, y: 3.16, w: cw - 0.3, h: 0.42, fontFace: FONT, fontSize: 22, bold: true, color: SEM[c.k.status], valign: "top" });
    s.addText(c.prev, { x, y: 3.64, w: cw - 0.3, h: 0.3, fontFace: FONT, fontSize: 14, color: MUTED, valign: "top" });
  });
  footer(s, `${D.source} · ${D.unit} · ตัวเลข 8 เดือนแรกเทียบทั้งปี 2568`, 2);
}

// ================================================ 3 · revenue vs plan band
{
  const s = pptx.addSlide();
  title(s, "รายได้ต่ำกว่ากรอบแผน 5 ใน 8 เดือน และไม่มีเดือนใดฟื้นได้ต่อเนื่อง");

  const frame  = { x: L, y: 1.45, w: W, h: 3.35 };
  const layout = { x: 0.085, y: 0.05, w: 0.78, h: 0.78 };
  const VMIN = 0, VMAX = 3.0;
  const A = axisMapper(frame, layout, VMIN, VMAX);

  const [lo, hi] = D.planBand;
  const vals = D.revenue.map((v) => Number(M(v)));
  // per-point colors: judged against the plan band
  const colors = D.revenue.map((v) => (v < lo ? BAD : v > hi ? GOOD : ACC));

  s.addChart(pptx.ChartType.bar,
    [{ name: "รายได้", labels: D.months, values: vals }],
    {
      ...frame, layout,
      barDir: "col", barGapWidthPct: 55,
      chartColors: colors,
      showLegend: false, showTitle: false,
      showValue: true, dataLabelFontFace: FONT, dataLabelFontSize: 11,
      dataLabelColor: INK, dataLabelFormatCode: "0.00", dataLabelPosition: "outEnd",
      catAxisLabelFontFace: FONT, catAxisLabelFontSize: 13, catAxisLabelColor: INK,
      catAxisLineShow: true, catAxisLineColor: HAIR, catAxisMajorTickMark: "none",
      valAxisMinVal: VMIN, valAxisMaxVal: VMAX, valAxisMajorUnit: 0.5,
      valAxisLabelFontFace: FONT, valAxisLabelFontSize: 11, valAxisLabelColor: MUTED,
      valAxisLabelFormatCode: "0.0", valAxisLineShow: false, valAxisMajorTickMark: "none",
      valGridLine: { style: "none" }, catGridLine: { style: "none" },
    });

  // plan band: two hairline dashed rules, drawn after the chart so they sit on top
  [{ v: hi, tag: `แผนบน ${M(hi)}`, dy: -0.20 }, { v: lo, tag: `แผนล่าง ${M(lo)}`, dy: 0.02 }].forEach((b) => {
    const y = A.yOf(Number(M(b.v)));
    s.addShape(pptx.ShapeType.line, {
      x: A.plotX, y, w: A.plotW, h: 0, line: { color: ACC, width: 1, dashType: "dash" },
    });
    s.addText(b.tag, {
      x: A.plotX + A.plotW + 0.06, y: y + b.dy, w: 1.1, h: 0.22,
      fontFace: FONT, fontSize: 12, color: ACC, valign: "top",
    });
  });

  footer(s, `กรอบแผน = ค่าเฉลี่ยรายเดือนปี 2568 ±5% (${TH(lo)}–${TH(hi)} บาท) · ${D.source}`, 3);
}

// ================================================== 4 · expense structure
{
  const s = pptx.addSlide();
  title(s, "ค่าบริการทั่วไปกินค่าใช้จ่าย 54% และเป็นก้อนเดียวที่โตขึ้นจากปีก่อน");

  const rows  = D.expenseStructure;
  const total = rows.reduce((a, r) => a + r[1], 0);

  const ring = { x: 0.5, y: 1.42, w: 3.9, h: 3.45 };
  s.addChart(pptx.ChartType.doughnut,
    [{ name: "ค่าใช้จ่าย", labels: rows.map((r) => r[0]), values: rows.map((r) => r[1]) }],
    {
      ...ring, layout: { x: 0.04, y: 0.04, w: 0.92, h: 0.92 },
      holeSize: 62, chartColors: RAMP, dataBorder: { pt: 1.5, color: "FFFFFF" },
      showLegend: false, showTitle: false, showValue: false, showPercent: false,
      showLabel: false, dataLabelFontSize: 11, dataNoEffects: true,
    });
  // total in the hole
  s.addText(M(total), {
    x: ring.x + ring.w / 2 - 1.0, y: ring.y + ring.h / 2 - 0.46, w: 2.0, h: 0.6,
    fontFace: FONT, fontSize: 34, bold: true, color: INK, align: "center", valign: "middle",
  });
  s.addText("ล้านบาท", {
    x: ring.x + ring.w / 2 - 1.0, y: ring.y + ring.h / 2 + 0.14, w: 2.0, h: 0.28,
    fontFace: FONT, fontSize: 14, color: MUTED, align: "center", valign: "top",
  });

  // ranked read-out, hairline rules only
  const tx = 4.85, tw = R - tx;
  let y = 1.5;
  rule(s, y, tx, tw);
  rows.forEach((r, i) => {
    const pct = ((r[1] / total) * 100).toFixed(0);
    s.addShape(pptx.ShapeType.rect, { x: tx, y: y + 0.20, w: 0.16, h: 0.16, fill: { color: RAMP[i] }, line: { color: RAMP[i], width: 0 } });
    s.addText(r[0], { x: tx + 0.3, y: y + 0.11, w: 2.5, h: 0.34, fontFace: FONT, fontSize: 16, color: INK, valign: "middle" });
    s.addText(`${pct}%`, { x: tx + 2.75, y: y + 0.11, w: 0.7, h: 0.34, fontFace: FONT, fontSize: 16, bold: true, color: i === 0 ? WARN : INK, align: "right", valign: "middle" });
    s.addText(TH(r[1]), { x: tx + 3.5, y: y + 0.11, w: 1.05, h: 0.34, fontFace: FONT, fontSize: 15, color: MUTED, align: "right", valign: "middle" });
    y += 0.56;
    rule(s, y, tx, tw);
  });
  s.addText("ค่าบริการทั่วไปเพิ่มขึ้น 1,798,789 บาทจากปี 2568 สวนทางกับรายได้ที่หายไป", {
    x: tx, y: y + 0.16, w: tw, h: 0.6, fontFace: FONT, fontSize: 15, color: WARN, valign: "top", lineSpacingMultiple: 1.15,
  });

  footer(s, `รวมค่าใช้จ่าย ${TH(total)} บาท · ${D.source}`, 4);
}

// ======================================================= 5 · profit bridge
{
  const s = pptx.addSlide();
  title(s, "กำไรหายไป 5.28 ล้านบาท เกือบทั้งหมดมาจากรายได้บริการที่หายไป 9.75 ล้าน");

  const frame  = { x: L, y: 1.42, w: W, h: 3.4 };
  const layout = { x: 0.085, y: 0.05, w: 0.76, h: 0.70 };
  const VMIN = -12, VMAX = 12;
  const A = axisMapper(frame, layout, VMIN, VMAX);

  const short = ["กำไร 2568", "รายได้หาย", "ค่าบริการเพิ่ม", "ค่าพนักงานลด", "เบ็ดเตล็ดไม่ซ้ำ", "อื่นๆ", "กำไร 8 ด. 2569"];
  const vals  = D.bridge.map((b) => Number(M(b[1])));
  const cols  = D.bridge.map((b) => (b[2] === "neg" ? BAD : b[2] === "pos" ? GOOD : ACC));

  s.addChart(pptx.ChartType.bar,
    [{ name: "ผลต่างกำไร", labels: short, values: vals }],
    {
      ...frame, layout,
      barDir: "col", barGapWidthPct: 45,
      chartColors: cols, // per-point: single series + >1 color => pptxgenjs emits <c:dPt>
      showLegend: false, showTitle: false,
      showValue: true, dataLabelFontFace: FONT, dataLabelFontSize: 11, dataLabelBold: true,
      dataLabelColor: INK, dataLabelFormatCode: "0.00;-0.00", dataLabelPosition: "outEnd",
      catAxisLabelFontFace: FONT, catAxisLabelFontSize: 11, catAxisLabelColor: INK,
      catAxisLabelPos: "low", catAxisLineShow: true, catAxisLineColor: "9AA0A4",
      catAxisMajorTickMark: "none",
      valAxisMinVal: VMIN, valAxisMaxVal: VMAX, valAxisMajorUnit: 6,
      valAxisLabelFontFace: FONT, valAxisLabelFontSize: 11, valAxisLabelColor: MUTED,
      valAxisLabelFormatCode: "0", valAxisLineShow: false, valAxisMajorTickMark: "none",
      valGridLine: { style: "none" }, catGridLine: { style: "none" },
    });

  [
    { v: Number(M(D.bridge[0][1])), tag: `ตั้งต้น ${M(D.bridge[0][1])}`, dy: -0.22 },
    { v: Number(M(D.bridge[6][1])), tag: `ปลายทาง ${M(D.bridge[6][1])}`, dy: -0.22 },
  ].forEach((b) => {
    const y = A.yOf(b.v);
    s.addShape(pptx.ShapeType.line, { x: A.plotX, y, w: A.plotW, h: 0, line: { color: MUTED, width: 1, dashType: "dash" } });
    s.addText(b.tag, { x: A.plotX + A.plotW + 0.06, y: y + b.dy, w: 1.15, h: 0.24, fontFace: FONT, fontSize: 12, color: INK, valign: "top" });
  });

  footer(s, "แท่งคือผลต่างจากปี 2568 ทั้งปี ไม่ใช่ยอดสะสม · หน่วย: ล้านบาท · " + D.source, 5);
}

// =============================================================== 6 · risks
{
  const s = pptx.addSlide();
  title(s, "ความเสี่ยงเร่งด่วนสามข้อ ทั้งหมดยังปิดได้ภายในเดือน ก.ย. นี้");
  const hair = [{ type: "none" }, { type: "none" }, { type: "solid", color: HAIR, pt: 0.75 }, { type: "none" }];
  const rows = D.risks.map((r) => ([
    { text: r[0], options: { fontFace: FONT, fontSize: 19, bold: true, color: INK, valign: "middle", border: hair, margin: [0.1, 0, 0.1, 0] } },
    { text: r[1], options: { fontFace: FONT, fontSize: 16, color: MUTED, valign: "middle", align: "right", border: hair, margin: [0.1, 0, 0.1, 0] } },
  ]));
  rule(s, 1.55);
  s.addTable(rows, { x: L, y: 1.55, w: W, colW: [5.1, 3.8], rowH: [0.92, 0.92, 0.92] });
  s.addText("ทั้งสามข้อเป็นเรื่องเอกสารและสัญญา ไม่ใช่เรื่องความต้องการของตลาด", {
    x: L, y: 4.42, w: W, h: 0.4, fontFace: FONT, fontSize: 16, color: ACC, valign: "top",
  });
  footer(s, D.source, 6);
}

// =========================================================== 7 · decisions
{
  const s = pptx.addSlide();
  title(s, "สามการตัดสินใจ คืนกำไรได้ราว 390,000 บาท/ปี ด้วยต้นทุนเกือบศูนย์");
  const hair = [{ type: "none" }, { type: "none" }, { type: "solid", color: HAIR, pt: 0.75 }, { type: "none" }];
  const cell = (t, o) => ({ text: t, options: { fontFace: FONT, valign: "middle", border: hair, margin: [0.1, 0, 0.1, 0], ...o } });

  const head = [
    cell("", {}),
    cell("การตัดสินใจ", { fontSize: 14, color: MUTED }),
    cell("เจ้าของ", { fontSize: 14, color: MUTED }),
    cell("ผลที่คาด", { fontSize: 14, color: MUTED, align: "right" }),
  ];
  const rows = D.decisions.map((d, i) => ([
    cell(String(i + 1), { fontSize: 20, bold: true, color: ACC }),
    cell(d[0], { fontSize: 18, color: INK }),
    cell(d[1], { fontSize: 16, color: MUTED }),
    cell(d[2], { fontSize: 17, bold: true, color: GOOD, align: "right" }),
  ]));
  rule(s, 1.5);
  s.addTable([head, ...rows], { x: L, y: 1.5, w: W, colW: [0.5, 4.6, 1.85, 1.95], rowH: [0.42, 0.9, 0.9, 0.9] });
  footer(s, "ผลที่คาดของข้อ 2 คำนวณจากค่าบริการทั่วไป 7,799,188 บาท × 5% · " + D.source, 7);
}

// ============================================================= 8 · closing
{
  const s = pptx.addSlide();
  title(s, "ถ้ารักษาระดับรายได้เดิมไว้ได้ ปิดปีที่ 25.49 ล้านบาท ต่ำกว่าปีก่อนเพียง 4.8%");

  rule(s, 1.62);
  s.addText("ประมาณการทั้งปี 2569", { x: L, y: 1.78, w: 4.2, h: 0.32, fontFace: FONT, fontSize: 16, color: MUTED, valign: "top" });
  s.addText("25.49", { x: L, y: 2.12, w: 4.2, h: 1.0, fontFace: FONT, fontSize: 64, bold: true, color: ACC, valign: "top" });
  s.addText("ล้านบาท", { x: L, y: 3.16, w: 4.2, h: 0.32, fontFace: FONT, fontSize: 16, color: MUTED, valign: "top" });

  s.addShape(pptx.ShapeType.line, { x: 4.95, y: 1.78, w: 0, h: 1.72, line: { color: HAIR, width: 0.75 } });
  s.addText("ปี 2568 ทำได้", { x: 5.25, y: 1.78, w: 4.2, h: 0.32, fontFace: FONT, fontSize: 16, color: MUTED, valign: "top" });
  s.addText("26.77", { x: 5.25, y: 2.12, w: 4.2, h: 0.7, fontFace: FONT, fontSize: 44, bold: true, color: INK, valign: "top" });
  s.addText("ล้านบาท · ส่วนต่าง -4.8%", { x: 5.25, y: 2.86, w: 4.2, h: 0.32, fontFace: FONT, fontSize: 16, color: MUTED, valign: "top" });
  s.addText("แต่กำไรจะไม่กลับมาเอง ถ้าค่าบริการทั่วไปยังโตสวนทางรายได้", {
    x: 5.25, y: 3.24, w: 4.2, h: 0.6, fontFace: FONT, fontSize: 16, color: BAD, valign: "top", lineSpacingMultiple: 1.15,
  });

  rule(s, 3.72);
  s.addText(D.annualized, { x: L, y: 3.9, w: W, h: 0.7, fontFace: FONT, fontSize: 18, color: INK, valign: "top", lineSpacingMultiple: 1.2 });
  footer(s, D.source, 8);
}

pptx.writeFile({ fileName: "data.pptx" }).then((f) => console.log("wrote", f));
