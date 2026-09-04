-- CreateTable
CREATE TABLE "lark_identities" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "open_id" TEXT NOT NULL,
    "union_id" TEXT,
    "tenant_key" TEXT NOT NULL,
    "email" TEXT,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "access_expires_at" DATETIME NOT NULL,
    "refresh_expires_at" DATETIME NOT NULL,
    "scopes" TEXT NOT NULL,
    "needs_reauth" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lark_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "lark_oauth_states" (
    "state" TEXT NOT NULL PRIMARY KEY,
    "code_verifier" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "user_id" INTEGER,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "lark_identities_user_id_key" ON "lark_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "lark_identities_open_id_key" ON "lark_identities"("open_id");
