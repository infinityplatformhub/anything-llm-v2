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
const { attached, mark, since, toolCalled } = require("../lib/evidence");
const { SKILLS } = require("../lib/skills");

const A = E2E_A_URL;
const LOG_A = E2E_LOG_A;
const FIXTURES = path.resolve(__dirname, "../fixtures/docs");
let key;

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
  key = generated.body.apiKey.secret; expect(key).toBeTruthy();
  await uploadAndEmbed("alpha-secret.txt", "ws-alpha");
  await uploadAndEmbed("beta-secret.txt", "ws-beta");

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
    expect(attached(chunk, skill.attachName)).toBe(false);
    if (skill.sideEffectAbsent) await skill.sideEffectAbsent(ctx);
  });

  const B = skill.skipB ? test.skip : test;
  B("B: enabled → attached and works", async () => {
    const ctx = { base: A, key, storage: E2E_STORAGE_A };
    if (skill.before) ctx.before = await skill.before(ctx);
    expectOk(await setSkills(A, null, "ws-alpha", [skill.id]));

    let response;
    let chunk;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const logMark = mark(LOG_A);
      response = await agentChatV1(A, key, "ws-alpha", skill.prompt);
      expectOk(response);
      chunk = since(LOG_A, logMark);
      expect(attached(chunk, skill.attachName)).toBe(true);
      if (toolCalled(chunk, skill.toolName) || attempt === 3) break;
      console.info(`[e2e] ${skill.id} B attempt ${attempt + 1}`);
    }
    await skill.assertB(ctx, chunk, response);
  });

  test("C: enabled in alpha only → beta not attached", async () => {
    expectOk(await setSkills(A, null, "ws-alpha", [skill.id]));
    const logMark = mark(LOG_A);
    expectOk(await agentChatV1(A, key, "ws-beta", skill.prompt));
    const chunk = since(LOG_A, logMark);
    expect(attached(chunk, skill.attachName)).toBe(false);
  });
});
