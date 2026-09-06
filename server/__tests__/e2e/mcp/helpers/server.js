const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn, fork, execFileSync } = require("child_process");
const { SERVER_DIR, PRELOAD } = require("../../lark/helpers/env");
const { TestServer } = require("../../lark/helpers/server");

async function startMcpServer(environment, config) {
  // Development permits loopback OAuth but hardcodes storage relative to source.
  // Copy source, never developer storage or .env; all product modules stay real.
  const source = path.join(environment.root, "server");
  fs.mkdirSync(source);
  for (const name of [
    "index.js",
    "package.json",
    "utils",
    "models",
    "endpoints",
    "middleware",
    "jobs",
    "swagger",
  ])
    fs.cpSync(path.join(SERVER_DIR, name), path.join(source, name), {
      recursive: true,
    });
  const modules = path.join(source, "node_modules");
  fs.mkdirSync(modules);
  // Share dependencies except Prisma, whose generated client depends on branch schema.
  for (const name of fs.readdirSync(path.join(SERVER_DIR, "node_modules"))) {
    if ([".prisma", "@prisma"].includes(name)) continue;
    fs.symlinkSync(
      path.join(SERVER_DIR, "node_modules", name),
      path.join(modules, name)
    );
  }
  fs.mkdirSync(path.join(modules, "@prisma"));
  for (const name of fs.readdirSync(
    path.join(SERVER_DIR, "node_modules/@prisma")
  )) {
    const from = path.join(SERVER_DIR, "node_modules/@prisma", name);
    const to = path.join(modules, "@prisma", name);
    if (name === "client")
      fs.cpSync(from, to, { recursive: true, dereference: true });
    else fs.symlinkSync(from, to);
  }
  const schemaPath = path.join(source, "schema.prisma");
  fs.writeFileSync(
    schemaPath,
    fs
      .readFileSync(environment.schemaPath, "utf8")
      .replace(
        'provider = "prisma-client-js"',
        `provider = "prisma-client-js"\n  output = ${JSON.stringify(path.join(modules, ".prisma/client"))}`
      )
  );
  const schema = fs.readFileSync(schemaPath, "utf8");
  if (!schema.includes("output = "))
    throw new Error("Missing isolated Prisma generator output");
  execFileSync(
    path.join(SERVER_DIR, "node_modules/.bin/prisma"),
    ["generate", "--schema", schemaPath],
    { cwd: source, stdio: "pipe" }
  );
  const preload = path.join(source, "e2e-preload.js");
  fs.copyFileSync(PRELOAD, preload);
  fs.symlinkSync(environment.storageDir, path.join(source, "storage"), "dir");
  fs.mkdirSync(path.join(environment.storageDir, "plugins"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(environment.storageDir, "plugins/anythingllm_mcp_servers.json"),
    JSON.stringify(config)
  );
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const env = {
    PATH: process.env.PATH,
    HOME: environment.root,
    ...environment.env,
    NODE_ENV: "development",
    SERVER_PORT: String(port),
    SERVER_URL: `http://127.0.0.1:${port}`,
    E2E_SERVER_SOURCE: source,
    E2E_PRELOAD: preload,
  };
  const child = spawn(
    process.execPath,
    ["--require", preload, path.join(source, "index.js")],
    {
      cwd: source,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  const server = new TestServer({ child, port, logs });
  try {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error(`server exited early:\n${logs.join("")}`);
      try {
        if ((await server.api("/api/ping")).json?.online)
          return { server, source, env };
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`server startup timed out:\n${logs.join("")}`);
  } catch (error) {
    await server.stop();
    throw error;
  }
}

// Exercises agent-facing product methods without an LLM or an invented HTTP route.
// Separate worker explicitly does NOT establish that the HTTP child booted a client.
function startRuntime(env, logs) {
  const child = fork(path.join(__dirname, "runtime.js"), [], {
    env,
    execArgv: ["--require", env.E2E_PRELOAD],
    silent: true,
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  let id = 0;
  const pending = new Map();
  child.on("message", (message) => {
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    message.error
      ? task.reject(new Error(message.error))
      : task.resolve(message.result);
  });
  child.on("exit", () => {
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error("MCP runtime worker exited"));
    }
    pending.clear();
  });
  return {
    call(method, workspace) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("MCP runtime request timed out"));
        }, 45000);
        pending.set(requestId, { resolve, reject, timer });
        child.send({ id: requestId, method, workspace });
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGKILL");
      });
    },
  };
}

module.exports = { startMcpServer, startRuntime };
