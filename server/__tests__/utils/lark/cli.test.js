require("./_polyfill");

const { EventEmitter } = require("events");

jest.mock("child_process", () => ({ spawn: jest.fn() }));
jest.mock("fs", () => ({
  promises: {
    mkdtemp: jest.fn(),
    rm: jest.fn(),
  },
}));
jest.mock("../../../utils/lark/settings", () => ({
  loadLarkConfig: jest.fn(),
}));
jest.mock("../../../utils/lark/oauth", () => ({
  getFreshAccessToken: jest.fn(),
}));
jest.mock("../../../models/larkIdentity", () => ({
  LarkIdentity: { get: jest.fn() },
}));
jest.mock("../../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));
jest.mock("../../../utils/EncryptionManager", () => ({
  EncryptionManager: jest.fn(),
}));

const { spawn } = require("child_process");
const fs = require("fs");
const { loadLarkConfig } = require("../../../utils/lark/settings");
const { getFreshAccessToken } = require("../../../utils/lark/oauth");
const { LarkIdentity } = require("../../../models/larkIdentity");
const { EventLogs } = require("../../../models/eventLogs");
const {
  LARK_CLI_BIN,
  MAX_OUTPUT_BYTES,
  PERMANENT_DENYLIST,
  TIMEOUT_MS,
  checkPolicy,
  classify,
  runAsUser,
  validateArgs,
} = require("../../../utils/lark/cli");

function childProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

function closeChild({ stdout = "{}", stderr = "", code = 0 } = {}) {
  const child = childProcess();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  });
  return child;
}

async function reachSpawn(expectedCalls = 1) {
  for (
    let index = 0;
    index < 50 && spawn.mock.calls.length < expectedCalls;
    index += 1
  )
    await Promise.resolve();
}

const config = {
  enabled: true,
  appId: "app-id",
  appSecret: "app-secret",
  tenantKey: "tenant-key",
  scopes: "contact:user.base:readonly",
  allowlist: ["contact", "docs", "im", "status"],
};
const encryption = { decrypt: jest.fn(), encrypt: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  fs.promises.mkdtemp.mockResolvedValue("/tmp/lark-run-1");
  fs.promises.rm.mockResolvedValue(undefined);
  loadLarkConfig.mockResolvedValue(config);
  LarkIdentity.get.mockResolvedValue({ id: 17, needs_reauth: false });
  getFreshAccessToken.mockResolvedValue("user-access-token");
  EventLogs.logEvent.mockResolvedValue({ eventLog: {}, message: null });
});

afterEach(() => {
  jest.useRealTimers();
});

test("allows configured canonical contact search docs fetch and message send", () => {
  expect(PERMANENT_DENYLIST).toEqual([
    "auth",
    "config",
    "profile",
    "logout",
    "api",
  ]);
  expect(
    checkPolicy(["contact", "+search-user"], config.allowlist).allowed
  ).toBe(true);
  expect(checkPolicy(["docs", "+fetch"], config.allowlist).allowed).toBe(true);
  expect(checkPolicy(["im", "+messages-send"], config.allowlist).allowed).toBe(
    true
  );
});

test("denies permanent subcommands even when allowlisted", () => {
  const allowlist = [...PERMANENT_DENYLIST, "contact"];
  for (const command of PERMANENT_DENYLIST) {
    expect(checkPolicy([command], allowlist).allowed).toBe(false);
    expect(checkPolicy([`+${command}`], allowlist).allowed).toBe(false);
    expect(checkPolicy(["contact", command], allowlist).allowed).toBe(false);
    expect(checkPolicy(["contact", `+${command}`], allowlist).allowed).toBe(
      false
    );
  }
  expect(checkPolicy(["API"], allowlist).allowed).toBe(false);
});

test("denies non-allowlisted and malformed argument arrays without spawn", async () => {
  const malformed = [
    [],
    "contact search",
    [""],
    ["-contact"],
    ["contact\0bad"],
    ["contact", "bad command"],
    ["contact", "search", "bad value"],
  ];

  for (const args of malformed) expect(validateArgs(args).ok).toBe(false);
  expect(validateArgs(["contact", "search", "--query", "Jane Doe"]).ok).toBe(
    true
  );

  const malformedResult = await runAsUser({
    userId: 4,
    args: ["contact", "bad command"],
    encryption,
  });
  expect(malformedResult.ok).toBe(false);

  const deniedResult = await runAsUser({
    userId: 4,
    args: ["calendar", "list"],
    encryption,
  });
  expect(deniedResult).toEqual(
    expect.objectContaining({ ok: false, error: expect.any(String) })
  );
  expect(spawn).not.toHaveBeenCalled();
});

test("classifies exact read forms and defaults unknown forms to write", () => {
  expect(classify(["+search-user"])).toBe("read");
  expect(classify(["docs", "+fetch"])).toBe("read");
  expect(classify(["status"])).toBe("read");
  expect(classify(["contact", "user-list"])).toBe("read");
  expect(classify(["docs", "document-get"])).toBe("read");
  expect(classify(["contact", "user-search"])).toBe("read");
  expect(classify(["im", "+messages-send"])).toBe("write");
  expect(classify(["im", "+messages-send", "--text", "document-get"])).toBe(
    "write"
  );
  expect(classify(["contact", "list"])).toBe("write");
});

test("spawns with isolated exact Lark environment and required suffix flags", async () => {
  const inherited = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    TZ: process.env.TZ,
    TMPDIR: process.env.TMPDIR,
  };
  spawn.mockImplementation(() => closeChild({ stdout: '{"items":[]}' }));

  await runAsUser({
    userId: 4,
    args: ["contact", "search", "--query", "Jane Doe"],
    encryption,
  });

  const [bin, args, options] = spawn.mock.calls[0];
  expect(bin).toBe(LARK_CLI_BIN);
  expect(args).toEqual([
    "contact",
    "search",
    "--query",
    "Jane Doe",
    "--as",
    "user",
    "--json",
  ]);
  expect(options).toEqual({
    env: {
      ...Object.fromEntries(
        Object.entries(inherited).filter(([, value]) => value !== undefined)
      ),
      LARKSUITE_CLI_BRAND: "lark",
      LARKSUITE_CLI_APP_ID: "app-id",
      LARKSUITE_CLI_USER_ACCESS_TOKEN: "user-access-token",
      LARKSUITE_CLI_CONFIG_DIR: "/tmp/lark-run-1",
      LARKSUITE_CLI_DATA_DIR: "/tmp/lark-run-1",
      HOME: "/tmp/lark-run-1",
      CI: "1",
    },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
});

test("refreshes token before spawn without exposing it in result", async () => {
  spawn.mockImplementation(() => closeChild({ stdout: '{"ok":"visible"}' }));

  const result = await runAsUser({
    userId: 4,
    args: ["contact", "search"],
    encryption,
  });

  expect(LarkIdentity.get).toHaveBeenCalledWith({ user_id: 4 });
  expect(getFreshAccessToken).toHaveBeenCalledWith({
    identityId: 17,
    config,
    encryption,
  });
  expect(getFreshAccessToken.mock.invocationCallOrder[0]).toBeLessThan(
    spawn.mock.invocationCallOrder[0]
  );
  expect(result).toEqual({ ok: true, data: { ok: "visible" } });
  expect(JSON.stringify(result)).not.toContain("user-access-token");
});

test("kills at timeout and combined output limit", async () => {
  jest.useFakeTimers();
  const timedOutChild = childProcess();
  spawn.mockReturnValueOnce(timedOutChild);
  const timedOutPromise = runAsUser({
    userId: 4,
    args: ["contact", "search"],
    encryption,
  });
  await reachSpawn();
  jest.advanceTimersByTime(TIMEOUT_MS);
  await expect(timedOutPromise).resolves.toEqual(
    expect.objectContaining({ ok: false, timedOut: true })
  );
  expect(timedOutChild.kill).toHaveBeenCalledWith("SIGKILL");

  jest.useRealTimers();
  const oversizedChild = childProcess();
  spawn.mockReturnValueOnce(oversizedChild);
  const oversizedPromise = runAsUser({
    userId: 4,
    args: ["contact", "search"],
    encryption,
  });
  await reachSpawn(2);
  oversizedChild.stdout.emit("data", Buffer.alloc(MAX_OUTPUT_BYTES - 1, "a"));
  oversizedChild.stderr.emit("data", Buffer.from("too much"));
  await expect(oversizedPromise).resolves.toEqual(
    expect.objectContaining({ ok: false, truncated: true })
  );
  expect(oversizedChild.kill).toHaveBeenCalledWith("SIGKILL");
});

test("surfaces bounded stderr on non-zero exit with secrets redacted", async () => {
  spawn.mockImplementation(() =>
    closeChild({
      stdout: "ignored stdout",
      stderr: "bad app-secret and user-access-token",
      code: 2,
    })
  );

  const result = await runAsUser({
    userId: 4,
    args: ["im", "+messages-send"],
    encryption,
  });

  expect(result).toEqual({
    ok: false,
    error: "bad [redacted] and [redacted]",
    exitCode: 2,
  });
  expect(Buffer.byteLength(result.error)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
});

test("cleans temporary directory on success failure and kill", async () => {
  spawn
    .mockImplementationOnce(() => closeChild())
    .mockImplementationOnce(() => closeChild({ stderr: "failed", code: 1 }));

  await runAsUser({ userId: 4, args: ["contact", "search"], encryption });
  await runAsUser({ userId: 4, args: ["im", "+messages-send"], encryption });

  const killedChild = childProcess();
  spawn.mockReturnValueOnce(killedChild);
  const killedPromise = runAsUser({
    userId: 4,
    args: ["contact", "search"],
    encryption,
  });
  await reachSpawn(3);
  killedChild.stdout.emit("data", Buffer.alloc(MAX_OUTPUT_BYTES + 1));
  await killedPromise;

  expect(fs.promises.rm).toHaveBeenCalledTimes(3);
  expect(fs.promises.rm).toHaveBeenNthCalledWith(1, "/tmp/lark-run-1", {
    recursive: true,
    force: true,
  });
});

test("audits policy rejection and process outcome with redacted args", async () => {
  await runAsUser({
    userId: 4,
    args: ["calendar", "list"],
    encryption,
  });
  expect(EventLogs.logEvent).toHaveBeenCalledWith(
    "lark_cli_invocation",
    expect.objectContaining({
      args: ["calendar", "list"],
      outcome: "rejected",
    }),
    4
  );

  spawn.mockImplementation(() => closeChild({ stdout: '{"sent":true}' }));
  await runAsUser({
    userId: 4,
    args: ["im", "+messages-send", "--text", "hello"],
    encryption,
  });
  expect(EventLogs.logEvent).toHaveBeenLastCalledWith(
    "lark_cli_invocation",
    {
      args: ["im", "+messages-send", "--text", "hello"],
      outcome: "success",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    },
    4
  );
});

test("rejects credentials in arguments before spawn with redacted audit", async () => {
  const result = await runAsUser({
    userId: 4,
    args: ["im", "+messages-send", "--text", "app-secret user-access-token"],
    encryption,
  });

  expect(result).toEqual({
    ok: false,
    error: "Arguments may not contain credentials",
  });
  expect(spawn).not.toHaveBeenCalled();
  expect(EventLogs.logEvent).toHaveBeenCalledWith(
    "lark_cli_invocation",
    expect.objectContaining({
      args: ["im", "+messages-send", "--text", "[redacted] [redacted]"],
      outcome: "rejected",
    }),
    4
  );
});

test("redacts token patterns from malformed argument audits", async () => {
  const token = "u-abcdefghijklmnop";
  await runAsUser({
    userId: 4,
    args: ["bad command", token],
    encryption,
  });

  expect(EventLogs.logEvent).toHaveBeenCalledWith(
    "lark_cli_invocation",
    expect.objectContaining({ args: ["bad command", "[redacted]"] }),
    4
  );
});

test("requires a connected identity without spawning", async () => {
  LarkIdentity.get.mockResolvedValueOnce(null).mockResolvedValueOnce({
    id: 17,
    needs_reauth: true,
  });

  await expect(
    runAsUser({ userId: 4, args: ["contact", "search"], encryption })
  ).resolves.toEqual({ ok: false, error: "Reconnect Lark in Settings" });
  await expect(
    runAsUser({ userId: 4, args: ["contact", "search"], encryption })
  ).resolves.toEqual({ ok: false, error: "Reconnect Lark in Settings" });
  expect(spawn).not.toHaveBeenCalled();
});

test("handles process error and close once", async () => {
  const child = childProcess();
  spawn.mockReturnValue(child);
  const resultPromise = runAsUser({
    userId: 4,
    args: ["contact", "search"],
    encryption,
  });
  await reachSpawn();
  child.emit("error", new Error("spawn failed with user-access-token"));
  child.emit("close", 1);

  await expect(resultPromise).resolves.toEqual({
    ok: false,
    error: "spawn failed with [redacted]",
  });
  expect(fs.promises.rm).toHaveBeenCalledTimes(1);
  expect(EventLogs.logEvent).toHaveBeenCalledTimes(1);
});

test("redacts credentials accidentally returned in JSON stdout", async () => {
  spawn.mockImplementation(() =>
    closeChild({
      stdout: '{"secret":"app-secret","nested":{"token":"user-access-token"}}',
    })
  );

  await expect(
    runAsUser({ userId: 4, args: ["contact", "search"], encryption })
  ).resolves.toEqual({
    ok: true,
    data: { secret: "[redacted]", nested: { token: "[redacted]" } },
  });
});

test("ignores cleanup failure and returns process result", async () => {
  fs.promises.rm.mockRejectedValue(new Error("cleanup failed"));
  spawn.mockImplementation(() => closeChild({ stdout: '{"ok":true}' }));

  await expect(
    runAsUser({ userId: 4, args: ["contact", "search"], encryption })
  ).resolves.toEqual({ ok: true, data: { ok: true } });
});
