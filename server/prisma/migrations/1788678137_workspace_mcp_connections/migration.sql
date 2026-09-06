-- CreateTable
CREATE TABLE "workspace_mcp_connections" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "workspace_id" INTEGER NOT NULL,
    "server_name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "expires_at" DATETIME,
    "company_label" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_mcp_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "workspace_mcp_connections_workspace_id_server_name_key" ON "workspace_mcp_connections"("workspace_id", "server_name");
