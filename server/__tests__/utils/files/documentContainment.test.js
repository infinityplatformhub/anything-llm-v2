const fs = require("fs");
const os = require("os");
const path = require("path");
jest.mock("node:worker_threads", () => ({ parentPort: { postMessage: jest.fn() } }));
jest.mock("../../../models/documents", () => ({ Document: { where: jest.fn() } }));

let storage;
let originalStorage;
let originalNodeEnv;
let fileData;
let DocumentManager;
let updateSourceDocument;

beforeAll(() => {
  originalStorage = process.env.STORAGE_DIR;
  originalNodeEnv = process.env.NODE_ENV;
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "anythingllm-document-containment-"));
  process.env.NODE_ENV = "test";
  process.env.STORAGE_DIR = storage;
  fs.mkdirSync(path.join(storage, "documents"));
  ({ fileData } = require("../../../utils/files"));
  ({ DocumentManager } = require("../../../utils/DocumentManager"));
  ({ updateSourceDocument } = require("../../../jobs/helpers"));
});

afterAll(() => {
  fs.rmSync(storage, { recursive: true, force: true });
  if (originalStorage === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = originalStorage;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

it("rejects raw traversal even when normalization would alias an existing document", async () => {
  fs.writeFileSync(path.join(storage, "documents", "inside.json"), JSON.stringify({ pageContent: "inside" }));
  expect(await fileData("inside.json")).toEqual({ pageContent: "inside" });
  expect(await fileData("../inside.json")).toBeNull();
  expect(await fileData(".")).toBeNull();
});

it("skips outside pinned sources and retains legitimate documents", async () => {
  const document = { pageContent: "inside", token_count_estimate: 1 };
  fs.writeFileSync(path.join(storage, "documents", "pinned.json"), JSON.stringify(document));
  fs.writeFileSync(path.join(storage, "outside.json"), JSON.stringify({ pageContent: "secret", token_count_estimate: 1 }));
  const { Document } = require("../../../models/documents");
  Document.where.mockResolvedValue([{ docpath: "../outside.json" }, { docpath: "pinned.json" }]);
  const read = jest.spyOn(fs, "readFileSync");
  try {
    expect(await new DocumentManager({ workspace: { id: 1 } }).pinnedDocs()).toEqual([document]);
    expect(read).not.toHaveBeenCalledWith(path.join(storage, "outside.json"), expect.anything());
  } finally { read.mockRestore(); }
});

it("refuses background writes outside documents and preserves the outside canary", () => {
  const outside = path.join(storage, "canary.json");
  fs.writeFileSync(outside, "unchanged");
  expect(updateSourceDocument("../canary.json", { overwritten: true })).toBe(false);
  expect(updateSourceDocument(outside, { overwritten: true })).toBe(false);
  expect(updateSourceDocument(".", {})).toBe(false);
  expect(updateSourceDocument(null, {})).toBe(false);
  expect(fs.readFileSync(outside, "utf8")).toBe("unchanged");
  expect(updateSourceDocument("inside.json", { pageContent: "updated" })).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(storage, "documents", "inside.json"), "utf8"))).toEqual({ pageContent: "updated" });
});
