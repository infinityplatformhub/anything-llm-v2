const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { Client } = require("../../../server/node_modules/pg");

async function withIndependentPostgres(run) {
  let id;
  let client;
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "anythingllm-independent-pg-")
  );
  try {
    id = execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--pull=never",
        "--platform",
        "linux/amd64",
        "--label",
        "anythingllm.fixture=independent-restore",
        "--publish",
        "127.0.0.1::5432",
        "--tmpfs",
        "/var/lib/postgresql/data",
        "--env",
        "POSTGRES_PASSWORD=synthetic-only",
        "--env",
        "POSTGRES_DB=fixture",
        "postgres:17-bookworm@sha256:66aafa11cf15800a3c94763f7e11d1e7b2e37e5e84bc4ce027cb6e1e4bfaf4df",
      ],
      { encoding: "utf8" }
    ).trim();
    const ports = JSON.parse(
      execFileSync(
        "docker",
        ["inspect", "--format", "{{json .NetworkSettings.Ports}}", id],
        { encoding: "utf8" }
      )
    );
    const binding = ports["5432/tcp"][0];
    assert.equal(binding.HostIp, "127.0.0.1");
    for (let attempt = 0; attempt < 60; attempt++) {
      const processName = execFileSync(
        "docker",
        ["exec", id, "cat", "/proc/1/comm"],
        { encoding: "utf8" }
      ).trim();
      if (processName !== "postgres") {
        if (attempt === 59)
          throw new Error("Independent PG initialization did not finish.");
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      client = new Client({
        host: "127.0.0.1",
        port: Number(binding.HostPort),
        user: "postgres",
        password: "synthetic-only",
        database: "fixture",
      });
      try {
        await client.connect();
        await client.query("SELECT 1");
        break;
      } catch (error) {
        await client.end().catch(() => {});
        client = null;
        if (attempt === 59) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await client.query(`CREATE ROLE anythingllm_migrator LOGIN PASSWORD 'synthetic-migrator';
      CREATE ROLE anythingllm_app LOGIN PASSWORD 'synthetic-runtime';
      ALTER SCHEMA public OWNER TO anythingllm_migrator;
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO anythingllm_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE anythingllm_migrator IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO anythingllm_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE anythingllm_migrator IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO anythingllm_app;`);
    const root = path.resolve(__dirname, "../../..");
    const env = Object.fromEntries(
      ["PATH", "HOME", "TMPDIR", "LANG"]
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]])
    );
    env.ANYTHINGLLM_DATABASE_URL = `postgresql://anythingllm_migrator:synthetic-migrator@127.0.0.1:${binding.HostPort}/fixture`;
    const migrated = spawnSync(
      path.join(root, "server/node_modules/.bin/prisma"),
      [
        "migrate",
        "deploy",
        "--schema",
        path.join(root, "server/prisma/postgresql/schema.prisma"),
      ],
      { env, cwd, encoding: "utf8" }
    );
    assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
    await client.query("SET ROLE anythingllm_migrator");
    await run(client);
  } finally {
    if (client) await client.end();
    if (id) {
      assert.equal(
        execFileSync(
          "docker",
          [
            "inspect",
            "--format",
            '{{index .Config.Labels "anythingllm.fixture"}}',
            id,
          ],
          { encoding: "utf8" }
        ).trim(),
        "independent-restore"
      );
      execFileSync("docker", ["rm", "--force", id], { stdio: "ignore" });
    }
    fs.rmdirSync(cwd);
  }
}

module.exports = { withIndependentPostgres };
