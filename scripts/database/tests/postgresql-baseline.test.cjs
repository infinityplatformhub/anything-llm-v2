const test = globalThis.test || require("node:test").test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("../../../server/node_modules/pg");
const { execFileSync, spawnSync } = require("node:child_process");
const os = require("node:os");

test("PG baseline preserves fork tables and restricts ledger writes", async () => {
  // An immutable locally available PG image, no production configuration/volumes.
  const image =
    "postgres:17-bookworm@sha256:66aafa11cf15800a3c94763f7e11d1e7b2e37e5e84bc4ce027cb6e1e4bfaf4df";
  const name = `anythingllm-pg-schema-${process.pid}-${Date.now()}`;
  let id;
  let client;
  let runtime;
  try {
    id = execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--pull=never",
        "--platform",
        "linux/amd64",
        "--name",
        name,
        "--label",
        "anythingllm.fixture=pg-migration",
        "--publish",
        "127.0.0.1::5432",
        "--env",
        "POSTGRES_PASSWORD=synthetic-fixture-only",
        "--env",
        "POSTGRES_DB=fixture",
        "--tmpfs",
        "/var/lib/postgresql/data",
        image,
      ],
      { encoding: "utf8" }
    ).trim();
    const binding = JSON.parse(
      execFileSync(
        "docker",
        ["inspect", "--format", "{{json .NetworkSettings.Ports}}", id],
        { encoding: "utf8" }
      )
    )["5432/tcp"][0];
    assert.equal(binding.HostIp, "127.0.0.1");
    const options = {
      host: "127.0.0.1",
      port: Number(binding.HostPort),
      user: "postgres",
      password: "synthetic-fixture-only",
      database: "fixture",
    };
    for (let attempt = 0; attempt < 60; attempt++) {
      // The image's temporary initdb server deliberately shuts down. Do not
      // accept its successful SELECT as readiness for the final PID 1 server.
      const processName = execFileSync(
        "docker",
        ["exec", id, "cat", "/proc/1/comm"],
        { encoding: "utf8" }
      ).trim();
      if (processName !== "postgres") {
        if (attempt === 59)
          throw new Error(
            "Disposable PostgreSQL initialization did not finish."
          );
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      client = new Client(options);
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
      ALTER DEFAULT PRIVILEGES FOR ROLE anythingllm_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anythingllm_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE anythingllm_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anythingllm_app;
    `);
    const root = path.resolve(__dirname, "../../..");
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "anythingllm-pg-prisma-")
    );
    try {
      const env = Object.fromEntries(
        ["PATH", "HOME", "TMPDIR", "LANG"]
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]])
      );
      env.ANYTHINGLLM_DATABASE_URL = `postgresql://anythingllm_migrator:synthetic-migrator@127.0.0.1:${binding.HostPort}/fixture`;
      const args = [
        "migrate",
        "deploy",
        "--schema",
        path.join(root, "server/prisma/postgresql/schema.prisma"),
      ];
      for (let run = 0; run < 2; run++) {
        const result = spawnSync(
          path.join(root, "server/node_modules/.bin/prisma"),
          args,
          { cwd, env, encoding: "utf8" }
        );
        assert.equal(result.status, 0, result.stdout + result.stderr);
      }
      const diff = spawnSync(
        path.join(root, "server/node_modules/.bin/prisma"),
        [
          "migrate",
          "diff",
          "--from-schema-datasource",
          path.join(root, "server/prisma/postgresql/schema.prisma"),
          "--to-schema-datamodel",
          path.join(root, "server/prisma/postgresql/schema.prisma"),
          "--exit-code",
        ],
        { cwd, env, encoding: "utf8" }
      );
      assert.equal(diff.status, 0, diff.stdout + diff.stderr);
    } finally {
      fs.rmdirSync(cwd);
    }
    const ledger = (
      await client.query(
        'SELECT migration_name,finished_at FROM "_prisma_migrations"'
      )
    ).rows;
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0].migration_name, "20261008000000_initial");
    assert.ok(ledger[0].finished_at);
    await require("../../../server/utils/prisma/schema").verifySchemaCatalog(
      async (sql) => (await client.query(sql)).rows
    );
    const verifyCatalog = () =>
      require("../../../server/utils/prisma/schema").verifySchemaCatalog(
        async (sql) => (await client.query(sql)).rows
      );
    await client.query(
      "ALTER TABLE users ALTER COLUMN id SET DEFAULT nextval('workspaces_id_seq'::regclass)"
    );
    try {
      await assert.rejects(verifyCatalog(), /sequence default mismatch/);
    } finally {
      await client.query(
        "ALTER TABLE users ALTER COLUMN id SET DEFAULT nextval('users_id_seq'::regclass)"
      );
    }
    await client.query("ALTER SEQUENCE users_id_seq OWNED BY NONE");
    try {
      await assert.rejects(verifyCatalog(), /sequence default mismatch/);
    } finally {
      await client.query("ALTER SEQUENCE users_id_seq OWNED BY users.id");
    }
    await verifyCatalog();
    await require("./import-regressions.cjs").verifyImportRegressions({
      client,
    });
    const tlsFixture = await require("./prisma-tls.cjs").verifyPrismaTls({
      id,
      client,
      port: Number(binding.HostPort),
    });
    if (process.env.MIGRATION_RUNTIME_IMAGE) {
      await require("./runtime-smoke.cjs").verifyRuntimeSmoke({
        id,
        client,
        tlsFixture,
      });
      // The smoke changed the server leaf for its isolated network. Restore the
      // loopback leaf for the remaining host-client strict hostname checks.
      for (const [source, target] of [
        [tlsFixture.keyFile, "server.key"],
        [tlsFixture.certificateFile, "server.crt"],
      ])
        execFileSync(
          "docker",
          [
            "exec",
            "--interactive",
            "--user",
            "root",
            id,
            "sh",
            "-c",
            `cat > /var/lib/postgresql/data/${target}`,
          ],
          { input: fs.readFileSync(source), stdio: ["pipe", "ignore", "pipe"] }
        );
      await client.query("SELECT pg_reload_conf()");
    }
    const models = require("../../../server/generated/prisma-postgresql").Prisma
      .dmmf.datamodel.models;
    const columns = (
      await client.query(
        "SELECT table_name,column_name,is_nullable,data_type FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position"
      )
    ).rows;
    for (const model of models) {
      const table = model.dbName || model.name;
      const fields = model.fields.filter((field) => field.kind === "scalar");
      const actual = columns.filter((column) => column.table_name === table);
      assert.equal(actual.length, fields.length, `Column count for ${table}`);
      for (const field of fields) {
        const column = actual.find(
          (candidate) => candidate.column_name === (field.dbName || field.name)
        );
        assert.ok(column, `Missing physical field ${table}.${field.name}`);
        assert.equal(column.is_nullable, field.isRequired ? "NO" : "YES");
        assert.equal(
          column.data_type,
          {
            Int: "integer",
            String: "text",
            Boolean: "boolean",
            Float: "double precision",
            DateTime: "timestamp with time zone",
          }[field.type]
        );
      }
    }
    const tables = (
      await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
      )
    ).rows.map((row) => row.tablename);
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../server/prisma/schema.prisma"),
      "utf8"
    );
    const expected = [...source.matchAll(/^model (\w+) \{/gm)].map(
      (match) => match[1]
    );
    assert.deepEqual(tables, [...expected, "_prisma_migrations"].sort());
    const dates = await client.query(
      "SELECT data_type, datetime_precision FROM information_schema.columns WHERE table_schema='public' AND column_name='createdAt' AND table_name='users'"
    );
    assert.deepEqual(dates.rows, [
      { data_type: "timestamp with time zone", datetime_precision: 3 },
    ]);
    runtime = new Client({
      ...options,
      user: "anythingllm_app",
      password: "synthetic-runtime",
    });
    await runtime.connect();
    const user = (
      await runtime.query(
        "INSERT INTO users (password) VALUES ($1) RETURNING id",
        ["fixture-hash"]
      )
    ).rows[0];
    const workspace = (
      await runtime.query(
        "INSERT INTO workspaces (name,slug) VALUES ($1,$2) RETURNING id",
        ["fixture", "fixture"]
      )
    ).rows[0];
    await runtime.query(
      'INSERT INTO workspace_mcp_servers (workspace_id,name,config,"lastUpdatedAt") VALUES ($1,$2,$3,now())',
      [workspace.id, "fixture", "ciphertext-fixture"]
    );
    await runtime.query(
      "INSERT INTO lark_identities (user_id,open_id,tenant_key,access_token,refresh_token,access_expires_at,refresh_expires_at,scopes) VALUES ($1,$2,$3,$4,$5,now(),now(),$6)",
      [
        user.id,
        "fixture-open",
        "fixture-tenant",
        "ciphertext-a",
        "ciphertext-r",
        "[]",
      ]
    );
    await assert.rejects(
      runtime.query('INSERT INTO "_prisma_migrations" (id) VALUES ($1)', [
        "tamper",
      ]),
      { code: "42501" }
    );
    await assert.rejects(
      runtime.query('UPDATE "_prisma_migrations" SET id=$1', ["tamper"]),
      { code: "42501" }
    );
    await assert.rejects(runtime.query('DELETE FROM "_prisma_migrations"'), {
      code: "42501",
    });
    await assert.rejects(
      runtime.query("CREATE TABLE unauthorized (id INTEGER)"),
      { code: "42501" }
    );
    await runtime.query('SELECT * FROM "_prisma_migrations"');
    const {
      PrismaClient,
    } = require("../../../server/generated/prisma-postgresql");
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: tlsFixture.url,
        },
      },
    });
    try {
      const {
        preflightDatabase,
      } = require("../../../server/utils/prisma/preflight");
      const artifact = require("../provider-artifact.cjs").createArtifact(
        "postgresql"
      );
      const configuration = {
        provider: "postgresql",
        url: tlsFixture.url,
      };
      const preflight = () =>
        preflightDatabase({
          prisma,
          Prisma: require("../../../server/generated/prisma-postgresql").Prisma,
          configuration,
          artifact,
        });
      await preflight();
      await client.query(
        "ALTER TABLE users ALTER COLUMN id SET DEFAULT nextval('workspaces_id_seq'::regclass)"
      );
      try {
        await assert.rejects(preflight(), /preflight failed/);
      } finally {
        await client.query(
          "ALTER TABLE users ALTER COLUMN id SET DEFAULT nextval('users_id_seq'::regclass)"
        );
      }
      await preflight();
      await client.query("DROP INDEX users_username_key");
      await assert.rejects(preflight(), /preflight failed/);
      await client.query(
        "CREATE UNIQUE INDEX users_username_key ON users(username)"
      );
      await client.query(
        "ALTER TABLE users ALTER COLUMN suspended SET DEFAULT 9"
      );
      await assert.rejects(preflight(), /preflight failed/);
      await client.query(
        "ALTER TABLE users ALTER COLUMN suspended SET DEFAULT 0"
      );
      await client.query(
        "ALTER TABLE workspace_mcp_servers DROP CONSTRAINT workspace_mcp_servers_workspace_id_fkey"
      );
      await assert.rejects(preflight(), /preflight failed/);
      await client.query(
        "ALTER TABLE workspace_mcp_servers ADD CONSTRAINT workspace_mcp_servers_workspace_id_fkey FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE ON UPDATE CASCADE"
      );
      await preflight();
      await client.query(
        'GRANT UPDATE ON "_prisma_migrations" TO anythingllm_app'
      );
      await assert.rejects(preflight(), /preflight failed/);
      await client.query(
        'REVOKE UPDATE ON "_prisma_migrations" FROM anythingllm_app'
      );
      await client.query("ALTER TABLE users ADD COLUMN unexpected TEXT");
      await assert.rejects(preflight(), /preflight failed/);
      await client.query("ALTER TABLE users DROP COLUMN unexpected");
      await client.query(
        "ALTER TABLE users ALTER COLUMN password DROP NOT NULL"
      );
      await assert.rejects(preflight(), /preflight failed/);
      await client.query(
        "ALTER TABLE users ALTER COLUMN password SET NOT NULL"
      );
      await client.query(
        "REVOKE USAGE ON SEQUENCE users_id_seq FROM anythingllm_app"
      );
      await assert.rejects(preflight(), /preflight failed/);
      await client.query(
        "GRANT USAGE ON SEQUENCE users_id_seq TO anythingllm_app"
      );
      await preflight();
      const found = await prisma.workspace_mcp_servers.findFirst({
        where: { workspace_id: workspace.id },
      });
      assert.equal(found.config, "ciphertext-fixture");
      const identity = await prisma.lark_identities.findUnique({
        where: { user_id: user.id },
      });
      assert.ok(identity.access_expires_at instanceof Date);
      await require("./provider-regressions.cjs").verifyProviderRegressions({
        prisma,
        admin: client,
        url: configuration.url,
      });
    } finally {
      await prisma.$disconnect();
      tlsFixture.cleanup();
    }
    await runtime.query("DELETE FROM workspaces WHERE id=$1", [workspace.id]);
    assert.equal(
      (
        await runtime.query(
          "SELECT COUNT(*)::int AS count FROM workspace_mcp_servers WHERE workspace_id=$1",
          [workspace.id]
        )
      ).rows[0].count,
      0
    );
  } catch (error) {
    // Fixture-only diagnostics distinguish server restarts/OOM from SQL bugs;
    // production credentials/data are never present in this disposable server.
    if (id) {
      const state = execFileSync(
        "docker",
        ["inspect", "--format", "{{json .State}}", id],
        { encoding: "utf8" }
      );
      console.error("Disposable PG state:", state);
      console.error(
        execFileSync("docker", ["logs", "--tail", "30", id], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })
      );
    }
    throw error;
  } finally {
    if (runtime) await runtime.end();
    if (client) await client.end();
    if (id) {
      const owned = execFileSync(
        "docker",
        [
          "inspect",
          "--format",
          '{{index .Config.Labels "anythingllm.fixture"}}',
          id,
        ],
        { encoding: "utf8" }
      ).trim();
      assert.equal(owned, "pg-migration");
      execFileSync("docker", ["rm", "--force", id], { stdio: "ignore" });
    }
  }
});
