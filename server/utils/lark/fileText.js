const fs = require("fs");
const path = require("path");
const { CollectorApi } = require("../collectorApi");

const TEXT_TYPES = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".csv",
  ".json",
  ".adoc",
  ".rst",
  ".org",
]);
const OFFICE_TYPES = new Set([".pdf", ".docx", ".xlsx", ".pptx"]);

async function extractText({ filePath, extension, maxBytes = 65_536 }) {
  extension = extension.toLowerCase();
  if (!TEXT_TYPES.has(extension) && !OFFICE_TYPES.has(extension))
    return { ok: false, error: "unsupported_file_type", extension };

  const filename = path.basename(filePath);
  const { size: bytes } = await fs.promises.stat(filePath);
  let text;
  if (TEXT_TYPES.has(extension)) {
    text = await fs.promises.readFile(filePath, "utf8");
  } else {
    try {
      const result = await new CollectorApi().parseDocument(filename, {
        absolutePath: filePath,
      });
      if (!result?.success || !Array.isArray(result.documents))
        return { ok: false, error: "parser_unavailable" };
      text = result.documents
        .map((document) => document.pageContent)
        .join("\n\n");
    } catch {
      return { ok: false, error: "parser_unavailable" };
    }
  }
  const buffer = Buffer.from(text, "utf8");
  const truncated = buffer.length > maxBytes;
  if (truncated) {
    let end = maxBytes;
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
    text = buffer.subarray(0, end).toString("utf8");
  }
  return { ok: true, filename, extension, bytes, text, truncated };
}

module.exports = { extractText };
