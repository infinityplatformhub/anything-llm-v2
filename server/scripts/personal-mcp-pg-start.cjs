#!/usr/bin/env node
// Release startup only. Does not generate or run migration history.
require("dotenv").config({
  path: process.env.NODE_ENV === "development" ? ".env.development" : ".env",
});
const { PrismaClient } = require("@prisma/client");
async function start() {
  const effectiveUrl =
    process.env.ANYTHINGLLM_DATABASE_URL || process.env.DATABASE_URL;
  if (!effectiveUrl || !/^postgres(?:ql)?:\/\//.test(effectiveUrl))
    throw new Error("PostgreSQL datasource required");
  const prisma = new PrismaClient({
    datasources: { db: { url: effectiveUrl } },
  });
  try {
    const provider = await prisma.$queryRawUnsafe(
      "SELECT current_database() AS name"
    );
    if (!provider[0]?.name) throw new Error("PostgreSQL preflight failed");
    await prisma.personal_mcp_grants.count();
    await prisma.personal_mcp_contexts.count();
  } finally {
    await prisma.$disconnect();
  }
  require("../index.js");
}
start().catch(() => {
  console.error("PERSONAL_MCP_PG_START_PREFLIGHT_FAILED");
  process.exitCode = 1;
});
