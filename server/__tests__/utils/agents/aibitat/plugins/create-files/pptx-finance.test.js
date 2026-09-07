/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");

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

describe("pptx-finance schema", () => {
  test("(a) accepts the nine-section finance fixture", () => {
    expect(validateFinanceSections(fixture.sections)).toEqual({
      ok: true,
      errors: [],
    });
  });

  test("(b) reports missing waterfall end with section index", () => {
    const sections = copy(fixture.sections);
    delete sections[4].data.end;

    const result = validateFinanceSections(sections);

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("sections[4]");
    expect(result.errors[0]).toContain("end");
  });

  test("(c) reports waterfall tie mismatch", () => {
    const sections = copy(fixture.sections);
    sections[4].data.end.value += 1000;

    const result = validateFinanceSections(sections);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/tie/i);
  });

  test("(d) rejects unknown scorecard status", () => {
    const sections = copy(fixture.sections);
    sections[1].data.rows[0].status = "blue";

    const result = validateFinanceSections(sections);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/sections\[1\].*status.*blue/i);
  });

  test("(e) rejects unsupported layout and lists supported layouts", () => {
    const sections = copy(fixture.sections);
    sections[0].layout = "pie";

    const result = validateFinanceSections(sections);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/sections\[0\].*pie/i);
    expect(result.errors.join(" ")).toMatch(/supported layouts/i);
  });

  test("rejects a missing section title", () => {
    const sections = copy(fixture.sections);
    delete sections[0].title;

    const result = validateFinanceSections(sections);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/sections\[0\]\.title/i);
  });

  test("rejects a formatted-string trend value", () => {
    const sections = copy(fixture.sections);
    sections[2].data.values[0] = "1,980,000";

    const result = validateFinanceSections(sections);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /sections\[2\]\.data\.values\[0\].*numeric/i
    );
  });

  test("rejects cash series length mismatch", () => {
    const sections = copy(fixture.sections);
    sections[5].data.payments.pop();

    const result = validateFinanceSections(sections);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /sections\[5\]\.data\.(categories|payments).*same length/i
    );
  });

  test("rejects a decision missing killCondition", () => {
    const sections = copy(fixture.sections);
    delete sections[8].data.items[0].killCondition;

    const result = validateFinanceSections(sections);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /sections\[8\]\.data\.items\[0\]\.killCondition/i
    );
  });

  test("rejects a formatted-string decision cost", () => {
    const sections = copy(fixture.sections);
    sections[8].data.items[0].cost = "1,000 บาท";

    const result = validateFinanceSections(sections);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /sections\[8\]\.data\.items\[0\]\.cost.*numeric/i
    );
  });
});

describe("pptx-finance executive theme and layouts", () => {
  test("(i) every theme color token is a six-digit hex value without #", () => {
    for (const themeName of getAvailableThemes()) {
      const theme = getTheme(themeName);
      const colorTokens = Object.entries(theme).flatMap(([key, value]) => {
        if (key === "chartColors") return value;
        return /color|^chart|^status/i.test(key) ? [value] : [];
      });

      expect(colorTokens.length).toBeGreaterThan(0);
      colorTokens.forEach((color) => {
        expect(color).not.toContain("#");
        expect(color).toMatch(/^[0-9A-F]{6}$/i);
      });
    }
  });

  test("(j) exposes the executive theme", () => {
    expect(getAvailableThemes()).toContain("executive");
  });

  test("formats finance numbers and percentages", () => {
    expect(formatNumber(1234567, "บาท")).toBe("1,234,567 บาท");
    expect(formatNumber(1234.56)).toBe("1,234.6");
    expect(formatPct(12.4)).toBe("+12.4%");
    expect(formatPct(-6.8)).toBe("-6.8%");
  });

  test("(k) renders non-chart finance layouts without pending fallback", async () => {
    const tool = setupTool();

    await tool.call(fixture);

    const outputDirectory = path.join(storageDir, "generated-files");
    const downloadCall = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const zip = await JSZip.loadAsync(
      fs.readFileSync(path.join(outputDirectory, downloadCall[1].storageFilename))
    );
    const slideXml = await Promise.all(
      Array.from({ length: 10 }, (_, index) => index + 1).map((slideNumber) =>
        zip.file(`ppt/slides/slide${slideNumber}.xml`).async("string")
      )
    );
    const [summaryXml, scorecardXml, risksXml, decisionsXml] = [2, 3, 9, 10].map(
      (slideNumber) => slideXml[slideNumber - 1]
    );

    for (const renderedXml of slideXml.slice(1))
      expect(renderedXml).not.toContain("pending");
    expect(summaryXml).toContain("18,420,000");
    const titleShape = summaryXml
      .match(/<p:sp>[\s\S]*?<\/p:sp>/g)
      .find((shape) => shape.includes(fixture.sections[0].title));
    expect(titleShape).toContain("<a:normAutofit");
    expect(scorecardXml).toContain("<a:tbl>");
    expect(risksXml).toContain("<a:tbl>");
    expect((decisionsXml.match(/roundRect/g) || []).length).toBeGreaterThanOrEqual(
      3
    );
  });

  test("(l) renders at least nine native finance charts", async () => {
    const tool = setupTool();
    await tool.call(fixture);
    const outputDirectory = path.join(storageDir, "generated-files");
    const downloadCall = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const zip = await JSZip.loadAsync(
      fs.readFileSync(path.join(outputDirectory, downloadCall[1].storageFilename))
    );
    const chartFiles = Object.keys(zip.files).filter((name) =>
      /^ppt\/charts\/chart\d+\.xml$/.test(name)
    );

    expect(chartFiles).toHaveLength(9);
  });

  test("(m) waterfall chart is stacked with inside-end labels", async () => {
    const tool = setupTool();
    await tool.call(fixture);
    const outputDirectory = path.join(storageDir, "generated-files");
    const downloadCall = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const zip = await JSZip.loadAsync(
      fs.readFileSync(path.join(outputDirectory, downloadCall[1].storageFilename))
    );
    const slideRelationships = await zip
      .file("ppt/slides/_rels/slide6.xml.rels")
      .async("string");
    const chartTarget = slideRelationships.match(/charts\/(chart\d+\.xml)/)[1];
    const chartXml = await zip.file(`ppt/charts/${chartTarget}`).async("string");

    expect(chartXml).toContain('<c:grouping val="stacked"/>');
    expect(chartXml).toContain('<c:dLblPos val="inEnd"/>');
  });

  test("waterfall hides chart labels and draws visible values as slide text", async () => {
    const tool = setupTool();
    await tool.call(fixture);
    const outputDirectory = path.join(storageDir, "generated-files");
    const downloadCall = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const zip = await JSZip.loadAsync(
      fs.readFileSync(path.join(outputDirectory, downloadCall[1].storageFilename))
    );
    const [chartXml] = await getSlideChartXml(zip, 6);
    const slideXml = await zip.file("ppt/slides/slide6.xml").async("string");

    expect(chartXml).not.toContain('<c:showVal val="1"/>');
    expect(chartXml).toContain('<c:showVal val="0"/>');
    expect(slideXml).toContain("1,640,000");
    expect(slideXml).toContain("2,530,000");
  });

  test("bar and doughnut charts render compact complete data labels", async () => {
    const tool = setupTool();
    await tool.call(fixture);
    const outputDirectory = path.join(storageDir, "generated-files");
    const downloadCall = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const zip = await JSZip.loadAsync(
      fs.readFileSync(path.join(outputDirectory, downloadCall[1].storageFilename))
    );
    const [barXml, donutXml] = await getSlideChartXml(zip, 5);

    expect(barXml).toMatch(
      /<c:dLbls>(?:(?!<\/c:dLbls>)[\s\S])*?<a:defRPr[^>]*sz="800"/
    );
    expect(donutXml).toContain('<c:showPercent val="1"/>');
    expect(donutXml).toContain('<c:showCatName val="0"/>');
    const doughnutLabels = donutXml.match(/<c:dLbl>[\s\S]*?<\/c:dLbl>/g) || [];
    expect(doughnutLabels).toHaveLength(fixture.sections[3].data.donut.values.length);
    doughnutLabels.forEach((label) => {
      expect(label).toContain('<c:dLblPos val="ctr"/>');
      expect(label.indexOf("<c:dLblPos")).toBeLessThan(
        label.indexOf("<c:showLegendKey")
      );
    });
    const oldAppendBehavior =
      '<c:dLbl><c:idx val="0"/><c:showLegendKey val="0"/>' +
      '<c:showVal val="0"/><c:dLblPos val="ctr"/></c:dLbl>';
    expect(oldAppendBehavior.indexOf("<c:dLblPos")).not.toBeLessThan(
      oldAppendBehavior.indexOf("<c:showLegendKey")
    );
  });

  test("trend plan band pins its axis and encodes exact range without shapes", async () => {
    const tool = setupTool();
    await tool.call(fixture);
    const outputDirectory = path.join(storageDir, "generated-files");
    const downloadCall = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const zip = await JSZip.loadAsync(
      fs.readFileSync(path.join(outputDirectory, downloadCall[1].storageFilename))
    );
    const [chartXml] = await getSlideChartXml(zip, 4);
    const slideXml = await zip.file("ppt/slides/slide4.xml").async("string");
    const planLines = (slideXml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []).filter(
      (shape) =>
        shape.includes('prst="line"') && shape.includes('prstDash val="dash"')
    );

    expect(chartXml).toContain('<c:max val="3000000"/>');
    expect((chartXml.match(/<c:ser>/g) || [])).toHaveLength(1);
    expect((chartXml.match(/<c:dPt>/g) || [])).toHaveLength(8);
    expect(chartXml).not.toContain("<c:lineChart>");
    expect(slideXml).toContain(
      "ช่วงแผน 2,100,000–2,350,000 บาท · 2 จาก 8 เดือนอยู่ในช่วง"
    );
    expect(planLines).toHaveLength(0);
  });

  test("forecast uses one valid chart with dashed forecast series", async () => {
    const tool = setupTool();
    await tool.call(fixture);
    const outputDirectory = path.join(storageDir, "generated-files");
    const downloadCall = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const generatedBuffer = fs.readFileSync(
      path.join(outputDirectory, downloadCall[1].storageFilename)
    );
    const zip = await JSZip.loadAsync(generatedBuffer);
    const [chartXml] = await getSlideChartXml(zip, 9);

    expect((chartXml.match(/<c:lineChart>/g) || [])).toHaveLength(1);
    expect((chartXml.match(/<c:ser>/g) || [])).toHaveLength(2);
    expect(chartXml).toContain('<a:prstDash val="dash"/>');

    const renamedZip = await JSZip.loadAsync(generatedBuffer);
    const relationships = await renamedZip
      .file("ppt/slides/_rels/slide9.xml.rels")
      .async("string");
    const chartName = relationships.match(/charts\/(chart\d+\.xml)/)[1];
    const renamedChart = (
      await renamedZip.file(`ppt/charts/${chartName}`).async("string")
    ).replace(/<c:v>ประมาณการ<\/c:v>/g, "<c:v>Renamed series</c:v>");
    const renamedChartSeries = renamedChart.match(/<c:ser>[\s\S]*?<\/c:ser>/g);
    renamedChartSeries[1] = renamedChartSeries[1].replace(
      '<a:prstDash val="dash"/>',
      '<a:prstDash val="solid"/>'
    );
    renamedZip.file(
      `ppt/charts/${chartName}`,
      renamedChart.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, () =>
        renamedChartSeries.shift()
      )
    );
    const renamedFixed = await JSZip.loadAsync(
      await fixEmbeddedChartTables(
        await renamedZip.generateAsync({ type: "nodebuffer" })
      )
    );
    const renamedChartXml = await renamedFixed
      .file(`ppt/charts/${chartName}`)
      .async("string");
    const renamedSeries =
      renamedChartXml.match(/<c:ser>[\s\S]*?<\/c:ser>/g) || [];

    expect(renamedSeries[1]).toContain('<a:prstDash val="dash"/>');
  });

  test("(n) stacked chart guard rejects outEnd labels", () => {
    expect(() =>
      assertStackedLabelPosition({
        barGrouping: "stacked",
        dataLabelPosition: "outEnd",
      })
    ).toThrow(/outEnd/);
    expect(RENDERERS.waterfall).toEqual(expect.any(Function));
  });

  test("(o) every chart color is a six-digit hex value", async () => {
    const tool = setupTool();
    await tool.call(fixture);
    const outputDirectory = path.join(storageDir, "generated-files");
    const downloadCall = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const zip = await JSZip.loadAsync(
      fs.readFileSync(path.join(outputDirectory, downloadCall[1].storageFilename))
    );
    const chartFiles = Object.keys(zip.files).filter((name) =>
      /^ppt\/charts\/chart\d+\.xml$/.test(name)
    );

    for (const chartFile of chartFiles) {
      const chartXml = await zip.file(chartFile).async("string");
      const colors = Array.from(
        chartXml.matchAll(/<c:srgbClr val="([^"]+)"/g),
        (match) => match[1]
      );
      colors.forEach((color) => expect(color).toMatch(/^[0-9A-F]{6}$/i));
    }
  });

  test("(p) finance output fixes all embedded chart table refs", async () => {
    const tool = setupTool();
    await tool.call(fixture);
    const outputDirectory = path.join(storageDir, "generated-files");
    const downloadCall = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const zip = await JSZip.loadAsync(
      fs.readFileSync(path.join(outputDirectory, downloadCall[1].storageFilename))
    );
    const embeddingNames = Object.keys(zip.files).filter((name) =>
      /^ppt\/embeddings\/.*\.xlsx$/.test(name)
    );

    expect(embeddingNames.length).toBeGreaterThanOrEqual(9);

    for (const embeddingName of embeddingNames) {
      const workbook = await JSZip.loadAsync(
        await zip.file(embeddingName).async("nodebuffer")
      );
      const tableNames = Object.keys(workbook.files).filter((name) =>
        /^xl\/tables\/.*\.xml$/.test(name)
      );
      for (const tableName of tableNames) {
        const tableXml = await workbook.file(tableName).async("string");
        expect(tableXml).not.toContain("'\"");
      }
    }
  });

  test("(q) raw pptxgenjs chart workbook contains the Keynote-breaking ref", async () => {
    const PptxGenJS = require("pptxgenjs");
    const pptx = new PptxGenJS();
    const slide = pptx.addSlide();
    slide.addChart(
      pptx.ChartType.bar,
      [{ name: "Series", labels: ["A", "B"], values: [1, 2] }],
      { barDir: "col", showLegend: false }
    );
    const raw = await pptx.write({ outputType: "nodebuffer" });
    const zip = await JSZip.loadAsync(raw);
    const embeddingNames = Object.keys(zip.files).filter((name) =>
      /^ppt\/embeddings\/.*\.xlsx$/.test(name)
    );
    const tableXml = [];

    for (const embeddingName of embeddingNames) {
      const workbook = await JSZip.loadAsync(
        await zip.file(embeddingName).async("nodebuffer")
      );
      const tableNames = Object.keys(workbook.files).filter((name) =>
        /^xl\/tables\/.*\.xml$/.test(name)
      );
      tableXml.push(
        ...(await Promise.all(
          tableNames.map((name) => workbook.file(name).async("string"))
        ))
      );
    }

    expect(tableXml.some((xml) => xml.includes("'\""))).toBe(true);
  });
});

describe("pptx-finance mode switch", () => {
  beforeEach(() => {
    runSectionAgent.mockClear();
  });

  test("exposes finance mode fields and example in the tool contract", () => {
    const tool = setupTool();
    const properties = tool.config.parameters.properties;
    const sectionProperties = properties.sections.items.properties;

    expect(tool.config.description).toMatch(/outline/i);
    expect(tool.config.description).toMatch(/finance/i);
    expect(properties.unit.type).toBe("string");
    expect(properties.footer.properties).toEqual(
      expect.objectContaining({
        period: expect.any(Object),
        source: expect.any(Object),
        preparedOn: expect.any(Object),
      })
    );
    expect(sectionProperties.layout.enum).toEqual(
      expect.arrayContaining([
        "summary",
        "scorecard",
        "trend_bar",
        "bar_donut",
        "waterfall",
        "cash",
        "ranked_pair",
        "risks_outlook",
        "decisions",
        "content",
        "section",
        "blank",
      ])
    );
    expect(sectionProperties.subtitle.type).toBe("string");
    expect(sectionProperties.notes.type).toBe("string");
    expect(sectionProperties.data.type).toBe("object");
    const financeExample = tool.config.examples.find((example) => {
      const call = JSON.parse(example.call);
      return call.mode === "finance";
    });
    expect(financeExample).toBeDefined();
    expect(JSON.parse(financeExample.call).sections).toHaveLength(2);
  });

  test("(f) outline mode calls one section agent per section", async () => {
    const tool = setupTool();
    const outline = {
      filename: "outline.pptx",
      title: "Outline",
      sections: [{ title: "One" }, { title: "Two" }],
    };

    expect(tool.config.parameters.properties.mode).toEqual(
      expect.objectContaining({
        enum: ["outline", "finance"],
        default: "outline",
      })
    );

    await tool.call(outline);

    expect(runSectionAgent).toHaveBeenCalledTimes(outline.sections.length);
  });

  test("(g) finance mode skips section agents and writes a PPTX", async () => {
    const tool = setupTool();

    const result = await tool.call(fixture);

    expect(result).toMatch(/^Successfully created presentation/);
    expect(runSectionAgent).not.toHaveBeenCalled();
    expect(tool.aibitat.socket.send).toHaveBeenCalledWith(
      "fileDownloadCard",
      expect.objectContaining({ filename: fixture.filename })
    );
    const outputDirectory = path.join(storageDir, "generated-files");
    const downloadCall = tool.aibitat.socket.send.mock.calls.find(
      ([type]) => type === "fileDownloadCard"
    );
    const generatedFile = downloadCall[1].storageFilename;

    const zip = await JSZip.loadAsync(
      fs.readFileSync(path.join(outputDirectory, generatedFile))
    );
    expect(zip.file("ppt/presentation.xml")).not.toBeNull();
    const slideFiles = Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name)
    );
    expect(slideFiles.length).toBeGreaterThanOrEqual(10);
  });

  test("(h) invalid finance input returns early without writing a file", async () => {
    const tool = setupTool();
    const invalid = copy(fixture);
    delete invalid.sections[4].data.end;

    const result = await tool.call(invalid);

    expect(result).toMatch(/^Cannot build finance deck:/);
    expect(runSectionAgent).not.toHaveBeenCalled();
    expect(tool.aibitat.socket.send).not.toHaveBeenCalled();
  });
});
