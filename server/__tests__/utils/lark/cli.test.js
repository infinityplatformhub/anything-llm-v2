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
  READ_COMMANDS,
  SECRET_PATTERN,
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
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
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
    ["contact", "search", "bad\u0007value"],
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

test("classifies only allowlisted read pairs and defaults everything to write", () => {
  expect(classify(["contact", "+search-user"])).toBe("read");
  expect(classify(["docs", "+fetch"])).toBe("read");
  expect(classify(["im", "+chat-list"])).toBe("read");
  expect(classify(["wiki", "+node-list"])).toBe("read");
  expect(classify(["calendar", "+agenda"])).toBe("read");
  // Case and the optional + prefix are normalized before the lookup.
  expect(classify(["CONTACT", "search-user"])).toBe("read");

  expect(classify(["im", "+messages-send"])).toBe("write");
  expect(classify(["contact", "list"])).toBe("write");
  expect(classify(["docs", "+create"])).toBe("write");
  // The old suffix heuristic read these as safe; the allowlist does not.
  expect(classify(["im", "+messages-delete-list"])).toBe("write");
  expect(classify(["docs", "+blocks-batch-update-get"])).toBe("write");
  expect(classify(["wiki", "+spaces-node-move-get"])).toBe("write");
  // Read pairs stay read no matter what flags follow; unknown flags cannot
  // exist because validateArgs rejects them first.
  expect(classify(["docs", "+fetch", "--doc", "document-get"])).toBe("read");
  expect(classify(["im", "+messages-send", "--text", "document-get"])).toBe(
    "write"
  );
  // A single token is not a group/subcommand pair.
  expect(classify(["status"])).toBe("write");
  expect(classify(["+search-user"])).toBe("write");
});

test("READ_COMMANDS is a frozen pinned pair allowlist", () => {
  expect(Array.isArray(READ_COMMANDS)).toBe(true);
  expect(Object.isFrozen(READ_COMMANDS)).toBe(true);
  expect(READ_COMMANDS).toContain("contact +search-user");
  expect(READ_COMMANDS).toContain("docs +fetch");
  for (const pair of READ_COMMANDS)
    expect(pair).toMatch(/^[a-z][a-z0-9-]* \+[a-z][a-z0-9-]*$/);
  // Nothing mutating may sit in the allowlist.
  for (const pair of READ_COMMANDS)
    expect(pair).not.toMatch(
      /\+(create|update|delete|remove|send|reply|edit|move|copy|add|revert|insert|upload|download|transfer|rsvp|join|cancel|script)/
    );
});

test("validates every argument token, not only the first two", () => {
  const rejected = [
    // Security PoC: arbitrary file write through a filesystem flag.
    [
      ["docs", "+fetch", "--doc", "https://x", "--output", "/app/x/handler.js"],
      "Flag is not permitted",
    ],
    [
      ["docs", "+fetch", "--doc", "x", "--output-dir", "storage"],
      "Flag is not permitted",
    ],
    [
      ["docs", "+fetch", "--doc", "x", "-o", "out.json"],
      "Flag is not permitted",
    ],
    [
      ["docs", "+fetch", "--doc", "x", "--local-dir", "storage"],
      "Flag is not permitted",
    ],
    [
      ["docs", "+fetch", "--doc", "x", "--body-file", "b"],
      "Flag is not permitted",
    ],
    [
      ["docs", "+fetch", "--doc", "x", "--cover-path", "c"],
      "Flag is not permitted",
    ],
    // Runner-owned flags the model may never set.
    [["im", "+chat-list", "--as", "bot"], "Flag is not permitted"],
    [["im", "+chat-list", "--config", "/etc/x"], "Flag is not permitted"],
    [["im", "+chat-list", "--profile", "evil"], "Flag is not permitted"],
    [["im", "+chat-list", "--brand", "feishu"], "Flag is not permitted"],
    [["im", "+chat-list", "--app-id", "cli_x"], "Flag is not permitted"],
    [["im", "+chat-list", "--user-access-token", "x"], "Flag is not permitted"],
    [
      ["im", "+chat-list", "--tenant-access-token", "x"],
      "Flag is not permitted",
    ],
    // Security PoC: @file makes the CLI read a local file as the value.
    [
      ["contact", "+search-user", "--query", "@/app/server/.env"],
      "Malformed argument value",
    ],
    [["docs", "+fetch", "--doc", "/etc/passwd"], "Malformed argument value"],
    [["docs", "+fetch", "--doc", "C:\\Windows\\x"], "Malformed argument value"],
    [
      ["docs", "+fetch", "--doc", "../../etc/passwd"],
      "Malformed argument value",
    ],
    [["docs", "+fetch", "--doc", "a\nb"], "Malformed argument value"],
    [["docs", "+fetch", "--doc", "a".repeat(4097)], "Malformed argument value"],
    // Security PoC: a third positional token smuggles a second subcommand.
    [
      ["im", "+chat-list", "+messages-send", "--text", "hi"],
      "Malformed argument token",
    ],
    [
      ["im", "status", "+messages-send", "--text", "x"],
      "Malformed argument token",
    ],
    [["api", "get", "/x"], "Malformed argument token"],
    // A flag-shaped token that is not a well-formed flag.
    [["docs", "+fetch", "--Doc", "x"], "Malformed flag token"],
    [["docs", "+fetch", "--output=/app/x"], "Malformed flag token"],
    [["docs", "+fetch", "-abc", "x"], "Malformed flag token"],
    // Fewer than two command tokens is not a command.
    [["contact"], "Command requires a group and a subcommand"],
  ];

  for (const [args, reason] of rejected) {
    const result = validateArgs(args);
    expect({ args, ...result }).toEqual({ args, ok: false, reason });
  }

  const accepted = [
    ["contact", "+search-user", "--query", "somchai"],
    ["im", "+messages-send", "--user-id", "ou_x", "--text", "hello world"],
    ["docs", "+fetch", "--doc", "https://x.larksuite.com/docx/abc"],
    ["im", "+chat-list", "--page-size", "50"],
    ["contact", "search", "--query", "Jane Doe"],
  ];
  for (const args of accepted)
    expect({ args, ...validateArgs(args) }).toEqual({ args, ok: true });

  expect(classify(["contact", "+search-user", "--query", "somchai"])).toBe(
    "read"
  );
  expect(
    classify([
      "im",
      "+messages-send",
      "--user-id",
      "ou_x",
      "--text",
      "hello world",
    ])
  ).toBe("write");
});

test("rejected argument policy never reaches spawn", async () => {
  const result = await runAsUser({
    userId: 4,
    args: ["docs", "+fetch", "--doc", "x", "--output", "/app/evil.js"],
    encryption,
  });
  expect(result).toEqual({ ok: false, error: "Flag is not permitted" });
  expect(spawn).not.toHaveBeenCalled();
  expect(EventLogs.logEvent).toHaveBeenCalledWith(
    "lark_cli_invocation",
    { argCount: 6, outcome: "rejected", reason: "Flag is not permitted" },
    4
  );
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

test("rejects credentials before allowlist policy with redacted audit", async () => {
  const result = await runAsUser({
    userId: 4,
    args: ["calendar", "list", "--token", "user-access-token"],
    encryption,
  });

  expect(result).toEqual({
    ok: false,
    error: "Arguments may not contain credentials",
  });
  expect(spawn).not.toHaveBeenCalled();
  expect(JSON.stringify(EventLogs.logEvent.mock.calls)).not.toContain(
    "user-access-token"
  );
  expect(EventLogs.logEvent).toHaveBeenCalledWith(
    "lark_cli_invocation",
    expect.objectContaining({
      args: ["calendar", "list", "--token", "[redacted]"],
      outcome: "rejected",
    }),
    4
  );
});

test("omits arguments from malformed invocation audit", async () => {
  await runAsUser({
    userId: 4,
    args: ["bad command", "prefixu-abcdefghijklmnop", "u-abcdefghijklmnop-"],
    encryption,
  });

  const metadata = EventLogs.logEvent.mock.calls[0][1];
  expect(metadata).toEqual(
    expect.objectContaining({
      argCount: 3,
      outcome: "rejected",
      reason: "Malformed command token",
    })
  );
  expect(metadata).not.toHaveProperty("args");
});

test("omits arguments from config failure and missing config audits", async () => {
  loadLarkConfig
    .mockRejectedValueOnce(new Error("config failed"))
    .mockResolvedValueOnce(null);

  await runAsUser({
    userId: 4,
    args: ["contact", "search", "--query", "arbitrary-secret"],
    encryption,
  });
  await runAsUser({
    userId: 4,
    args: ["contact", "search", "--query", "arbitrary-secret"],
    encryption,
  });

  for (const [, metadata] of EventLogs.logEvent.mock.calls) {
    expect(metadata).not.toHaveProperty("args");
    expect(metadata.outcome).toBe("error");
  }
  expect(
    EventLogs.logEvent.mock.calls.map(([, metadata]) => metadata.reason)
  ).toEqual(["config_load_failed", "Lark is not configured"]);
  expect(JSON.stringify(EventLogs.logEvent.mock.calls)).not.toContain(
    "config failed"
  );
  expect(JSON.stringify(EventLogs.logEvent.mock.calls)).not.toContain(
    "arbitrary-secret"
  );
});

test("omits arguments from missing identity audit", async () => {
  LarkIdentity.get.mockResolvedValue(null);
  await runAsUser({
    userId: 4,
    args: ["contact", "search", "--query", "arbitrary-secret"],
    encryption,
  });

  const metadata = EventLogs.logEvent.mock.calls[0][1];
  expect(metadata).toEqual(
    expect.objectContaining({
      outcome: "error",
      reason: "identity_missing",
    })
  );
  expect(metadata).not.toHaveProperty("args");
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

test("audits needs-reauth identity with a fixed reason and no arguments", async () => {
  LarkIdentity.get.mockResolvedValue({ id: 17, needs_reauth: true });

  await expect(
    runAsUser({
      userId: 4,
      args: ["contact", "search", "--query", "arbitrary-secret"],
      encryption,
    })
  ).resolves.toEqual({ ok: false, error: "Reconnect Lark in Settings" });

  const metadata = EventLogs.logEvent.mock.calls[0][1];
  expect(metadata).toEqual(
    expect.objectContaining({
      outcome: "error",
      reason: "identity_needs_reauth",
    })
  );
  expect(metadata).not.toHaveProperty("args");
  expect(JSON.stringify(EventLogs.logEvent.mock.calls)).not.toContain(
    "arbitrary-secret"
  );
});

test("audits token refresh failure with a fixed reason and no arguments", async () => {
  getFreshAccessToken.mockRejectedValue(
    new Error("refresh rejected for u-abcdefghijklmnopqrst")
  );

  await expect(
    runAsUser({
      userId: 4,
      args: ["contact", "search", "--query", "arbitrary-secret"],
      encryption,
    })
  ).resolves.toEqual({ ok: false, error: "Reconnect Lark in Settings" });

  const metadata = EventLogs.logEvent.mock.calls[0][1];
  expect(metadata).toEqual(
    expect.objectContaining({
      outcome: "error",
      reason: "token_refresh_failed",
    })
  );
  expect(metadata).not.toHaveProperty("args");
  expect(spawn).not.toHaveBeenCalled();
  expect(JSON.stringify(EventLogs.logEvent.mock.calls)).not.toContain(
    "refresh rejected"
  );
});

test("audits policy rejection with recursively redacted arguments", async () => {
  const result = await runAsUser({
    userId: 4,
    args: ["calendar", "list", "--note", "u-abcdefghijklmnopqrst"],
    encryption,
  });

  expect(result).toEqual({
    ok: false,
    error: "Command is not allowlisted",
  });
  expect(spawn).not.toHaveBeenCalled();
  expect(EventLogs.logEvent).toHaveBeenCalledWith(
    "lark_cli_invocation",
    expect.objectContaining({
      args: ["calendar", "list", "--note", "[redacted]"],
      outcome: "rejected",
      reason: "Command is not allowlisted",
    }),
    4
  );
  const audited = JSON.stringify(EventLogs.logEvent.mock.calls);
  expect(audited).not.toContain("u-abcdefghijklmnopqrst");
  expect(audited).not.toContain("user-access-token");
});

test("audits successful run with recursively redacted arguments", async () => {
  spawn.mockImplementation(() => closeChild({ stdout: '{"sent":true}' }));

  await expect(
    runAsUser({
      userId: 4,
      args: ["im", "+messages-send", "--text", "u-abcdefghijklmnopqrst"],
      encryption,
    })
  ).resolves.toEqual({ ok: true, data: { sent: true } });

  expect(EventLogs.logEvent).toHaveBeenLastCalledWith(
    "lark_cli_invocation",
    {
      args: ["im", "+messages-send", "--text", "[redacted]"],
      outcome: "success",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    },
    4
  );
  expect(JSON.stringify(EventLogs.logEvent.mock.calls)).not.toContain(
    "u-abcdefghijklmnopqrst"
  );
});

test("ignores a foreign reason property on a rejected identity lookup", async () => {
  LarkIdentity.get.mockRejectedValue({ reason: "evil text" });

  await expect(
    runAsUser({ userId: 4, args: ["contact", "search"], encryption })
  ).resolves.toEqual({ ok: false, error: "Reconnect Lark in Settings" });

  const metadata = EventLogs.logEvent.mock.calls[0][1];
  expect(metadata.reason).toBe("identity_missing");
  expect(JSON.stringify(EventLogs.logEvent.mock.calls)).not.toContain(
    "evil text"
  );
});

test("redacts credentials from console diagnostics on pre-secret failures", async () => {
  loadLarkConfig.mockRejectedValueOnce(
    new Error("config read u-abcdefghijklmnopqrst failed")
  );
  await runAsUser({ userId: 4, args: ["contact", "search"], encryption });

  getFreshAccessToken.mockRejectedValueOnce(
    new Error("refresh denied for u-zyxwvutsrqponmlkjihg")
  );
  await runAsUser({ userId: 4, args: ["contact", "search"], encryption });

  const logged = JSON.stringify(
    console.error.mock.calls.map((call) =>
      call.map((entry) =>
        entry instanceof Error ? entry.stack || entry.message : entry
      )
    )
  );
  expect(logged).toContain("config_load_failed");
  expect(logged).toContain("token_refresh_failed");
  expect(logged).toContain("[redacted]");
  expect(logged).not.toContain("u-abcdefghijklmnopqrst");
  expect(logged).not.toContain("u-zyxwvutsrqponmlkjihg");
  for (const call of console.error.mock.calls)
    for (const entry of call) expect(entry).not.toBeInstanceOf(Error);
});
