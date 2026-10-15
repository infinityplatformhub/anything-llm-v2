const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

async function verifyRuntimeSmoke({ id: pgId, client, tlsFixture }) {
  if (!process.env.MIGRATION_RUNTIME_IMAGE)
    throw new Error(
      "Explicit fixture runtime image is required for runtime-smoke tests."
    );
  const image = process.env.MIGRATION_RUNTIME_IMAGE;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anythingllm-app-smoke-"));
  const network = "anythingllm-smoke-" + process.pid + "-" + Date.now();
  let appId;
  let networkCreated = false;
  try {
    execFileSync(
      "docker",
      [
        "network",
        "create",
        "--internal",
        "--subnet",
        "10.253.247.0/24",
        "--label",
        "anythingllm.fixture=runtime-smoke",
        network,
      ],
      { encoding: "utf8" }
    );
    networkCreated = true;
    execFileSync("docker", ["network", "connect", network, pgId], {
      stdio: "ignore",
    });
    const networks = JSON.parse(
      execFileSync(
        "docker",
        ["inspect", "--format", "{{json .NetworkSettings.Networks}}", pgId],
        { encoding: "utf8" }
      )
    );
    const pgAddress = networks[network].IPAddress;
    // The fixture certificate names 127.0.0.1; mint a second leaf for the exact
    // internal-network PG address rather than disabling hostname verification.
    const caRoot = path.dirname(tlsFixture.caFile);
    fs.writeFileSync(
      path.join(caRoot, "smoke.cnf"),
      `[req]\ndistinguished_name=dn\nreq_extensions=ext\nprompt=no\n[dn]\nCN=${pgAddress}\n[ext]\nsubjectAltName=IP:${pgAddress}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "smoke.key",
        "-out",
        "smoke.csr",
        "-config",
        "smoke.cnf",
      ],
      { cwd: caRoot, stdio: "ignore" }
    );
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        "smoke.csr",
        "-CA",
        "ca.crt",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        "smoke.crt",
        "-days",
        "1",
        "-extfile",
        "smoke.cnf",
        "-extensions",
        "ext",
      ],
      { cwd: caRoot, stdio: "ignore" }
    );
    for (const [source, target] of [
      ["smoke.key", "server.key"],
      ["smoke.crt", "server.crt"],
    ])
      execFileSync(
        "docker",
        [
          "exec",
          "--interactive",
          "--user",
          "root",
          pgId,
          "sh",
          "-c",
          `cat > /var/lib/postgresql/data/${target}`,
        ],
        {
          input: fs.readFileSync(path.join(caRoot, source)),
          stdio: ["pipe", "ignore", "pipe"],
        }
      );
    execFileSync(
      "docker",
      [
        "exec",
        "--user",
        "root",
        pgId,
        "sh",
        "-c",
        "chown postgres:postgres /var/lib/postgresql/data/server.* && chmod 600 /var/lib/postgresql/data/server.key",
      ],
      { stdio: "ignore" }
    );
    await client.query("SELECT pg_reload_conf()");
    const password = require("../../../server/node_modules/bcryptjs").hashSync(
      "synthetic-smoke-password",
      4
    );
    const user = (
      await client.query(
        "INSERT INTO users(username,password,role,seen_recovery_codes) VALUES($1,$2,$3,true) RETURNING id",
        ["fixture-smoke", password, "admin"]
      )
    ).rows[0];
    await client.query(
      "INSERT INTO system_settings(label,value) VALUES('multi_user_mode','true'),('onboarding_complete','true') ON CONFLICT(label) DO UPDATE SET value=excluded.value"
    );
    const workspace = (
      await client.query(
        "INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id",
        ["Smoke fixture", "smoke-fixture"]
      )
    ).rows[0];
    await client.query(
      "INSERT INTO workspace_users(user_id,workspace_id) VALUES($1,$2)",
      [user.id, workspace.id]
    );
    await client.query(
      'INSERT INTO workspace_chats("workspaceId",prompt,response,user_id) VALUES($1,$2,$3,$4)',
      [
        workspace.id,
        "fixture prompt",
        JSON.stringify({ text: "fixture response", sources: [] }),
        user.id,
      ]
    );
    const invocation = (
      await client.query(
        "INSERT INTO workspace_agent_invocations(uuid,prompt,user_id,workspace_id,closed) VALUES($1,$2,$3,$4,true) RETURNING id",
        ["fixture-smoke-invocation", "fixture agent", user.id, workspace.id]
      )
    ).rows[0];
    const envFile = path.join(root, "synthetic.env");
    fs.writeFileSync(
      envFile,
      [
        "NODE_ENV=production",
        "SERVER_PORT=3001",
        "STORAGE_DIR=/app/server/storage",
        "DISABLE_TELEMETRY=true",
        "ANYTHINGLLM_DATABASE_PROVIDER=postgresql",
        `ANYTHINGLLM_DATABASE_URL=postgresql://anythingllm_app:synthetic-runtime@${pgAddress}:5432/fixture?sslmode=require&sslaccept=strict&sslcert=/fixture-ca/ca.crt&connection_limit=5`,
        "SIG_KEY=synthetic-smoke-key",
        "SIG_SALT=synthetic-smoke-salt",
        "JWT_SECRET=synthetic-smoke-jwt",
      ].join("\n"),
      { mode: 0o600 }
    );
    appId = execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--pull=never",
        "--platform",
        "linux/amd64",
        "--network",
        network,
        "--label",
        "anythingllm.fixture=runtime-smoke",
        "--env-file",
        envFile,
        "--tmpfs",
        "/app/server/storage:uid=1000,gid=1000",
        "--mount",
        `type=bind,source=${tlsFixture.caFile},target=/fixture-ca/ca.crt,readonly`,
        image,
      ],
      { encoding: "utf8" }
    ).trim();
    // Docker internal networks do not reliably publish ports on Desktop. Make
    // real HTTP requests inside the isolated app container, not via host routing.
    function request(route, options = {}) {
      const script = `fetch('http://127.0.0.1:3001'+${JSON.stringify(route)},${JSON.stringify(options)}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()}))).catch(()=>process.exit(1))`;
      return JSON.parse(
        execFileSync("docker", ["exec", appId, "node", "-e", script], {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        })
      );
    }
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = request("/api/ping");
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {}
      const state = JSON.parse(
        execFileSync(
          "docker",
          ["inspect", "--format", "{{json .State}}", appId],
          { encoding: "utf8" }
        )
      );
      if (!state.Running) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(ready, true, "PG application must become ready");
    const login = request("/api/request-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "fixture-smoke",
        password: "synthetic-smoke-password",
      }),
    });
    assert.equal(login.status, 200);
    const result = login.body;
    assert.equal(result.valid, true);
    assert.ok(result.token);
    const history = request("/api/workspace/smoke-fixture/chats", {
      headers: { Authorization: "Bearer " + result.token },
    });
    assert.equal(history.status, 200);
    assert.match(JSON.stringify(history.body), /fixture response/);
    // Test baseline agent persistence against PG without triggering an LLM/MCP.
    const checked = execFileSync(
      "docker",
      [
        "exec",
        "--workdir",
        "/app/server",
        appId,
        "node",
        "-e",
        `require('dotenv').config({path:'/app/server/.env'});const {WorkspaceAgentInvocation}=require('/app/server/models/workspaceAgentInvocation');WorkspaceAgentInvocation.get({id:${invocation.id}}).then(async x=>{if(!x||!x.closed)process.exitCode=1;await require('/app/server/utils/prisma').$disconnect();})`,
      ],
      { encoding: "utf8" }
    );
    assert.ok(!checked.includes("FAILED"));
  } catch (error) {
    if (appId)
      console.error(
        "Synthetic app smoke logs:",
        execFileSync("docker", ["logs", "--tail", "60", appId], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })
      );
    throw error;
  } finally {
    if (appId)
      execFileSync("docker", ["rm", "--force", appId], { stdio: "ignore" });
    if (networkCreated) {
      execFileSync("docker", ["network", "disconnect", network, pgId], {
        stdio: "ignore",
      });
      execFileSync("docker", ["network", "rm", network], { stdio: "ignore" });
    }
    fs.rmSync(root, { recursive: true });
  }
}

module.exports = { verifyRuntimeSmoke };
