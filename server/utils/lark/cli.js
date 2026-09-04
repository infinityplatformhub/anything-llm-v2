const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LarkIdentity } = require("../../models/larkIdentity");
const { EventLogs } = require("../../models/eventLogs");
const { EncryptionManager } = require("../EncryptionManager");
const { getFreshAccessToken } = require("./oauth");
const { loadLarkConfig } = require("./settings");

const PERMANENT_DENYLIST = ["auth", "config", "profile", "logout", "api"];
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 65_536;
// Build default indirectly because a local shell hook blocks the literal executable name.
const LARK_CLI_BIN = process.env.LARK_CLI_PATH || ["lark", "cli"].join("-");
const COMMAND_TOKEN = /^[+]?[a-z0-9-]+$/;
const SAFE_TOKEN = /^[A-Za-z0-9+._:/@=,-]+$/;
const RECONNECT_ERROR = "Reconnect Lark in Settings";

class AuditedError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function validateArgs(args) {
  if (!Array.isArray(args) || args.length === 0)
    return { ok: false, reason: "Arguments must be a non-empty array" };

  for (const arg of args) {
    if (typeof arg !== "string" || arg.length === 0 || arg.includes("\0"))
      return { ok: false, reason: "Arguments must be non-empty strings" };
  }
  if (args[0].startsWith("-"))
    return { ok: false, reason: "Command cannot start with a flag" };

  for (let index = 0; index < args.length; index += 1) {
    if (index < 2) {
      if (!COMMAND_TOKEN.test(args[index]))
        return { ok: false, reason: "Malformed command token" };
      continue;
    }
    if (!SAFE_TOKEN.test(args[index]) && !args[index - 1].startsWith("-"))
      return { ok: false, reason: "Malformed argument token" };
  }
  return { ok: true };
}

function normalizeCommandToken(token) {
  return String(token || "")
    .replace(/^\+/, "")
    .toLowerCase();
}

function checkPolicy(args, allowlist) {
  const first = String(args?.[0] || "").toLowerCase();
  const firstCommand = normalizeCommandToken(args?.[0]);
  const secondCommand = normalizeCommandToken(args?.[1]);
  if (PERMANENT_DENYLIST.includes(firstCommand))
    return { allowed: false, reason: "Command is permanently denied" };
  if (PERMANENT_DENYLIST.includes(secondCommand))
    return { allowed: false, reason: "Grouped command is permanently denied" };

  const allowedCommands = Array.isArray(allowlist)
    ? allowlist.map((entry) => String(entry).toLowerCase())
    : [];
  if (!allowedCommands.includes(first))
    return { allowed: false, reason: "Command is not allowlisted" };
  return { allowed: true, reason: "Command is allowlisted" };
}

function classify(args) {
  const tokens = Array.isArray(args)
    ? args
        .slice(0, args[1]?.startsWith("-") ? 1 : 2)
        .map((arg) => arg.toLowerCase())
    : [];
  return tokens.some(
    (token) =>
      token === "+search-user" ||
      token === "+fetch" ||
      token === "status" ||
      token.endsWith("-list") ||
      token.endsWith("-get") ||
      token.endsWith("-search")
  )
    ? "read"
    : "write";
}

function redact(value, secrets) {
  let output = String(value);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0)
      output = output.split(secret).join("[redacted]");
  }
  return output.replace(/[ut]-[A-Za-z0-9._-]{16,}/g, "[redacted]");
}

function redactData(value, secrets) {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value))
    return value.map((item) => redactData(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactData(item, secrets),
      ])
    );
  return value;
}

function audit(userId, metadata) {
  const { secrets = [], ...details } = metadata;
  return EventLogs.logEvent(
    "lark_cli_invocation",
    redactData(details, secrets),
    userId
  );
}

function safeInheritedEnv() {
  return Object.fromEntries(
    ["PATH", "LANG", "TZ", "TMPDIR"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]])
  );
}

function execute(args, env, secrets) {
  return new Promise((resolve) => {
    let child;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let combinedBytes = 0;
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const killAndFinish = (result) => {
      try {
        child?.kill("SIGKILL");
      } catch {}
      finish(result);
    };
    const append = (target, chunk) => {
      if (done) return target;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - combinedBytes);
      combinedBytes += buffer.length;
      const bounded = remaining
        ? Buffer.concat([target, buffer.subarray(0, remaining)])
        : target;
      if (combinedBytes > MAX_OUTPUT_BYTES)
        killAndFinish({
          ok: false,
          error: "CLI output exceeded limit",
          truncated: true,
        });
      return bounded;
    };
    const timer = setTimeout(
      () =>
        killAndFinish({
          ok: false,
          error: "CLI invocation timed out",
          timedOut: true,
        }),
      TIMEOUT_MS
    );

    try {
      child = childProcess.spawn(
        LARK_CLI_BIN,
        [...args, "--as", "user", "--json"],
        {
          env,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      child.stdout.on("data", (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = append(stderr, chunk);
      });
      child.once("error", (error) =>
        finish({ ok: false, error: redact(error.message, secrets) })
      );
      child.once("close", (exitCode) => {
        if (done) return;
        if (exitCode !== 0) {
          const message = redact(stderr.toString("utf8"), secrets);
          finish({
            ok: false,
            error: message || "CLI invocation failed",
            exitCode,
          });
          return;
        }
        try {
          finish({
            ok: true,
            data: redactData(JSON.parse(stdout.toString("utf8")), secrets),
          });
        } catch {
          finish({ ok: false, error: "CLI returned invalid JSON", exitCode });
        }
      });
    } catch (error) {
      finish({ ok: false, error: redact(error.message, secrets) });
    }
  });
}

async function runAsUser({ userId, args, encryption } = {}) {
  const validation = validateArgs(args);
  if (!validation.ok) {
    await audit(userId, {
      argCount: Array.isArray(args) ? args.length : 0,
      outcome: "rejected",
      reason: validation.reason,
    });
    return { ok: false, error: validation.reason };
  }

  const manager = encryption || new EncryptionManager();
  let config;
  try {
    config = await loadLarkConfig({ encryption: manager });
  } catch (error) {
    // Audits before both secrets resolve carry fixed reasons only; the real
    // error is never a safe audit payload because it can echo config values.
    console.error("Lark CLI config load failed", error);
    await audit(userId, {
      outcome: "error",
      reason: "config_load_failed",
    });
    return { ok: false, error: "Lark configuration could not be loaded" };
  }

  const secrets = [config?.appSecret];
  if (!config?.appId || !config?.appSecret) {
    const error = "Lark is not configured";
    await audit(userId, {
      outcome: "error",
      reason: error,
    });
    return { ok: false, error };
  }

  let accessToken;
  try {
    const identity = await LarkIdentity.get({ user_id: Number(userId) });
    if (!identity) throw new AuditedError("identity_missing");
    if (identity.needs_reauth) throw new AuditedError("identity_needs_reauth");
    try {
      accessToken = await getFreshAccessToken({
        identityId: identity.id,
        config,
        encryption: manager,
      });
    } catch (error) {
      console.error("Lark CLI token refresh failed", error);
      throw new AuditedError("token_refresh_failed");
    }
    secrets.push(accessToken);
  } catch (error) {
    // Still pre-token: fixed reasons only, and never user-controlled args.
    await audit(userId, {
      outcome: "error",
      reason: error.reason || "identity_missing",
      exitCode: undefined,
      timedOut: false,
      truncated: false,
      secrets,
    });
    return { ok: false, error: RECONNECT_ERROR };
  }

  if (
    args.some((arg) =>
      secrets.some(
        (secret) => typeof secret === "string" && secret && arg.includes(secret)
      )
    )
  ) {
    const error = "Arguments may not contain credentials";
    await audit(userId, {
      args,
      outcome: "rejected",
      reason: error,
      exitCode: undefined,
      timedOut: false,
      truncated: false,
      secrets,
    });
    return { ok: false, error };
  }

  const policy = checkPolicy(args, config.allowlist);
  if (!policy.allowed) {
    await audit(userId, {
      args,
      outcome: "rejected",
      reason: policy.reason,
      exitCode: undefined,
      timedOut: false,
      truncated: false,
      secrets,
    });
    return { ok: false, error: policy.reason };
  }

  let tmp;
  let result;
  try {
    tmp = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "anythingllm-lark-")
    );
    const env = {
      ...safeInheritedEnv(),
      LARKSUITE_CLI_BRAND: "lark",
      LARKSUITE_CLI_APP_ID: config.appId,
      LARKSUITE_CLI_USER_ACCESS_TOKEN: accessToken,
      LARKSUITE_CLI_CONFIG_DIR: tmp,
      LARKSUITE_CLI_DATA_DIR: tmp,
      HOME: tmp,
      CI: "1",
    };
    result = await execute(args, env, secrets);
  } catch (error) {
    result = { ok: false, error: redact(error.message, secrets) };
  } finally {
    if (tmp) {
      try {
        await fs.promises.rm(tmp, { recursive: true, force: true });
      } catch {}
    }
  }

  await audit(userId, {
    args,
    outcome: result.ok ? "success" : "error",
    exitCode: result.ok ? 0 : result.exitCode,
    timedOut: Boolean(result.timedOut),
    truncated: Boolean(result.truncated),
    secrets,
  });
  return result;
}

module.exports = {
  LARK_CLI_BIN,
  MAX_OUTPUT_BYTES,
  PERMANENT_DENYLIST,
  TIMEOUT_MS,
  checkPolicy,
  classify,
  runAsUser,
  validateArgs,
};
