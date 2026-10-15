CREATE TABLE "personal_mcp_contexts" (
 "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
 "workspace_id" INTEGER NOT NULL,
 "user_id" INTEGER NOT NULL,
 "thread_key" INTEGER NOT NULL DEFAULT 0,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "personal_mcp_contexts_workspace_id_user_id_thread_key_key" ON "personal_mcp_contexts"("workspace_id","user_id","thread_key");
