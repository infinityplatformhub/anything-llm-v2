-- Preserve already-deployed live tables; no personal-MCP feature deployment.
CREATE TABLE "personal_mcp_grants" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "server_name" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "refresh_until" TIMESTAMPTZ(3),
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "tokens" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "lastUpdatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "personal_mcp_grants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "personal_mcp_contexts" (
    "id" SERIAL NOT NULL,
    "workspace_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "thread_key" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "personal_mcp_contexts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "personal_mcp_grants_workspace_id_server_name_idx" ON "personal_mcp_grants"("workspace_id", "server_name");
CREATE UNIQUE INDEX "personal_mcp_grants_workspace_id_user_id_server_name_key" ON "personal_mcp_grants"("workspace_id", "user_id", "server_name");
CREATE UNIQUE INDEX "personal_mcp_contexts_workspace_id_user_id_thread_key_key" ON "personal_mcp_contexts"("workspace_id", "user_id", "thread_key");
ALTER TABLE "personal_mcp_grants" ADD CONSTRAINT "personal_mcp_grants_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "personal_mcp_grants" ADD CONSTRAINT "personal_mcp_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "personal_mcp_contexts" ADD CONSTRAINT "personal_mcp_contexts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "personal_mcp_contexts" ADD CONSTRAINT "personal_mcp_contexts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
