/* global jest, describe, it, expect, beforeAll, afterAll */
/** Real HTTP server, throwaway SQLite, and no product-module mocks. */
require("../lark/helpers/preload");

const { createTempEnvironment } = require("../lark/helpers/env");
const { startServer } = require("../lark/helpers/server");
const { withDb, closeDb } = require("../lark/helpers/db");

jest.setTimeout(120000);

const PASSWORD = "Passw0rd!2345";
const ADMIN = { username: "e2eadmin", password: PASSWORD };
const DEFAULT_SKILLS = [
  "rag-memory",
  "document-summarizer",
  "web-scraping",
  "filesystem-agent",
  "create-files-agent",
  "create-chart",
  "generate-image",
  "web-browsing",
  "sql-agent",
  "lark-cli",
];

let environment;
let server;
let adminToken;
let aliceToken;
let teamWorkspace;

const db = (callback) => withDb(environment, callback);

beforeAll(async () => {
  environment = createTempEnvironment();
  Object.assign(process.env, environment.env, { NODE_ENV: "test" });
  server = await startServer(environment);
  adminToken = (await server.enableMultiUser(ADMIN)).token;
});

afterAll(async () => {
  await closeDb();
  if (server) await server.stop();
  if (environment) environment.cleanup();
});

describe("default agent skills end-to-end", () => {
  it("seeds all built-in skills for a newly created workspace", async () => {
    const created = await server.api("/api/workspace/new", {
      method: "POST",
      token: adminToken,
      body: { name: "team" },
    });

    expect([200, 201]).toContain(created.status);
    teamWorkspace = created.json.workspace;
    const read = await server.api(
      `/api/admin/workspace/${teamWorkspace.slug}/agent-skills`,
      { token: adminToken }
    );
    expect(read.status).toBe(200);
    expect(read.json.enabledSkills).toEqual(DEFAULT_SKILLS);
    await db(async (prisma) => {
      const row = await prisma.workspace_agent_settings.findUnique({
        where: { workspace_id: teamWorkspace.id },
      });
      expect(row).not.toBeNull();
      expect(row.enabled_skills).toBe(JSON.stringify(DEFAULT_SKILLS));
    });
  });

  it("seeds all built-in skills for an auto-created personal workspace", async () => {
    await server.createUser({
      token: adminToken,
      username: "alice",
      password: PASSWORD,
      role: "default",
    });
    aliceToken = (await server.login({ username: "alice", password: PASSWORD }))
      .token;

    const listed = await server.api("/api/workspaces", { token: aliceToken });
    expect(listed.status).toBe(200);
    expect(listed.json.workspaces).toHaveLength(1);
    const personalWorkspace = listed.json.workspaces[0];
    const read = await server.api(
      `/api/admin/workspace/${personalWorkspace.slug}/agent-skills`,
      { token: adminToken }
    );
    expect(read.status).toBe(200);
    expect(read.json.enabledSkills).toEqual(DEFAULT_SKILLS);
  });

  it("@edge leaves an existing workspace without settings untouched", async () => {
    const workspace = await db((prisma) =>
      prisma.workspaces.create({
        data: {
          name: "legacy",
          slug: "legacy",
          chatMode: "automatic",
        },
      })
    );

    const read = await server.api(
      `/api/admin/workspace/${workspace.slug}/agent-skills`,
      { token: adminToken }
    );
    expect(read.status).toBe(200);
    expect(read.json.enabledSkills).toEqual([]);
    await db(async (prisma) => {
      expect(
        await prisma.workspace_agent_settings.findUnique({
          where: { workspace_id: workspace.id },
        })
      ).toBeNull();
    });
  });

  it("@edge lets an admin turn skills off without changing later defaults", async () => {
    const updated = await server.api(
      `/api/admin/workspace/${teamWorkspace.slug}/agent-skills`,
      {
        method: "POST",
        token: adminToken,
        body: { enabledSkills: ["rag-memory"] },
      }
    );
    expect(updated.status).toBe(200);

    const readTeam = await server.api(
      `/api/admin/workspace/${teamWorkspace.slug}/agent-skills`,
      { token: adminToken }
    );
    expect(readTeam.status).toBe(200);
    expect(readTeam.json.enabledSkills).toEqual(["rag-memory"]);

    const created = await server.api("/api/workspace/new", {
      method: "POST",
      token: adminToken,
      body: { name: "team2" },
    });
    expect([200, 201]).toContain(created.status);
    const readTeam2 = await server.api(
      `/api/admin/workspace/${created.json.workspace.slug}/agent-skills`,
      { token: adminToken }
    );
    expect(readTeam2.status).toBe(200);
    expect(readTeam2.json.enabledSkills).toEqual(DEFAULT_SKILLS);
  });

  it("keeps agent skill settings admin-only", async () => {
    const denied = await server.api(
      `/api/admin/workspace/${teamWorkspace.slug}/agent-skills`,
      { token: aliceToken }
    );
    expect(denied.status).toBe(401);
  });
});
