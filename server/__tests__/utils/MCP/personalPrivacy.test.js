/* global jest */
const { describe, it, expect, beforeAll, afterAll } = require("@jest/globals");
require("../../utils/lark/_polyfill");
const crypto = require("crypto");
const JWT = require("jsonwebtoken");
const prisma = require("../../../utils/prisma");
const caller = require("../../../utils/MCP/personalCaller");
const {
  chatHistory,
} = require("../../../utils/agents/aibitat/plugins/chat-history");
const { WorkspaceChats } = require("../../../models/workspaceChats");
let workspace, a, b;
beforeAll(async () => {
  process.env.JWT_SECRET = "socket-personal-test";
  workspace = await prisma.workspaces.create({
    data: { name: "Socket ownership", slug: crypto.randomUUID() },
  });
  for (const name of ["a", "b"]) {
    const user = await prisma.users.create({
      data: { username: name + crypto.randomUUID(), password: "unused" },
    });
    await prisma.workspace_users.create({
      data: { workspace_id: workspace.id, user_id: user.id },
    });
    if (name === "a") a = user;
    else b = user;
  }
});
afterAll(async () => {
  await prisma.workspaces.delete({ where: { id: workspace.id } });
  for (const user of [a, b])
    await prisma.users.delete({ where: { id: user.id } });
  await prisma.$disconnect();
});
describe("personal websocket ownership and shared history", () => {
  it("redacts deferred first registration after privacy flips and abort before insert resolves", async () => {
    let finish;
    const create = jest.spyOn(WorkspaceChats, "new").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const save = jest.spyOn(WorkspaceChats, "upsert").mockResolvedValue({});
    const handlers = [];
    const instance = {
      handlerProps: {
        invocation: { workspace_id: workspace.id, user_id: a.id },
      },
      onAbort: jest.fn(),
      onMessage: (fn) => handlers.push(fn),
      registerChatId: jest.fn(),
    };
    chatHistory.plugin().setup(instance);
    const pending = handlers[0]({
      from: "USER",
      content: "private-first-race",
    });
    instance.personalMcpUsed = true;
    instance._aborted = true;
    finish({ chat: { id: 321 } });
    await pending;
    expect(save).toHaveBeenCalled();
    expect(JSON.stringify(save.mock.calls)).not.toContain("private-first-race");
    create.mockRestore();
    save.mockRestore();
  });
  it("redacts follow-up input before pre-registering a chat even when the turn aborts", async () => {
    const create = jest
      .spyOn(WorkspaceChats, "new")
      .mockResolvedValue({ chat: { id: 123 } });
    const handlers = [];
    const instance = {
      personalMcpUsed: true,
      handlerProps: {
        invocation: { workspace_id: workspace.id, user_id: a.id },
      },
      onAbort: jest.fn(),
      onMessage: (fn) => handlers.push(fn),
      registerChatId: jest.fn(),
    };
    chatHistory.plugin().setup(instance);
    await handlers[0]({ from: "USER", content: "private-follow-up-aborted" });
    expect(JSON.stringify(create.mock.calls)).not.toContain(
      "private-follow-up-aborted"
    );
    create.mockRestore();
  });
  it("suppresses provider diagnostics once invocation contains private tool context", () => {
    const Provider = require("../../../utils/agents/aibitat/providers/ai-provider");
    const instance = new Provider();
    instance.attachHandlerProps({ invocation: { personalMcpUsed: true } });
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    instance.providerLog("private-result", { text: "private-result" });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it("only the invocation owner can get a personal caller from a signed session subprotocol", async () => {
    const invocation = { workspace, user_id: a.id };
    const request = (user) => ({
      headers: {
        "sec-websocket-protocol":
          "anythingllm-agent, anythingllm-session." +
          JWT.sign({ id: user.id }, process.env.JWT_SECRET, {
            expiresIn: "1h",
          }),
      },
    });
    expect(
      await caller.assert(
        await caller.fromSocket(request(a), invocation),
        workspace
      )
    ).toBe(a.id);
    await expect(caller.fromSocket(request(b), invocation)).rejects.toThrow(
      "personal_auth_required"
    );
    await expect(
      caller.fromSocket({ headers: {}, query: { userId: a.id } }, invocation)
    ).rejects.toThrow("personal_auth_required");
  });
  it.each(["_store", "_storeSpecial"])(
    "redacts private results and derived response from %s, excludes retrieval",
    async (method) => {
      const save = jest.spyOn(WorkspaceChats, "upsert").mockResolvedValue({});
      const plugin = chatHistory.plugin();
      const instance = {
        personalMcpUsed: true,
        trackedChatId: 123,
        handlerProps: {
          invocation: { workspace_id: workspace.id, user_id: a.id },
        },
        _pendingCitations: [{ text: "private-citation" }],
        _pendingOutputs: [{ content: "private-output" }],
        clearTrackedChatId: jest.fn(),
        clearCitations: jest.fn(),
        clearClarifyingQuestionSurveys: jest.fn(),
      };
      await plugin[method](instance, {
        prompt: "private-follow-up-input",
        response: "private-derived-result",
        options: { storedResponse: () => "private-special-result" },
      });
      const saved = save.mock.calls[0][1];
      expect(JSON.stringify(saved)).not.toMatch(
        /private-derived|private-citation|private-output|private-special|private-follow-up/
      );
      expect(saved.include).toBe(false);
      expect(saved.response.text).toBe(
        "Personal MCP response is not stored in shared history."
      );
      save.mockRestore();
    }
  );
});
