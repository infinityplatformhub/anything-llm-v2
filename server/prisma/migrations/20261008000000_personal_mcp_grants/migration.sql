-- New empty table only. Never import workspace/global credentials.
CREATE TABLE "personal_mcp_grants" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "workspace_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "server_name" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "refresh_until" DATETIME,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "tokens" TEXT,
  "expires_at" DATETIME,
  "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "personal_mcp_grants_workspace_id_user_id_server_name_key" ON "personal_mcp_grants"("workspace_id", "user_id", "server_name");
CREATE INDEX "personal_mcp_grants_workspace_id_server_name_idx" ON "personal_mcp_grants"("workspace_id", "server_name");
