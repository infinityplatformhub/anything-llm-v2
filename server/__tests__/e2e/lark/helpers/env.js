/**
 * Shared temp-environment plumbing for the Lark E2E suite: an isolated sqlite
 * database, a storage dir, fixed crypto secrets, and the fake CLI shim.
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const SERVER_DIR = path.resolve(__dirname, "../../../..");
const REPO_PRISMA_DIR = path.join(SERVER_DIR, "prisma");
const PRISMA_BIN = path.join(SERVER_DIR, "node_modules/.bin/prisma");
const PRELOAD = path.join(__dirname, "preload.js");
const FAKE_CLI = path.join(__dirname, "fakeCli.js");

/**
 * Builds a throwaway sqlite database by copying the repo migrations next to a
 * schema whose datasource url points into the temp dir, then running
 * `prisma migrate deploy` against it. The generated client still carries the
 * hardcoded `file:../storage/anythingllm.db`, so every process that touches the
 * database is started with `--require preload.js` + E2E_DATABASE_URL.
 */
function createTempEnvironment() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "allm-lark-e2e-"));
  const storageDir = path.join(root, "storage");
  const prismaDir = path.join(root, "prisma");
  const dbFile = path.join(root, "anythingllm.db");
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(prismaDir, { recursive: true });
  fs.cpSync(
    path.join(REPO_PRISMA_DIR, "migrations"),
    path.join(prismaDir, "migrations"),
    { recursive: true }
  );
  const schema = fs
    .readFileSync(path.join(REPO_PRISMA_DIR, "schema.prisma"), "utf8")
    .replace('url      = "file:../storage/anythingllm.db"', `url      = "file:${dbFile}"`);
  if (!schema.includes(`file:${dbFile}`))
    throw new Error("Could not repoint schema.prisma datasource for E2E");
  const schemaPath = path.join(prismaDir, "schema.prisma");
  fs.writeFileSync(schemaPath, schema);
  execFileSync(PRISMA_BIN, ["migrate", "deploy", "--schema", schemaPath], {
    cwd: SERVER_DIR,
    stdio: "pipe",
  });

  const cliState = path.join(root, "fake-cli-state.json");
  const invocations = path.join(root, "fake-cli-invocations.jsonl");
  const cliShim = path.join(root, "fake-cli-shim.sh");
  fs.writeFileSync(cliState, JSON.stringify({ mode: "ok", invocationsFile: invocations }));
  fs.writeFileSync(invocations, "");
  // The runner scrubs the environment before spawning, so the mode has to ride
  // in through the shim rather than through an inherited variable.
  fs.writeFileSync(
    cliShim,
    `#!/bin/sh\nFAKE_CLI_STATE=${JSON.stringify(cliState)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLI)} "$@"\n`
  );
  fs.chmodSync(cliShim, 0o755);

  const env = {
    STORAGE_DIR: storageDir,
    E2E_DATABASE_URL: `file:${dbFile}`,
    JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    JWT_EXPIRY: "30d",
    SIG_KEY: crypto.randomBytes(32).toString("hex"),
    SIG_SALT: crypto.randomBytes(32).toString("hex"),
    LARK_CLI_PATH: cliShim,
    DISABLE_TELEMETRY: "true",
    // Not "production": updateENV() dumps the whole environment to server/.env there,
    // which would overwrite a developer's file with throwaway secrets.
    NODE_ENV: "test",
  };

  return {
    root,
    storageDir,
    dbFile,
    schemaPath,
    env,
    cliState,
    invocations,
    preload: PRELOAD,
    setCliMode(mode) {
      fs.writeFileSync(
        cliState,
        JSON.stringify({ mode, invocationsFile: invocations })
      );
    },
    readInvocations() {
      return fs
        .readFileSync(invocations, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    clearInvocations() {
      fs.writeFileSync(invocations, "");
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { createTempEnvironment, SERVER_DIR, PRELOAD };

// Jest treats every JavaScript file under __tests__ as a suite; this keeps the
// helper honest when it is collected directly.
if (typeof expect !== "undefined" && expect.getState().testPath === __filename)
  test("is a helper module, not a suite", () => {
    expect(module.exports).toBeDefined();
  });
