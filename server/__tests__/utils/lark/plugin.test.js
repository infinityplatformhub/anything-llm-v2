require("./_polyfill");

jest.mock("../../../utils/lark/cli", () => ({
  SECRET_PATTERN: /[ut]-[A-Za-z0-9._-]{16,}/g,
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
jest.mock("../../../models/workspaceAgentSettings", () => ({
  WorkspaceAgentSettings: { enabledSkills: jest.fn() },
}));

const cli = require("../../../utils/lark/cli");
const settings = require("../../../utils/lark/settings");
const { LarkIdentity } = require("../../../models/larkIdentity");
const { SystemSettings } = require("../../../models/systemSettings");
const {
  larkCli,
  redactForDisplay,
  normalizeArgs,
} = require("../../../utils/agents/aibitat/plugins/lark-cli");
const { SECRET_PATTERN: REAL_SECRET_PATTERN } = jest.requireActual(
  "../../../utils/lark/cli"
);

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

test.each([
  'drive +search --query "x y"',
  ["drive +search --query 'x y'"],
])("normalizes collapsed args %j", (input) => {
  expect(normalizeArgs(input)).toEqual(["drive", "+search", "--query", "x y"]);
});
test("leaves multi-token arrays untouched and rejects unclosed quotes", () => {
  const args = ["drive", "+search", "--query", "x y"];
  expect(normalizeArgs(args)).toBe(args);
  expect(normalizeArgs('drive +search --query "unfinished')).toEqual([]);
});
test.each([null, 42, ["drive", 42], [""], ["drive", ""], 'drive +search --query ""'])("normalization rejects invalid input %j", (input) => {
  expect(normalizeArgs(input)).toEqual([]);
});
test("normalization preserves valid command array reference", () => {
  const args = ["drive", "+search"];
  expect(normalizeArgs(args)).toBe(args);
});

test("normalization preserves policy checks on quoted command tokens", () => {
  const real = jest.requireActual("../../../utils/lark/cli");
  const args = normalizeArgs('im +chat-list --verbose "+messages-send"');
  expect(args).toEqual(["im", "+chat-list", "--verbose", "+messages-send"]);
  expect(real.validateArgs(args).ok).toBe(false);
  expect(real.classify(normalizeArgs('im +messages-send --text "hi there"'))).toBe("write");
});
test("handler normalizes collapsed command before runner", async () => {
  await registeredHandler(fakeAibitat())({ args: ['drive +search --query "x y"'] });
  expect(cli.validateArgs).toHaveBeenCalledWith(["drive", "+search", "--query", "x y"]);
  expect(cli.runAsUser).toHaveBeenCalledWith({ userId: 7, args: ["drive", "+search", "--query", "x y"] });
});

test("description routes uploaded wiki files to Drive download", () => {
  const aibitat = fakeAibitat();
  registeredHandler(aibitat);
  const definition = aibitat.function.mock.calls[0][0];
  expect(definition.description).toContain("Use docs +fetch only for Lark Docs (docx).");
  expect(definition.description).toContain("drive +download --wiki-token <token>");
  expect(definition.examples).toContainEqual({
    prompt: "read the PDF at the wiki page token",
    call: JSON.stringify({ args: ["drive", "+download", "--wiki-token", "<token>"] }),
  });
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
  const token = `u-${"a".repeat(16)}`;
  const args = [
    "im",
    "+messages-send",
    "--user-id",
    "ou_recipient",
    "--text",
    `private message ${token}`,
  ];

  await handler({ args });

  expect(aibitat.requestToolApproval).toHaveBeenCalledWith({
    skillName: "lark-cli",
    payload: {
      command:
        "im +messages-send --user-id ou_recipient --text private message [redacted]",
    },
    description:
      "Run Lark command as you: im +messages-send --user-id ou_recipient --text private message [redacted] (write)",
  });
  expect(aibitat.requestToolApproval.mock.invocationCallOrder[0]).toBeLessThan(
    cli.runAsUser.mock.invocationCallOrder[0]
  );
});

test("requests approval for unknown classifications", async () => {
  cli.classify.mockReturnValue("unknown");
  const aibitat = fakeAibitat();
  aibitat.requestToolApproval.mockResolvedValue({ approved: true });

  await registeredHandler(aibitat)({ args: ["im", "+future-command"] });

  expect(aibitat.requestToolApproval).toHaveBeenCalledWith(
    expect.objectContaining({ skillName: "lark-cli" })
  );
  expect(cli.runAsUser).toHaveBeenCalled();
});

test("does not run unknown classification after denied approval", async () => {
  cli.classify.mockReturnValue("unknown");
  const aibitat = fakeAibitat();
  aibitat.requestToolApproval.mockResolvedValue({ approved: false });

  await expect(
    registeredHandler(aibitat)({ args: ["im", "+future-command"] })
  ).resolves.toBe("Lark command was not approved.");

  expect(aibitat.requestToolApproval).toHaveBeenCalled();
  expect(cli.runAsUser).not.toHaveBeenCalled();
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
  const { agentSkillsForWorkspace } = require("../../../utils/agents/defaults");
  const {
    WorkspaceAgentSettings,
  } = require("../../../models/workspaceAgentSettings");
  WorkspaceAgentSettings.enabledSkills.mockResolvedValue(["lark-cli"]);
  SystemSettings.isMultiUserMode.mockResolvedValue(true);

  expect(plugins["lark-cli"]).toBe(larkCli);
  expect(plugins["lark-cli"].name).toBe("lark-cli");
  const discovered = await agentSkillsForWorkspace({ id: 1 });
  expect(discovered.filter((name) => name === "lark-cli")).toEqual([
    "lark-cli",
  ]);
});

test("approval redaction reuses the runner's single secret pattern", () => {
  // The plugin must not carry its own copy of the pattern: a drift between the
  // two would let a token reach the approval card the runner would have hidden.
  expect(REAL_SECRET_PATTERN).toBeInstanceOf(RegExp);
  expect(REAL_SECRET_PATTERN.flags).toContain("g");

  const token = `u-${"a".repeat(20)}`;
  const source = require("fs").readFileSync(
    require.resolve("../../../utils/agents/aibitat/plugins/lark-cli"),
    "utf8"
  );
  expect(source).toContain("SECRET_PATTERN");
  expect(source).not.toMatch(/\[ut\]-\[A-Za-z0-9/);

  expect(redactForDisplay(["im", "+messages-send", "--text", token])).toEqual([
    "im",
    "+messages-send",
    "--text",
    "[redacted]",
  ]);
});
