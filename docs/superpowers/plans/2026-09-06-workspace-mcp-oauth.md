# Workspace-scoped MCP + per-workspace OAuth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP servers เปิดให้ใช้ต่อ workspace (deny by default) และ remote MCP ที่ป้องกันด้วย OAuth (use case แรก: FlowAccount `https://mcp.flowaccount.com/mcp`) เชื่อมด้วยบัญชีต่อ workspace ผ่าน OAuth 2.1 + PKCE ในแอป โดย token เก็บต่อ workspace และ refresh อัตโนมัติ

**Architecture:** ตารางใหม่ `workspace_mcp_connections` (unique `workspace_id+server_name`, มี token columns ทำ nullable) เป็นทั้ง allowlist และที่เก็บ credential การกรองเกิดที่ 6 จุดตาม spec (โหลด tools ×2, attach ×2, toggle ×1, list ×1). Server ที่ config ใส่ `anythingllm.perWorkspaceAuth: true` จะถูก hypervisor บูตเป็น process แยก key `<workspaceId>:<serverName>` พร้อมฉีด `Authorization: Bearer` จาก token ของ workspace นั้น — server อื่นคง singleton เดิม. OAuth ใช้ dynamic client registration + PKCE (state เซ็นด้วย HMAC จาก crypto stdlib ไม่ใช้ jsonwebtoken).

**Tech Stack:** Node/Express, Prisma (SQLite), Jest, React + Vite.

**Issue:** #25 · **Spec:** `docs/superpowers/specs/2026-09-06-workspace-scoped-mcp-oauth.md` · **Mockup:** `docs/superpowers/mockups/workspace-mcp-connectors.html` @ `5e6adf67`

**Evidence contract:** `cd server && node ../node_modules/jest/bin/jest.js __tests__/utils/agents/workspaceMcpGating.test.js --silent` → `PASS …workspaceMcpGating`

**Ledger:** `.superpowers/sdd/workspace-mcp-oauth/ledger.md` — ทุก ruling จด `Ruling: <what> — <why> — <cost if wrong>`

**Repo quirks (ใส่ในทุก brief):**
- jest ต้องรัน `cd server && node ../node_modules/jest/bin/jest.js <path>` (ห้าม npx)
- ใน worktree session ใช้ `/usr/bin/git` และ `node node_modules/eslint/bin/eslint.js`
- node_modules เป็น symlink → Prisma client/DB ที่แตะจริงคือของ main checkout (`file:../storage/anythingllm.db` resolved จาก symlinked `.prisma`) — ห้ามรัน `prisma migrate dev` (interactive + จะแก้ shared DB แบบไม่ควบคุม) ให้สร้าง migration.sql เองและ apply ด้วย `prisma db execute`
- ห้าม import chain ที่ดึง `jsonwebtoken` ในเทสที่ไม่จำเป็น (Node 26 ไม่มี SlowBuffer — ถ้าต้องใช้ ให้ require `server/__tests__/utils/lark/_polyfill.js` ก่อน)

---

## File map

| Path | Action | Responsibility |
|---|---|---|
| `server/prisma/schema.prisma` | modify | เพิ่ม model `workspace_mcp_connections` + relation บน `workspaces` |
| `server/prisma/migrations/<ts>_workspace_mcp_connections/migration.sql` | create (มือ, ไม่ใช้ migrate dev) | additive DDL |
| `server/models/workspaceMcpConnection.js` | create | allowlist + token CRUD ต่อ workspace |
| `server/utils/MCP/index.js` | modify | `activeMCPServers(workspace)` กรองด้วย allowlist; ต่อ OAuth server ระบุ instance key |
| `server/utils/MCP/hypervisor/index.js` | modify | key `<wsId>:<name>` + ฉีด Authorization header เมื่อ `perWorkspaceAuth` |
| `server/utils/MCP/oauth.js` | create | discovery, dynamic registration, PKCE authorize URL, code exchange, refresh (fetch ล้วน + crypto HMAC state) |
| `server/utils/agents/defaults.js:93` | modify | ส่ง `workspace` เข้า `activeMCPServers` |
| `server/utils/agents/ephemeral.js:334,421-426` | modify | ใช้ list ที่กรองแล้ว + เช็คซ้ำตอน attach |
| `server/utils/agents/index.js:651,729-748` | modify | เช็คซ้ำตอน attach + บล็อค toggle server ที่ไม่ enable |
| `server/endpoints/mcpServers.js` | modify | `/mcp-servers/list` รับ `?workspaceSlug=` แล้วกรอง (ไม่มี param = คืนทั้งหมดสำหรับ admin เดิม) |
| `server/endpoints/mcpOAuth.js` | create | `GET /mcp/oauth/start/:workspaceSlug/:serverName` (302), `GET /mcp/oauth/callback`, `POST /mcp/oauth/disconnect` (ผ่าน workspace slug) |
| `server/index.js` | modify | ลงทะเบียน router ใหม่ |
| `server/__tests__/models/workspaceMcpConnection.test.js` | create | model unit tests |
| `server/__tests__/utils/agents/workspaceMcpGating.test.js` | create | **evidence contract** — gating ทุกทางเดิน |
| `server/__tests__/endpoints/mcpOAuth.test.js` | create | endpoint + state validation + fake OAuth server |
| `frontend/src/models/workspaceMcp.js` | create | API client ใหม่ |
| `frontend/src/pages/WorkspaceSettings/AgentConfig/index.jsx` | modify | แทรก section MCP Connectors (ตาม mockup) |
| `frontend/src/pages/WorkspaceSettings/AgentConfig/McpConnectors/index.jsx` (+ css) | create | การ์ด server, toggle, Connect/Disconnect, สถานะ |

---

### Task 1: Prisma model + migration

**Files:** Modify `server/prisma/schema.prisma`; create migration dir

- [ ] Append model (ท้ายไฟล์ schema) + relation `mcp_connections workspace_mcp_connections[]` ใน `model workspaces`:

```prisma
model workspace_mcp_connections {
  id            Int       @id @default(autoincrement())
  workspace_id  Int
  server_name   String
  enabled       Boolean   @default(false)
  access_token  String?
  refresh_token String?
  expires_at    DateTime?
  company_label String?
  createdAt     DateTime  @default(now())
  lastUpdatedAt DateTime  @default(now())
  workspace     workspaces @relation(fields: [workspace_id], references: [id], onDelete: Cascade, onUpdate: Cascade)

  @@unique([workspace_id, server_name])
}
```

- [ ] สร้าง `server/prisma/migrations/<unix-ts>_workspace_mcp_connections/migration.sql` เป็น additive DDL (CREATE TABLE + CREATE UNIQUE INDEX `workspace_mcp_connections_workspace_id_server_name_key`) ตามรูปแบบ migration ที่มีอยู่
- [ ] Apply ด้วย `cd server && node node_modules/prisma/build/index.js db execute --file prisma/migrations/<ts>_workspace_mcp_connections/migration.sql --schema prisma/schema.prisma` แล้ว `prisma generate` — **ห้าม** `migrate dev`
- [ ] **RED→GREEN:** `server/__tests__/models/workspaceMcpConnection.test.js` — สร้าง/อ่าน/unique constraint/cascade delete ตาม pattern ของ model test ที่มีอยู่ รัน: `cd server && node ../node_modules/jest/bin/jest.js __tests__/models/workspaceMcpConnection.test.js`

### Task 2: Allowlist model + `activeMCPServers(workspace)` + evidence gating tests

**Files:** Create `server/models/workspaceMcpConnection.js`; modify `server/utils/MCP/index.js`; create `server/__tests__/utils/agents/workspaceMcpGating.test.js`

- [ ] `workspaceMcpConnection.js`: `list(workspaceId)`, `enabledNames(workspaceId)`, `isAllowed(workspaceId, serverName)`, `setEnabled(workspaceId, serverName, bool)`, `saveTokens(workspaceId, serverName, {access_token, refresh_token, expires_at, company_label})`, `clearTokens(...)`, `find(workspaceId, serverName)`
- [ ] `MCPCompatibilityLayer.activeMCPServers(workspace)` — เมื่อ `workspace` ถูกส่งมา: ถาม allowlist ก่อน, คืนเฉพาะ server ที่ enable (server `perWorkspaceAuth` ต้องมี access_token ด้วยจึงถือว่าพร้อม); ไม่ส่ง workspace = พฤติกรรมเดิมทุกอย่าง (admin path). Mock `hypervisor.bootMCPServers` ในเทส ไม่บูต process จริง
- [ ] **RED→GREEN:** `workspaceMcpGating.test.js` (mock `server/models/workspaceMcpConnection` + `MCP/hypervisor`): 1) workspace ไม่มี row → ไม่เห็น MCP function ใด 2) enable `flowaccount` → เห็นเฉพาะ `@@mcp_flowaccount` 3) ephemeral path ได้ list เดียวกัน 4) attach `@@mcp_x` ที่ไม่ enable โดนบล็อค 5) toggle `@@mcp_x` ที่ไม่ enable โดนบล็อค. รันแล้วต้อง PASS ครบ — ไฟล์นี้คือ evidence contract

### Task 3: Wire choke points ที่เหลือ + list endpoint

**Files:** Modify `server/utils/agents/defaults.js`, `ephemeral.js`, `agents/index.js`, `server/endpoints/mcpServers.js`

- [ ] `defaults.js:93` → `...(await new MCPCompatibilityLayer().activeMCPServers(workspace))`
- [ ] `ephemeral.js` `#loadAgents` ใช้ `workspaceAgentDef.functions` เดียวกับ normal path (ตัดการสร้าง MCP list ซ้ำ) + จุด attach `:334` เช็ค `isAllowed` ก่อน `convertServerToolsToPlugins`
- [ ] `agents/index.js:651` attach ทำเช่นเดียวกัน; `#toggleAgentTool` บล็อค `@@mcp_<name>` ถ้า workspace ไม่ enable
- [ ] `/mcp-servers/list` รับ `?workspaceSlug=` → กรองตาม allowlist (ใช้ `Workspace.workspaceById(slug)` pattern เดิม); ไม่มี param คงคืนทั้งหมด
- [ ] **RED→GREEN:** ขยาย `workspaceMcpGating.test.js` (defaults/ephemeral/toggle) + `server/__tests__/endpoints/workspaceMcpList.test.js` — list มี/ไม่มี workspaceSlug, 403 ทาง admin path คงเดิม. รันทั้งสองไฟล์ผ่าน

### Task 4: OAuth client + endpoints (start/callback/disconnect)

**Files:** Create `server/utils/MCP/oauth.js`, `server/endpoints/mcpOAuth.js`; modify `server/index.js`

- [ ] `oauth.js` (fetch ล้วน, ไม่พึ่ง sdk):
  - `discover(serverUrl)` → อ่าน `/.well-known/oauth-protected-resource` → `/.well-known/oauth-authorization-server` (cache 5 นาที)
  - `ensureClient(serverUrl)` → dynamic registration ที่ `registration_endpoint` (redirect_uris = [origin ปัจจุบัน + `/api/mcp/oauth/callback`]) เก็บ `{serverUrl → client_id, redirect_uri}` ลง `system_settings` label `mcp_oauth_clients` (JSON); origin เปลี่ยน → register ใหม่
  - `authorizeUrl(...)` พร้อม PKCE S256 (crypto.randomBytes + S256 challenge) และ state = `base64url(payload).hmacSha256(JWT_SECRET)` payload `{wsSlug, serverName, userId, exp}` (exp 10 นาที)
  - `exchangeCode(...)`, `refreshTokens(refresh_token, serverUrl)` — ตาม RFC 6749
- [ ] Endpoints (middleware `validatedRequest` + `flexUserRoleValid([ROLES.admin])` ตาม endpoints เดิม):
  - `GET /mcp/oauth/start/:workspaceSlug/:serverName` → ตรวจ config มี server นี้ + `perWorkspaceAuth`; ตอบ 302 ไป authorizeUrl; บันทึก pending state (in-memory Map exp 10 นาที สำหรับ verifier)
  - `GET /mcp/oauth/callback?code&state` → ตรวจ HMAC + exp → exchange → `saveTokens` → 302 กลับ `/workspace/<slug>/settings/agent-config` พร้อม `?mcp=<serverName>&connected=1` (error → `&error=<code>`); callback **ห้าม** log token
  - `POST /mcp/oauth/disconnect` body `{workspaceSlug, serverName}` → `clearTokens` + hypervisor หยุด process `<wsId>:<name>`
- [ ] **RED→GREEN:** `server/__tests__/endpoints/mcpOAuth.test.js` — ยิงผ่าน fake app (pattern เดียวกับ endpoint test เดิมใน repo) + fake OAuth server (node http ในเทส): 1) start โดยไม่ login → 401/403 ตาม mode 2) start ถูกต้อง → 302 มี `code_challenge` + `state` 3) callback state ปลอม → reject 4) callback ถูกต้อง → token ลง DB (ดูผ่าน model, ไม่อ่าน log) 5) callback ไม่เซ็น header ใดกลับมาเป็น token. รัน: `cd server && node ../node_modules/jest/bin/jest.js __tests__/endpoints/mcpOAuth.test.js`

### Task 5: Hypervisor per-workspace process + auto refresh

**Files:** Modify `server/utils/MCP/hypervisor/index.js`, `server/utils/MCP/index.js`

- [ ] Config entry รองรับ `anythingllm.perWorkspaceAuth: true` — getter แยก list server ธรรมดา vs per-workspace
- [ ] `bootMCPServers(workspace, serverName)` สำหรับ per-workspace server: key `<workspaceId>:<serverName>`, transport remote เท่านั้น (stdio + perWorkspaceAuth → ปฏิเสธพร้อม error ชัด), headers `Authorization: Bearer <access_token>` จาก `workspaceMcpConnection.find`; ถ้า `expires_at` ใกล้หมด (< 60 วิ) เรียก `refreshTokens` ก่อนบูต; เจอ 401 จาก server → refresh 1 ครั้งแล้ว retry, ยัง 401 → mark connection expired (บันทึก `expires_at` ใหม่เป็น past, คืน error ที่ UI อ่านได้)
- [ ] `stopWorkspaceServer(workspaceId, serverName)` — ใช้โดย disconnect
- [ ] Singleton เดิมคงพฤติกรรมเดิมทุกอย่างเมื่อไม่มี per-workspace server
- [ ] **RED→GREEN:** `server/__tests__/utils/MCP/workspaceHypervisor.test.js` — mock transport: key ถูกต้อง, header มี token ล่าสุด, refresh เมื่อใกล้หมดอายุ, ไม่บูต stdio per-workspace. รันผ่าน

### Task 6: Frontend MCP Connectors (ตาม mockup)

**Files:** Create `frontend/src/models/workspaceMcp.js`, `frontend/src/pages/WorkspaceSettings/AgentConfig/McpConnectors/index.jsx`; modify `frontend/src/pages/WorkspaceSettings/AgentConfig/index.jsx`, `frontend/src/models/mcpServers.js`

- [ ] `workspaceMcp.js`: `list(slug)`, `toggle(slug, serverName, enabled)`, `disconnect(slug, serverName)` (start/callback เดินทาง redirect ตรง ไม่ผ่าน client)
- [ ] Section ใน AgentConfig ใต้ agent skills เดิม: การ์ดต่อ server จาก `GET /mcp-servers/list?workspaceSlug=<slug>` + สถานะจาก `workspaceMcp.list` — state: disconnected (ปุ่ม Connect), connected (บริษัท + expiry + Disconnect), error/expired (banner + Reconnect), loading (skeleton), empty (คำอธิบายไป Admin) — ตาม mockup `workspace-mcp-connectors.html` @ `5e6adf67`
- [ ] Connect = `window.location = /api/mcp/oauth/start/<slug>/<server>` (full page redirect); กลับมาพร้อม query → toast/สถานะตาม `connected`/`error`
- [ ] Toggle disable เมื่อยังไม่ connected (ตาม mockup) + คง visibility แบบ admin-only ของหน้า settings เดิม
- [ ] **Verify:** `cd frontend && node node_modules/eslint/bin/eslint.js src/pages/WorkspaceSettings/AgentConfig src/models/workspaceMcp.js` + `node node_modules/vite/bin/vite.js build` ผ่าน; ไม่มีเทส UI ใหม่ (ตามขอบเขต)

---

## ลำดับ dispatch

Task 1 → 2 → 3 → 4 → 5 → 6 (2 ต้องมี 1; 3 ต้องมี 2; 4 ต้องมี 1; 5 ต้องมี 2+4; 6 ต้องมี 3+4 endpoint shape) — ทำตามลำดับเดียว, Task 6 พรางไปคู่ขนานกับ 5 ได้เมื่อ 4 เสร็จ

**Definition of done ของแต่ละ task:** เทสใหม่ผ่าน (RED ก่อนเขียนโค้ด พิสูจน์ด้วยรันบนโค้ดเดิม), eslint ไฟล์ที่แตะผ่าน, ไม่มีไฟล์อื่นแตะเกิน File map (ถ้าจำเป็นต้องแตะเกิน → หยุดรายงาน PMO พร้อมเหตุผล)
