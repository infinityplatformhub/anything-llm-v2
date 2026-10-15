const { it, expect } = require("@jest/globals");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

it("standalone new-table migration works on PostgreSQL without SQLite history", async () => {
  const url = process.env.PERSONAL_MCP_TEST_PG_URL;
  if (!url)
    throw new Error(
      "Set PERSONAL_MCP_TEST_PG_URL to the dedicated disposable PG database"
    );
  const parsed = new URL(url);
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "55471" ||
    parsed.pathname !== "/anythingllm_mcp_oauth_test"
  )
    throw new Error("Refusing non-fixture PG destination");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA personal_client_migration_verify");
    await client.query(
      "SET LOCAL search_path TO personal_client_migration_verify"
    );
    // Independent baseline fixture, not another worker\'s tables or migration history.
    await client.query(
      "CREATE TABLE users (id SERIAL PRIMARY KEY); CREATE TABLE workspaces (id SERIAL PRIMARY KEY);"
    );
    const sql = fs
      .readFileSync(
        path.resolve(
          __dirname,
          "../../../prisma/postgresql/personal-mcp-grants.sql"
        ),
        "utf8"
      )
      .replace(/^BEGIN;|^COMMIT;/gm, "");
    expect(sql).not.toMatch(/AUTOINCREMENT|PRAGMA|INSERT.*SELECT/i);
    await client.query(sql);
    const contextSql = fs
      .readFileSync(
        path.resolve(
          __dirname,
          "../../../prisma/postgresql/personal-mcp-contexts.sql"
        ),
        "utf8"
      )
      .replace(/^BEGIN;|^COMMIT;/gm, "");
    await client.query(contextSql);
    await client.query(
      "INSERT INTO users DEFAULT VALUES; INSERT INTO users DEFAULT VALUES; INSERT INTO workspaces DEFAULT VALUES;"
    );
    await client.query(
      "INSERT INTO personal_mcp_grants (workspace_id,user_id,server_name,fingerprint,tokens) VALUES (1,1,'medusa','fp','cipher-a'),(1,2,'medusa','fp','cipher-b')"
    );
    await client.query(
      "INSERT INTO personal_mcp_contexts(workspace_id,user_id,thread_key) VALUES (1,1,0)"
    );
    expect(
      (await client.query("SELECT thread_key FROM personal_mcp_contexts"))
        .rows[0].thread_key
    ).toBe(0);
    const first = await client.query(
      "UPDATE personal_mcp_grants SET version=version+1, tokens=NULL WHERE workspace_id=1 AND user_id=1 AND server_name='medusa' AND version=1"
    );
    const stale = await client.query(
      "UPDATE personal_mcp_grants SET tokens='stale' WHERE workspace_id=1 AND user_id=1 AND server_name='medusa' AND version=1"
    );
    expect(first.rowCount).toBe(1);
    expect(stale.rowCount).toBe(0);
    expect(
      (
        await client.query(
          "SELECT tokens FROM personal_mcp_grants WHERE user_id=2"
        )
      ).rows[0].tokens
    ).toBe("cipher-b");
    await client.query("DELETE FROM users WHERE id=1");
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM personal_mcp_grants"
        )
      ).rows[0].count
    ).toBe(1);
    await client.query("DELETE FROM workspaces WHERE id=1");
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM personal_mcp_grants"
        )
      ).rows[0].count
    ).toBe(0);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
