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

function copy(value) {
  return JSON.parse(JSON.stringify(value));
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
