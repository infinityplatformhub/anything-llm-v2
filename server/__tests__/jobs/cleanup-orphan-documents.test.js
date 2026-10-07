const fs = require("fs");
const os = require("os");
const path = require("path");
const mockDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "orphan-documents-")
);
let mockRecords;
let mockConclude;
jest.mock("../../models/workspaceParsedFiles", () => ({
  WorkspaceParsedFiles: {
    where: async (_where, _limit, _order, select) =>
      mockRecords.map((record) =>
        Object.fromEntries(
          Object.keys(select)
            .filter((key) => select[key])
            .map((key) => [key, record[key]])
        )
      ),
  },
}));
jest.mock("../../utils/files", () => ({ directUploadsPath: mockDirectory }));
jest.mock("../../jobs/helpers", () => ({
  log: () => {},
  conclude: () => mockConclude(),
}));

afterAll(() => fs.rmSync(mockDirectory, { recursive: true, force: true }));

it("keeps referenced collector output and legacy names but deletes actual orphans", async () => {
  mockRecords = [
    {
      filename: "mailbox.mbox",
      metadata: JSON.stringify({
        location: "direct-uploads/mailbox-msg-1.json",
      }),
    },
    {
      filename: "mailbox.mbox",
      metadata: JSON.stringify({
        location: "direct-uploads/mailbox-msg-2.json",
      }),
    },
    { filename: "Legacy document.txt", metadata: "{}" },
    { filename: "Malformed.txt", metadata: "not-json" },
    { filename: "Null.txt", metadata: "null" },
    { filename: "Invalid.txt", metadata: JSON.stringify({ location: 42 }) },
    { filename: "Empty.txt", metadata: JSON.stringify({ location: "" }) },
  ];
  const keep = [
    "mailbox-msg-1.json",
    "mailbox-msg-2.json",
    "Legacy-document.txt",
    "Malformed.txt",
    "Null.txt",
    "Invalid.txt",
    "Empty.txt",
  ];
  for (const name of [...keep, "orphan.json"])
    fs.writeFileSync(path.join(mockDirectory, name), name);
  await new Promise((resolve) => {
    mockConclude = resolve;
    require("../../jobs/cleanup-orphan-documents");
  });
  for (const name of keep)
    expect(fs.readFileSync(path.join(mockDirectory, name), "utf8")).toBe(name);
  expect(fs.existsSync(path.join(mockDirectory, "orphan.json"))).toBe(false);
});
