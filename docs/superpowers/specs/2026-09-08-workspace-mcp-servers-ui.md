# Spec: เพิ่ม/แก้/ทดสอบ MCP server ต่อ workspace จากหน้าเว็บ (ไม่ต้องแก้ไฟล์)

วันที่: 2026-09-08 · สถานะ: รออนุมัติ mockup · ผู้ตัดสิน: เจ้าของโปรเจกต์ (ถาม-ตอบในเซสชันนี้)

## เป้าหมาย

Admin เพิ่ม MCP server ให้ workspace ได้จาก Workspace Settings › Agent Configuration โดยไม่ต้องแก้
`anythingllm_mcp_servers.json` และทดสอบได้ก่อน/หลัง save: (1) connect + list tools (2) เรียก tool จริง
พร้อม args แล้วดูผลลัพธ์ดิบ

## สถานะปัจจุบัน (พิสูจน์จากโค้ด)

- Config ทั้ง instance อยู่ไฟล์เดียว `storage/plugins/anythingllm_mcp_servers.json`
  (`server/utils/MCP/hypervisor/index.js:254-296`) — API มีแค่ list/toggle/delete/toggle-tool/force-reload
  (`server/endpoints/mcpServers.js`) **ไม่มี create/update** ทั้ง global และ workspace
- UI Admin › Agents › MCP Servers อ่านอย่างเดียว + start/stop/delete; ข้อความบอกให้ "add it back manually"
  (`frontend/src/pages/Admin/Agents/MCPServers/ServerPanel.jsx:19`)
- Workspace มี allowlist + OAuth ต่อห้องแล้ว (issue #25, ตาราง `workspace_mcp_connections`) แต่ catalog
  ยังมาจากไฟล์ global เท่านั้น; empty state ใน McpConnectors บอกให้ไป Admin › Agents
  (`frontend/src/pages/WorkspaceSettings/AgentConfig/McpConnectors/index.jsx:157-172`)
- Hypervisor มี key `<workspaceId>:<name>` + `bootWorkspaceServer` อยู่แล้ว แต่รับเฉพาะ server ที่
  `anythingllm.perWorkspaceAuth === true` (`hypervisor/index.js:130-134`)
- ไม่มี endpoint ทดสอบ/เรียก tool นอก agent loop

## การตัดสินใจที่อนุมัติ (2026-09-08)

| # | การตัดสิน | ทางเลือกที่ปัดทิ้ง | ราคาที่รับ |
|---|---|---|---|
| 1 | Config **ต่อ workspace** (phase 3 ของ spec 2026-09-05) | Admin global อย่างเดียว | schema ใหม่ + Opus review |
| 2 | เก็บใน **DB table ใหม่** config เข้ารหัสด้วย `EncryptionManager` | ไฟล์ต่อ workspace | hypervisor อ่าน config 2 แหล่ง (ไฟล์ global + DB) |
| 3 | Catalog global **คงไว้** + workspace-owned เพิ่มทับ | ย้ายทั้งหมดเป็นต่อ workspace | 2 ระบบคู่กัน UI ต้องบอกชัดว่าอันไหน shared/อันไหนของห้อง |
| 4 | **Admin เท่านั้น** เพิ่ม/แก้/ลบ/ทดสอบ; manager อ่าน (mask) | Admin + manager ของห้อง | manager ต้องขอ admin |
| 5 | **HTTP/SSE เท่านั้น** (url + headers + OAuth) ไม่รับ stdio ต่อ workspace | รองรับ stdio | server ที่ต้องรัน local ยังต้องแก้ไฟล์ global |
| 6 | กรอกได้ 2 แบบ: **ฟอร์ม** และ **paste JSON** (ก้อน `mcpServers` ที่ vendor แจก) | ฟอร์มอย่างเดียว / JSON อย่างเดียว | 2 โหมดต้อง sync กัน |
| 7 | ทดสอบ = **Test connection (ก่อน save ได้)** + **เรียก tool จริง** (หลัง save) | Test connection อย่างเดียว | เรียก tool จาก web มี side effect ได้ — UI เตือน |
| 8 | Secret ใน headers **mask ตอนอ่านกลับ** แก้ทับได้ | แสดงเต็ม | update ต้อง merge ค่าเดิมฝั่ง server |

## ดีไซน์

### Data (schema ใหม่ — migration)

Prisma model `workspace_mcp_servers`:

- `id`, `workspace_id` (FK workspaces, cascade), `name` (string, `^[a-z0-9][a-z0-9_-]{1,63}$`)
- `config` (string — JSON ของ server definition เข้ารหัสทั้งก้อนด้วย `EncryptionManager`, รูปแบบเดียวกับ
  `SystemSettings` ใช้กับ credential ที่ `server/models/systemSettings.js:136`)
- `createdAt`, `lastUpdatedAt`; unique `(workspace_id, name)`

สถานะ enabled / token OAuth **ไม่เพิ่มคอลัมน์** — ใช้ `workspace_mcp_connections` เดิม (key
`server_name` = `name`) ทั้ง allowlist และ token จึงเป็นระบบเดียวกับ catalog global

ลบ server → ลบ row `workspace_mcp_connections` ของชื่อนั้นในห้องนั้นด้วย (ไม่ทิ้ง token กำพร้า)

### รูปแบบ config ที่รับ (validate ฝั่ง server ก่อน encrypt ทุกครั้ง)

```json
{
  "url": "https://…",                       // บังคับ; http/https เท่านั้น; ผ่าน httpUrl() ของ utils/MCP/oauth.js (บล็อก IP literal, loopback นอก development)
  "type": "sse" | "http" | "streamable",     // optional; ไม่ใส่ = sse ตาม createHttpTransport
  "headers": { "Authorization": "Bearer …" }, // optional; string→string; ≤ 20 คีย์; รวม ≤ 4 KB
  "anythingllm": {
    "perWorkspaceAuth": true|false,           // true = ใช้ OAuth flow เดิมของ #25 (ปุ่ม Connect)
    "suppressedTools": ["…"]                  // optional
  }
}
```

- มี `command` / `args` / `env` → 400 `stdio_not_supported` (ตัดสิน #5)
- คีย์นอกรายการข้างบน → 400 `unknown_field` (ไม่ silently drop เพราะ user paste JSON แล้วคาดว่ามีผล)
- ชื่อซ้ำกับ server global ในไฟล์ → 409 `name_conflict` (ชื่อ tool ของ agent เป็น `<server>-<tool>` ชนกันไม่ได้)
  ถ้าไฟล์ global เพิ่มชื่อซ้ำทีหลัง: **ของห้องชนะ** เฉพาะห้องนั้น + log warning (Ruling บันทึกใน ledger)
- Paste JSON รับได้ทั้ง `{ "mcpServers": { "<name>": {…} } }` (1 ตัวขึ้นไป — สร้างทีละตัว ตัวที่ผิดรายงานแยก)
  และ definition เดี่ยว `{ "url": … }` + ช่องชื่อ

### Masking (ตัดสิน #8)

- API ที่คืน config แทนค่า header ที่ **ชื่อคีย์** match `/token|key|secret|password|authorization|cookie/i`
  ด้วย sentinel `"••••••••"` (คงชื่อคีย์ + 4 ตัวท้ายไม่แสดง — mask เต็ม)
- Update ส่ง sentinel กลับมา = คงค่าเดิม; ส่งค่าอื่น = ทับ; ไม่ส่งคีย์ = ลบ
- ค่าจริงไม่ออกจาก server ทาง API/log/error ใดๆ

### Hypervisor (`server/utils/MCP/hypervisor/index.js`, `MCP/index.js`)

- เพิ่ม `workspaceServerConfigs(workspaceId)` อ่าน DB → decrypt → `{name, server}[]` (decrypt ล้มเหลว = ข้าม + log
  ชื่อ server อย่างเดียว)
- `findServerConfig(name, workspace)` = workspace-owned ก่อน แล้วค่อย global; ทุกจุดที่ `mcpServerConfigs.find(name)`
  ในทาง agent (`activeMCPServers`, `convertServerToolsToPlugins`, handler, `callWorkspaceTool`,
  `connectWorkspaceServer`, `mcpOAuth.js target()`) เปลี่ยนมาใช้ตัวนี้
- Workspace-owned ทุกตัวบูตด้วย key `<workspaceId>:<name>` ผ่าน `bootWorkspaceServer` (แยก process/client
  ต่อห้องเหมือน OAuth เดิม) — ตัวที่ **ไม่** perWorkspaceAuth ใช้ headers ตาม config ตรงๆ ไม่ต้องมี token
- Update/Delete → `stopWorkspaceServer(wsId, name)` ทันที; boot ใหม่ตอน agent เรียกครั้งถัดไป (hot reload ไม่ต้อง
  restart)
- `activeMCPServers(workspace)` รวม workspace-owned ที่ enabled ใน allowlist
- `GET /mcp-servers/list?workspaceSlug=` คืน workspace-owned ด้วย (มี field `owner: "workspace"|"global"`)

### API ใหม่ (ทั้งหมด `validatedRequest` + `flexUserRoleValid([ROLES.admin])` เว้นที่ระบุ)

| method | path | body / ผล |
|---|---|---|
| GET | `/workspace/:slug/mcp-servers` | admin + manager (สมาชิกห้อง) → `{servers:[{name, owner, config(masked), enabled, connected…}]}` |
| POST | `/workspace/:slug/mcp-servers` | `{name, config}` หรือ `{mcpServers:{…}}` → 201 `{created:[…], errors:[{name, error}]}` |
| PUT | `/workspace/:slug/mcp-servers/:name` | `{config}` (sentinel merge) → 200 |
| DELETE | `/workspace/:slug/mcp-servers/:name` | → 200; ลบ connection row + stop client |
| POST | `/workspace/:slug/mcp-servers/test` | `{config}` (ยังไม่ save) **หรือ** `{name}` (saved) → `{success, tools:[{name,description,inputSchema}], latencyMs, error}` — client ชั่วคราว timeout 15 s ปิดทิ้งเสมอ ไม่แตะ client ที่ agent ใช้อยู่; saved + perWorkspaceAuth ใช้ token ของห้อง |
| POST | `/workspace/:slug/mcp-servers/:name/call` | `{toolName, arguments}` → `{success, result(string ≤ 64 KB ตัดพร้อม flag truncated), latencyMs, error}` ผ่าน `callWorkspaceTool` (ได้ refresh/401 handling เดิม) |

- `:slug` + `:name` validate เหมือน endpoints เดิม (string ไม่ว่าง; name ตาม regex)
- error message ฝั่ง API ไม่สะท้อน header/token/URL ที่มี credential (ใช้รหัสคงที่ + ข้อความจาก MCP SDK ที่กรองแล้ว)
- `/test` ด้วย `{config}` ต้องผ่าน validator เดียวกับ create (กัน SSRF ผ่านช่อง test)
- rate: 1 test/call ต่อ (ห้อง, server) พร้อมกัน — ซ้อนกัน → 409 `busy`

### UI — Workspace Settings › Agent Configuration › MCP Connectors (มี mockup ขั้น 1.5)

การ์ดเดิมคงไว้ เพิ่ม:

1. หัว section: ปุ่ม **Add MCP server** (admin) → modal
   - แท็บ **Form**: name, URL, transport (SSE/Streamable HTTP), headers (key/value แถว + ปุ่มเพิ่ม, ค่าที่ชื่อเข้าข่าย
     secret แสดงเป็น password field), toggle "Requires OAuth per workspace", suppressed tools (หลัง test)
   - แท็บ **JSON**: textarea paste ก้อน `mcpServers` ของ vendor; validate ตอนพิมพ์ (syntax + field ที่รู้จัก +
     stdio → error ชี้บรรทัด); กด "Use in form" กลับไปแท็บ Form (sync สองทาง)
   - ปุ่ม **Test connection** (ก่อน save ได้): states — idle / testing (spinner + cancel) / ok (n tools, latency,
     รายชื่อ tool พับได้) / error (รหัส + ข้อความสั้น + "Details" พับ)
   - ปุ่ม **Save** (disabled จนกว่า form valid; ไม่บังคับ test ผ่าน แต่ถ้ายังไม่ test แสดง warning)
2. การ์ด server: chip `Workspace-owned` / `Shared globally`; workspace-owned มีเมนู **Edit · Test · Delete**
   - Edit เปิด modal เดิม prefill (headers secret เป็น `••••••••`; พิมพ์ทับได้; ปุ่ม "clear")
   - Delete → confirm ระบุว่าจะลบ token/allowlist ของห้องด้วย
3. แผง **Test tools** (ต่อ server ที่ save แล้ว; global ที่ enabled ก็ใช้ได้): เลือก tool → ฟอร์ม args สร้างจาก
   `inputSchema` (string/number/boolean/enum; object/array = JSON textarea; required ติด *) → **Run** →
   ผลลัพธ์ดิบใน `<pre>` + latency + ปุ่ม copy; error state; banner เตือน "tool อาจเขียนข้อมูลจริงที่ปลายทาง"
4. Empty state ใหม่: "No MCP servers yet — Add MCP server หรือเปิดจาก shared catalog"
5. Manager: เห็นทุกอย่างอ่านอย่างเดียว (config mask) ไม่มีปุ่ม Add/Edit/Test/Run

Admin › Agents › MCP Servers (global) **ไม่แตะ** ในรอบนี้

### Security ที่ต้องมี (ห้ามตัด)

- URL ผ่าน `httpUrl()` เดิม (บล็อก IP literal / loopback นอก development); DNS-rebinding ยังเป็น follow-up #25-3
- config เข้ารหัสที่ DB; ไม่ log config ดิบ; response mask; error ไม่รั่ว header
- `/test`, `/call`, create/update/delete: admin เท่านั้น (ระวัง `flexUserRoleValid` single-user bypass — posture
  เดิมของ MCP endpoints, จดไว้ไม่แก้ #25-11)
- `/call` ใช้ `WorkspaceMcpConnection.isAllowed` + boot ของห้องนั้น — เรียก server ของห้องอื่นไม่ได้แม้เป็น admin
  (ต้องผ่าน `:slug` ที่ตรง)
- client ชั่วคราวของ `/test` ปิดใน `finally` เสมอ (กัน socket ค้าง)

## ไม่ทำในรอบนี้ (non-goals)

- stdio ต่อ workspace (ตัดสิน #5)
- แก้ไข/เพิ่ม server global จาก UI (Admin › Agents ยังอ่านไฟล์)
- ย้าย catalog global เป็นต่อ workspace / legacy import (spec 09-05 phase 3 ส่วนที่เหลือ)
- Manager เพิ่ม server เอง
- retry บน network error ของ `callWorkspaceTool` (#37)
- Encrypt token OAuth ที่ `workspace_mcp_connections` (#25-2) — คนละคอลัมน์ ไม่ปนกัน

## เกณฑ์เสร็จ (ร่าง evidence contract)

- Jest: `server/__tests__/endpoints/workspaceMcpServers.test.js` — create (form + mcpServers paste + stdio 400 +
  name_conflict 409 + unknown_field 400) / list mask / update sentinel merge / delete ลบ connection / test ผ่าน
  mock MCP (helper `server/__tests__/e2e/mcp/helpers/mockMcp.js` มีอยู่แล้ว) / call ผ่าน + truncated / manager 403
  บน mutate / ห้อง B เรียก server ของห้อง A ไม่ได้
- Jest hypervisor: workspace-owned non-OAuth บูต key `<ws>:<name>` ด้วย headers จาก config; update → client เดิมถูกปิด;
  global ชื่อซ้ำถูก shadow เฉพาะห้องนั้น
- Headed Playwright (`@edge` ≥ 1): add ผ่านฟอร์ม → test → save → run tool → ผลลัพธ์แสดง; paste JSON ที่มี
  `command` → error ชี้ชัด (`@edge`); edit เห็น mask + save โดยไม่แตะ secret แล้ว test ยังผ่าน
- dev2 (manual): เพิ่ม FlowAccount เป็น workspace-owned ในห้องทดสอบ → Connect OAuth → run `get_company`
