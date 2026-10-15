const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const cli = path.resolve(__dirname, "../cli.cjs");
function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
}

test("prints explicit offline/maintenance commands without accessing a database", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /export/);
  assert.match(result.stdout, /verify/);
  assert.match(result.stdout, /import/);
});

test("refuses an unknown command or URL on the command line", () => {
  const result = run([
    "import",
    "--url",
    "postgresql://user:secret-sentinel@localhost/db",
  ]);
  assert.notEqual(result.status, 0);
  assert.ok(!result.stderr.includes("secret-sentinel"));
});

test("does not accept an unprotected request file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anythingllm-cli-"));
  try {
    const request = path.join(root, "request.json");
    fs.writeFileSync(request, "{}", { mode: 0o644 });
    const result = run(["export", "--request", request]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /protected/);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("emits complete provider mapping without altering the built artifact", () => {
  const result = run(["contract"]);
  assert.equal(result.status, 0);
  const contract = JSON.parse(result.stdout);
  assert.equal(contract.tables.length, 40);
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../../server/utils/prisma/artifact.json"),
        "utf8"
      )
    ).provider,
    "sqlite"
  );
});
