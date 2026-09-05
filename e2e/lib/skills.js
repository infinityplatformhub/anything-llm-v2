const path = require("path");
const { agentChatV1, setSkills } = require("./api");
const { files, toolCalled, toolCalledAny } = require("./evidence");

const text = (response) => String(response.body?.textResponse ?? "");
const scheduledJobs = async (base) => {
  const response = await fetch(`${base}/api/scheduled-jobs`);
  const body = await response.json();
  if (!response.ok) throw new Error(`scheduled jobs returned ${response.status}`);
  return body.jobs;
};

const SKILLS = [
  {
    id: "rag-memory",
    attachName: "rag-memory",
    toolName: "rag-memory",
    prompt: "You must call the rag-memory tool first, then quote the alpha reference code exactly.",
    assertB: async (ctx, chunk, response) => {
      expect(toolCalled(chunk, "rag-memory")).toBe(true);
      expect(text(response)).toContain("ALPHA-TOKEN-7731");
      await setSkills(ctx.base, null, "ws-beta", ["rag-memory"]);
      const beta = await agentChatV1(ctx.base, ctx.key, "ws-beta", "You must call the rag-memory tool first, then quote the alpha reference code exactly.");
      expect(text(beta)).not.toContain("ALPHA-TOKEN");
    },
  },
  {
    id: "document-summarizer",
    attachName: "document-summarizer",
    toolName: "document-summarizer",
    prompt: "You must call document-summarizer now with action list and document_filename null. Return its filenames.",
    assertB: async (_ctx, chunk, response) => {
      expect(toolCalled(chunk, "document-summarizer")).toBe(true);
      expect(text(response)).toContain("alpha-reference");
      expect(text(response)).not.toContain("beta-reference");
    },
  },
  {
    id: "web-scraping",
    attachName: "web-scraping",
    toolName: "web-scraping",
    prompt: "Use the web-scraping tool to fetch http://localhost:58080/page.html now, then quote the marker exactly.",
    assertB: async (_ctx, chunk, response) => {
      expect(toolCalled(chunk, "web-scraping")).toBe(true);
      expect(text(response)).toMatch(/FIXTURE-WEB-MARKER/);
    },
  },
  {
    id: "web-browsing",
    attachName: "web-browsing",
    toolName: "web-browsing",
    prompt: "You must call web-browsing now to search for the official Node.js website URL. Return a result URL.",
    assertB: async (_ctx, chunk, response) => {
      expect(toolCalled(chunk, "web-browsing")).toBe(true);
      expect(text(response)).toContain("http");
    },
  },
  {
    id: "sql-agent",
    attachName: "sql-agent",
    toolNames: ["sql-list-databases", "sql-list-tables", "sql-get-table-schema", "sql-query"],
    prompt: "Using your SQL tools, find how many rows are in the customers table of database alpha_db. Reply with just the number.",
    assertB: async (_ctx, chunk, response) => {
      expect(toolCalledAny(chunk, ["sql-list-databases", "sql-list-tables", "sql-get-table-schema", "sql-query"])).toBe(true);
      expect(text(response)).toContain("3");
    },
  },
  {
    id: "create-chart",
    attachName: "create-chart",
    toolName: "create-chart",
    prompt: "Create a bar chart of these values: a=1,b=2,c=3.",
    assertB: async (_ctx, chunk, response) => {
      expect(toolCalled(chunk, "create-chart")).toBe(true);
      expect(JSON.stringify(response.body)).toMatch(/rechart|Rendering (?:a )?bar chart|"type":"bar"/i);
    },
  },
  {
    id: "generate-image",
    attachName: "generate-image",
    toolName: "generate-image",
    prompt: "Generate an image of a red circle.",
    skipB: true,
  },
  {
    id: "filesystem-agent",
    attachName: "filesystem-agent",
    toolName: "filesystem-write-text-file",
    prompt: "Create a text file named alpha-note.txt containing the word hello using your filesystem tool.",
    before: async (ctx) => files(path.join(ctx.storage, "anythingllm-fs"), /alpha-note\.txt/).length,
    sideEffectAbsent: async (ctx) => expect(files(path.join(ctx.storage, "anythingllm-fs"), /alpha-note\.txt/)).toHaveLength(ctx.before),
    assertB: async (ctx, chunk) => {
      expect(toolCalled(chunk, "filesystem-write-text-file")).toBe(true);
      expect(files(path.join(ctx.storage, "anythingllm-fs"), /alpha-note\.txt/)).toHaveLength(1);
    },
  },
  {
    id: "create-files-agent",
    attachName: "create-files-agent",
    toolName: "create-text-file",
    prompt: "You must call create-text-file now with filename note, extension txt, and content hello world.",
    before: async (ctx) => files(path.join(ctx.storage, "generated-files"), /^text-.*\.txt$/).length,
    sideEffectAbsent: async (ctx) => expect(files(path.join(ctx.storage, "generated-files"), /^text-.*\.txt$/)).toHaveLength(ctx.before),
    assertB: async (ctx, chunk) => {
      expect(toolCalled(chunk, "create-text-file")).toBe(true);
      expect(files(path.join(ctx.storage, "generated-files"), /^text-.*\.txt$/)).toHaveLength(ctx.before + 1);
    },
  },
  {
    id: "create-scheduled-job",
    attachName: "create-scheduled-job",
    toolName: "create-scheduled-job",
    prompt: "You must call create-scheduled-job now with name Daily hello, prompt say hello, schedule 0 9 * * *, and tools an empty array.",
    before: async (ctx) => (await scheduledJobs(ctx.base)).length,
    sideEffectAbsent: async (ctx) => expect(await scheduledJobs(ctx.base)).toHaveLength(ctx.before),
    assertB: async (ctx, chunk) => {
      expect(toolCalled(chunk, "create-scheduled-job")).toBe(true);
      expect(await scheduledJobs(ctx.base)).toHaveLength(ctx.before + 1);
    },
  },
  {
    id: "gmail",
    attachName: "gmail-agent",
    toolName: "gmail-get-inbox",
    prompt: "Check my Gmail inbox.",
    skipB: true,
  },
  {
    id: "google-calendar",
    attachName: "google-calendar-agent",
    toolName: "gcal-list-calendars",
    prompt: "List my Google calendars.",
    skipB: true,
  },
  {
    id: "outlook",
    attachName: "outlook-agent",
    toolName: "outlook-get-inbox",
    prompt: "Check my Outlook inbox.",
    skipB: true,
  },
];

module.exports = { SKILLS };
