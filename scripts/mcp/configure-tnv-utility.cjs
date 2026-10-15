#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { isDeepStrictEqual } = require("util");
const {
  validateWorkspaceServerConfig,
} = require("../../server/utils/MCP/serverConfig");

const SERVER_NAME = "tnv-utility";
const SERVER_CONFIG = {
  type: "streamable",
  url: "https://utility-production-4bec.up.railway.app/mcp",
  anythingllm: {
    perUserAuth: true,
    personalAuth: { type: "apiKey", header: "X-API-Key" },
  },
};

function readCatalog(catalogPath) {
  let raw;
  try {
    raw = fs.readFileSync(catalogPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT")
      return { raw: null, catalog: { mcpServers: {} } };
    throw new Error("Cannot read MCP catalog.");
  }
  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch {
    throw new Error("MCP catalog contains invalid JSON.");
  }
  if (
    !catalog ||
    typeof catalog !== "object" ||
    Array.isArray(catalog) ||
    !catalog.mcpServers ||
    typeof catalog.mcpServers !== "object" ||
    Array.isArray(catalog.mcpServers)
  )
    throw new Error("MCP catalog must contain an mcpServers object.");
  return { raw, catalog };
}

function configureCatalog({ storageDir, apply = false }) {
  if (!storageDir)
    throw new Error("Set STORAGE_DIR to the application's storage directory.");
  validateWorkspaceServerConfig(SERVER_CONFIG);
  const catalogPath = path.resolve(
    storageDir,
    "plugins/anythingllm_mcp_servers.json"
  );
  const directory = path.dirname(catalogPath);
  const lockPath = `${catalogPath}.tnv-utility.lock`;
  let lock;
  let temporaryPath;
  let backupPath = null;
  if (apply) {
    fs.mkdirSync(directory, { recursive: true });
    try {
      lock = fs.openSync(lockPath, "wx", 0o600);
    } catch {
      throw new Error(
        "Cannot acquire TNv catalog lock. Check for another run or a stale lock."
      );
    }
  }
  try {
    if (lock !== undefined) fs.writeFileSync(lock, `${process.pid}\n`);
    const { raw, catalog } = readCatalog(catalogPath);
    if (Object.hasOwn(catalog.mcpServers, SERVER_NAME)) {
      if (!isDeepStrictEqual(catalog.mcpServers[SERVER_NAME], SERVER_CONFIG))
        throw new Error(
          "Existing tnv-utility definition differs. Review it manually before retrying."
        );
      return { status: "unchanged", catalogPath, backupPath };
    }
    if (!apply) return { status: "would-add", catalogPath, backupPath };
    const suffix = randomUUID();
    if (raw !== null) {
      backupPath = `${catalogPath}.tnv-utility-${suffix}.bak`;
      fs.writeFileSync(backupPath, raw, { flag: "wx", mode: 0o600 });
    }
    catalog.mcpServers[SERVER_NAME] = SERVER_CONFIG;
    temporaryPath = `${catalogPath}.tnv-utility-${suffix}.tmp`;
    const temporaryFile = fs.openSync(temporaryPath, "wx", 0o600);
    try {
      fs.writeFileSync(temporaryFile, `${JSON.stringify(catalog, null, 2)}\n`);
      fs.fsyncSync(temporaryFile);
    } finally {
      fs.closeSync(temporaryFile);
    }
    // Admin catalog writes do not share this lock. Pause those writes during apply.
    if (readCatalog(catalogPath).raw !== raw)
      throw new Error(
        "MCP catalog changed during configuration. Pause other catalog writes and retry."
      );
    fs.renameSync(temporaryPath, catalogPath);
    temporaryPath = null;
    return { status: "added", catalogPath, backupPath };
  } finally {
    if (temporaryPath) fs.rmSync(temporaryPath, { force: true });
    if (lock !== undefined) {
      fs.closeSync(lock);
      fs.rmSync(lockPath, { force: true });
    }
  }
}

function main(args = process.argv.slice(2)) {
  if (args.some((arg) => !["--apply", "--help"].includes(arg)))
    throw new Error(
      "Use --apply to write the catalog, or no arguments for a dry run."
    );
  if (args.includes("--help")) {
    console.log(
      "STORAGE_DIR=/path/to/storage node scripts/mcp/configure-tnv-utility.cjs [--apply]"
    );
    return;
  }
  const result = configureCatalog({
    storageDir: process.env.STORAGE_DIR,
    apply: args.includes("--apply"),
  });
  console.log(`TNv Utility catalog entry: ${result.status}.`);
  if (result.status === "would-add")
    console.log(
      "Dry run. Pause other catalog writes, then rerun with --apply."
    );
  if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
}

module.exports = { configureCatalog, main };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`TNv Utility configuration failed. ${error.message}`);
    process.exitCode = 1;
  }
}
