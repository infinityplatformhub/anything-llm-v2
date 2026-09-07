/** Real HTTP server, throwaway SQLite, and no product-module mocks. */
require("../lark/helpers/preload");

const { createTempEnvironment } = require("../lark/helpers/env");
const { startServer } = require("../lark/helpers/server");
const { withDb, closeDb } = require("../lark/helpers/db");

jest.setTimeout(120000);

const PASSWORD = "Passw0rd!2345";
const ADMIN = { username: "e2eadmin", password: PASSWORD };

let environment;
let server;
let adminToken;
let alice;
let aliceToken;
let bob;
let bobToken;
let bobWorkspace;

const db = (callback) => withDb(environment, callback);

beforeAll(async () => {
  environment = createTempEnvironment();
  Object.assign(process.env, environment.env, { NODE_ENV: "test" });
  server = await startServer(environment);
  const admin = await server.enableMultiUser(ADMIN);
  adminToken = admin.token;
});

afterAll(async () => {
  await closeDb();
  if (server) await server.stop();
  if (environment) environment.cleanup();
});

describe("personal workspace end-to-end", () => {
  it("does not create a personal workspace for an admin", async () => {
    const response = await server.api("/api/workspaces", { token: adminToken });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ workspaces: [] });
    await db(async (prisma) => {
      expect(await prisma.workspaces.count()).toBe(0);
    });
  });

  it("creates and links one personal workspace for a default user", async () => {
    alice = await server.createUser({
      token: adminToken,
      username: "alice",
      password: PASSWORD,
      role: "default",
    });
    aliceToken = (await server.login({ username: "alice", password: PASSWORD }))
      .token;

    const response = await server.api("/api/workspaces", { token: aliceToken });

    expect(response.status).toBe(200);
    expect(response.json.workspaces).toHaveLength(1);
    expect(response.json.workspaces[0].name).toBe("alice's workspace");
    const workspace = response.json.workspaces[0];
    await db(async (prisma) => {
      expect(await prisma.workspaces.count()).toBe(1);
      expect(await prisma.workspace_users.findMany()).toEqual([
        expect.objectContaining({
          user_id: alice.id,
          workspace_id: workspace.id,
        }),
      ]);
    });
  });

  it("keeps repeated personal-workspace reads idempotent", async () => {
    const responses = [];
    for (let index = 0; index < 3; index += 1)
      responses.push(
        await server.api("/api/workspaces", { token: aliceToken })
      );

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.json.workspaces).toHaveLength(1);
      expect(response.json.workspaces[0].name).toBe("alice's workspace");
    }
    await db(async (prisma) => {
      expect(await prisma.workspaces.count()).toBe(1);
      expect(
        await prisma.workspace_users.count({ where: { user_id: alice.id } })
      ).toBe(1);
    });
  });

  it("@edge creates exactly one personal workspace under concurrent reads", async () => {
    bob = await server.createUser({
      token: adminToken,
      username: "bob",
      password: PASSWORD,
      role: "default",
    });
    bobToken = (await server.login({ username: "bob", password: PASSWORD }))
      .token;

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        server.api("/api/workspaces", { token: bobToken })
      )
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.json.workspaces).toHaveLength(1);
      expect(response.json.workspaces[0].name).toBe("bob's workspace");
    }
    bobWorkspace = responses[0].json.workspaces[0];
    await db(async (prisma) => {
      expect(
        await prisma.workspaces.count({ where: { id: bobWorkspace.id } })
      ).toBe(1);
      expect(
        await prisma.workspace_users.count({ where: { user_id: bob.id } })
      ).toBe(1);
    });
  });

  it("@edge does not create a personal workspace for a manager", async () => {
    await server.createUser({
      token: adminToken,
      username: "mia",
      password: PASSWORD,
      role: "manager",
    });
    const miaToken = (
      await server.login({ username: "mia", password: PASSWORD })
    ).token;
    const beforeCount = await db((prisma) => prisma.workspaces.count());

    const response = await server.api("/api/workspaces", { token: miaToken });

    expect(response.status).toBe(200);
    await db(async (prisma) => {
      expect(await prisma.workspaces.count()).toBe(beforeCount);
      const mia = await prisma.users.findUnique({ where: { username: "mia" } });
      expect(
        await prisma.workspace_users.count({ where: { user_id: mia.id } })
      ).toBe(0);
    });
  });

  it("keeps another default user's workspace private", async () => {
    const list = await server.api("/api/workspaces", { token: aliceToken });
    const detail = await server.api(`/api/workspace/${bobWorkspace.slug}`, {
      token: aliceToken,
    });

    expect(list.status).toBe(200);
    expect(list.json.workspaces).toHaveLength(1);
    expect(list.json.workspaces[0].name).toBe("alice's workspace");
    expect(detail.status).toBe(200);
    expect(detail.json).toEqual({ workspace: null });
    await db(async (prisma) => {
      expect(
        await prisma.workspace_users.count({
          where: { user_id: alice.id, workspace_id: bobWorkspace.id },
        })
      ).toBe(0);
    });
  });

  it("keeps workspace creation restricted to admin and manager roles", async () => {
    const denied = await server.api("/api/workspace/new", {
      method: "POST",
      token: aliceToken,
      body: { name: "x" },
    });
    expect(denied.status).toBe(401);

    const allowed = await server.api("/api/workspace/new", {
      method: "POST",
      token: adminToken,
      body: { name: "admin workspace" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.json.workspace.name).toBe("admin workspace");
    await db(async (prisma) => {
      expect(
        await prisma.workspaces.count({ where: { name: "x" } })
      ).toBe(0);
      expect(
        await prisma.workspaces.count({ where: { name: "admin workspace" } })
      ).toBe(1);
    });
  });
});
