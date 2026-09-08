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
    expect(require("../../../../../../utils/agents/aibitat/plugins/create-files/pdf/utils.js").applyBranding).toBeUndefined();
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
