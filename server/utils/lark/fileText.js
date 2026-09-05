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

async function sniffExtension(filePath) {
  const file = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(65_536);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return ".pdf";
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
      let offset = 0;
      while (offset + 30 <= bytes.length) {
        if (bytes.readUInt32LE(offset) !== 0x04034b50) break;
        const nameLength = bytes.readUInt16LE(offset + 26);
        const extraLength = bytes.readUInt16LE(offset + 28);
        const nameEnd = offset + 30 + nameLength;
        if (nameEnd + extraLength > bytes.length) break;
        const name = bytes.subarray(offset + 30, nameEnd).toString("utf8");
        for (const [prefix, extension] of [
          ["word/", ".docx"],
          ["xl/", ".xlsx"],
          ["ppt/", ".pptx"],
        ])
          if (name.startsWith(prefix)) return extension;
        offset = nameEnd + extraLength + bytes.readUInt32LE(offset + 18);
      }
      return ".zip";
    }
    const textSample = bytes.subarray(0, 512);
    if (textSample.includes(0)) return "";
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(textSample, {
        stream: bytesRead > 512,
      });
      return ".txt";
    } catch {
      return "";
    }
  } finally {
    await file.close();
  }
}

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

module.exports = { extractText, sniffExtension };
