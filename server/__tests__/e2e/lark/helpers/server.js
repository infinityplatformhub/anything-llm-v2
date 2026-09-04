/**
 * Boots the real AnythingLLM server as a child process against the temp
 * environment and exposes a small fetch-based API client.
 */
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { SERVER_DIR, PRELOAD } = require("./env");

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TestServer {
  constructor({ child, port, logs }) {
    this.child = child;
    this.port = port;
    this.logs = logs;
  }

  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * @param {string} routePath e.g. "/api/ping"
   * @param {{token?: string, method?: string, body?: any, redirect?: "manual"|"follow"}} options
   */
  async api(routePath, { token, method = "GET", body, redirect = "manual" } = {}) {
    const response = await fetch(`${this.origin}${routePath}`, {
      method,
      redirect,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      status: response.status,
      headers: response.headers,
      location: response.headers.get("location"),
      text,
      json,
    };
  }

  /** Creates the first admin and flips the instance into multi-user mode. */
  async enableMultiUser({ username, password }) {
    const result = await this.api("/api/system/enable-multi-user", {
      method: "POST",
      body: { username, password },
    });
    if (!result.json?.success)
      throw new Error(
        `enable-multi-user failed: ${result.status} ${result.text}`
      );
    return this.login({ username, password });
  }

  async login({ username, password }) {
    const result = await this.api("/api/request-token", {
      method: "POST",
      body: { username, password },
    });
    if (!result.json?.valid || !result.json?.token)
      throw new Error(`login failed for ${username}: ${result.text}`);
    return { token: result.json.token, user: result.json.user };
  }

  async createUser({ token, username, password, role = "default" }) {
    const result = await this.api("/api/admin/users/new", {
      method: "POST",
      token,
      body: { username, password, role },
    });
    if (!result.json?.user)
      throw new Error(`create user ${username} failed: ${result.text}`);
    return result.json.user;
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    await new Promise((resolve) => {
      this.child.once("exit", resolve);
      this.child.kill("SIGKILL");
    });
  }
}

/**
 * Boots the server, retrying once on a lost port. freePort releases its probe
 * listener before the child binds, so another process on a busy machine can
 * claim the number in between; that is rare, recoverable, and not worth failing
 * a run over.
 *
 * @param {ReturnType<import("./env").createTempEnvironment>} environment
 * @param {Record<string,string>} extraEnv
 * @param {{firstPort?: number}} options test hook for the retry self-check
 */
async function startServer(environment, extraEnv = {}, options = {}) {
  const attempts = [options.firstPort ?? (await freePort()), null];
  let lastError;
  for (const candidate of attempts) {
    const port = candidate ?? (await freePort());
    try {
      return await startOnPort(environment, extraEnv, port);
    } catch (error) {
      lastError = error;
      if (!isPortTaken(error)) throw error;
    }
  }
  throw lastError;
}

function isPortTaken(error) {
  return /EADDRINUSE|address already in use/i.test(error?.message || "");
}

/** Resolves if nothing is listening, rejects EADDRINUSE-style if something is. */
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.connect({ port, host: "127.0.0.1" });
    const done = (error) => {
      probe.destroy();
      error ? reject(error) : resolve();
    };
    probe.once("connect", () =>
      done(new Error(`EADDRINUSE: port ${port} was claimed before startup`))
    );
    probe.once("error", () => done()); // refused means free
    probe.setTimeout(1000, () => done());
  });
}

/**
 * @param {ReturnType<import("./env").createTempEnvironment>} environment
 * @param {Record<string,string>} extraEnv
 * @param {number} port
 */
async function startOnPort(environment, extraEnv, port) {
  // bootHTTP passes listen errors to a handler that only re-registers signal
  // traps, so a stolen port makes the child hang silently rather than exit.
  // Checking first turns that 90 s mystery into an immediate, retryable error.
  await assertPortFree(port);
  const logs = [];
  const child = spawn(
    process.execPath,
    ["--require", PRELOAD, path.join(SERVER_DIR, "index.js")],
    {
      cwd: SERVER_DIR,
      env: {
        PATH: process.env.PATH,
        HOME: environment.root,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        ...environment.env,
        ...extraEnv,
        SERVER_PORT: String(port),
        SERVER_URL: `http://127.0.0.1:${port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));

  const server = new TestServer({ child, port, logs });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`server exited early:\n${logs.join("")}`);
    try {
      const ping = await server.api("/api/ping");
      if (ping.json?.online === true) return server;
    } catch {}
    await delay(250);
  }
  await server.stop();
  throw new Error(`server did not become ready:\n${logs.join("")}`);
}

module.exports = { startServer, TestServer };

// Jest treats every JavaScript file under __tests__ as a suite; this keeps the
// helper honest when it is collected directly.
if (typeof expect !== "undefined" && expect.getState().testPath === __filename)
  test("is a helper module, not a suite", () => {
    expect(module.exports).toBeDefined();
  });
