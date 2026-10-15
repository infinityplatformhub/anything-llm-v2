const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function run(provider, failGate = false) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "anythingllm-entrypoint-")
  );
  const app = path.join(root, "app");
  const bin = path.join(root, "bin");
  const log = path.join(root, "events");
  fs.mkdirSync(path.join(app, "server"), { recursive: true });
  fs.mkdirSync(bin);
  // Replace only the fixed container root with the owned fixture root. Execute
  // the actual shell flow; fake process boundaries cannot access services/data.
  const script = fs
    .readFileSync(
      path.resolve(__dirname, "../../../docker/docker-entrypoint.sh"),
      "utf8"
    )
    .replaceAll("/app", app);
  fs.writeFileSync(path.join(root, "entrypoint.sh"), script);
  fs.writeFileSync(
    path.join(bin, "node"),
    `#!/bin/bash
case "$*" in
  *ready.js*) echo gate >> "$FIXTURE_LOG"; exit "$FIXTURE_GATE" ;;
  *artifact.json*) printf '%s' "$FIXTURE_PROVIDER" ;;
  *collector/index.js*) echo start >> "$FIXTURE_LOG"; sleep 1 ;;
  *) echo start >> "$FIXTURE_LOG"; sleep 0.2 ;;
esac
`,
    { mode: 0o700 }
  );
  fs.writeFileSync(
    path.join(bin, "npx"),
    '#!/bin/bash\necho "npx:$*" >> "$FIXTURE_LOG"\n',
    { mode: 0o700 }
  );
  try {
    // macOS ships Bash 3 without wait -n; execute the Linux entrypoint in the
    // pinned existing image, with no network or production mounts.
    const env = {
      PATH: bin + ":/usr/bin:/bin",
      STORAGE_DIR: root,
      FIXTURE_LOG: log,
      FIXTURE_PROVIDER: provider,
      FIXTURE_GATE: failGate ? "1" : "0",
    };
    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--pull=never",
        "--platform",
        "linux/amd64",
        "--network",
        "none",
        "--mount",
        `type=bind,source=${root},target=${root}`,
        ...Object.entries(env).flatMap(([key, value]) => [
          "--env",
          `${key}=${value}`,
        ]),
        "--entrypoint",
        "/bin/bash",
        "postgres:17-bookworm@sha256:66aafa11cf15800a3c94763f7e11d1e7b2e37e5e84bc4ce027cb6e1e4bfaf4df",
        path.join(root, "entrypoint.sh"),
      ],
      {
        encoding: "utf8",
      }
    );
    return {
      status: result.status,
      events: fs.readFileSync(log, "utf8").trim().split("\n"),
    };
  } finally {
    fs.rmSync(root, { recursive: true }); // Exact owned fixture, never app storage.
  }
}

test("PG entrypoint starts both processes only after gate and never runs DDL", () => {
  const { status, events } = run("postgresql");
  assert.equal(status, 0);
  assert.equal(events[0], "gate");
  assert.equal(events.filter((event) => event === "start").length, 2);
  assert.ok(!events.some((event) => event.startsWith("npx:")));
});

test("failed readiness starts neither server nor collector", () => {
  const { status, events } = run("postgresql", true);
  assert.equal(status, 1);
  assert.deepEqual(events, ["gate"]);
});

test("SQLite entrypoint retains generation and migration", () => {
  const { status, events } = run("sqlite");
  assert.equal(status, 0);
  assert.ok(
    events.includes("npx:prisma generate --schema=./prisma/schema.prisma")
  );
  assert.ok(
    events.includes("npx:prisma migrate deploy --schema=./prisma/schema.prisma")
  );
});
