// Bold editorial direction — INFI executive deck.
// Run: node build-editorial.js   (from this folder)
const path = require("path");
const PptxGenJS = require(path.join(__dirname, "../../../../server/node_modules/pptxgenjs"));
const D = require("./data.js");

// ---- palette -------------------------------------------------------------
const INK = "0E1116"; // full-bleed slides
const PAPER = "F7F5F2"; // warm paper slides
const ACCENT = "E3FF4F"; // saturated lime — max one element per slide, never as text on paper

// two-tier semantics so contrast holds on both grounds
const ON_INK = { text: "FFFFFF", dim: "8A93A3", faint: "5A6475", bad: "FF6B6B", warn: "FFC53D", good: "4ADE80", mute: "39414E" };
const ON_PAPER = { text: "0E1116", dim: "6B7280", faint: "9AA3AE", bad: "C42B2B", warn: "B26A00", good: "12805C", mute: "C7CBD1" };

const F = "Leelawadee UI";
const M = (v) => (v / 1e6).toFixed(2);
const PLAN_LO = D.planBand[0];

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_16x9"; // 10 x 5.625 in
pptx.author = "INFI";
pptx.title = "INFI Executive Report 2569";

const L = 0.62; // left margin
const W = 8.76; // content width

let page = 0;
function footer(slide, onInk) {
  page += 1;
  const c = onInk ? ON_INK.faint : ON_PAPER.faint;
  const n = String(page).padStart(2, "0");
  slide.addText(`หน้า ${n}`, { x: L, y: 5.06, w: 2.0, h: 0.28, fontFace: F, fontSize: 11, color: c, valign: "middle" });
  slide.addText(`${D.source} · ${D.unit}`, { x: 3.0, y: 5.06, w: 6.38, h: 0.28, fontFace: F, fontSize: 11, color: c, align: "right", valign: "middle" });
}
function newSlide(onInk) {
  const s = pptx.addSlide();
  s.background = { color: onInk ? INK : PAPER };
  return s;
}
function rule(slide, y, color = ACCENT, w = 1.1) {
  slide.addShape(pptx.shapes.RECTANGLE, { x: L, y, w, h: 0.075, fill: { color }, line: { color, width: 0 } });
}
function title(slide, text, onInk, sub) {
  const p = onInk ? ON_INK : ON_PAPER;
  slide.addText(text, { x: L, y: 0.46, w: W, h: 0.62, fontFace: F, fontSize: 30, bold: true, color: p.text, valign: "middle" });
  if (sub) slide.addText(sub, { x: L, y: 1.08, w: W, h: 0.32, fontFace: F, fontSize: 14, color: p.dim, valign: "middle" });
}
// charts must repaint their own ground or they punch a white hole in an ink slide
function ground(onInk) {
  const bg = onInk ? INK : PAPER;
  return { chartArea: { fill: { color: bg } }, plotArea: { fill: { color: bg } } };
}
const AXIS_OFF = {
  showLegend: false,
  valAxisHidden: true,
  valAxisLineShow: false,
  valGridLine: { style: "none" },
  catGridLine: { style: "none" },
  catAxisLineShow: false,
  catAxisMajorTickMark: "none",
  valAxisMajorTickMark: "none",
};

// ---- 1 · cover (ink) -----------------------------------------------------
{
  const s = newSlide(true);
  s.addText(`${D.company}`, { x: L, y: 0.46, w: W, h: 0.3, fontFace: F, fontSize: 13, color: ON_INK.dim, charSpacing: 1.4 });
  s.addText("รายงานผู้บริหาร", { x: L, y: 0.78, w: W, h: 0.3, fontFace: F, fontSize: 13, color: ON_INK.faint, charSpacing: 1.4 });
  rule(s, 2.02);
  s.addText(
    [
      { text: "รายได้หาย 36.5%", options: { breakLine: true } },
      { text: "กำไรหาย 67.5%", options: {} },
    ],
    { x: L, y: 2.24, w: 8.2, h: 1.95, fontFace: F, fontSize: 60, bold: true, color: ON_INK.text, lineSpacingMultiple: 1.05, valign: "top" }
  );
  s.addText(`${D.period} · ${D.compare}`, { x: L, y: 4.34, w: 7.0, h: 0.34, fontFace: F, fontSize: 16, color: ON_INK.dim });
  s.addText(D.source, { x: L, y: 5.06, w: W, h: 0.28, fontFace: F, fontSize: 11, color: ON_INK.faint });
}

// ---- 2 · KPI summary (paper) — 4 giant numbers, no boxes -----------------
{
  const s = newSlide(false);
  title(s, "ตัวเลขหลักทั้งสี่ลดลงพร้อมกัน", false, `${D.period} · ${D.compare} · ${D.unit}`);
  const cells = [
    { label: D.kpis[0].label, big: M(D.kpis[0].value), unit: "ล้านบาท", delta: D.kpis[0].delta, status: D.kpis[0].status },
    { label: D.kpis[1].label, big: M(D.kpis[1].value), unit: "ล้านบาท", delta: D.kpis[1].delta, status: D.kpis[1].status },
    { label: D.kpis[2].label, big: M(D.kpis[2].value), unit: "ล้านบาท", delta: D.kpis[2].delta, status: D.kpis[2].status },
    { label: D.kpis[3].label, big: String(D.kpis[3].value), unit: "ของรายได้", delta: D.kpis[3].delta, status: D.kpis[3].status },
  ];
  const cols = [L, 5.05];
  const rows = [1.62, 3.28];
  cells.forEach((c, i) => {
    const x = cols[i % 2];
    const y = rows[Math.floor(i / 2)];
    const col = ON_PAPER[c.status] || ON_PAPER.text;
    s.addText(c.label, { x, y, w: 4.3, h: 0.28, fontFace: F, fontSize: 14, color: ON_PAPER.dim, charSpacing: 1.2 });
    s.addText(c.big, { x, y: y + 0.24, w: 2.9, h: 0.92, fontFace: F, fontSize: 54, bold: true, color: ON_PAPER.text, valign: "middle" });
    s.addText(c.unit, { x: x + 2.62, y: y + 0.62, w: 1.7, h: 0.3, fontFace: F, fontSize: 14, color: ON_PAPER.faint, valign: "middle" });
    s.addText(c.delta, { x, y: y + 1.14, w: 4.3, h: 0.34, fontFace: F, fontSize: 20, bold: true, color: col, valign: "middle" });
  });
  footer(s, false);
}

// ---- 3 · monthly revenue vs plan (paper) ---------------------------------
{
  const s = newSlide(false);
  title(s, "รายได้ต่ำกว่าแผน 5 ใน 8 เดือน มีเพียง ก.ค. ที่ทะลุ", false, `เส้นแผนล่าง ${PLAN_LO.toLocaleString("en-US")} บาท/เดือน · แท่งเทาคือเดือนที่ต่ำกว่าแผน · หน่วย ล้านบาท`);
  const colors = D.revenue.map((v, i) => (i === 6 ? ACCENT : v >= PLAN_LO ? ON_PAPER.text : ON_PAPER.mute));
  s.addChart(
    pptx.charts.BAR,
    [{ name: "รายได้", labels: D.months, values: D.revenue.map((v) => Number(M(v))) }],
    {
      x: L, y: 1.7, w: W, h: 3.05,
      ...AXIS_OFF,
      ...ground(false),
      chartColors: colors,
      barGapWidthPct: 42,
      valAxisMaxVal: 3.4,
      valAxisMinVal: 0,
      showValue: true,
      dataLabelFontFace: F,
      dataLabelFontSize: 12,
      dataLabelFontBold: true,
      dataLabelColor: ON_PAPER.text,
      dataLabelPosition: "outEnd",
      dataLabelFormatCode: "0.00",
      catAxisLabelFontFace: F,
      catAxisLabelFontSize: 13,
      catAxisLabelColor: ON_PAPER.dim,
    }
  );
  footer(s, false);
}

// ---- 4 · expense structure (ink) -----------------------------------------
{
  const s = newSlide(true);
  const total = D.expenseStructure.reduce((a, b) => a + b[1], 0);
  const share = Math.round((D.expenseStructure[0][1] / total) * 100);
  title(s, `ค่าบริการทั่วไปกิน ${share}% ของค่าใช้จ่ายทั้งหมด`, true, `ค่าใช้จ่ายรวม ${total.toLocaleString("en-US")} บาท · หน่วย ล้านบาท`);
  // horizontal bars render bottom-up, so reverse to put the biggest on top
  const rowsData = [...D.expenseStructure].reverse();
  const barColors = rowsData.map((r) => (r[0] === D.expenseStructure[0][0] ? ACCENT : ON_INK.mute));
  s.addChart(
    pptx.charts.BAR,
    [{ name: "ค่าใช้จ่าย", labels: rowsData.map((r) => r[0]), values: rowsData.map((r) => Number(M(r[1]))) }],
    {
      x: L, y: 1.62, w: W, h: 3.2,
      barDir: "bar",
      ...AXIS_OFF,
      ...ground(true),
      chartColors: barColors,
      barGapWidthPct: 46,
      valAxisMaxVal: 9.4,
      valAxisMinVal: 0,
      showValue: true,
      dataLabelFontFace: F,
      dataLabelFontSize: 12,
      dataLabelFontBold: true,
      dataLabelColor: ON_INK.text,
      dataLabelPosition: "outEnd",
      dataLabelFormatCode: "0.00",
      catAxisLabelFontFace: F,
      catAxisLabelFontSize: 13,
      catAxisLabelColor: ON_INK.dim,
    }
  );
  footer(s, true);
}

// ---- 5 · profit bridge (paper) -------------------------------------------
{
  const s = newSlide(false);
  title(s, "รายได้ที่หายไปคือสาเหตุเดียวที่ใหญ่พอจะอธิบายกำไร", false, "ส่วนต่างกำไรสุทธิ 2568 → 8 เดือนแรก 2569 · หน่วย ล้านบาท");
  const shortLabel = { "กำไรสุทธิ 2568": "กำไร 2568", "รายได้บริการหาย": "รายได้หาย", "ค่าบริการทั่วไปเพิ่ม": "ค่าบริการเพิ่ม", "ค่าพนักงานลด": "ค่าพนักงานลด", "เบ็ดเตล็ด 2568 ไม่เกิดซ้ำ": "เบ็ดเตล็ดไม่ซ้ำ", "อื่นๆ": "อื่นๆ", "กำไรสุทธิ 8 ด. 2569": "กำไร 8ด. 2569" };
  const labels = D.bridge.map((b) => shortLabel[b[0]] || b[0]);
  const values = D.bridge.map((b) => Number(M(b[1])));
  const kind = D.bridge.map((b) => b[2]);
  const colors = kind.map((k) => (k === "start" ? ON_PAPER.faint : k === "end" ? ACCENT : k === "neg" ? ON_PAPER.bad : ON_PAPER.good));
  s.addChart(
    pptx.charts.BAR,
    [{ name: "ส่วนต่าง", labels, values }],
    {
      x: 0.55, y: 1.7, w: 8.9, h: 3.05,
      ...AXIS_OFF,
      ...ground(false),
      chartColors: colors,
      invertedColors: colors, // negatives read the same index-aligned palette
      barGapWidthPct: 40,
      valAxisMaxVal: 9.0,
      valAxisMinVal: -11.0,
      showValue: true,
      dataLabelFontFace: F,
      dataLabelFontSize: 11,
      dataLabelFontBold: true,
      dataLabelColor: ON_PAPER.text,
      dataLabelPosition: "outEnd",
      dataLabelFormatCode: "0.00",
      catAxisLabelFontFace: F,
      catAxisLabelFontSize: 11,
      catAxisLabelColor: ON_PAPER.dim,
      catAxisLabelPos: "low", // keep names off the bars when values go negative
    }
  );
  footer(s, false);
}

// ---- 6 · risks (ink) — three giant numbers -------------------------------
{
  const s = newSlide(true);
  title(s, "สามสัญญาณที่ต้องจัดการภายในเดือนนี้", true);
  const big = [
    { n: "0", color: ON_INK.bad },
    { n: "+30%", color: ON_INK.warn },
    { n: "5 / 8", color: ON_INK.warn },
  ];
  const ys = [1.52, 2.66, 3.80];
  D.risks.forEach((r, i) => {
    s.addText(big[i].n, { x: L, y: ys[i], w: 2.35, h: 0.78, fontFace: F, fontSize: 44, bold: true, color: big[i].color, valign: "middle" });
    s.addText(r[0], { x: 3.05, y: ys[i] + 0.06, w: 6.33, h: 0.36, fontFace: F, fontSize: 18, bold: true, color: ON_INK.text, valign: "middle" });
    s.addText(r[1], { x: 3.05, y: ys[i] + 0.42, w: 6.33, h: 0.34, fontFace: F, fontSize: 14, color: ON_INK.dim, valign: "middle" });
  });
  footer(s, true);
}

// ---- 7 · decisions (paper) -----------------------------------------------
{
  const s = newSlide(false);
  title(s, "สามการตัดสินใจ ต้นทุนต่ำ ผลชัดภายในไตรมาสนี้", false);
  const ys = [1.56, 2.70, 3.84];
  D.decisions.forEach((d, i) => {
    s.addText(String(i + 1).padStart(2, "0"), { x: L, y: ys[i], w: 1.05, h: 0.8, fontFace: F, fontSize: 44, bold: true, color: "E5E2DC", valign: "middle" });
    s.addText(d[0], { x: 1.72, y: ys[i] + 0.06, w: 5.5, h: 0.38, fontFace: F, fontSize: 18, bold: true, color: ON_PAPER.text, valign: "middle" });
    s.addText(d[1], { x: 1.72, y: ys[i] + 0.44, w: 5.5, h: 0.32, fontFace: F, fontSize: 14, color: ON_PAPER.dim, valign: "middle" });
    const chip = i === 1; // the one decision with a quantified baht saving
    if (chip) s.addShape(pptx.shapes.RECTANGLE, { x: 7.35, y: ys[i] + 0.15, w: 2.03, h: 0.42, fill: { color: ACCENT }, line: { color: ACCENT, width: 0 } });
    s.addText(d[2], { x: 7.35, y: ys[i] + 0.15, w: 2.03, h: 0.42, fontFace: F, fontSize: 14, bold: chip, color: chip ? ON_PAPER.text : ON_PAPER.dim, align: "right", valign: "middle" });
  });
  footer(s, false);
}

// ---- 8 · closing / annualized (ink) --------------------------------------
{
  const s = newSlide(true);
  s.addText("ประมาณการปิดปี 2569", { x: L, y: 0.46, w: W, h: 0.32, fontFace: F, fontSize: 13, color: ON_INK.dim, charSpacing: 1.4 });
  rule(s, 1.52);
  s.addText("25.49", { x: L, y: 1.76, w: 4.3, h: 1.5, fontFace: F, fontSize: 88, bold: true, color: ON_INK.text, valign: "middle" });
  s.addText("ล้านบาท", { x: 4.55, y: 1.92, w: 2.2, h: 0.4, fontFace: F, fontSize: 18, color: ON_INK.dim, valign: "middle" });
  s.addText("ต่ำกว่าปี 2568 เพียง 4.8%", { x: 4.55, y: 2.36, w: 4.83, h: 0.46, fontFace: F, fontSize: 24, bold: true, color: ON_INK.warn, valign: "middle" });
  s.addText(D.annualized, { x: L, y: 3.62, w: 7.6, h: 0.9, fontFace: F, fontSize: 16, color: ON_INK.dim, lineSpacingMultiple: 1.3, valign: "top" });
  footer(s, true);
}

pptx
  .writeFile({ fileName: path.join(__dirname, "editorial.pptx") })
  .then((f) => console.log("wrote", f))
  .catch((e) => { console.error(e); process.exit(1); });
