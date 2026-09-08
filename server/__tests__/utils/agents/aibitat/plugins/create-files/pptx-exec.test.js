/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");
const PptxGenJS = require("pptxgenjs");
const {
  addActionTitle,
  addFooter,
  renderCover,
  renderStatement,
  renderTitleSlide,
  renderSectionSlide,
  renderContentSlide,
  renderBlankSlide,
  chartBaseOptions,
} = require("../../../../../../utils/agents/aibitat/plugins/create-files/pptx/utils.js");

async function buildDeck(render) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  render(pptx.addSlide(), pptx);
  const zip = await JSZip.loadAsync(await pptx.write({ outputType: "nodebuffer" }));
  return zip.file("ppt/slides/slide1.xml").async("string");
}

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "pptx-finance-"));
process.env.STORAGE_DIR = storageDir;

jest.mock(
  "../../../../../../utils/agents/aibitat/plugins/create-files/pptx/section-agent.js",
  () => ({
    runSectionAgent: jest.fn().mockResolvedValue({
      slides: [{ layout: "content", title: "x", content: ["y"] }],
      citations: [],
    }),
  })
);

const fixture = require("./fixtures/finance-deck.json");
const {
  FINANCE_LAYOUTS,
  validateFinanceSections,
} = require("../../../../../../utils/agents/aibitat/plugins/create-files/pptx/finance-schema.js");
const {
  runSectionAgent,
} = require("../../../../../../utils/agents/aibitat/plugins/create-files/pptx/section-agent.js");
const {
  CreatePptxPresentation,
} = require("../../../../../../utils/agents/aibitat/plugins/create-files/pptx/create-presentation.js");
const {
  getAvailableThemes,
  getTheme,
} = require("../../../../../../utils/agents/aibitat/plugins/create-files/pptx/themes.js");
const {
  RENDERERS,
  assertStackedLabelPosition,
  fixEmbeddedChartTables,
  formatNumber,
  formatPct,
  roundedAxisMax,
} = require("../../../../../../utils/agents/aibitat/plugins/create-files/pptx/finance-layouts.js");

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

async function getSlideChartXml(zip, slideNumber) {
  const relationships = await zip
    .file(`ppt/slides/_rels/slide${slideNumber}.xml.rels`)
    .async("string");
  const targets = Array.from(
    relationships.matchAll(/charts\/(chart\d+\.xml)/g),
    (match) => match[1]
  );
  return Promise.all(
    targets.map((target) => zip.file(`ppt/charts/${target}`).async("string"))
  );
}

function setupTool() {
  let captured;
  const aibitat = {
    function: jest.fn((config) => {
      captured = config;
    }),
    handlerProps: { log: jest.fn() },
    introspect: jest.fn(),
    socket: { send: jest.fn() },
    _chats: [],
    addCitation: jest.fn(),
  };
  CreatePptxPresentation.plugin().setup(aibitat);
  return {
    aibitat,
    config: captured,
    call: (input) =>
      captured.handler.call(
        { super: aibitat, caller: "test-agent" },
        copy(input)
      ),
  };
}

afterAll(() => {
  fs.rmSync(storageDir, { recursive: true, force: true });
  delete process.env.STORAGE_DIR;
});

describe("exec themes", () => {
  const KEYS = [
    "fontFace",
    "ground",
    "groundText",
    "groundMuted",
    "hairline",
    "tileColors",
    "pillBg",
    "good",
    "warn",
    "bad",
    "series",
    "accentColor",
  ];

  test("every theme carries every exec token as 6-hex / arrays of 6-hex", () => {
    for (const id of getAvailableThemes()) {
      const t = getTheme(id);
      for (const key of KEYS) expect(t[key]).toBeDefined();
      expect(t.fontFace).toBe("Leelawadee UI");
      expect(t.tileColors).toHaveLength(4);
      expect(t.series).toHaveLength(5);
      for (const [key, value] of Object.entries(t)) {
        if (
          ["name", "description", "fontFace", "fontTitle", "fontBody"].includes(key)
        ) continue;
        for (const color of Array.isArray(value) ? value : [value]) {
          expect(color).toMatch(/^[0-9A-F]{6}$/);
        }
      }
      expect(t.chartColors).toEqual(t.series);
      expect(t.chartPositive).toBe(t.good);
      expect(t.chartNegative).toBe(t.bad);
      expect(t.chartNeutral).toBe(t.groundMuted);
      expect(t.chartGrid).toBe(t.hairline);
      expect(t.statusGreen).toBe(t.good);
      expect(t.statusAmber).toBe(t.warn);
      expect(t.statusRed).toBe(t.bad);
      expect(t.fontTitle).toBe(t.fontFace);
      expect(t.fontBody).toBe(t.fontFace);
    }
  });

  test("executive is the data-forward teal palette", () => {
    const t = getTheme("executive");
    expect(t.accentColor).toBe("0F4C5C");
    expect(t.ground).toBe("0F1B1F");
    expect(t.titleColor).toBe("141414");
  });

  test("normalizes theme names and derives default tokens for unknown names", () => {
    expect(getTheme(" EXECUTIVE ")).toEqual(getTheme("executive"));
    for (const name of [undefined, null, "", "unknown"]) {
      expect(getTheme(name)).toEqual(getTheme("default"));
    }
  });
});

describe("no watermark", () => {
  test("pptx (finance fixture) has no branding text or image in any slide part", async () => {
    const tool = setupTool();
    await tool.call(fixture);
    const directory = path.join(storageDir, "generated-files");
    const file = fs.readdirSync(directory)
      .filter((name) => name.endsWith(".pptx"))
      .sort((a, b) => fs.statSync(path.join(directory, b)).mtimeMs - fs.statSync(path.join(directory, a)).mtimeMs)[0];
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(directory, file)));
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(slides.length).toBeGreaterThan(0);
    for (const name of slides) {
      const xml = await zip.file(name).async("string");
      expect(xml).not.toMatch(/Created with|AnythingLLM/);
    }
    expect(Object.values(zip.files).some((entry) => !entry.dir && /^ppt\/media\//.test(entry.name))).toBe(false);
  });

  test("chat PDF export still produces a readable PDF after shared helper removal", async () => {
    const { sendChatHistoryFile } = require("../../../../../../utils/chats/exportChatToFile.js");
    const { PDFDocument } = require("pdf-lib");
    const headers = {};
    const buffer = await sendChatHistoryFile({
      setHeader: (name, value) => { headers[name] = value; },
      send: (value) => value,
    }, [], { workspaceName: "Watermark regression" }, "pdf");
    expect(headers["Content-Type"]).toBe("application/pdf");
    expect(Buffer.isBuffer(buffer)).toBe(true);
    const pdf = await PDFDocument.load(buffer);
    expect(pdf.getPageCount()).toBeGreaterThan(0);
  });

  test("branding helpers are gone", () => {
    expect(require("../../../../../../utils/agents/aibitat/plugins/create-files/lib.js").getLogo).toBeUndefined();
    // The pdf helper module held nothing but branding, so it is gone entirely;
    // the other three modules still exist and only lost their branding export.
    expect(() =>
      require("../../../../../../utils/agents/aibitat/plugins/create-files/pdf/utils.js")
    ).toThrow();
    expect(require("../../../../../../utils/agents/aibitat/plugins/create-files/xlsx/utils.js").applyBranding).toBeUndefined();
    expect(require("../../../../../../utils/agents/aibitat/plugins/create-files/pptx/utils.js").addBranding).toBeUndefined();
  });
});


describe("chrome", () => {
  const theme = getTheme("executive");

  test("cover: full-slide ground rect, 48pt headline, Leelawadee UI", async () => {
    const xml = await buildDeck((s, p) => renderCover(s, p, {
      title: "รายงาน", headline: "รายได้หาย 36.5%\nกำไรหาย 67.5%",
      subtitle: "ม.ค.–ก.ย. 2569", meta: "Finance team",
    }, theme));
    expect(xml).toMatch(/<a:srgbClr val="0F1B1F"\/>/);
    expect(xml).toMatch(/sz="4800"/);
    expect(xml).toMatch(/typeface="Leelawadee UI"/);
    expect(xml).not.toMatch(/typeface="Calibri"/);
    expect(xml).toMatch(/<a:ext cx="9144000" cy="5143500"\/>/);
    for (const text of ["รายงาน", "รายได้หาย 36.5%", "ม.ค.–ก.ย. 2569", "Finance team"]) {
      expect(xml).toContain(text);
    }
  });

  test("action title is 26pt bold and footer hairline sits at y=5.05in", async () => {
    const xml = await buildDeck((s, p) => {
      expect(addActionTitle(s, theme, "รายได้ต่ำกว่าแผน 5 ใน 8 เดือน")).toBe(1.45);
      addFooter(s, p, theme, { slideNumber: 3, totalSlides: 8, note: "ที่มา FlowAccount" });
    });
    expect(xml).toMatch(/sz="2600" b="1"/);
    expect(xml).toMatch(/<a:off x="640080" y="4617720"\/>/);
    expect(xml).toContain("3 / 8");
    expect(xml).toContain("ที่มา FlowAccount");
    expect(xml).toMatch(/algn="r"/);
  });

  test("statement uses ground and 48pt headline without footer", async () => {
    const xml = await buildDeck((s, p) => renderStatement(s, p, {
      headline: "Protect cash", subtitle: "Fund only proven growth",
    }, theme, { slideNumber: 2, totalSlides: 8 }));
    expect(xml).toMatch(/<a:ext cx="9144000" cy="5143500"\/>/);
    expect(xml).toMatch(/<a:off x="548640" y="1737360"\/>/);
    expect(xml).toMatch(/sz="4800" b="1"/);
    expect(xml).toMatch(/sz="1800"/);
    expect(xml).toContain("Fund only proven growth");
    expect(xml).not.toContain("2 / 8");
    expect(xml).not.toMatch(/typeface="Calibri"/);
  });

  test("legacy title and section signatures render cover and statement", async () => {
    const cover = await buildDeck((s, p) => renderTitleSlide(s, p, {
      title: "Annual results", author: "Finance team",
    }, theme));
    expect(cover).toContain("Annual results");
    expect(cover).toContain("Finance team");
    expect(cover).toMatch(/sz="4800"/);
    const section = await buildDeck((s, p) => renderSectionSlide(s, p, {
      title: "Recovery", subtitle: "Focus next quarter",
    }, theme, 2, 8));
    expect(section).toContain("Recovery");
    expect(section).toMatch(/sz="4800"/);
    expect(section).not.toContain("2 / 8");
  });

  test("content and blank use hairline footer and content uses action title", async () => {
    for (const body of [
      { content: ["Protect cash", "Cut losses"] },
      { table: { headers: ["Metric"], rows: [["Revenue"]] } },
    ]) {
      const xml = await buildDeck((s, p) => renderContentSlide(s, p, {
        title: "Recovery plan", subtitle: "Next quarter", note: "Source: finance", ...body,
      }, theme, 3, 8));
      expect(xml).toMatch(/sz="2600" b="1"/);
      expect(xml).toMatch(/<a:off x="640080" y="4617720"\/>/);
      expect(xml).toContain("Source: finance");
      expect(xml).not.toMatch(/typeface="Calibri"/);
    }
    const blank = await buildDeck((s, p) => renderBlankSlide(s, p, theme, 4, 8));
    expect(blank).toMatch(/<a:off x="640080" y="4617720"\/>/);
    expect(blank).toContain("4 / 8");
  });

  test("chartBaseOptions has every mandatory key", () => {
    const o = chartBaseOptions(theme, "FFFFFF");
    expect(o).toMatchObject({
      chartColors: theme.series, showLegend: false, showValue: true,
      showTitle: false, dataLabelFontSize: 11, catAxisLabelFontSize: 12,
      valAxisLabelFontSize: 11, dataLabelFontFace: "Leelawadee UI",
      catAxisLabelFontFace: "Leelawadee UI", valAxisLabelFontFace: "Leelawadee UI",
      dataLabelColor: theme.bodyColor, catAxisLabelColor: theme.subtitleColor,
      valGridLine: { style: "none" }, catGridLine: { style: "none" },
      valAxisLineShow: false, catAxisMajorTickMark: "none",
      chartArea: { fill: { color: "FFFFFF" }, border: { color: "FFFFFF", pt: 0 } },
      plotArea: { fill: { color: "FFFFFF" }, border: { color: "FFFFFF", pt: 0 } },
    });
    expect(chartBaseOptions(theme, theme.ground).plotArea.fill.color).toBe("0F1B1F");
  });
});

const {
  EXEC_RENDERERS,
  validateExecSection,
  CHART_TYPES,
} = require("../../../../../../utils/agents/aibitat/plugins/create-files/pptx/exec-layouts.js");

async function renderOne(layout, data, themeId = "executive") {
  const theme = getTheme(themeId);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  EXEC_RENDERERS[layout](
    pptx.addSlide(),
    pptx,
    { layout, title: "T", data },
    theme,
    { slideNumber: 1, totalSlides: 1, bg: theme.background }
  );
  const zip = await JSZip.loadAsync(
    await pptx.write({ outputType: "nodebuffer" })
  );
  return {
    slideXml: await zip.file("ppt/slides/slide1.xml").async("string"),
    chartXmls: await getSlideChartXml(zip, 1),
  };
}

describe("exec layouts", () => {
  test("kpi: 4 tiles, 40pt numbers, delta in theme.bad", async () => {
    const { slideXml } = await renderOne("kpi", { kpis: [
      {label:"รายได้",value:16994313,delta:"-36.5%",status:"bad"},{label:"ค่าใช้จ่าย",value:14453214,delta:"-23.7%",status:"warn"},
      {label:"กำไรสุทธิ",value:2541099,delta:"-67.5%",status:"bad"},{label:"อัตรากำไร",value:"15.0%",delta:"-14.2 pt",status:"bad"} ]});
    expect((slideXml.match(/sz="4000" b="1"/g)||[]).length).toBe(4);
    expect(slideXml).toMatch(/<a:srgbClr val="B3261E"\/>/); expect(slideXml).toMatch(/<a:srgbClr val="8A6100"\/>/);
    expect(slideXml).toMatch(/16,994,313/);
  });
  test("chart column with highlight: 8 dPt, index 6 accent, others muted, no gridlines", async () => {
    const { chartXmls } = await renderOne("chart", { type:"column", categories:["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค."], series:[{name:"รายได้",values:[2.35,2.2,2.05,1.95,1.92,1.83,2.89,1.81]}], highlight:[6] });
    const x = chartXmls[0]; const dpts = x.match(/<c:dPt>[\s\S]*?<\/c:dPt>/g);
    expect(dpts).toHaveLength(8); expect(dpts[6]).toMatch(/0F4C5C/); expect(dpts[0]).toMatch(/A6C8CE/);
    expect(x).not.toMatch(/<c:majorGridlines>/); expect(x).toMatch(/sz="1100"/); expect(x).toMatch(/typeface="Leelawadee UI"/);
  });
  test("bridge: negatives bad, positives good, ends accent, symmetric axis", async () => {
    const { chartXmls } = await renderOne("chart", { type:"bridge", categories:["2568","รายได้หาย","ค่าบริการ","พนักงาน","เบ็ดเตล็ด","อื่นๆ","2569"], series:[{name:"กำไร",values:[7.82,-9.75,-1.8,0.99,4.93,0.35,2.54]}] });
    const d = chartXmls[0].match(/<c:dPt>[\s\S]*?<\/c:dPt>/g);
    expect(d[0]).toMatch(/0F4C5C/); expect(d[1]).toMatch(/B3261E/); expect(d[3]).toMatch(/1E7A4B/); expect(d[6]).toMatch(/0F4C5C/);
    expect(chartXmls[0]).toMatch(/<c:min val="-12"\/>/); expect(chartXmls[0]).toMatch(/<c:max val="12"\/>/);
  });
  test("doughnut: hole + total text", async () => {
    const { slideXml, chartXmls } = await renderOne("chart", { type:"doughnut", categories:["a","b"], series:[{name:"s",values:[7.8,4.26]}] });
    expect(chartXmls[0]).toMatch(/<c:holeSize val="62"\/>/); expect(slideXml).toMatch(/12\.06/);
  });
  test("two-column: chart on the left half, points on the right", async () => {
    const { slideXml, chartXmls } = await renderOne("two-column", { chart:{type:"doughnut",categories:["a","b"],series:[{name:"s",values:[1,2]}]}, points:["หนึ่ง","สอง","สาม"] });
    expect(chartXmls).toHaveLength(1);
    const xs = [...slideXml.matchAll(/<a:off x="(\d+)"/g)].map(m=>+m[1]); expect(Math.max(...xs)).toBeGreaterThanOrEqual(5.9*914400);
    expect(slideXml).toMatch(/หนึ่ง/);
  });
  test("validation: length mismatch, >4 kpis, bridge with 2 series are errors", () => {
    const errs=[]; validateExecSection({layout:"chart",title:"t",data:{type:"bar",categories:["a"],series:[{name:"s",values:[1,2]}]}},"sections[0]",errs);
    validateExecSection({layout:"kpi",title:"t",data:{kpis:new Array(5).fill({label:"l",value:1})}},"sections[1]",errs);
    validateExecSection({layout:"chart",title:"t",data:{type:"bridge",categories:["a"],series:[{name:"s",values:[1]},{name:"t",values:[1]}]}},"sections[2]",errs);
    expect(errs).toHaveLength(3); expect(errs[0]).toMatch(/sections\[0\]/);
  });
  test("statement delegates to the ground-coloured statement chrome", async () => {
    const { slideXml } = await renderOne("statement", { headline: "รักษากระแสเงินสด", subtitle: "ลงทุนเฉพาะที่พิสูจน์แล้ว" });
    expect(slideXml).toMatch(/<a:srgbClr val="0F1B1F"\/>/);
    expect(slideXml).toMatch(/sz="4800" b="1"/);
    expect(slideXml).not.toContain("1 / 1");
  });
  test("doughnut percent labels keep a percent format code", async () => {
    const { chartXmls } = await renderOne("chart", {
      type: "doughnut", categories: ["a", "b"],
      series: [{ name: "s", values: [7.8, 4.26] }],
    });
    expect(chartXmls[0]).toMatch(/<c:numFmt formatCode="0%"/);
    expect(chartXmls[0]).toMatch(/<c:showPercent val="1"\/>/);
    const withFormat = await renderOne("chart", {
      type: "doughnut", categories: ["a", "b"],
      series: [{ name: "s", values: [7.8, 4.26] }], valueFormat: "0.0%",
    });
    expect(withFormat.chartXmls[0]).toMatch(/<c:numFmt formatCode="0.0%"/);
  });

  test("four points stay above the footer hairline", async () => {
    const { slideXml } = await renderOne("two-column", {
      chart: { type: "column", categories: ["a"], series: [{ name: "s", values: [1] }] },
      points: ["หนึ่ง", "สอง", "สาม", "สี่"],
    });
    // Only the right-hand points column; the footer text below the hairline is
    // drawn by addFooter and is allowed there.
    const bottoms = [...slideXml.matchAll(/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="\d+" cy="(\d+)"\/>/g)]
      .filter((m) => Number(m[1]) >= 5.9 * 914400)
      .map((m) => (Number(m[2]) + Number(m[3])) / 914400);
    expect(bottoms.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...bottoms)).toBeLessThanOrEqual(5.05);
    expect(slideXml).toMatch(/สี่/);
  });

  test("charts fall back to the theme background when ctx.bg is absent", async () => {
    const theme = getTheme("executive");
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_16x9";
    EXEC_RENDERERS.chart(
      pptx.addSlide(), pptx,
      { layout: "chart", title: "T", data: {
        type: "column", categories: ["a"], series: [{ name: "s", values: [1] }] } },
      theme, { slideNumber: 1, totalSlides: 1 }
    );
    const zip = await JSZip.loadAsync(await pptx.write({ outputType: "nodebuffer" }));
    const [chartXml] = await getSlideChartXml(zip, 1);
    expect(chartXml).not.toMatch(/val="undefined"/);
    expect(chartXml).toMatch(/<a:srgbClr val="FFFFFF"\/>/);
  });

  test("kpi tiles honour ctx.y and stay above the footer", async () => {
    const theme = getTheme("executive");
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_16x9";
    EXEC_RENDERERS.kpi(
      pptx.addSlide(), pptx,
      { layout: "kpi", title: "T", data: { kpis: [
        { label: "a", value: 1 }, { label: "b", value: 2 },
        { label: "c", value: 3 }, { label: "d", value: 4 } ] } },
      theme,
      { slideNumber: 1, totalSlides: 1, bg: theme.background, y: 2.2 }
    );
    const zip = await JSZip.loadAsync(await pptx.write({ outputType: "nodebuffer" }));
    const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
    const boxes = [...slideXml.matchAll(/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g)]
      .map((m) => ({ y: Number(m[2]) / 914400, w: Number(m[3]) / 914400, h: Number(m[4]) / 914400 }));
    const tiles = boxes.filter((box) => Math.abs(box.w - 4.2) < 0.001);
    expect(tiles).toHaveLength(4);
    expect(Math.min(...tiles.map((tile) => tile.y))).toBeCloseTo(2.2, 5);
    expect(Math.max(...tiles.map((tile) => tile.y + tile.h))).toBeLessThanOrEqual(5.05);
  });

  test("compressed kpi tiles keep the value clear of the delta pill", async () => {
    // 2.35 is the start-Y Task 5 uses to seat tiles under a narrative; it is the
    // tightest grid this layout has to draw.
    const theme = getTheme("executive");
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_16x9";
    EXEC_RENDERERS.kpi(
      pptx.addSlide(), pptx,
      { layout: "kpi", title: "T", data: { kpis: [
        { label: "a", value: 16994313, delta: "-36.5%", status: "bad" },
        { label: "b", value: 14453214, delta: "-23.7%", status: "warn" },
        { label: "c", value: 2541099, delta: "-67.5%", status: "bad" },
        { label: "d", value: "15.0%", delta: "-14.2 pt", status: "bad" } ] } },
      theme,
      { slideNumber: 1, totalSlides: 1, bg: theme.background, y: 2.35 }
    );
    const zip = await JSZip.loadAsync(await pptx.write({ outputType: "nodebuffer" }));
    const slideXml = await zip.file("ppt/slides/slide1.xml").async("string");
    // One <p:sp> per shape, in the order the renderer emitted them: tile, label,
    // value, pill, delta — so grouping by tile is a matter of walking that order.
    const shapes = [...slideXml.matchAll(
      /<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g
    )].map((m) => ({
      x: Number(m[1]) / 914400, y: Number(m[2]) / 914400,
      w: Number(m[3]) / 914400, h: Number(m[4]) / 914400,
    }));
    const tiles = shapes.filter((shape) => Math.abs(shape.w - 4.2) < 0.001);
    expect(tiles).toHaveLength(4);

    for (const tile of tiles) {
      const inner = shapes.filter(
        (shape) =>
          shape !== tile &&
          shape.x >= tile.x && shape.x < tile.x + tile.w &&
          shape.y >= tile.y && shape.y < tile.y + tile.h
      );
      // The 40pt value is the tallest text in the tile; the pill is the widest
      // short box below it.
      const value = inner.reduce((tallest, shape) =>
        shape.h > tallest.h ? shape : tallest
      );
      const pill = inner
        .filter((shape) => shape.y > value.y)
        .reduce((highest, shape) => (shape.y < highest.y ? shape : highest));
      expect(value.y + value.h).toBeLessThanOrEqual(pill.y + 1e-9);
      expect(pill.y + pill.h).toBeLessThanOrEqual(tile.y + tile.h + 1e-9);
    }
  });

  test("finance mode renders an exec layout instead of a pending slide", async () => {
    const tool = setupTool();
    await tool.call({
      filename: "exec-in-finance", title: "Exec", theme: "executive",
      mode: "finance", unit: "บาท",
      sections: [{ layout: "kpi", title: "ผลประกอบการ", data: { kpis: [
        { label: "รายได้", value: 16994313, delta: "-36.5%", status: "bad" },
        { label: "กำไรสุทธิ", value: 2541099, delta: "-67.5%", status: "bad" } ] } }],
    });
    const directory = path.join(storageDir, "generated-files");
    const file = fs.readdirSync(directory)
      .filter((name) => name.endsWith(".pptx"))
      .sort((a, b) =>
        fs.statSync(path.join(directory, b)).mtimeMs -
        fs.statSync(path.join(directory, a)).mtimeMs)[0];
    const zip = await JSZip.loadAsync(fs.readFileSync(path.join(directory, file)));
    const slideNames = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const slideXmls = await Promise.all(
      slideNames.map((name) => zip.file(name).async("string"))
    );
    const body = slideXmls.join("");
    expect(body).not.toMatch(/pending/);
    expect(body).toMatch(/sz="4000" b="1"/);
    expect(body).toContain("16,994,313");
  });

  test("an exec layout in a finance deck carries the deck footer and its speaker notes", async () => {
    const tool = setupTool();
    await tool.call({
      filename: "exec-finance-footer", title: "Exec", theme: "executive",
      mode: "finance", unit: "บาท",
      footer: { period: "ม.ค.–ส.ค. 2569", source: "FlowAccount", preparedOn: "2026-09-07" },
      sections: [{
        layout: "kpi", title: "ผลประกอบการ", subtitle: "ภาพรวม", notes: "พูดถึงรายได้ที่หายไปก่อน",
        data: { kpis: [
          { label: "รายได้", value: 16994313, delta: "-36.5%", status: "bad" },
          { label: "กำไรสุทธิ", value: 2541099, delta: "-67.5%", status: "bad" } ] },
      }],
    });
    const [, card] = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const zip = await JSZip.loadAsync(
      fs.readFileSync(path.join(storageDir, "generated-files", card.storageFilename))
    );
    const slide2 = await zip.file("ppt/slides/slide2.xml").async("string");
    // The same period / source / prepared-on chrome the finance renderers compose,
    // so a kpi slide is not left with only a page number beside a scorecard.
    expect(slide2).toContain("ภาพรวม · งวด ม.ค.–ส.ค. 2569");
    expect(slide2).toContain("แหล่งข้อมูล FlowAccount");
    // Follow slide 2's own relationships so the notes are proven to hang off the
    // kpi slide, not merely to exist somewhere in the deck.
    const rels = await zip
      .file("ppt/slides/_rels/slide2.xml.rels")
      .async("string");
    const target = rels.match(/notesSlides\/(notesSlide\d+\.xml)/)[1];
    const notes = await zip.file(`ppt/notesSlides/${target}`).async("string");
    expect(notes).toContain("พูดถึงรายได้ที่หายไปก่อน");
  });

  test("finance mode accepts the exec layouts and still fails closed on bad data", () => {
    expect(Object.keys(FINANCE_LAYOUTS)).toEqual(
      expect.arrayContaining(["kpi", "chart", "two-column", "statement"])
    );
    expect(CHART_TYPES).toEqual([
      "bar", "column", "line", "area", "pie", "doughnut", "bridge",
    ]);
    const ok = validateFinanceSections([
      { layout: "kpi", title: "t", data: { kpis: [
        { label: "a", value: 1 }, { label: "b", value: 2, status: "good" } ] } },
    ]);
    expect(ok).toEqual({ ok: true, errors: [] });
    const bad = validateFinanceSections([
      { layout: "two-column", title: "t", data: { chart: {
        type: "column", categories: ["a"], series: [{ name: "s", values: [1] }],
      }, points: ["only one"] } },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toMatch(/sections\[0\]\.data\.points/);
  });
});

test("finance fixture renders with no font below 11pt, no Calibri, no gridlines, action titles at 26pt", async () => {
  const tool = setupTool();
  const directory = path.join(storageDir, "generated-files");
  const before = new Set(fs.existsSync(directory) ? fs.readdirSync(directory) : []);
  await tool.call({ ...copy(fixture), filename: "restyle.pptx" });
  const file = fs.readdirSync(directory).find((name) => !before.has(name) && name.endsWith(".pptx"));
  expect(file).toBeDefined();
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(directory, file)));
  const parts = Object.keys(zip.files).filter((name) => /^ppt\/(slides\/slide|charts\/chart)\d+\.xml$/.test(name));
  expect(parts.length).toBeGreaterThan(0);
  for (const name of parts) {
    const xml = await zip.file(name).async("string");
    for (const match of xml.matchAll(/ sz="(\d+)"/g)) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(1100);
    }
    expect(xml).not.toMatch(/Calibri/);
    expect(xml).not.toMatch(/<c:majorGridlines>/);
  }
  expect(await zip.file("ppt/slides/slide2.xml").async("string")).toMatch(/sz="2600" b="1"/);
});

describe("finance executive composition", () => {
  const theme = getTheme("executive");

  test("summary has one title/footer, prioritised metadata, and readable comparisons below KPI tiles", async () => {
    const section = copy(fixture.sections[0]);
    section.data.metrics[0].delta = 0;
    const xml = await buildDeck((slide, pptx) => RENDERERS.summary(
      slide, pptx, section, theme,
      { slideNumber: 2, totalSlides: 10, footer: fixture.footer, unit: fixture.unit }
    ));
    const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g);
    expect(shapes.filter((shape) => shape.includes(section.title.slice(0, 15)))).toHaveLength(1);
    expect(shapes.filter((shape) => shape.includes("2 / 10"))).toHaveLength(1);
    expect(xml).toContain("งวด ม.ค.–ส.ค. 2569");
    expect(xml).toContain("แหล่งข้อมูล FlowAccount");
    expect(xml).not.toContain(section.subtitle);
    const zero = shapes.find((shape) => /<a:t>0%<\/a:t>/.test(shape));
    expect(zero).toContain('val="1E7A4B"');
    const negative = shapes.find((shape) => shape.includes("-6.8%"));
    expect(negative).toContain('val="B3261E"');
    for (const metric of section.data.metrics) {
      const note = shapes.find((shape) => shape.includes(metric.deltaLabel));
      expect(note).toBeDefined();
      const y = Number(note.match(/<a:off x="\d+" y="(\d+)"/)?.[1]) / 914400;
      expect(y).toBeGreaterThanOrEqual(3.9);
      expect(note).not.toContain("<a:normAutofit");
    }
  });

  test("scorecard status dots are 0.14in and centred in their table cells", async () => {
    const section = fixture.sections[1];
    const xml = await buildDeck((slide, pptx) => RENDERERS.scorecard(
      slide, pptx, section, theme, { slideNumber: 3, totalSlides: 10 }
    ));
    const widths = [...xml.matchAll(/<a:gridCol w="(\d+)"/g)].map((m) => Number(m[1]));
    const rowHeights = [...xml.matchAll(/<a:tr h="(\d+)"/g)].map((m) => Number(m[1]));
    const dots = (xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []).filter((shape) => shape.includes('prst="ellipse"'));
    expect(dots).toHaveLength(section.data.rows.length);
    let rowY = 1.45 * 914400 + rowHeights[0];
    dots.forEach((dot, index) => {
      const [, x, y, w, h] = dot.match(/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/).map(Number);
      expect(w / 914400).toBeCloseTo(0.14, 5);
      expect(h / 914400).toBeCloseTo(0.14, 5);
      expect((x + w / 2) / 914400).toBeCloseTo(0.7 + (widths.reduce((a, b) => a + b, 0) - widths.at(-1) / 2) / 914400, 5);
      expect((y + h / 2) / 914400).toBeCloseTo((rowY + rowHeights[index + 1] / 2) / 914400, 5);
      rowY += rowHeights[index + 1];
    });
    expect(rowY / 914400).toBeLessThanOrEqual(5.05);
    expect(xml).toContain('val="0F4C5C"');
    expect(xml).toContain('val="D6D9DB"');
  });
});

test("finance chart captions do not shrink below their explicit readable size", async () => {
  for (const [layout, index, caption] of [
    ["trend_bar", 2, "ช่วงแผน"],
    ["trend_bar", 2, fixture.sections[2].data.annotation],
    ["waterfall", 4, "โครงสร้าง"],
  ]) {
    const xml = await buildDeck((slide, pptx) => RENDERERS[layout](
      slide, pptx, fixture.sections[index], getTheme("executive"),
      { slideNumber: 1, totalSlides: 1, unit: fixture.unit }
    ));
    const shape = (xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []).find((part) => part.includes(`<a:t>${caption}`));
    expect(shape).toBeDefined();
    expect(shape).not.toContain("<a:normAutofit");
    expect(shape).toContain('sz="1100"');
  }
});

describe("finance review regressions", () => {
  test("fixture slide text never requests automatic shrinking", async () => {
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_16x9";
    const theme = getTheme("executive");
    renderCover(pptx.addSlide(), pptx, { title: fixture.title }, theme);
    fixture.sections.forEach((section, index) => RENDERERS[section.layout](
      pptx.addSlide(), pptx, section, theme,
      { slideNumber: index + 2, totalSlides: 10, footer: fixture.footer, unit: fixture.unit }
    ));
    const zip = await JSZip.loadAsync(await pptx.write({ outputType: "nodebuffer" }));
    for (const name of Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))) {
      expect(await zip.file(name).async("string")).not.toMatch(/<a:normAutofit/);
    }
  });

  test("finance uses fontFace even when legacy aliases disagree", async () => {
    const theme = { ...getTheme("executive"), fontBody: "Legacy Body", fontTitle: "Legacy Title" };
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_16x9";
    fixture.sections.forEach((section) => RENDERERS[section.layout](pptx.addSlide(), pptx, section, theme,
      { slideNumber: 1, totalSlides: 9, unit: fixture.unit }));
    const zip = await JSZip.loadAsync(await pptx.write({ outputType: "nodebuffer" }));
    for (const name of Object.keys(zip.files).filter((name) => /^ppt\/(slides\/slide|charts\/chart)\d+\.xml$/.test(name))) {
      expect(await zip.file(name).async("string")).not.toMatch(/Legacy Body|Legacy Title/);
    }
  });

  test.each([
    [undefined, 5, "1E7A4B"], [undefined, -5, "B3261E"],
    ["higher_is_better", 5, "1E7A4B"], ["higher_is_better", -5, "B3261E"],
    ["lower_is_better", 5, "B3261E"], ["lower_is_better", -5, "1E7A4B"],
    ["lower_is_better", 0, "1E7A4B"],
  ])("summary polarity %s with delta %s uses %s", async (polarity, delta, color) => {
    const section = copy(fixture.sections[0]);
    section.data.metrics[0] = { ...section.data.metrics[0], polarity, delta };
    const xml = await buildDeck((slide, pptx) => RENDERERS.summary(slide, pptx, section,
      getTheme("executive"), { slideNumber: 1, totalSlides: 1, unit: fixture.unit }));
    const deltaText = delta > 0 ? `+${delta}%` : `${delta}%`;
    const shape = (xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []).find((shape) => shape.includes(`<a:t>${deltaText}</a:t>`));
    expect(shape).toContain(`val="${color}"`);
  });

  test("summary rejects unknown metric polarity", () => {
    const section = copy(fixture.sections[0]);
    section.data.metrics[0].polarity = "sometimes";
    const result = validateFinanceSections([section]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("sections[0].data.metrics[0].polarity");
    for (const polarity of ["higher_is_better", "lower_is_better"]) {
      section.data.metrics[0].polarity = polarity;
      expect(validateFinanceSections([section]).ok).toBe(true);
    }
  });

  test("footer drops subtitle, prepared date, then source while retaining period", async () => {
    const theme = getTheme("executive");
    for (const [note, keep, drop] of [
      [["S".repeat(200), "งวด Q1", "แหล่งข้อมูล ERP", "จัดทำ today"].join(" · "), ["งวด Q1", "ERP", "today"], ["SSSS"]],
      [["S".repeat(200), "งวด Q1", "แหล่งข้อมูล ERP", `จัดทำ ${"D".repeat(200)}`].join(" · "), ["งวด Q1", "ERP"], ["DDDD", "SSSS"]],
      [["S".repeat(200), "งวด Q1", `แหล่งข้อมูล ${"E".repeat(200)}`, "จัดทำ today"].join(" · "), ["งวด Q1"], ["EEEE", "today", "SSSS"]],
    ]) {
      const xml = await buildDeck((slide, pptx) => addFooter(slide, pptx, theme,
        { slideNumber: 1, totalSlides: 1, note }));
      keep.forEach((text) => expect(xml).toContain(text));
      drop.forEach((text) => expect(xml).not.toContain(text));
      expect(xml).not.toContain("<a:normAutofit");
    }
  });
});

test("long finance titles and decision details end with ellipsis at fixed sizes", async () => {
  const section = copy(fixture.sections[8]);
  section.title = "Long action title ".repeat(100);
  section.data.items[0].title = "Long decision ".repeat(100);
  section.data.items[0].killCondition = "Long condition ".repeat(100);
  const xml = await buildDeck((slide, pptx) => RENDERERS.decisions(slide, pptx, section,
    getTheme("executive"), { slideNumber: 1, totalSlides: 1 }));
  const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g);
  for (const [text, size] of [["Long action", 2600], ["Long decision", 1800], ["Long condition", 1400]]) {
    const shape = shapes.find((shape) => shape.includes(text));
    expect(shape).toContain("…");
    expect(shape).toContain(`sz="${size}"`);
    expect(shape).not.toContain("<a:normAutofit");
  }
});

test("KPI values fit their serialized boxes, reducing size before ellipsizing at 28pt", async () => {
  const { slideXml } = await renderOne("kpi", { kpis: [
    { label: "Long", value: 1000000000000000 },
    { label: "Medium", value: 12345678 },
    { label: "Short", value: 1 },
  ] });
  const values = (slideXml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [])
    .filter((shape) => /<a:t>[\d,]+…?<\/a:t>/.test(shape));
  expect(values).toHaveLength(3);
  const sizes = [];
  for (const shape of values) {
    const text = shape.match(/<a:t>([^<]+)<\/a:t>/)[1];
    const size = Number(shape.match(/sz="(\d+)"/)[1]) / 100;
    const [, x, y, w, h] = shape.match(/<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/).map(Number);
    // Independent digit/comma/ellipsis widths in em, matching the estimator's conservative contract.
    const widthEm = [...text].reduce((sum, char) => sum + (char === "," ? 0.35 : char === "…" ? 0.8 : 0.62), 0);
    expect(widthEm * size).toBeLessThanOrEqual(w / 12700);
    expect(size).toBeLessThanOrEqual(h / 12700);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThanOrEqual(1.5 * 914400);
    expect(size).toBeGreaterThanOrEqual(28);
    expect(shape).not.toContain("<a:normAutofit");
    sizes.push(size);
  }
  expect(values[0]).toContain("…");
  expect(sizes[0]).toBe(28);
  expect(values[1]).not.toContain("…");
  expect(sizes[1]).toBeLessThan(40);
  expect(sizes[2]).toBe(40);
});

test("truncated KPI number keeps its unit inside the value box", async () => {
  const { slideXml } = await renderOne("kpi", { kpis: [
    { label: "Large amount", value: 1000000000000000, unit: "THB" },
    { label: "Other", value: 2 }, { label: "Third", value: 3 },
  ] });
  const value = (slideXml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [])
    .find((shape) => /<a:t>1,[^<]*<\/a:t>/.test(shape));
  const text = value.match(/<a:t>([^<]+)<\/a:t>/)[1];
  expect(text).toMatch(/^1,[\d,]*… THB$/);
  expect(value).toContain('sz="2800"');
  expect(value).not.toContain("<a:normAutofit");
  const width = Number(value.match(/<a:ext cx="(\d+)"/)[1]) / 12700;
  const em = [...text].reduce((sum, char) => sum + (/\d/.test(char) ? 0.62 : char === "," || char === " " ? 0.35 : char === "…" ? 0.8 : 0.75), 0);
  expect(em * 28).toBeLessThanOrEqual(width);
});

test.each([
  ["THB/yr", "… THB/yr"],
  ["THB/year", "…"],
  ["THB/year per customer account", "…"],
])("truncated KPI with wide unit %s always preserves a marker", async (unit, expected) => {
  const { slideXml } = await renderOne("kpi", { kpis: [
    { label: "Large amount", value: 1000000000000000, unit },
    { label: "Other", value: 2 }, { label: "Third", value: 3 },
  ] });
  const shape = (slideXml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [])
    .find((part) => part.includes('sz="2800" b="1"'));
  expect(shape).toContain(`<a:t>${expected}</a:t>`);
  expect(shape).not.toContain("<a:normAutofit");
  const width = Number(shape.match(/<a:ext cx="(\d+)"/)[1]) / 12700;
  const em = [...expected].reduce((sum, char) => sum + (
    char === "…" || char === "/" ? 0.8 : char === " " ? 0.35 : /[A-Z]/.test(char) ? 0.75 : 0.62
  ), 0);
  expect(em * 28).toBeLessThanOrEqual(width);
});

describe("outline mode with exec layouts", () => {
  beforeEach(() => {
    runSectionAgent.mockClear();
  });

  test("section agent schema exposes exec layouts and no blank; prompt carries the chart rule", () => {
    const src = fs.readFileSync(
      require.resolve(
        "../../../../../../utils/agents/aibitat/plugins/create-files/pptx/section-agent.js"
      ),
      "utf8"
    );
    expect(src).toMatch(
      /enum: \["statement", "content", "kpi", "chart", "two-column"\]/
    );
    expect(src).not.toMatch(/"blank"/);
    expect(src).toMatch(/MUST be a "chart" slide/);
  });

  test("outline deck: cover from headline, chart slide from agent, closing statement, keynote fix applied", async () => {
    runSectionAgent.mockResolvedValueOnce({
      slides: [
        {
          layout: "chart",
          title: "รายได้ต่ำกว่าแผน",
          data: {
            type: "column",
            categories: ["a", "b", "c"],
            series: [{ name: "s", values: [1, 2, 3] }],
          },
        },
      ],
      citations: [],
    });
    const tool = setupTool();
    await tool.call({
      filename: "outline.pptx",
      title: "รายงานผู้บริหาร",
      headline: "รายได้หาย 36.5%",
      closing: { headline: "ปิดปีที่ 25.49 ล้าน" },
      sections: [{ title: "x" }],
    });
    // Generated filenames are UUIDs, so lexicographic sorting picks an arbitrary
    // deck; the download card names the file this call actually wrote.
    const [, card] = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const file = path.join(storageDir, "generated-files", card.storageFilename);
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    expect(await zip.file("ppt/slides/slide1.xml").async("string")).toMatch(
      /รายได้หาย 36.5%/
    );
    expect(await getSlideChartXml(zip, 2)).toHaveLength(1);
    expect(await zip.file("ppt/slides/slide3.xml").async("string")).toMatch(
      /ปิดปีที่ 25.49/
    );
    const wb = await JSZip.loadAsync(
      await zip
        .file(Object.keys(zip.files).find((n) => /embeddings\/.*xlsx$/.test(n)))
        .async("nodebuffer")
    );
    expect(await wb.file("xl/tables/table1.xml").async("string")).not.toMatch(
      /'"/
    );
  });

  test("outline deck: a kpi section shaped exactly as the section-agent prompt documents renders as tiles, not a fallback", async () => {
    // The prompt in section-agent.js is the contract a model follows, so this
    // builds a kpi section from it verbatim: a formatted string delta and a
    // status value. Any drift between that prompt and validateExecSection
    // shows up here as the raw-JSON content fallback.
    runSectionAgent.mockResolvedValueOnce({
      slides: [
        {
          layout: "kpi",
          title: "รายได้ต่ำกว่าแผน 5 ใน 8 เดือน",
          data: {
            kpis: [
              { label: "รายได้", value: 16994313, unit: "บาท", delta: "-36.5%", status: "bad" },
              { label: "กำไรสุทธิ", value: 2541099, unit: "บาท", delta: "-67.5%", status: "bad" },
              { label: "อัตรากำไร", value: "15.0%", delta: "+1.2 pt", status: "good" },
            ],
            note: "แหล่งข้อมูล FlowAccount",
          },
        },
      ],
      citations: [],
    });
    const tool = setupTool();
    await tool.call({
      filename: "kpi-contract.pptx",
      title: "รายงานผู้บริหาร",
      headline: "รายได้หาย 36.5%",
      sections: [{ title: "x" }],
    });
    expect(tool.aibitat.handlerProps.log).not.toHaveBeenCalledWith(
      expect.stringMatching(/falling back to content/)
    );
    const [, card] = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const zip = await JSZip.loadAsync(
      fs.readFileSync(path.join(storageDir, "generated-files", card.storageFilename))
    );
    const slide2 = await zip.file("ppt/slides/slide2.xml").async("string");
    const theme = getTheme("default");
    // A string value needs no formatting and holds the headline 40pt; the two
    // long figures carry a wide unit and step down inside a three-column tile,
    // which is the KPI value fit, not the fallback.
    expect(slide2).toContain('sz="4000" b="1"');
    expect(slide2).toContain("15.0%");
    expect((slide2.match(/sz="2800" b="1"/g) || []).length).toBe(2);
    for (const value of ["16,9", "2,54"]) expect(slide2).toContain(value);
    expect(slide2).toMatch(new RegExp(`<a:srgbClr val="${theme.bad}"/>`));
    expect(slide2).toMatch(new RegExp(`<a:srgbClr val="${theme.good}"/>`));
    for (const delta of ["-36.5%", "-67.5%", "+1.2 pt"]) {
      expect(slide2).toContain(delta);
    }
    // The fallback renders the section data as escaped JSON on a bullet slide.
    expect(slide2).not.toContain("&quot;kpis&quot;");
    expect(slide2).not.toContain("<a:normAutofit");
  });

  test("outline deck: invalid chart data falls back to a content slide, deck still written", async () => {
    runSectionAgent.mockResolvedValueOnce({
      slides: [
        {
          layout: "chart",
          title: "bad",
          data: {
            type: "column",
            categories: ["a"],
            series: [{ name: "s", values: [1, 2] }],
          },
        },
      ],
      citations: [],
    });
    const tool = setupTool();
    const r = await tool.call({
      filename: "fallback.pptx",
      title: "t",
      sections: [{ title: "x" }],
    });
    expect(r).toMatch(/Successfully created/);
    expect(tool.aibitat.handlerProps.log).toHaveBeenCalledWith(
      expect.stringMatching(/falling back to content/)
    );
  });
});

describe("outline mode text safety", () => {
  beforeEach(() => {
    runSectionAgent.mockClear();
  });

  test("control characters in the deck footer never reach the cover slide", async () => {
    runSectionAgent.mockResolvedValueOnce({
      slides: [{ layout: "content", title: "x", content: ["y"] }],
      citations: [],
    });
    const tool = setupTool();
    // Backspace, vertical tab and form feed are illegal in XML 1.0, so a deck
    // carrying them into slide1 is one PowerPoint refuses to open.
    await tool.call({
      filename: "footer-control.pptx",
      title: "Deck",
      headline: "Verdict",
      footer: {
        period: `Q${String.fromCharCode(8)}1`,
        source: `Flow${String.fromCharCode(12)}Account`,
        preparedOn: `2026${String.fromCharCode(11)}-01-01`,
      },
      sections: [{ title: "x" }],
    });
    const [, card] = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const zip = await JSZip.loadAsync(
      fs.readFileSync(
        path.join(storageDir, "generated-files", card.storageFilename)
      )
    );
    const slide1 = await zip.file("ppt/slides/slide1.xml").async("string");
    expect(slide1).toMatch(/Q1/);
    expect(slide1).toMatch(/FlowAccount/);
    expect(slide1).not.toMatch(/[\u0008\u000B\u000C]/);
  });

  test("a tool-built deck with a closing and a two-column slide requests no automatic shrinking", async () => {
    runSectionAgent.mockResolvedValueOnce({
      slides: [
        {
          layout: "two-column",
          title: "Growth stalled in the second half",
          data: {
            chart: {
              type: "column",
              categories: ["a", "b", "c"],
              series: [{ name: "s", values: [1, 2, 3] }],
            },
            points: [
              "Sales headcount doubled without new pipeline".repeat(4),
              "Discounting held revenue flat",
            ],
          },
        },
        {
          layout: "statement",
          title: "Verdict",
          data: {
            headline: "Protect cash before funding any new growth bet".repeat(
              3
            ),
            subtitle: "Reassess at the next board meeting".repeat(4),
          },
        },
        {
          layout: "chart",
          title: "Revenue splits four ways",
          data: {
            type: "doughnut",
            categories: ["a", "b", "c"],
            series: [{ name: "s", values: [111111111, 222222222, 333333333] }],
          },
        },
        {
          layout: "content",
          title: "Detail",
          subtitle: "A subtitle far too long for its 0.3 inch strip".repeat(4),
          content: ["one", "two"],
        },
      ],
      citations: [],
    });
    const tool = setupTool();
    await tool.call({
      filename: "no-autofit.pptx",
      title: "Deck",
      headline: "Verdict",
      closing: {
        headline:
          "Close the year at 25.49 million after the cost freeze".repeat(3),
        subtitle: "Every division holds headcount flat until March".repeat(4),
      },
      sections: [{ title: "x" }],
    });
    const [, card] = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const zip = await JSZip.loadAsync(
      fs.readFileSync(
        path.join(storageDir, "generated-files", card.storageFilename)
      )
    );
    const slides = Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name)
    );
    expect(slides.length).toBe(6);
    for (const name of slides) {
      expect(await zip.file(name).async("string")).not.toMatch(
        /<a:normAutofit/
      );
    }
  });
});

describe("Thai text measurement and token-safe bounding", () => {
  const { textWidthEm, boundText } = require("../../../../../../utils/agents/aibitat/plugins/create-files/pptx/utils.js");
  const theme = getTheme("executive");
  // The exact headlines from the executive theme preview deck that were being ellipsized.
  const COVER_HEADLINE = "รายได้ยังไม่ฟื้น ต้องเร่งปิดช่องว่างก่อนสิ้นปี";
  const CLOSING_HEADLINE = "เร่งรายได้ Q4 ให้ถึงเป้า";
  const runs = (xml) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);

  test("Thai cover and statement headlines render in full at 48pt without an ellipsis", async () => {
    const cover = await buildDeck((s, p) => renderCover(s, p, { headline: COVER_HEADLINE }, theme));
    const statement = await buildDeck((s, p) => renderStatement(s, p, { headline: CLOSING_HEADLINE }, theme));
    for (const [xml, headline] of [[cover, COVER_HEADLINE], [statement, CLOSING_HEADLINE]]) {
      const text = runs(xml).join("");
      expect(text).toContain(headline);
      expect(text).not.toContain("…");
      expect(xml).toMatch(/sz="4800"/);
      expect(xml).not.toContain("<a:normAutofit");
    }
  });

  test("a statement headline with an explicit line break keeps both lines", async () => {
    const headline = "\u0e40\u0e23\u0e48\u0e07\u0e23\u0e32\u0e22\u0e44\u0e14\u0e49\n\u0e04\u0e38\u0e21\u0e04\u0e48\u0e32\u0e1a\u0e23\u0e34\u0e01\u0e32\u0e23 \u0e23\u0e31\u0e01\u0e29\u0e32\u0e01\u0e33\u0e44\u0e23";
    const xml = await buildDeck((s, p) => renderStatement(s, p, { headline }, theme));
    expect(runs(xml)).toEqual(headline.split("\n"));
    expect(xml).not.toContain("\u2026");
  });

  test("a 40-character Thai headline fits two lines at 48pt", () => {
    const headline = COVER_HEADLINE.slice(0, 40);
    const bounded = boundText(headline, { w: 8.8, h: 2.2, fontSize: 48 });
    expect(bounded).not.toContain("…");
    // Thai wraps at word boundaries that carry no space, so lines rejoin without one.
    expect(bounded.replace(/\s/g, "")).toBe(headline.replace(/\s/g, ""));
    expect(bounded.split("\n")).toHaveLength(2);
  });

  test("two-column points never split a number across runs", async () => {
    const { slideXml } = await renderOne("two-column", {
      chart: { type: "column", categories: ["ม.ค."], series: [{ name: "รายได้", values: [1] }] },
      points: [
        "ค่าบริการทั่วไป 7,799,188 บาท เป็นต้นทุนหลักที่ต้องทบทวนสัญญา",
        "ค่าพนักงาน 4,255,441 บาท เป็นรายการใหญ่อันดับสอง",
      ],
    });
    const texts = runs(slideXml);
    for (const number of ["7,799,188", "4,255,441"]) {
      expect(texts.filter((text) => text.includes(number))).toHaveLength(1);
      // Any run holding part of the number must hold all of it: no digit or comma
      // of the figure may appear in a run that lacks the whole figure.
      for (const text of texts) {
        const partial = new RegExp(`(?<!${number.slice(0, -1)})${number.slice(0, 3)}`);
        if (partial.test(text)) expect(text).toContain(number);
      }
    }
    expect(slideXml).not.toContain("<a:normAutofit");
  });

  test("two-column points never split a sign, a percent, or a range from its figure", async () => {
    // Every line wraps exactly at a seam ICU offers around a sign or a percent.
    // The first two are where a loss used to render as a gain; the last two are
    // ranges, where a line opening at "-2569" reads as a negative year.
    const { slideXml } = await renderOne("two-column", {
      chart: { type: "column", categories: ["ม.ค."], series: [{ name: "รายได้", values: [1] }] },
      points: [
        "กกกกกกกกกกกกก -1,234,567 บาท",
        "กกกกกกกกกกกกกกกกกก 15.0% ของแผน",
        "กกกกกกกกกกกกกก 2568-2569 ยังไม่ปรับแผน",
        "กกกกกกกกกกกกกกกกกก 50%-60% ของเป้า",
      ],
    });
    const texts = runs(slideXml);
    for (const figure of ["-1,234,567", "15.0%", "2568-2569", "50%-60%"]) {
      expect(texts.some((text) => text.includes(figure))).toBe(true);
    }
    for (const text of texts) {
      // No run may end on a lone sign, open on a percent, or open on a sign
      // glued to digits — each of those is a figure broken across two lines.
      expect(text).not.toMatch(/[-+\u2212]\s*$/);
      expect(text).not.toMatch(/^\s*%/);
      // A run may open on a signed figure only when the sign is the figure's own,
      // as in the genuine loss below. A sign pulled off the figure before it,
      // which is what a broken range looks like, is the defect.
      if (/^\s*[-+\u2212][\d.,]/.test(text)) expect(text).toContain("-1,234,567");
      // A run may hold the digits only when it also holds the whole figure.
      if (text.includes("1,234,567")) expect(text).toContain("-1,234,567");
      if (text.includes("15.0")) expect(text).toContain("15.0%");
      if (text.includes("2569")) expect(text).toContain("2568-2569");
      if (text.includes("60%")) expect(text).toContain("50%-60%");
    }
    expect(slideXml).not.toContain("<a:normAutofit");
  });

  test("Thai combining marks add zero advance width", () => {
    const COMBINING = /[ัิ-ฺ็-๎]/g;
    for (const text of ["รายได้ยังไม่ฟื้น", "เร่งรายได้ Q4 ให้ถึงเป้า", "ค่าบริการทั่วไป"]) {
      const bare = text.replace(COMBINING, "");
      expect(bare).not.toBe(text);
      expect(textWidthEm(text)).toBeCloseTo(textWidthEm(bare), 10);
    }
  });
});
