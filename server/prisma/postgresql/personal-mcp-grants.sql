-- Standalone additive PostgreSQL migration. Do NOT replay SQLite migrations.
-- Apply through the production operator's existing PG migration process after backup.
BEGIN;
CREATE TABLE "personal_mcp_grants" (
  "id" SERIAL PRIMARY KEY,
  "workspace_id" INTEGER NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "server_name" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "refresh_until" TIMESTAMP(3),
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "tokens" TEXT,
  "expires_at" TIMESTAMP(3),
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "personal_mcp_grants_workspace_id_user_id_server_name_key" ON "personal_mcp_grants"("workspace_id", "user_id", "server_name");
CREATE INDEX "personal_mcp_grants_workspace_id_server_name_idx" ON "personal_mcp_grants"("workspace_id", "server_name");
COMMIT;
