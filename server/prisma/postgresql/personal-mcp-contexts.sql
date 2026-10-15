-- Narrow durable privacy boundary; independent additive PG migration.
BEGIN;
CREATE TABLE "personal_mcp_contexts" (
 "id" SERIAL PRIMARY KEY,
 "workspace_id" INTEGER NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "thread_key" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "personal_mcp_contexts_workspace_id_user_id_thread_key_key" ON "personal_mcp_contexts"("workspace_id","user_id","thread_key");
COMMIT;
