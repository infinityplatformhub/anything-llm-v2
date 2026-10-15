const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const groups = {
  configuration: [
    "configuration.test.cjs",
    "database-cli.test.cjs",
    "maintenance-connection.test.cjs",
  ],
  schema: [
    "schema-parity.test.cjs",
    "schema-contract.test.cjs",
    "provider-artifact.test.cjs",
  ],
  runtime: [
    "recovery-keys.test.cjs",
    "preflight.test.cjs",
    "startup.test.cjs",
    "bootstrap.test.cjs",
    "entrypoint.test.cjs",
  ],
  postgres: ["postgresql-baseline.test.cjs"],
  import: ["postgresql-baseline.test.cjs", "sequence-source.test.cjs"],
  verify: ["postgresql-baseline.test.cjs", "sequence-source.test.cjs"],
  provider: ["postgresql-baseline.test.cjs"],
  restore: [
    "postgresql-baseline.test.cjs",
    "publication.test.cjs",
    "recovery-set.test.cjs",
  ],
  recovery: ["publication.test.cjs", "recovery-set.test.cjs", "r2.test.cjs"],
};

function command(executable, args, env = process.env) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

const group = process.argv[2];
if (
  process.argv.length !== 3 ||
  ![...Object.keys(groups), "snapshot", "sqlite", "all"].includes(group)
) {
  console.error(
    "Select configuration, schema, runtime, postgres, import, verify, provider, restore, recovery, snapshot, sqlite or all."
  );
  process.exit(1);
}
if (group !== "snapshot" && group !== "sqlite") {
  const files =
    group === "all"
      ? [...new Set(Object.values(groups).flat())]
      : groups[group];
  command(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...files.map((file) => path.join("scripts/database/tests", file)),
  ]);
}
if (["snapshot", "all"].includes(group)) {
  command(
    "python3",
    [
      "-m",
      "unittest",
      "discover",
      "-s",
      "scripts/database/tests",
      "-p",
      "test_*.py",
      "-v",
    ],
    { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
  );
}
if (["sqlite", "all"].includes(group)) {
  const jest =
    process.env.MIGRATION_JEST_PATH ||
    path.join(root, "node_modules/jest/bin/jest.js");
  if (!fs.existsSync(jest)) {
    console.error(
      "Jest is unavailable; set MIGRATION_JEST_PATH to the approved installed Jest 29 entrypoint. Regression tests have NOT passed."
    );
    process.exit(1);
  }
  const tracked = spawnSync("git", ["ls-files", "server/__tests__"], {
    cwd: root,
    encoding: "utf8",
  });
  if (tracked.status !== 0) process.exit(1);
  const tests = tracked.stdout
    .trim()
    .split("\n")
    .filter(
      (file) => /\.(test|spec)\.js$/.test(file) && !file.includes("/e2e/")
    );
  if (!tests.length) process.exit(1);
  command(process.execPath, [
    jest,
    "--runInBand",
    "--runTestsByPath",
    ...tests,
  ]);
  command(process.execPath, [
    jest,
    "--runInBand",
    "--testMatch",
    "**/client-selection.test.cjs",
    "--runTestsByPath",
    "scripts/database/tests/client-selection.test.cjs",
  ]);
}
