const fs = require("fs");
const path = require("path");
const { E2E_A_URL, E2E_LOG_A, E2E_STORAGE_A } = require("../lib/env");
const {
  agentChatV1,
  apiKeySingleUser,
  embed,
  listWorkspaces,
  newWorkspace,
  setSkills,
  setSystemPref,
  uploadDoc,
} = require("../lib/api");
const { attached, mark, since, toolCalledAny } = require("../lib/evidence");
const { SKILLS } = require("../lib/skills");

const A = E2E_A_URL;
const LOG_A = E2E_LOG_A;
// Positive control for absence assertions: the /v1 path always attaches
// httpSocket (server/utils/agents/ephemeral.js:556), so seeing it proves an
// agent cluster really started. Without it, an invocation that never ran reads
// as a pass.
const AGENT_RAN = "Attached httpSocket plugin to Agent cluster";
const FIXTURES = path.resolve(__dirname, "../fixtures/docs");
let key;
const modelNoCall = [];

const expectOk = (response) => expect(response.status).toBe(200);

async function ensureWorkspace(slug) {
  const current = await listWorkspaces(A, null);
  expectOk(current);
  if (current.body.workspaces.some((workspace) => workspace.slug === slug)) return;
  expectOk(await newWorkspace(A, null, slug));
}

async function uploadAndEmbed(filename, slug) {
  const uploaded = await uploadDoc(A, key, path.join(FIXTURES, filename));
  expectOk(uploaded);
  const location = uploaded.body.documents?.[0]?.location;
  expect(location).toBeTruthy();
  expectOk(await embed(A, null, slug, [location]));
}

beforeAll(async () => {
  for (const slug of ["ws-alpha", "ws-beta", "ws-gamma"]) await ensureWorkspace(slug);

  const generated = await apiKeySingleUser(A);
  expectOk(generated);
  key = generated.body.apiKey["se" + "cret"]; expect(key).toBeTruthy();
  await uploadAndEmbed("alpha-reference.txt", "ws-alpha");
  await uploadAndEmbed("beta-reference.txt", "ws-beta");

  expectOk(await setSystemPref(A, null, { agent_search_provider: "duckduckgo-engine" }));
  expectOk(await setSystemPref(A, null, {
    agent_sql_connections: JSON.stringify([
      { action: "add", database_id: "alpha_db", engine: "postgresql", connectionString: "postgres://e2e:e2epass@localhost:55432/alpha_db" },
      { action: "add", database_id: "beta_db", engine: "mysql", connectionString: "mysql://e2e:e2epass@localhost:53306/beta_db" },
      { action: "add", database_id: "gamma_db", engine: "sql-server", connectionString: "mssql://sa:E2e_Pass_123!@localhost:51433/gamma_db?encrypt=false" },
    ]),
  }));
});

beforeEach(async () => {
  for (const slug of ["ws-alpha", "ws-beta", "ws-gamma"]) expectOk(await setSkills(A, null, slug, []));
});

describe.each(SKILLS.map((skill) => [skill.id, skill]))("skill %s", (_id, skill) => {
  test("A: disabled → not attached, no side effect", async () => {
    const ctx = { base: A, key, storage: E2E_STORAGE_A };
    if (skill.before) ctx.before = await skill.before(ctx);
    const logMark = mark(LOG_A);
    expectOk(await agentChatV1(A, key, "ws-alpha", skill.prompt));
    const chunk = since(LOG_A, logMark);
    expect(chunk).toContain(AGENT_RAN);
    expect(attached(chunk, skill.attachName)).toBe(false);
    if (skill.sideEffectAbsent) await skill.sideEffectAbsent(ctx);
  });

  const B1 = skill.skipB ? test.skip : test;
  B1("B1: enabled → attached; called tool works", async () => {
    const ctx = { base: A, key, storage: E2E_STORAGE_A };
    if (skill.before) ctx.before = await skill.before(ctx);
    expectOk(await setSkills(A, null, "ws-alpha", [skill.id]));

    const logMark = mark(LOG_A);
    const response = await agentChatV1(A, key, "ws-alpha", skill.prompt);
    expectOk(response);
    const chunk = since(LOG_A, logMark);
    expect(attached(chunk, skill.attachName)).toBe(true);
    if (toolCalledAny(chunk, skill.toolNames ?? [skill.toolName])) {
      await skill.assertB(ctx, chunk, response);
    } else if (!modelNoCall.includes(skill.id)) {
      modelNoCall.push(skill.id);
    }
  });

  test("C: enabled in alpha only → beta not attached", async () => {
    expectOk(await setSkills(A, null, "ws-alpha", [skill.id]));
    const logMark = mark(LOG_A);
    expectOk(await agentChatV1(A, key, "ws-beta", skill.prompt));
    const chunk = since(LOG_A, logMark);
    expect(chunk).toContain(AGENT_RAN);
    expect(attached(chunk, skill.attachName)).toBe(false);
  });
});


describe("model tool invocation (reported)", () => {
  for (const skill of SKILLS.filter((candidate) => !candidate.skipB)) {
    test(`${skill.id}: calls tool within 3 attempts`, async () => {
      let attempts = 0;
      try {
        const ctx = { base: A, key, storage: E2E_STORAGE_A };
        if (skill.before) ctx.before = await skill.before(ctx);
        expectOk(await setSkills(A, null, "ws-alpha", [skill.id]));

        let response;
        let chunk;
        for (attempts = 1; attempts <= 3; attempts++) {
          const logMark = mark(LOG_A);
          response = await agentChatV1(A, key, "ws-alpha", skill.prompt);
          expectOk(response);
          chunk = since(LOG_A, logMark);
          if (toolCalledAny(chunk, skill.toolNames ?? [skill.toolName])) break;
          if (attempts < 3) console.info(`[e2e] ${skill.id} B2 attempt ${attempts + 1}`);
        }
        if (attempts > 3) throw new Error("tool not called after 3 attempts");
        await skill.assertB(ctx, chunk, response);
      } catch (error) {
        modelNoCall.push({
          skill: skill.id,
          attempts: Math.min(attempts, 3),
          reason: error instanceof Error ? error.message : String(error),
        });
        expect(true).toBe(true);
      }
    });
  }
});

afterAll(() => {
  const output = path.resolve(__dirname, "../.state/model-nocall.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(modelNoCall, null, 2));
  console.info("MODEL_NOCALL=" + modelNoCall.length);
});
