// Direction: WARM REPORT — annual-report deck on warm grey-beige paper, deep plum blocks.
const PptxGenJS = require("../../../../server/node_modules/pptxgenjs");
const D = require("./data.js");

// ---------- palette ----------
const PAPER    = "E9E4DB"; // warm grey-beige paper ground
const PAPER_HI = "F2EEE7"; // lifted paper, used for pills
const INK      = "241F1C"; // warm brown-black
const INK_MUTE = "8A8076"; // warm grey, footers + captions
const PLUM     = "4B2E3D"; // deep plum, the block colour
const OCHRE    = "9A6A12"; // ochre, decoration + warn

// muted accent ladder for KPI tiles (tonal, never semantic)
const TILE = ["4B2E3D", "6E4550", "7A5A3E", "8E6B3A"];
const ON_TILE = "CFC4B6"; // label colour that sits on every tile

// semantic, kept apart from the accent
const SEM = { good: "3F6042", warn: OCHRE, bad: "A8392C" };

// chart tones — softer than the block colours so charts feel rounded
const C_REV = "6E4550", C_EXP = "B3A188";
const DONUT = ["4B2E3D", "7A4A50", "A0714B", "C09A5E", "D8C2A0"];

const FONT = "Leelawadee UI";
const M = 0.7;              // left margin, everything hangs off it
const W = 10 - M * 2;       // 8.6in content width

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_16x9";
pptx.author = "INFI";
pptx.company = D.company;

const S = pptx.ShapeType;
const baht = (n) => (n / 1e6).toFixed(2) + " ล้าน";
const mil = (n) => n / 1e6;

// ---------- shared chrome ----------
function footer(slide, page) {
  slide.addText(String(page).padStart(2, "0"), {
    x: M, y: 5.06, w: 1.0, h: 0.28, fontFace: FONT, fontSize: 10, color: INK_MUTE, align: "left",
  });
  slide.addText(D.source, {
    x: 10 - M - 6.0, y: 5.06, w: 6.0, h: 0.28, fontFace: FONT, fontSize: 10, color: INK_MUTE, align: "right",
  });
}
function page(bg) {
  const s = pptx.addSlide();
  s.background = { color: bg || PAPER };
  return s;
}
function title(slide, text) {
  slide.addText(text, {
    x: M, y: 0.46, w: W, h: 0.95, fontFace: FONT, fontSize: 28, bold: true,
    color: INK, align: "left", valign: "top", lineSpacingMultiple: 1.08,
  });
}
function kicker(slide, text) {
  slide.addText(text, {
    x: M, y: 0.18, w: W, h: 0.28, fontFace: FONT, fontSize: 14, color: INK_MUTE,
    align: "left", charSpacing: 1.4,
  });
}

// ================= 1. COVER — solid plum block, 58% of the slide =================
{
  const s = page();
  s.addShape(S.rect, { x: 0, y: 0, w: 10, h: 3.3, fill: { color: PLUM } });
  // decoration 1 of 3: ochre ring straddling the block edge
  s.addShape(S.ellipse, {
    x: 7.55, y: 2.62, w: 1.36, h: 1.36,
    fill: { type: "solid", color: PAPER, transparency: 100 },
    line: { color: OCHRE, width: 1.5 },
  });

  s.addText(D.company, {
    x: M, y: 0.72, w: W, h: 0.34, fontFace: FONT, fontSize: 14, color: ON_TILE, charSpacing: 1.6,
  });
  s.addText("รายงานผลประกอบการ\n" + D.period, {
    x: M, y: 1.22, w: 7.0, h: 1.6, fontFace: FONT, fontSize: 32, bold: true,
    color: PAPER, lineSpacingMultiple: 1.14, valign: "top",
  });
  s.addText(D.compare, {
    x: M, y: 3.58, w: 4.0, h: 0.32, fontFace: FONT, fontSize: 16, color: INK,
  });
  s.addText(D.unit + " · " + D.source, {
    x: M, y: 5.06, w: W, h: 0.28, fontFace: FONT, fontSize: 10, color: INK_MUTE,
  });
}

// ================= 2. KPI — 2x2 solid tiles =================
{
  const s = page();
  kicker(s, "ภาพรวม");
  title(s, "กำไรหด 67.5% รายได้หายเร็วกว่าที่ลดค่าใช้จ่ายได้");

  const tw = (W - 0.2) / 2, th = 1.6;
  D.kpis.forEach((k, i) => {
    const x = M + (i % 2) * (tw + 0.2);
    const y = 1.55 + Math.floor(i / 2) * (th + 0.15);
    s.addShape(S.rect, { x, y, w: tw, h: th, fill: { color: TILE[i] } });

    s.addText(k.label, {
      x: x + 0.28, y: y + 0.14, w: tw - 0.56, h: 0.28,
      fontFace: FONT, fontSize: 14, color: ON_TILE,
    });
    s.addText(typeof k.value === "number" ? baht(k.value) : k.value, {
      x: x + 0.28, y: y + 0.42, w: tw - 0.56, h: 0.68,
      fontFace: FONT, fontSize: 44, bold: true, color: PAPER, valign: "middle",
    });
    // delta on a paper pill, semantic colour
    s.addShape(S.roundRect, {
      x: x + 0.28, y: y + 1.10, w: 1.62, h: 0.38, rectRadius: 0.19,
      fill: { color: PAPER_HI },
    });
    s.addText(k.delta, {
      x: x + 0.28, y: y + 1.10, w: 1.62, h: 0.38,
      fontFace: FONT, fontSize: 20, bold: true, color: SEM[k.status],
      align: "center", valign: "middle",
    });
    s.addText("ปี 2568 " + (typeof k.prev === "number" ? baht(k.prev) : k.prev), {
      x: x + 2.05, y: y + 1.10, w: tw - 2.33, h: 0.38,
      fontFace: FONT, fontSize: 14, color: ON_TILE, valign: "middle",
    });
  });
  footer(s, 2);
}

// ================= 3. REVENUE AREA vs PLAN BAND =================
{
  const s = page();
  kicker(s, "รายได้รายเดือน · ล้านบาท");
  title(s, "รายได้ต่ำกว่าแผน 5 ใน 8 เดือน มีเพียง ก.ค. ที่ทะลุแผนบน");

  // translucent plan band behind the plot, mapped to valAxis 0–3 ล้าน
  const chart = { x: M, y: 1.45, w: W, h: 3.15 };
  const plotTop = 1.50, plotBot = 4.28, span = plotTop - plotBot; // negative
  const yFor = (v) => plotBot + span * (v / 3);
  const bTop = yFor(D.planBand[1] / 1e6), bBot = yFor(D.planBand[0] / 1e6);
  s.addShape(S.rect, {
    x: M + 0.35, y: bTop, w: W - 0.35, h: bBot - bTop,
    fill: { color: OCHRE, transparency: 82 }, line: { color: OCHRE, width: 0.75, transparency: 55 },
  });

  s.addChart(pptx.ChartType.area, [
    { name: "รายได้", labels: [D.months], values: D.revenue.map(mil) },
    { name: "ค่าใช้จ่าย", labels: [D.months], values: D.expense.map(mil) },
  ], {
    ...chart,
    chartColors: [C_REV, C_EXP],
    chartColorsOpacity: 58,
    showLegend: true, legendPos: "t", legendFontSize: 12, legendColor: INK, legendFontFace: FONT,
    showValue: false, dataLabelFontFace: FONT, dataLabelFontSize: 11, dataLabelColor: INK,
    catAxisLabelFontSize: 12, catAxisLabelColor: INK, catAxisLabelFontFace: FONT,
    valAxisLabelFontSize: 12, valAxisLabelColor: INK_MUTE, valAxisLabelFontFace: FONT,
    valAxisMinVal: 0, valAxisMaxVal: 3, valAxisMajorUnit: 1,
    valGridLine: { style: "none" },
    catGridLine: { style: "none" },
    catAxisLineShow: true, catAxisLineColor: INK_MUTE,
    valAxisLineShow: false,
    dataBorder: { pt: 0.75, color: PAPER },
  });

  s.addText("แถบสีคือแผนรายเดือน 2.12–2.34 ล้านบาท", {
    x: M, y: 4.62, w: W, h: 0.3, fontFace: FONT, fontSize: 14, color: INK_MUTE,
  });
  footer(s, 3);
}

// ================= 4. EXPENSE DOUGHNUT =================
{
  const s = page();
  kicker(s, "โครงสร้างค่าใช้จ่าย");
  title(s, "ค่าบริการทั่วไปกินค่าใช้จ่าย 54% เป็นจุดเดียวที่กดได้จริง");

  s.addChart(pptx.ChartType.doughnut, [{
    name: "ค่าใช้จ่าย",
    labels: [D.expenseStructure.map((r) => r[0])],
    values: D.expenseStructure.map((r) => r[1]),
  }], {
    x: M - 0.25, y: 1.5, w: 5.4, h: 3.3,
    chartColors: DONUT, holeSize: 56,
    showLegend: false,
    showValue: true, showPercent: false,
    dataLabelFontSize: 12, dataLabelColor: PAPER, dataLabelFontFace: FONT,
    // pptxgenjs XML-escapes formatCode, so pass a literal quote (pre-escaping double-encodes)
    dataLabelFormatCode: '#,##0,, "ล."',
    dataLabelPosition: "ctr",
    dataBorder: { pt: 1.25, color: PAPER },
  });

  // hand-built legend, left-aligned type instead of pptxgenjs' centred one
  D.expenseStructure.forEach((r, i) => {
    const y = 1.72 + i * 0.6;
    s.addShape(S.rect, { x: 5.6, y: y + 0.08, w: 0.22, h: 0.22, fill: { color: DONUT[i] } });
    s.addText(r[0], { x: 5.95, y, w: 2.3, h: 0.38, fontFace: FONT, fontSize: 16, color: INK, valign: "middle" });
    s.addText(baht(r[1]), { x: 8.15, y, w: 1.15, h: 0.38, fontFace: FONT, fontSize: 16, bold: true, color: INK, align: "right", valign: "middle" });
  });
  footer(s, 4);
}

// ================= 5. PROFIT BRIDGE =================
{
  const s = page();
  kicker(s, "สะพานกำไร · ล้านบาท");
  title(s, "รายได้บริการที่หายไป 9.75 ล้าน คือสาเหตุเดียวที่ใหญ่พอ");

  const tone = { start: PLUM, end: PLUM, pos: SEM.good, neg: SEM.bad };
  const rows = D.bridge.slice().reverse(); // barDir:"bar" plots bottom-up

  s.addChart(pptx.ChartType.bar, [{
    name: "ส่วนต่าง",
    labels: [rows.map((r) => r[0])],
    values: rows.map((r) => mil(r[1])),
  }], {
    x: M, y: 1.45, w: W, h: 3.2,
    barDir: "bar", barGapWidthPct: 45,
    chartColors: rows.map((r) => tone[r[2]]),
    showLegend: false,
    showValue: true,
    dataLabelFontSize: 12, dataLabelColor: INK, dataLabelFontFace: FONT,
    dataLabelFormatCode: "+#,##0.0;-#,##0.0",
    dataLabelPosition: "outEnd",
    catAxisLabelFontSize: 13, catAxisLabelColor: INK, catAxisLabelFontFace: FONT,
    valAxisHidden: true,
    valAxisLabelFontSize: 11,
    valGridLine: { style: "none" }, catGridLine: { style: "none" },
    catAxisLineShow: false, valAxisLineShow: false,
  });
  footer(s, 5);
}

// ================= 6. RISKS =================
{
  const s = page();
  kicker(s, "ความเสี่ยง");
  title(s, "สามความเสี่ยงที่ยังเปิดอยู่ ณ วันปิดรอบ");

  D.risks.forEach(([head, sub], i) => {
    const y = 1.62 + i * 1.12;
    s.addShape(S.line, { x: M, y, w: W, h: 0, line: { color: "CFC6B8", width: 1 } });
    s.addText(String(i + 1).padStart(2, "0"), {
      x: M, y: y + 0.16, w: 0.7, h: 0.36, fontFace: FONT, fontSize: 16, bold: true, color: OCHRE,
    });
    s.addText(head, {
      x: M + 0.72, y: y + 0.12, w: W - 0.72, h: 0.42, fontFace: FONT, fontSize: 20, bold: true, color: INK,
    });
    s.addText(sub, {
      x: M + 0.72, y: y + 0.56, w: W - 0.72, h: 0.34, fontFace: FONT, fontSize: 16, color: INK_MUTE,
    });
  });
  s.addShape(S.line, { x: M, y: 1.62 + 3 * 1.12, w: W, h: 0, line: { color: "CFC6B8", width: 1 } });
  footer(s, 6);
}

// ================= 7. DECISIONS =================
{
  const s = page();
  kicker(s, "การตัดสินใจ");
  title(s, "สามการตัดสินใจ ปิดได้ภายในเดือนนี้");

  const head = ["สิ่งที่ต้องทำ", "เจ้าของ", "ผลที่คาด"].map((t) => ({
    text: t,
    options: { fontFace: FONT, fontSize: 14, bold: true, color: PAPER, fill: { color: PLUM }, valign: "middle" },
  }));
  const body = D.decisions.map(([what, who, impact], i) => [
    { text: what, options: { fontFace: FONT, fontSize: 16, color: INK } },
    { text: who, options: { fontFace: FONT, fontSize: 16, color: INK_MUTE } },
    { text: impact, options: { fontFace: FONT, fontSize: 16, bold: true, color: OCHRE } },
  ]);
  s.addTable([head, ...body], {
    x: M, y: 1.6, w: W, colW: [4.7, 1.7, 2.2],
    rowH: [0.44, 0.72, 0.72, 0.72],
    border: [{ type: "none" }, { type: "none" }, { pt: 1, color: "CFC6B8" }, { type: "none" }],
    fill: { color: PAPER }, valign: "middle",
    margin: [0.06, 0.14, 0.06, 0.14],
  });
  footer(s, 7);
}

// ================= 8. CLOSING — block again, bottom-weighted =================
{
  const s = page();
  s.addShape(S.rect, { x: 0, y: 2.28, w: 10, h: 3.345, fill: { color: PLUM } });
  // decoration 3 of 3: ochre rule above the block
  s.addShape(S.line, { x: M, y: 1.9, w: 3.2, h: 0, line: { color: OCHRE, width: 2.25 } });

  s.addText("ถ้าไม่ทำอะไรเลย", {
    x: M, y: 1.02, w: W, h: 0.4, fontFace: FONT, fontSize: 14, color: INK_MUTE, charSpacing: 1.6,
  });
  s.addText("ปิดปีที่ 25.49 ล้านบาท", {
    x: M, y: 1.32, w: W, h: 0.6, fontFace: FONT, fontSize: 32, bold: true, color: INK,
  });
  s.addText(D.annualized, {
    x: M, y: 2.75, w: 7.6, h: 1.0, fontFace: FONT, fontSize: 20, color: PAPER, lineSpacingMultiple: 1.2, valign: "top",
  });
  s.addText("ต่ำกว่าปี 2568", {
    x: M, y: 4.0, w: 3.0, h: 0.32, fontFace: FONT, fontSize: 14, color: ON_TILE,
  });
  s.addText("4.8%", {
    x: M, y: 4.28, w: 3.0, h: 0.66, fontFace: FONT, fontSize: 44, bold: true, color: PAPER,
  });
  s.addText(D.source, {
    x: 10 - M - 6.0, y: 5.06, w: 6.0, h: 0.28, fontFace: FONT, fontSize: 10, color: ON_TILE, align: "right",
  });
  s.addText("08", {
    x: M, y: 5.06, w: 1.0, h: 0.28, fontFace: FONT, fontSize: 10, color: ON_TILE,
  });
}

pptx.writeFile({ fileName: __dirname + "/warm.pptx" }).then((f) => {
  // self-check: file lands, is a real package, and carries 8 slides
  const fs = require("fs"), zlib = require("zlib");
  const buf = fs.readFileSync(f);
  const assert = require("assert");
  assert.ok(buf.length > 30 * 1024, "pptx under 30 KB: " + buf.length);
  assert.equal(buf.slice(0, 2).toString(), "PK", "not a zip");
  const slides = (buf.toString("latin1").match(/ppt\/slides\/slide\d+\.xml/g) || []);
  assert.ok(new Set(slides).size >= 8, "expected 8 slides, saw " + new Set(slides).size);
  console.log("wrote", f, buf.length, "bytes,", new Set(slides).size, "slides");
});
