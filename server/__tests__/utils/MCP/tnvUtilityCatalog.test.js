/* global jest, require, __dirname, process */
const {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} = require("@jest/globals");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
jest.mock("../../../models/systemSettings", () => ({ SystemSettings: {} }));
const {
  configureCatalog,
} = require("../../../../scripts/mcp/configure-tnv-utility.cjs");

let storageDir;
let catalogPath;
const originalCatalog = {
  customMetadata: { version: 2 },
  mcpServers: {
    "tnv2-novels": {
      url: "https://novels.example/mcp",
      headers: { "X-API-Key": "existing-private-key" },
    },
    other: { command: "existing-command", args: ["--keep"] },
  },
};

beforeEach(() => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tnv-catalog-"));
  catalogPath = path.join(storageDir, "plugins/anythingllm_mcp_servers.json");
  fs.mkdirSync(path.dirname(catalogPath));
  fs.writeFileSync(catalogPath, JSON.stringify(originalCatalog));
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe("TNv Utility catalog bootstrap", () => {
  it("defaults to a dry run without changing files or printing existing secrets", () => {
    const before = fs.readFileSync(catalogPath, "utf8");
    expect(configureCatalog({ storageDir }).status).toBe("would-add");
    expect(fs.readFileSync(catalogPath, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(catalogPath))).toEqual([
      path.basename(catalogPath),
    ]);
  });

  it("persists the personal API-key entry and preserves every existing entry and field", () => {
    const before = fs.readFileSync(catalogPath, "utf8");
    const result = configureCatalog({ storageDir, apply: true });
    expect(result.status).toBe("added");
    expect(JSON.parse(fs.readFileSync(catalogPath, "utf8"))).toEqual({
      ...originalCatalog,
      mcpServers: {
        ...originalCatalog.mcpServers,
        "tnv-utility": {
          type: "streamable",
          url: "https://utility-production-4bec.up.railway.app/mcp",
          anythingllm: {
            perUserAuth: true,
            personalAuth: { type: "apiKey", header: "X-API-Key" },
          },
        },
      },
    });
    expect(fs.readFileSync(result.backupPath, "utf8")).toBe(before);
    expect(fs.statSync(result.backupPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(catalogPath).mode & 0o777).toBe(0o600);
    const installed = fs.readFileSync(catalogPath, "utf8");
    const files = fs.readdirSync(path.dirname(catalogPath));
    expect(configureCatalog({ storageDir, apply: true }).status).toBe(
      "unchanged"
    );
    expect(fs.readFileSync(catalogPath, "utf8")).toBe(installed);
    expect(fs.readdirSync(path.dirname(catalogPath))).toEqual(files);
  });

  it("creates a catalog when storage has no plugins directory", () => {
    fs.rmSync(path.dirname(catalogPath), { recursive: true });
    expect(configureCatalog({ storageDir }).status).toBe("would-add");
    expect(fs.existsSync(path.dirname(catalogPath))).toBe(false);
    expect(configureCatalog({ storageDir, apply: true }).status).toBe("added");
    expect(
      Object.keys(JSON.parse(fs.readFileSync(catalogPath, "utf8")).mcpServers)
    ).toEqual(["tnv-utility"]);
  });

  it("refuses a mismatched definition without replacing it", () => {
    const existing = JSON.stringify({
      mcpServers: { "tnv-utility": { url: "https://other.example/mcp" } },
    });
    fs.writeFileSync(catalogPath, existing);
    expect(() => configureCatalog({ storageDir, apply: true })).toThrow(
      "Existing tnv-utility definition differs"
    );
    expect(fs.readFileSync(catalogPath, "utf8")).toBe(existing);
    expect(fs.readdirSync(path.dirname(catalogPath))).toEqual([
      path.basename(catalogPath),
    ]);
  });

  it.each(["{invalid private-key", "null", '{"mcpServers":[]}', "{}"])(
    "rejects malformed catalog %s without changing it",
    (existing) => {
      fs.writeFileSync(catalogPath, existing);
      expect(() => configureCatalog({ storageDir, apply: true })).toThrow(
        /MCP catalog/
      );
      expect(fs.readFileSync(catalogPath, "utf8")).toBe(existing);
    }
  );

  it("refuses a concurrent bootstrap lock and preserves the owner lock", () => {
    fs.writeFileSync(`${catalogPath}.tnv-utility.lock`, "12345\n");
    expect(() => configureCatalog({ storageDir, apply: true })).toThrow(
      "Cannot acquire TNv catalog lock"
    );
    expect(fs.readFileSync(`${catalogPath}.tnv-utility.lock`, "utf8")).toBe(
      "12345\n"
    );
    expect(JSON.parse(fs.readFileSync(catalogPath, "utf8"))).toEqual(
      originalCatalog
    );
  });

  it("detects another catalog writer before replacement and retains its change", () => {
    const writeFileSync = fs.writeFileSync;
    const concurrentCatalog = JSON.stringify({
      ...originalCatalog,
      changedByAdmin: true,
    });
    jest.spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
      const result = writeFileSync(file, ...args);
      if (typeof file === "string" && file.endsWith(".bak"))
        writeFileSync(catalogPath, concurrentCatalog);
      return result;
    });
    expect(() => configureCatalog({ storageDir, apply: true })).toThrow(
      "MCP catalog changed during configuration"
    );
    expect(fs.readFileSync(catalogPath, "utf8")).toBe(concurrentCatalog);
    expect(
      fs
        .readdirSync(path.dirname(catalogPath))
        .some((file) => file.endsWith(".tmp") || file.endsWith(".lock"))
    ).toBe(false);
  });

  it("runs the CLI with a dry run, explicit apply, and idempotent repeat", () => {
    const script = path.resolve(
      __dirname,
      "../../../../scripts/mcp/configure-tnv-utility.cjs"
    );
    const run = (...args) =>
      spawnSync(process.execPath, [script, ...args], {
        env: { ...process.env, STORAGE_DIR: storageDir },
        encoding: "utf8",
      });
    const dryRun = run();
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain("would-add");
    expect(dryRun.stdout).not.toContain("existing-private-key");
    expect(JSON.parse(fs.readFileSync(catalogPath, "utf8"))).toEqual(
      originalCatalog
    );
    expect(run("--apply").status).toBe(0);
    expect(run("--apply").stdout).toContain("unchanged");
    expect(run("--unknown").status).toBe(1);
    expect(
      JSON.parse(fs.readFileSync(catalogPath, "utf8")).mcpServers["tnv-utility"]
        .anythingllm.personalAuth
    ).toEqual({ type: "apiKey", header: "X-API-Key" });
  });
});
