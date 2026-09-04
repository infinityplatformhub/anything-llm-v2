require("./_polyfill");

jest.mock("../../../utils/lark/cli", () => ({
  checkPolicy: jest.fn(),
  classify: jest.fn(),
  runAsUser: jest.fn(),
  validateArgs: jest.fn(),
}));
jest.mock("../../../utils/lark/settings", () => ({
  isLarkLoginEnabled: jest.fn(),
  loadLarkConfig: jest.fn(),
}));
jest.mock("../../../models/larkIdentity", () => ({
  LarkIdentity: { get: jest.fn() },
}));
jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: {
    getValueOrFallback: jest.fn(),
    isMultiUserMode: jest.fn(),
  },
}));

const cli = require("../../../utils/lark/cli");
const settings = require("../../../utils/lark/settings");
const { LarkIdentity } = require("../../../models/larkIdentity");
const { SystemSettings } = require("../../../models/systemSettings");
const { larkCli } = require("../../../utils/agents/aibitat/plugins/lark-cli");

const config = {
  enabled: true,
  appId: "app-id",
  appSecret: "app-secret",
  tenantKey: "tenant-key",
  allowlist: ["contact", "docs", "im"],
};

function fakeAibitat(userId = 7) {
  return {
    handlerProps: {
      invocation: userId === undefined ? {} : { user_id: userId },
      log: jest.fn(),
    },
    function: jest.fn(),
    requestToolApproval: jest.fn(),
    introspect: jest.fn(),
  };
}

function registeredHandler(aibitat) {
  larkCli.plugin().setup(aibitat);
  return aibitat.function.mock.calls[0]?.[0]?.handler;
}

beforeEach(() => {
  jest.clearAllMocks();
  SystemSettings.isMultiUserMode.mockResolvedValue(true);
  SystemSettings.getValueOrFallback.mockImplementation(
    async ({ label }, fallback) =>
      label === "default_agent_skills" ? '["lark-cli"]' : fallback
  );
  settings.isLarkLoginEnabled.mockResolvedValue(true);
  settings.loadLarkConfig.mockResolvedValue(config);
  LarkIdentity.get.mockResolvedValue({ id: 12, needs_reauth: false });
  cli.validateArgs.mockReturnValue({ ok: true });
  cli.checkPolicy.mockReturnValue({ allowed: true, reason: "allowed" });
  cli.classify.mockReturnValue("read");
  cli.runAsUser.mockResolvedValue({ ok: true, data: { items: [] } });
});

test("reads user_id from handlerProps invocation", async () => {
  const aibitat = fakeAibitat(41);
  const handler = registeredHandler(aibitat);

  await handler({ args: ["contact", "+search-user", "--query", "Pat"] });

  expect(LarkIdentity.get).toHaveBeenCalledWith({ user_id: 41 });
  expect(cli.runAsUser).toHaveBeenCalledWith({
    userId: 41,
    args: ["contact", "+search-user", "--query", "Pat"],
  });
});

test("is hidden without user_id and unavailable config or identity fails closed", async () => {
  const withoutUser = fakeAibitat(null);
  registeredHandler(withoutUser);
  expect(withoutUser.function).not.toHaveBeenCalled();

  const disabled = fakeAibitat();
  settings.isLarkLoginEnabled.mockResolvedValueOnce(false);
  expect(await registeredHandler(disabled)({ args: ["docs", "+fetch"] })).toBe(
    "Lark is not connected for this user. Connect Lark in Settings."
  );

  const missingIdentity = fakeAibitat();
  LarkIdentity.get.mockResolvedValueOnce(null);
  expect(
    await registeredHandler(missingIdentity)({ args: ["docs", "+fetch"] })
  ).toBe("Lark is not connected for this user. Connect Lark in Settings.");
  expect(cli.runAsUser).not.toHaveBeenCalled();
});

test("is unavailable outside multi-user mode", async () => {
  SystemSettings.isMultiUserMode.mockResolvedValue(false);
  const handler = registeredHandler(fakeAibitat());

  expect(await handler({ args: ["docs", "+fetch"] })).toBe(
    "Lark is not connected for this user. Connect Lark in Settings."
  );
  expect(settings.loadLarkConfig).not.toHaveBeenCalled();
});

test("is hidden when identity needs reauth", async () => {
  LarkIdentity.get.mockResolvedValue({ id: 12, needs_reauth: true });
  const handler = registeredHandler(fakeAibitat());

  expect(await handler({ args: ["docs", "+fetch"] })).toBe(
    "Lark is not connected for this user. Connect Lark in Settings."
  );
  expect(cli.runAsUser).not.toHaveBeenCalled();
});

test("runs classified read without approval", async () => {
  const aibitat = fakeAibitat();
  const handler = registeredHandler(aibitat);

  await expect(
    handler({ args: ["docs", "+fetch", "--doc", "doc-token"] })
  ).resolves.toBe('{"items":[]}');
  expect(cli.classify).toHaveBeenCalledWith([
    "docs",
    "+fetch",
    "--doc",
    "doc-token",
  ]);
  expect(aibitat.requestToolApproval).not.toHaveBeenCalled();
});

test("requests approval before classified write with redacted description", async () => {
  cli.classify.mockReturnValue("write");
  const aibitat = fakeAibitat();
  aibitat.requestToolApproval.mockResolvedValue({
    approved: true,
    message: "ok",
  });
  const handler = registeredHandler(aibitat);
  const args = [
    "im",
    "+messages-send",
    "--user-id",
    "ou_secret",
    "--text",
    "private message",
  ];

  await handler({ args });

  expect(aibitat.requestToolApproval).toHaveBeenCalledWith({
    skillName: "lark-cli",
    payload: { command: args.join(" ") },
    description:
      "Run Lark command as you: im +messages-send --user-id [redacted] --text [redacted] (write)",
  });
  expect(aibitat.requestToolApproval.mock.invocationCallOrder[0]).toBeLessThan(
    cli.runAsUser.mock.invocationCallOrder[0]
  );

  await handler({
    args: ["im", "+messages-send", "--text=private", "stray-value"],
  });
  expect(aibitat.requestToolApproval).toHaveBeenLastCalledWith(
    expect.objectContaining({
      description:
        "Run Lark command as you: im +messages-send --text=[redacted] [redacted] (write)",
    })
  );
});

test("does not run write after denied or missing approval", async () => {
  cli.classify.mockReturnValue("write");
  const denied = fakeAibitat();
  denied.requestToolApproval.mockResolvedValue({
    approved: false,
    message: "no",
  });

  await expect(
    registeredHandler(denied)({ args: ["im", "+messages-send"] })
  ).resolves.toBe("Lark command was not approved.");

  const missingApproval = fakeAibitat();
  delete missingApproval.requestToolApproval;
  await expect(
    registeredHandler(missingApproval)({ args: ["im", "+messages-send"] })
  ).resolves.toBe("Lark command was not approved.");
  expect(cli.runAsUser).not.toHaveBeenCalled();
});

test("rejects invalid or disallowed args before runner", async () => {
  const handler = registeredHandler(fakeAibitat());
  cli.validateArgs.mockReturnValueOnce({ ok: false, reason: "invalid args" });
  await expect(handler({ args: [] })).resolves.toBe("invalid args");

  cli.checkPolicy.mockReturnValueOnce({
    allowed: false,
    reason: "Command is not allowlisted",
  });
  await expect(handler({ args: ["drive", "+list"] })).resolves.toBe(
    "Command is not allowlisted"
  );
  expect(cli.runAsUser).not.toHaveBeenCalled();
});

test("passes only user ID and args to opaque runner and sanitizes failures", async () => {
  cli.runAsUser.mockResolvedValue({
    ok: false,
    error: "CLI invocation failed",
    exitCode: 1,
  });
  const args = ["contact", "+search-user", "--query", "Pat"];
  const handler = registeredHandler(fakeAibitat(29));

  await expect(handler({ args })).resolves.toBe("CLI invocation failed");
  expect(cli.runAsUser).toHaveBeenCalledWith({ userId: 29, args });
  expect(Object.keys(cli.runAsUser.mock.calls[0][0]).sort()).toEqual([
    "args",
    "userId",
  ]);
});

test("registers plugin once in exports and defaults discovery", async () => {
  const plugins = require("../../../utils/agents/aibitat/plugins");
  const {
    agentSkillsFromSystemSettings,
  } = require("../../../utils/agents/defaults");

  expect(plugins["lark-cli"]).toBe(larkCli);
  expect(plugins["lark-cli"].name).toBe("lark-cli");
  const discovered = await agentSkillsFromSystemSettings();
  expect(discovered.filter((name) => name === "lark-cli")).toEqual([
    "lark-cli",
  ]);
});
