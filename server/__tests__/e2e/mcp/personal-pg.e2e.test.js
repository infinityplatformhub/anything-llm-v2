require("../lark/helpers/preload");
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { Client } = require("pg");
const crypto = require("crypto");
const net = require("net");
jest.setTimeout(120000);
test("isolated full PostgreSQL schema/client and migration-free application startup serve personal API", async () => {
  const url = process.env.PERSONAL_MCP_TEST_PG_URL;
  if (
    !url ||
    new URL(url).pathname !== "/anythingllm_mcp_oauth_test" ||
    new URL(url).host !== "127.0.0.1:55471"
  )
    throw new Error("fixture destination required");
  const server = path.resolve(__dirname, "../../..");
  const root = fs.mkdtempSync(
    path.join(server, "storage/personal-pg-integration-")
  );
  const source = path.join(root, "server");
  fs.mkdirSync(source);
  const modules = path.join(source, "node_modules");
  fs.mkdirSync(modules);
  let child,
    db = new Client({ connectionString: url });
  await db.connect();
  const schemaName = `personal_client_fix3_${crypto.randomBytes(6).toString("hex")}`;
  const wrongSchema = `${schemaName}_unmigrated`;
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  try {
    await db.query(`CREATE SCHEMA ${schemaName}`);
    await db.query(`CREATE SCHEMA ${wrongSchema}`);
    for (const name of [
      "index.js",
      "package.json",
      "utils",
      "models",
      "endpoints",
      "middleware",
      "jobs",
      "swagger",
      "scripts",
      "prisma",
    ])
      fs.cpSync(path.join(server, name), path.join(source, name), {
        recursive: true,
      });
    for (const name of fs.readdirSync(path.join(server, "node_modules"))) {
      if ([".prisma", "@prisma"].includes(name)) continue;
      fs.symlinkSync(
        path.join(server, "node_modules", name),
        path.join(modules, name)
      );
    }
    fs.cpSync(
      path.join(server, "node_modules/@prisma"),
      path.join(modules, "@prisma"),
      { recursive: true, dereference: true }
    );
    const schema = fs
      .readFileSync(path.join(server, "prisma/schema.prisma"), "utf8")
      .replace(
        'provider = "prisma-client-js"',
        `provider = "prisma-client-js"\n output = ${JSON.stringify(path.join(modules, ".prisma/client"))}`
      )
      .replace('provider = "sqlite"', 'provider = "postgresql"')
      .replace(
        'url      = "file:../storage/anythingllm.db"',
        'url      = env("DATABASE_URL")'
      );
    const schemaPath = path.join(source, "pg.prisma");
    fs.writeFileSync(schemaPath, schema);
    const connection = new URL(url);
    connection.searchParams.set("schema", schemaName);
    const env = {
      ...process.env,
      DATABASE_URL: connection.href,
      ANYTHINGLLM_DATABASE_URL: connection.href,
      NODE_ENV: "development",
      STORAGE_DIR: path.join(source, "storage"),
      SERVER_PORT: String(port),
      SERVER_URL: `http://127.0.0.1:${port}`,
      SIG_KEY: "pg-fixture-key",
      SIG_SALT: "pg-fixture-salt",
      JWT_SECRET: "pg-fixture-secret",
      DISABLE_TELEMETRY: "true",
    };
    fs.mkdirSync(env.STORAGE_DIR);
    fs.mkdirSync(path.join(env.STORAGE_DIR, "plugins"));
    fs.writeFileSync(
      path.join(env.STORAGE_DIR, "plugins/anythingllm_mcp_servers.json"),
      ' {"mcpServers":{}}'
    );
    execFileSync(
      process.execPath,
      [
        path.join(server, "node_modules/prisma/build/index.js"),
        "db",
        "push",
        "--schema",
        schemaPath,
        "--skip-generate",
      ],
      { cwd: source, env, stdio: "pipe" }
    );
    execFileSync(
      process.execPath,
      [
        path.join(server, "node_modules/prisma/build/index.js"),
        "generate",
        "--schema",
        schemaPath,
      ],
      { cwd: source, env, stdio: "pipe" }
    );
    // Replace only fixture new tables via executable additive job (full baseline untouched).
    await db.query(`SET search_path TO ${schemaName}`);
    await db.query(
      "DROP TABLE personal_mcp_grants; DROP TABLE personal_mcp_contexts;"
    );
    const jobUrl = new URL(connection);
    jobUrl.searchParams.set("options", `-c search_path=${schemaName}`);
    execFileSync(
      process.execPath,
      [path.join(source, "scripts/personal-mcp-pg-migrate.cjs")],
      {
        cwd: source,
        env: {
          ...env,
          DATABASE_URL: jobUrl.href,
          PERSONAL_MCP_PG_MIGRATION_APPROVED: "true",
        },
        stdio: "pipe",
      }
    );
    const Prisma = require(path.join(modules, ".prisma/client")).PrismaClient;
    const prisma = new Prisma({
      datasources: { db: { url: connection.href } },
    });
    try {
      const ws = await prisma.workspaces.create({
        data: { name: "PG startup", slug: "pg-startup" },
      });
      const user = await prisma.users.create({
        data: { username: "pg-owner", password: "fixture" },
      });
      await prisma.workspace_users.create({
        data: { workspace_id: ws.id, user_id: user.id },
      });
      await prisma.system_settings.create({
        data: { label: "multi_user_mode", value: "true" },
      });
      // Run actual context helper and postinsert protection with isolated PG client.
      const previous = {
        ANYTHINGLLM_DATABASE_URL: process.env.ANYTHINGLLM_DATABASE_URL,
        SIG_KEY: process.env.SIG_KEY,
        SIG_SALT: process.env.SIG_SALT,
      };
      Object.assign(process.env, {
        ANYTHINGLLM_DATABASE_URL: connection.href,
        SIG_KEY: env.SIG_KEY,
        SIG_SALT: env.SIG_SALT,
      });
      const Context = require(
        path.join(source, "models/personalMcpContext")
      ).PersonalMcpContext;
      const model = require(
        path.join(source, "models/workspaceAgentInvocation")
      ).WorkspaceAgentInvocation;
      const invocation = await prisma.workspace_agent_invocations.create({
        data: {
          uuid: crypto.randomUUID(),
          workspace_id: ws.id,
          user_id: user.id,
          prompt: "pg-sensitive-first",
        },
      });
      await Context.mark(invocation);
      // Concurrent DB sessions serialize mark + postinsert protection on the
      // existing workspace row (no read-first lock upgrade or process mutex).
      const concurrent = await prisma.workspace_agent_invocations.create({
        data: {
          uuid: crypto.randomUUID(),
          workspace_id: ws.id,
          user_id: user.id,
          thread_id: 74,
          prompt: "pg-concurrent-sensitive",
        },
      });
      await Promise.all([
        Context.mark(concurrent),
        Context.protectCreated(concurrent),
      ]);
      expect(
        (
          await prisma.workspace_agent_invocations.findUnique({
            where: { uuid: concurrent.uuid },
          })
        ).prompt
      ).toMatch(/^personal-mcp-encrypted:/);
      const created = await model.new({
        workspace: ws,
        user,
        prompt: "pg-sensitive-followup",
      });
      expect(created.invocation.prompt).toMatch(/^personal-mcp-encrypted:/);
      expect(
        (
          await prisma.workspace_agent_invocations.findUnique({
            where: { uuid: invocation.uuid },
          })
        ).prompt
      ).not.toContain("pg-sensitive-first");
      await require(path.join(source, "utils/prisma")).$disconnect();
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      const wrong = new URL(connection);
      wrong.searchParams.set("schema", wrongSchema);
      // DEFAULT target is unmigrated: success proves effective override B used.
      const startupEnv = { ...env, DATABASE_URL: wrong.href };
      child = spawn(
        process.execPath,
        [
          "--require",
          path.resolve(__dirname, "../lark/helpers/preload.js"),
          path.join(source, "scripts/personal-mcp-pg-start.cjs"),
        ],
        { cwd: source, env: startupEnv, stdio: ["ignore", "pipe", "pipe"] }
      );
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      const token = require("jsonwebtoken").sign(
        { id: user.id },
        env.JWT_SECRET
      );
      let result;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          result = await fetch(
            `http://127.0.0.1:${port}/api/workspace/pg-startup/mcp-personal`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          break;
        } catch {
          if (child.exitCode !== null)
            throw new Error(
              "isolated application exited: " + output.slice(-1000)
            );
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(result?.status).toBe(200);
      expect(await result.json()).toEqual({ servers: [] });
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
      child = null;
      // Reverse targets: default A valid but override B unmigrated must never boot.
      const rejected = spawn(
        process.execPath,
        [
          "--require",
          path.resolve(__dirname, "../lark/helpers/preload.js"),
          path.join(source, "scripts/personal-mcp-pg-start.cjs"),
        ],
        {
          cwd: source,
          env: { ...env, ANYTHINGLLM_DATABASE_URL: wrong.href },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let diagnostic = "";
      rejected.stdout.on("data", (d) => (diagnostic += d));
      rejected.stderr.on("data", (d) => (diagnostic += d));
      expect(
        await new Promise((resolve) => rejected.once("exit", resolve))
      ).toBe(1);
      expect(diagnostic).toContain("PERSONAL_MCP_PG_START_PREFLIGHT_FAILED");
      expect(diagnostic).not.toContain("Server listening");
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    if (child) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await db.query("SET search_path TO public");
    await db.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await db.query(`DROP SCHEMA IF EXISTS ${wrongSchema} CASCADE`);
    await db.end();
    // Keep local generated artifact/evidence; never replace main SQLite client.
  }
});
