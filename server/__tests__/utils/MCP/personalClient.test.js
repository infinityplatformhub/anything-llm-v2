/* global jest */
const {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} = require("@jest/globals");
require("../../utils/lark/_polyfill");
const crypto = require("crypto");
const prisma = require("../../../utils/prisma");
const {
  validateWorkspaceServerConfig,
} = require("../../../utils/MCP/serverConfig");
let Grant, caller, workspace, a, b;
const config = {
  url: "https://medusa.example/mcp",
  type: "http",
  anythingllm: { perUserAuth: true },
};
beforeAll(async () => {
  process.env.SIG_KEY ||= "personal-test-key";
  process.env.SIG_SALT ||= "personal-test-salt";
  workspace = await prisma.workspaces.create({
    data: { name: "Personal MCP", slug: crypto.randomUUID() },
  });
  a = await prisma.users.create({
    data: { username: crypto.randomUUID(), password: "unused" },
  });
  b = await prisma.users.create({
    data: { username: crypto.randomUUID(), password: "unused" },
  });
  for (const user of [a, b])
    await prisma.workspace_users.create({
      data: { workspace_id: workspace.id, user_id: user.id },
    });
});
beforeEach(async () => {
  Grant = require("../../../models/personalMcpGrant").PersonalMcpGrant;
  caller = require("../../../utils/MCP/personalCaller");
  await prisma.personal_mcp_grants.deleteMany({
    where: { workspace_id: workspace.id },
  });
});
afterAll(async () => {
  if (workspace)
    await prisma.workspaces.delete({ where: { id: workspace.id } });
  if (a) await prisma.users.delete({ where: { id: a.id } });
  if (b) await prisma.users.delete({ where: { id: b.id } });
  await prisma.$disconnect();
});
describe("personal MCP config and grants", () => {
  it("stores only a bounded public account label and ignores raw provider identity objects", async () => {
    const grant = await Grant.begin(workspace.id, a.id, "medusa", config);
    await Grant.save(workspace.id, a.id, "medusa", grant.version, config, {
      access_token: "private-token",
      account_label: "  Alice\nShop  ",
      medusa_jwt: "must-not-store",
    });
    const found = await Grant.find(workspace.id, a.id, "medusa", config);
    expect(found.account_label).toBe("Alice Shop");
    expect(found.medusa_jwt).toBeUndefined();
  });
  it("accepts personal remote auth but rejects ambiguous auth modes", () => {
    expect(validateWorkspaceServerConfig(config)).toEqual(config);
    expect(() =>
      validateWorkspaceServerConfig({
        ...config,
        anythingllm: { perUserAuth: true, perWorkspaceAuth: true },
      })
    ).toThrow("invalid_anythingllm");
    expect(() =>
      validateWorkspaceServerConfig({
        ...config,
        anythingllm: { perUserAuth: "yes" },
      })
    ).toThrow("invalid_anythingllm");
    expect(() =>
      validateWorkspaceServerConfig({
        command: "node",
        anythingllm: { perUserAuth: true },
      })
    ).toThrow("stdio_not_supported");
  });
  it("encrypts tokens and isolates A/B in one workspace without copying legacy tokens", async () => {
    const grant = await Grant.begin(workspace.id, a.id, "medusa", config);
    expect(
      await Grant.save(workspace.id, a.id, "medusa", grant.version, config, {
        access_token: "private-access",
        refresh_token: "private-refresh",
      })
    ).toBe(true);
    expect(await Grant.find(workspace.id, b.id, "medusa", config)).toBeNull();
    const row = await prisma.personal_mcp_grants.findFirst({
      where: { user_id: a.id },
    });
    expect(JSON.stringify(row)).not.toMatch(/private-access|private-refresh/);
    expect(
      await Grant.find(workspace.id, a.id, "medusa", config)
    ).toMatchObject({
      enabled: true,
      access_token: "private-access",
      refresh_token: "private-refresh",
    });
  });
  it("disconnect tombstone prevents stale refresh and callback overwrite", async () => {
    const first = await Grant.begin(workspace.id, a.id, "medusa", config);
    await Grant.clear(workspace.id, a.id, "medusa");
    expect(
      await Grant.save(workspace.id, a.id, "medusa", first.version, config, {
        access_token: "stale",
      })
    ).toBe(false);
    const second = await Grant.begin(workspace.id, a.id, "medusa", config);
    expect(
      await Grant.save(workspace.id, a.id, "medusa", second.version, config, {
        access_token: "fresh",
      })
    ).toBe(true);
    expect(
      await Grant.save(workspace.id, a.id, "medusa", second.version, config, {
        access_token: "stale-refresh",
      })
    ).toBe(false);
    expect(
      (await Grant.find(workspace.id, a.id, "medusa", config)).access_token
    ).toBe("fresh");
  });
  it("definition changes invalidate all personal grants and old callback versions", async () => {
    const first = await Grant.begin(workspace.id, a.id, "medusa", config);
    await Grant.invalidate(workspace.id, "medusa");
    expect(
      await Grant.save(workspace.id, a.id, "medusa", first.version, config, {
        access_token: "stale",
      })
    ).toBe(false);
    expect(
      await Grant.find(workspace.id, a.id, "medusa", {
        ...config,
        url: "https://other.example/mcp",
      })
    ).toBeNull();
  });
  it("database refresh lease is owner scoped and disconnect clears refresh but not reconnect", async () => {
    const first = await Grant.begin(workspace.id, a.id, "medusa", config);
    await Grant.save(workspace.id, a.id, "medusa", first.version, config, {
      access_token: "initial",
      refresh_token: "refresh",
    });
    const original = await Grant.find(workspace.id, a.id, "medusa", config);
    const lease = await Grant.acquireRefresh(
      workspace.id,
      a.id,
      "medusa",
      original.version,
      config
    );
    expect(lease).toBe(original.version + 1);
    expect(
      await Grant.acquireRefresh(
        workspace.id,
        a.id,
        "medusa",
        original.version,
        config
      )
    ).toBeNull();
    await Grant.save(workspace.id, a.id, "medusa", lease, config, {
      access_token: "refreshed",
      refresh_token: "rotated",
    });
    await Grant.clearGeneration(
      workspace.id,
      a.id,
      "medusa",
      original.generation
    );
    expect(
      (await Grant.find(workspace.id, a.id, "medusa", config)).enabled
    ).toBe(false);
    const newer = await Grant.begin(workspace.id, a.id, "medusa", config);
    await Grant.save(workspace.id, a.id, "medusa", newer.version, config, {
      access_token: "reconnected",
    });
    await Grant.clearGeneration(
      workspace.id,
      a.id,
      "medusa",
      original.generation
    );
    expect(
      (await Grant.find(workspace.id, a.id, "medusa", config)).access_token
    ).toBe("reconnected");
  });
  it("requires a verified caller, active user and current membership", async () => {
    await expect(
      caller.fromResponse({ locals: { user: a } }, workspace)
    ).rejects.toThrow("personal_auth_required");
    const response = { locals: { user: a, browserSessionUserId: a.id } };
    const verified = await caller.fromResponse(response, workspace);
    expect(await caller.assert(verified, workspace)).toBe(a.id);
    await expect(caller.assert({ userId: a.id }, workspace)).rejects.toThrow(
      "personal_auth_required"
    );
    await prisma.users.update({ where: { id: a.id }, data: { suspended: 1 } });
    await expect(caller.assert(verified, workspace)).rejects.toThrow(
      "personal_auth_required"
    );
    await prisma.users.update({ where: { id: a.id }, data: { suspended: 0 } });
    await prisma.workspace_users.deleteMany({
      where: { workspace_id: workspace.id, user_id: a.id },
    });
    await expect(caller.assert(verified, workspace)).rejects.toThrow(
      "personal_auth_required"
    );
    await prisma.workspace_users.create({
      data: { workspace_id: workspace.id, user_id: a.id },
    });
  });
});
