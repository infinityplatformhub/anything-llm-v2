require("../../utils/lark/_polyfill");
const fs = require("fs");
const crypto = require("crypto");
const prisma = require("../../../utils/prisma");
const Layer = require("../../../utils/MCP");
const {
  WorkspaceMcpServer: Servers,
} = require("../../../models/workspaceMcpServer");
const { PersonalMcpGrant: Grant } = require("../../../models/personalMcpGrant");
const {
  PersonalMcpContext: Context,
} = require("../../../models/personalMcpContext");
let workspace, user, catalogPath, original;
const name = "strict-target";
const personal = {
  url: "https://fixture.example/mcp",
  anythingllm: { perUserAuth: true },
};
beforeAll(async () => {
  workspace = await prisma.workspaces.create({
    data: { name: "Strict classifier", slug: crypto.randomUUID() },
  });
  user = await prisma.users.create({
    data: { username: crypto.randomUUID(), password: "fixture" },
  });
  catalogPath = new Layer().mcpServerJSONPath;
  original = fs.readFileSync(catalogPath, "utf8");
});
afterEach(async () => {
  jest.restoreAllMocks();
  fs.writeFileSync(catalogPath, original);
  await prisma.workspace_mcp_servers.deleteMany({
    where: { workspace_id: workspace.id },
  });
  await prisma.personal_mcp_grants.deleteMany({
    where: { workspace_id: workspace.id },
  });
});
afterAll(async () => {
  await prisma.workspaces.delete({ where: { id: workspace.id } });
  await prisma.users.delete({ where: { id: user.id } });
  await prisma.$disconnect();
});
test.each([
  "",
  " ",
  "null",
  "[]",
  "{}",
  '{"mcpServers":null}',
  '{"mcpServers":[]}',
  '{"mcpServers":',
  'prefix {"mcpServers":{}} suffix',
])("strict global read rejects invalid current format: %j", async (text) => {
  fs.writeFileSync(catalogPath, text);
  await expect(
    Layer.findServerConfigStrict(name, workspace.id)
  ).rejects.toThrow("personal_config_unavailable");
});
test("strict global read accepts actual empty current catalog and uses own-property target lookup", async () => {
  fs.writeFileSync(catalogPath, '{"mcpServers":{}}');
  expect(await Layer.findServerConfigStrict(name, workspace.id)).toBeNull();
  expect(
    await Layer.findServerConfigStrict("constructor", workspace.id)
  ).toBeNull();
});
test.each([
  null,
  [],
  "invalid",
  { anythingllm: null },
  { anythingllm: { perUserAuth: "true" } },
])(
  "malformed relevant definition is unknown, not nonpersonal: %j",
  async (config) => {
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({ mcpServers: { [name]: config } })
    );
    await expect(
      Layer.findServerConfigStrict(name, workspace.id)
    ).rejects.toThrow("personal_config_unavailable");
  }
);
test("strict read does not validate unrelated definitions or change lenient repair", async () => {
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({ mcpServers: { [name]: personal, unrelated: null } })
  );
  expect(await Layer.findServerConfigStrict(name, workspace.id)).toEqual({
    name,
    server: personal,
    owner: "global",
  });
  fs.writeFileSync(catalogPath, "not a catalog");
  expect(new Layer().mcpServerConfigs).toEqual([]);
  fs.writeFileSync(catalogPath, '{"mcpServers":{}} trailing');
  expect(new Layer().mcpServerConfigs).toEqual([]);
});
test("workspace override is authoritative without reading unhealthy global; absent file is unknown without creation", async () => {
  await Servers.create(workspace.id, name, personal);
  fs.writeFileSync(catalogPath, "not a catalog");
  expect(await Layer.findServerConfigStrict(name, workspace.id)).toEqual({
    name,
    server: personal,
    owner: "workspace",
  });
  await Servers.delete(workspace.id, name);
  fs.unlinkSync(catalogPath);
  await expect(
    Layer.findServerConfigStrict(name, workspace.id)
  ).rejects.toThrow("personal_config_unavailable");
  expect(fs.existsSync(catalogPath)).toBe(false);
});
test.each(["SIG_KEY", "SIG_SALT"])(
  "strict workspace decrypt requires original %s and never generates/writes replacement keys",
  async (missing) => {
    await Servers.create(workspace.id, name, personal);
    const saved = {
      SIG_KEY: process.env.SIG_KEY,
      SIG_SALT: process.env.SIG_SALT,
    };
    const write = jest.spyOn(fs, "writeFileSync");
    delete process.env[missing];
    try {
      await expect(
        Layer.findServerConfigStrict(name, workspace.id)
      ).rejects.toThrow("personal_config_unavailable");
      expect(process.env[missing]).toBeUndefined();
      expect(process.env[missing === "SIG_KEY" ? "SIG_SALT" : "SIG_KEY"]).toBe(
        saved[missing === "SIG_KEY" ? "SIG_SALT" : "SIG_KEY"]
      );
      expect(write).not.toHaveBeenCalled();
    } finally {
      Object.assign(process.env, saved);
    }
    expect(
      (await Layer.findServerConfigStrict(name, workspace.id)).server
    ).toEqual(personal);
  }
);
test.each(["null", "[]", "not json"])(
  "decryptable invalid workspace shadow %s never falls back to global",
  async (plaintext) => {
    await Servers.create(workspace.id, name, personal);
    const { EncryptionManager } = require("../../../utils/EncryptionManager");
    await prisma.workspace_mcp_servers.update({
      where: { workspace_id_name: { workspace_id: workspace.id, name } },
      data: { config: new EncryptionManager().encrypt(plaintext) },
    });
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({ mcpServers: { [name]: personal } })
    );
    await expect(
      Layer.findServerConfigStrict(name, workspace.id)
    ).rejects.toThrow("personal_config_unavailable");
  }
);
test.each([
  "empty",
  "deleted",
  "disabled",
  "nonpersonal",
  "fingerprint-changed",
  "unrelated-user",
])(
  "healthy %s classification preserves unmarked legacy context",
  async (mode) => {
    const row = await Grant.begin(workspace.id, user.id, name, personal);
    await Grant.save(workspace.id, user.id, name, row.version, personal, {
      access_token: "fixture",
    });
    let config = personal;
    if (mode === "nonpersonal")
      config = { command: "node", args: ["fixture.js"] };
    if (mode === "fingerprint-changed")
      config = { ...personal, url: "https://changed.example/mcp" };
    fs.writeFileSync(
      catalogPath,
      JSON.stringify({
        mcpServers:
          mode === "empty" || mode === "deleted" ? {} : { [name]: config },
      })
    );
    if (mode === "disabled") await Grant.clear(workspace.id, user.id, name);
    const invocation = {
      workspace_id: workspace.id,
      user_id: mode === "unrelated-user" ? user.id + 10000 : user.id,
      thread_id: 999,
      workspace: { id: workspace.id },
    };
    await Context.prepare(invocation);
    expect(await Context.has(invocation)).toBe(false);
  }
);
test("classifier uses persisted workspace id, never an embedded workspace override", async () => {
  const row = await Grant.begin(workspace.id, user.id, name, personal);
  await Grant.save(workspace.id, user.id, name, row.version, personal, {
    access_token: "fixture",
  });
  await Servers.create(workspace.id, name, personal);
  fs.writeFileSync(catalogPath, '{"mcpServers":{}}');
  const invocation = {
    workspace_id: workspace.id,
    user_id: user.id,
    thread_id: 777,
    workspace: { id: workspace.id + 10000 },
  };
  await Context.prepare(invocation);
  expect(await Context.has(invocation)).toBe(true);
});
