# Spec: Workspace-scoped MCP + per-workspace OAuth (FlowAccount first)

วันที่: 2026-09-06 · สถานะ: รออนุมัติ · ผู้ตัดสิน: เจ้าของโปรเจกต์ (ผ่านการถาม-ตอบในเซสชันนี้)

## เป้าหมาย

1. เปิด/ปิด MCP server ให้ใช้ได้ **เฉพาะ workspace ที่เลือก** (ปัจจุบัน global ทั้ง instance)
2. Remote MCP ที่ป้องกันด้วย OAuth ต้อง auth **แยกต่อ workspace** — use case แรกคือ
   FlowAccount AI Connector (`https://mcp.flowaccount.com/mcp`) โดย 1 workspace = 1 บริษัท FlowAccount

## สถานะปัจจุบัน (พิสูจน์จากโค้ด + probe จริง)

- MCP config เป็นไฟล์ JSON เดียวทั้ง instance (`server/storage/plugins/anythingllm_mcp_servers.json`)
  — เพิ่ม server ต้องแก้ไฟล์เอง, endpoints ที่มี (list/toggle/delete/toggle-tool) เป็น admin-only
  (`server/endpoints/mcpServers.js`)
- **Global 100%** — `WORKSPACE_AGENT.getDefinition()` ใส่ทุก MCP server ที่บูตได้เข้า functions
  โดยไม่ดู workspace (`server/utils/agents/defaults.js:93`); ephemeral agent สร้าง list ซ้ำแยก
  (`server/utils/agents/ephemeral.js:421-426`); `GET /mcp-servers/list` ถูกเรียกจากหน้าแชทของทุก
  workspace ทำให้ user เห็นชื่อ server ทั้ง instance (UI leak)
- FlowAccount MCP ตรวจสอบแล้วด้วยการยิงจริง: OAuth 2.1 มาตรฐาน (PKCE S256, grant
  `authorization_code` + `refresh_token` เท่านั้น, **ไม่มี `client_credentials`** → ไม่มี token static,
  มี dynamic client registration + `offline_access`) — ข้อจำกัดทางการ 1 connection = 1 บริษัท
- MCP hypervisor เป็น singleton process pool (`server/utils/MCP/hypervisor/index.js:36`) —
  header/auth ติดที่ process เดียว จึงแชร์ credential ข้าม workspace ไม่ได้

## การตัดสินใจที่อนุมัติ

| # | การตัดสิน | ทางเลือกที่ปัดทิ้ง |
|---|---|---|
| 1 | Enable แบบ allowlist ต่อ workspace (บน global config เดิม) กรองที่จุดโหลด tools | Workspace เป็นเจ้าของ MCP เองทั้งชุด (= phase 3 ของ spec 2026-09-05 — ยังไม่ทำตอนนี้) |
| 2 | OAuth-protected remote server: **auth แยกต่อ workspace บังคับ** — hypervisor key process เป็น `<workspaceId>:<serverName>` เฉพาะ server กลุ่มนี้ | Token static ใช้ร่วม (ไม่มีทางเป็นจริง — probe พิสูจน์แล้ว), paste refresh token เอง |
| 3 | OAuth flow **ในแอป**: ปุ่ม Connect ใน workspace settings → popup login FlowAccount + เลือกบริษัท → เก็บ access/refresh token ต่อ workspace, refresh อัตโนมัติ | ทำ OAuth นอกแอป |
| 4 | ทำบน branch แยก คู่ขนานกับ phase 1 (workspace agent settings) | รอ phase 1 เสร็จ |

## ดีไซน์

### Data (schema ใหม่ — ต้องผ่าน migration)

Prisma model `workspace_mcp_connections`:

- `id`, `workspace_id` (FK workspaces, cascade), `server_name`
- `enabled` (bool) — allowlist สำหรับ server ทุกชนิด
- `access_token`, `refresh_token`, `expires_at` — null ได้ (server ที่ไม่ใช่ OAuth ใช้แค่ enabled)
- `company_label` (ชื่อบริษัท FlowAccount ที่ผูก ไว้โชว์ใน UI), timestamps
- unique `(workspace_id, server_name)`

Tokens เก็บตรง DB ตามฝึกฝนเดิมของ repo (เช่นตาราง `api_keys`) — เสี่ยง at-rest ที่รับไว้ชั่วคราว
(จดเป็น follow-up: encrypt at rest)

### การ mark server ที่ต้อง auth ต่อ workspace

ใน `anythingllm_mcp_servers.json` เพิ่ม flag ต่อ server: `anythingllm.perWorkspaceAuth: true`
(explicit config ไม่ auto-detect) — server ที่ไม่ใส่ flag ยังเป็น global process เดิม แค่ถูกกรองด้วย allowlist

### Runtime filtering (จุดแก้ 6 จุด — ปิดทั้งทางเดินปกติและทาง API)

1. `defaults.js:93` — ส่ง `workspace` เข้า `activeMCPServers(workspace)` กรองด้วย allowlist
2. `ephemeral.js:421-426` — ใช้ผลเดียวกัน (แก้คู่กัน ไม่งั้นรั่วทาง API chat)
3. `agents/index.js:651` + `ephemeral.js:334` — ตอน attach `@@mcp_` เช็ค allowlist ซ้ำ (defense in depth)
4. `#toggleAgentTool` (`agents/index.js:729`) — บล็อค toggle ของ server ที่ workspace ไม่ได้ enable
5. `GET /mcp-servers/list` — คืนเฉพาะ server ที่ workspace นั้น enable (แก้ UI leak)
6. Hypervisor: server ที่ `perWorkspaceAuth` บูตเป็น process แยก key `<workspaceId>:<name>`
   ฉีด `Authorization: Bearer <access_token>` ต่อ workspace, refresh ก่อนหมดอายุ/เมื่อเจอ 401,
   หยุด process เมื่อ disconnect — server อื่นคง singleton เดิม

### OAuth flow ในแอป

- ครั้งแรกของ instance: dynamic client registration กับ `registration_endpoint` ของ server
  (redirect URI = `<baseUrl>/api/mcp/oauth/callback`) เก็บ `client_id` ไว้ที่ `system_settings`
- เริ่ม flow: `GET /api/mcp/oauth/start/:workspaceSlug/:serverName` (admin เท่านั้น) → 302 ไป
  authorization_endpoint พร้อม PKCE + state ผูก workspace+user (CSRF) หมดอายุสั้น
- callback: แลก code → token, เก็บลง `workspace_mcp_connections`, redirect กลับหน้า settings
- refresh: ฝั่ง server ใช้ `refresh_token` (scope `offline_access`) ก่อน expires_at หรือเมื่อ 401
- Disconnect: ลบ token + หยุด process (revoke ถ้า server มี endpoint)

### API ใหม่ทั้งหมด (admin workspace เท่านั้น)

- `GET /api/workspace/:slug/mcp` — list + สถานะ (enabled, connected, company, expiry)
- `POST /api/workspace/:slug/mcp/toggle` — enable/disable (server ไม่มี auth ใช้ข้อเดียว)
- `GET /api/mcp/oauth/start/...` + `GET /api/mcp/oauth/callback` — ตามข้างบน
- `POST /api/workspace/:slug/mcp/disconnect`

### UI (มี mockup แยก — ขั้น 1.5)

Workspace Settings → Agent Configuration เพิ่ม section "MCP Connectors":
การ์ดต่อ server — enable toggle, สถานะ connection, ปุ่ม Connect/Disconnect, error/expiry state

## Security ที่ต้องมี (ห้ามตัด)

- state ของ OAuth ผูก workspace+user + หมดอายุ; callback validate ก่อนแลก code
- ไม่ log token; error ไม่สะท้อน token
- callback + oauth/start + disconnect: admin-only (ระวัง `flexUserRoleValid` bypass ใน
  single-user mode — ใช้ middleware ให้ตรงพฤติกรรมเดิมของ endpoints MCP ที่มีอยู่)
- tokens อยู่ DB ที่เดียว ไม่ลงไฟล์/log

## ไม่ทำในรอบนี้ (non-goals)

- Workspace เป็นเจ้าของ MCP server เอง (เพิ่ม/แก้ config ต่อ workspace) — คงเป็น phase 3 ของ
  spec 2026-09-05
- stdio server ต่อ workspace, custom skills/flows ต่อ workspace
- หลายบริษัท FlowAccount ต่อ workspace (ข้อจำกัด vendor: 1 connection = 1 บริษัท)
- Encrypt token at rest (follow-up ถัดไป)

## เกณฑ์เสร็จ (ร่าง evidence contract)

- Workspace A enable FlowAccount, Workspace B ไม่ enable → agent ของ A เรียก tool ได้,
  agent ของ B ไม่เห็น tool (ทั้ง chat ปกติและ API/ephemeral)
- Connect OAuth จริงผ่าน UI → อ่านข้อมูล FlowAccount ได้จาก agent ใน workspace นั้น
- Token หมดอายุ → refresh เองสำเร็จ (ไม่ต้อง user กดอะไร)
- `GET /mcp-servers/list` จาก session ใน workspace B ไม่เห็น server ที่ B ไม่ enable
