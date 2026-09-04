const path = require("path");
const { PrismaClient } = require("../../server/node_modules/@prisma/client");
const { E2E_A_URL, E2E_LOG_A, E2E_STORAGE_A } = require("../lib/env");
const {
  listWorkspaces,
  newWorkspace,
  uploadDoc,
  embed,
  getSkills,
  setSkills,
  agentChatV1,
  streamChatJwt,
} = require("../lib/api");
const { mark, since, attached, attachedAny } = require("../lib/evidence");

const ALL_SKILLS = [
  "rag-memory",
  "document-summarizer",
  "web-scraping",
  "web-browsing",
  "sql-agent",
  "create-chart",
  "generate-image",
  "filesystem-agent",
  "create-files-agent",
  "create-scheduled-job",
  "gmail-agent",
  "google-calendar-agent",
  "outlook-agent",
];
const SLUGS = ["ws-alpha", "ws-beta", "ws-gamma"];
const fixtures = path.resolve(__dirname, "../fixtures/docs");

let key;

const expectOk = (response) => expect(response.status).toBe(200);

async function ensureWorkspace(slug) {
  const current = await listWorkspaces(E2E_A_URL, null);
  expectOk(current);
  if (current.body.workspaces.some((workspace) => workspace.slug === slug)) return;
  expectOk(await newWorkspace(E2E_A_URL, null, slug));
}

async function uploadAndEmbed(filename, slug) {
  const uploaded = await uploadDoc(E2E_A_URL, key, path.join(fixtures, filename));
  expectOk(uploaded);
  const location = uploaded.body.documents?.[0]?.location;
  expect(location).toBeTruthy();
  expectOk(await embed(E2E_A_URL, null, slug, [location]));
}

async function ensureFixtures() {
  for (const slug of SLUGS) await ensureWorkspace(slug);

  const response = await fetch(`${E2E_A_URL}/api/system/generate-api-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const generated = { status: response.status, body: await response.json() };
  expectOk(generated);
  key = generated.body.apiKey.secret;
  await uploadAndEmbed("alpha-secret.txt", "ws-alpha");
  await uploadAndEmbed("beta-secret.txt", "ws-beta");
}

async function writeStaleSkills(slug) {
  const db = path.join(E2E_STORAGE_A, "anythingllm.db");
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${db}` } } });
  try {
    const workspace = await prisma.workspaces.findUnique({ where: { slug } });
    expect(workspace).not.toBeNull();
    await prisma.workspace_agent_settings.upsert({
      where: { workspace_id: workspace.id },
      create: {
        workspace_id: workspace.id,
        enabled_skills: JSON.stringify(["ghost-skill", "rag-memory"]),
      },
      update: {
        enabled_skills: JSON.stringify(["ghost-skill", "rag-memory"]),
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

function responseText(response) {
  return typeof response.body === "string"
    ? response.body
    : response.body?.textResponse ?? "";
}

describe("cross-workspace isolation", () => {
  beforeAll(ensureFixtures);

  beforeEach(async () => {
    for (const slug of SLUGS) {
      expectOk(await setSkills(E2E_A_URL, null, slug, []));
    }
  });

  test("all skills in alpha attach none in gamma", async () => {
    const updated = await setSkills(E2E_A_URL, null, "ws-alpha", ALL_SKILLS);
    expectOk(updated);
    expect(updated.body.enabledSkills).toEqual(ALL_SKILLS);
    const m = mark(E2E_LOG_A);
    const response = await agentChatV1(E2E_A_URL, key, "ws-gamma", "Say hello.");
    expect(response.status).toBe(200);
    expect(attachedAny(since(E2E_LOG_A, m))).toEqual([]);
  });

  test("aliases cannot smuggle non-canonical skills", async () => {
    const updated = await setSkills(E2E_A_URL, null, "ws-alpha", [
      "memory",
      "docSummarizer",
      "rag-memory",
    ]);
    expect(updated.status).toBe(200);
    expect(updated.body.enabledSkills).toEqual(["rag-memory"]);

    const fetched = await getSkills(E2E_A_URL, null, "ws-alpha");
    expect(fetched.status).toBe(200);
    expect(fetched.body.enabledSkills).toEqual(["rag-memory"]);
  });

  test("stale skill ids are filtered without breaking chat", async () => {
    await writeStaleSkills("ws-alpha");
    const fetched = await getSkills(E2E_A_URL, null, "ws-alpha");
    expect(fetched.status).toBe(200);
    expect(fetched.body.enabledSkills).toEqual(["rag-memory"]);

    const response = await agentChatV1(
      E2E_A_URL,
      key,
      "ws-alpha",
      "Search your memory for the alpha token."
    );
    expect(response.status).toBe(200);
  });

  test("API and UI chat paths attach the same workspace skills", async () => {
    await setSkills(E2E_A_URL, null, "ws-alpha", ["rag-memory"]);

    const apiMark = mark(E2E_LOG_A);
    const apiResponse = await agentChatV1(
      E2E_A_URL,
      key,
      "ws-alpha",
      "Search your memory for the alpha token."
    );
    expect(apiResponse.status).toBe(200);
    expect(attached(since(E2E_LOG_A, apiMark), "rag-memory")).toBe(true);

    const uiMark = mark(E2E_LOG_A);
    const uiResponse = await streamChatJwt(
      E2E_A_URL,
      null,
      "ws-alpha",
      "@agent Search your memory for the alpha token."
    );
    expect(uiResponse.status).toBe(200);
    expect(attached(since(E2E_LOG_A, uiMark), "rag-memory")).toBe(true);
  });

  test("skill changes take effect on the next chat", async () => {
    await setSkills(E2E_A_URL, null, "ws-alpha", ["rag-memory"]);
    const enabledMark = mark(E2E_LOG_A);
    const enabled = await agentChatV1(
      E2E_A_URL,
      key,
      "ws-alpha",
      "Search your memory for the alpha token."
    );
    expect(enabled.status).toBe(200);
    expect(attached(since(E2E_LOG_A, enabledMark), "rag-memory")).toBe(true);

    await setSkills(E2E_A_URL, null, "ws-alpha", []);
    const disabledMark = mark(E2E_LOG_A);
    const disabled = await agentChatV1(
      E2E_A_URL,
      key,
      "ws-alpha",
      "Search your memory for the alpha token."
    );
    expect(disabled.status).toBe(200);
    expect(attached(since(E2E_LOG_A, disabledMark), "rag-memory")).toBe(false);
  });

  test("RAG data does not cross workspace boundaries", async () => {
    expectOk(await setSkills(E2E_A_URL, null, "ws-alpha", ["rag-memory"]));
    expectOk(await setSkills(E2E_A_URL, null, "ws-beta", ["rag-memory"]));

    const beta = await agentChatV1(
      E2E_A_URL,
      key,
      "ws-beta",
      "Search your documents for the secret token stored only in alpha."
    );
    expect(beta.status).toBe(200);
    expect(responseText(beta)).not.toContain("ALPHA-TOKEN-7731");

    const alpha = await agentChatV1(
      E2E_A_URL,
      key,
      "ws-alpha",
      "Search your documents for the secret token stored only in beta."
    );
    expect(alpha.status).toBe(200);
    expect(responseText(alpha)).not.toContain("BETA-TOKEN-9942");
  });

  test.todo("phase 4: sql connections per workspace — alpha must not see beta_db");
  test.todo("phase 4: filesystem root per workspace — beta cannot read alpha-note.txt");
  test.todo("phase 5: scheduled job bound to workspace");
});
