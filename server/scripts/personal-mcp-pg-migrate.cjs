#!/usr/bin/env node
// Explicit additive PG-only job. Connection supplied privately, never logged.
require("dotenv").config({
  path: process.env.NODE_ENV === "development" ? ".env.development" : ".env",
});
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
async function migrate() {
  if (
    process.env.PERSONAL_MCP_PG_MIGRATION_APPROVED !== "true" ||
    !process.env.DATABASE_URL
  )
    throw new Error("approval required");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT current_database()");
    for (const file of [
      "personal-mcp-grants.sql",
      "personal-mcp-contexts.sql",
    ]) {
      const sql = fs
        .readFileSync(
          path.join(__dirname, "../prisma/postgresql", file),
          "utf8"
        )
        .replace(/^BEGIN;|^COMMIT;/gm, "");
      await client.query(sql);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}
migrate()
  .then(() => console.log("PERSONAL_MCP_PG_ADDITIVE_MIGRATION_OK"))
  .catch(() => {
    console.error("PERSONAL_MCP_PG_ADDITIVE_MIGRATION_FAILED");
    process.exitCode = 1;
  });
