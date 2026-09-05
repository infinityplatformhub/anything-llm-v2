require("./_polyfill");
const fs = require("fs");
const os = require("os");
const path = require("path");
jest.mock("../../../utils/collectorApi", () => ({ CollectorApi: jest.fn() }));
const { CollectorApi } = require("../../../utils/collectorApi");
const { extractText } = require("../../../utils/lark/fileText");
let tmp;
const parseDocument = jest.fn();
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lark-text-test-"));
  parseDocument.mockReset();
  CollectorApi.mockImplementation(() => ({ parseDocument }));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
function fixture(extension, text = "hello") {
  const filePath = path.join(tmp, `file${extension}`);
  fs.writeFileSync(filePath, text);
  return filePath;
}
test.each([".md", ".mdx", ".txt", ".csv", ".json", ".adoc", ".rst", ".org"])("reads %s as UTF-8", async (extension) => {
  const filePath = fixture(extension, "Hello ไทย");
  expect(await extractText({ filePath, extension, maxBytes: 65536 })).toEqual({ ok: true, filename: `file${extension}`, extension, bytes: Buffer.byteLength("Hello ไทย"), text: "Hello ไทย", truncated: false });
  expect(parseDocument).not.toHaveBeenCalled();
});
test.each([".pdf", ".docx", ".xlsx", ".pptx"])("parses %s with collector", async (extension) => {
  const filePath = fixture(extension);
  parseDocument.mockResolvedValue({ success: true, documents: [{ pageContent: "one" }, { pageContent: "two" }] });
  expect(await extractText({ filePath, extension, maxBytes: 65536 })).toMatchObject({ ok: true, text: "one\n\ntwo", bytes: 5 });
  expect(parseDocument).toHaveBeenCalledWith(`file${extension}`, { absolutePath: filePath });
});
test.each([false, { success: false, documents: [] }, { success: true }])("collector failure returns parser_unavailable", async (response) => {
  parseDocument.mockResolvedValue(response);
  expect(await extractText({ filePath: fixture(".pdf"), extension: ".pdf", maxBytes: 65536 })).toEqual({ ok: false, error: "parser_unavailable" });
});
test("unreachable collector returns parser_unavailable", async () => {
  parseDocument.mockRejectedValue(new Error("connection refused"));
  expect(await extractText({ filePath: fixture(".pdf"), extension: ".pdf", maxBytes: 65536 })).toEqual({ ok: false, error: "parser_unavailable" });
});
test("unsupported extension is explicit", async () => {
  expect(await extractText({ filePath: fixture(".bin"), extension: ".bin", maxBytes: 65536 })).toEqual({ ok: false, error: "unsupported_file_type", extension: ".bin" });
});
test("caps UTF-8 at complete characters and caps collector text", async () => {
  const result = await extractText({ filePath: fixture(".md", "a€b"), extension: ".md", maxBytes: 3 });
  expect(result).toMatchObject({ text: "a", truncated: true });
  expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(3);
  parseDocument.mockResolvedValue({ success: true, documents: [{ pageContent: "x".repeat(70000) }] });
  const office = await extractText({ filePath: fixture(".pdf"), extension: ".pdf", maxBytes: 65536 });
  expect(office.text).toHaveLength(65536);
  expect(office.truncated).toBe(true);
});
