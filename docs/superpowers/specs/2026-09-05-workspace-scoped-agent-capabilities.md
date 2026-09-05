# Workspace-scoped agent capabilities

วันที่ 2026-09-05 · สถานะ: รอคนอนุมัติ

## ตัดสินใจแล้ว (จากคำตอบผู้ใช้)

| ข้อ | คำตอบ |
|---|---|
| รูปแบบ | **แบบ ข** — แต่ละ workspace เป็นเจ้าของ Custom Skills / Agent Flows / MCP Servers ของตัวเอง สร้างในห้องไหนเห็นแค่ห้องนั้น ไม่มี catalog กลาง |
| ค่าเริ่มต้น | **deny by default** — workspace ใหม่และ workspace เดิมหลัง migrate ไม่มีอะไรเปิดจนกว่า admin จะเปิด |
| ใครแก้ | **admin เท่านั้น** manager แก้ได้แค่ agentProvider/agentModel เหมือนเดิม |
| config built-in | **แยกราย workspace รวม credential** (SQL connection, web search key, image-gen, ฯลฯ) |
| ขอบเขต | **รวม** scheduled jobs และ Gmail / Calendar / Outlook |
| UI | ให้ AI ตัดสินใจ — หน้า Admin › Agents เพิ่ม workspace selector ด้านบน ทุกอย่างในหน้าเป็นของ workspace ที่เลือก |

## สภาพปัจจุบัน

ทุกอย่างเป็น global จุดรวมเดียวคือ `server/utils/agents/defaults.js:86-95` (`WORKSPACE_AGENT.getDefinition`) รวม
built-in + `ImportedPlugin.activeImportedPlugins()` + `AgentFlows.activeFlowPlugins()` + `MCPCompatibilityLayer.activeMCPServers()`
แล้ว `#loadAgents` (`server/utils/agents/index.js:750-770`) โหลดทั้งก้อน `workspace` ถูกส่งเข้ามาแต่ไม่ได้ใช้กรอง

| ของ | เก็บที่ | ใครโหลด |
|---|---|---|
| built-in on/off | `system_settings` `default_agent_skills` / `disabled_agent_skills` | `defaults.js:125-193` |
| SQL connections | `system_settings` `agent_sql_connections` (มี credential ใน connectionString ไม่เข้ารหัส) | `sql-agent/SQLConnectors/index.js:46-54` |
| web search | provider ใน `system_settings` `agent_search_provider`, key ใน `.env` (`AGENT_*_API_KEY`) | `web-browsing.js:66-71`, `updateENV.js:588-651` |
| image gen | `.env` ทั้งหมด (`IMAGE_GEN_*`) | `systemSettings.js:502-516` |
| Gmail / Calendar / Outlook | `system_settings` `gmail_agent_config` / `google_calendar_agent_config` / `outlook_agent_config` **ปิดตัวเองใน multi-user mode** | `gmail/lib.js:263-287`, `outlook/lib.js:547-568` |
| custom skills | `storage/plugins/agent-skills/<hubId>/` | `imported.js:35-43,66-80` |
| flows | `storage/plugins/agent-flows/<uuid>.json` | `agentFlows/index.js:17-20,185-193` |
| MCP | `storage/plugins/anythingllm_mcp_servers.json` | `MCP/hypervisor/index.js:64-78`, `MCP/index.js:12-20` |
| scheduled jobs | ตาราง `scheduled_jobs` ไม่มี workspaceId รันจาก prompt ล้วน | `schema.prisma:403-429`, `jobs/run-scheduled-job.js:61-74` |

ทางเข้า agent ที่ต้องครอบ: chat ปกติ และ API chat (`apiChatHandler.js:181-208, 557-585` ส่ง workspace มาแล้ว)
Embed chat ไม่รัน agent ไม่ต้องแตะ

## ออกแบบ

### หลักการเดียว

**ทุก capability ผูกกับ `workspaceId` ตั้งแต่ตอนเก็บ** ไม่ใช่ global แล้วค่อยกรอง
`getDefinition(provider, workspace, …)` เปลี่ยนให้ทุก source รับ `workspace.id` และคืนเฉพาะของห้องนั้น
นี่คือ choke point เดียว ครอบทั้ง chat ปกติและ API chat โดยอัตโนมัติ

### Storage ใหม่

ตาราง Prisma ใหม่ `workspace_agent_settings` (1:1 กับ workspaces, สร้างเมื่อเรียกครั้งแรก)

```
id, workspaceId (unique, FK cascade),
enabled_skills      Json  // ["rag-memory","sql-agent",…] deny by default = []
skill_configs       Json  // { "sql-agent": {connections:[…]}, "web-browsing": {provider, apiKey}, "image-generation": {...}, "gmail": {...}, "outlook": {...} }
createdAt, updatedAt
```

`skill_configs` เข้ารหัสทั้งก้อนด้วย `EncryptionManager` (`server/utils/EncryptionManager/index.js`) ก่อนเขียน DB
เพราะมี credential ของหลายทีมปนกันในตารางเดียว ต่างจากตอนนี้ที่เก็บ plain

ไฟล์บนดิสก์ย้ายเป็นราย workspace:

```
storage/plugins/workspaces/<workspaceId>/agent-skills/<hubId>/
storage/plugins/workspaces/<workspaceId>/agent-flows/<uuid>.json
storage/plugins/workspaces/<workspaceId>/mcp_servers.json
```

`scheduled_jobs` เพิ่มคอลัมน์ `workspaceId` (FK cascade, NOT NULL หลัง migrate)

### MCP process

MCP hypervisor ตอนนี้เป็น singleton รัน process ตาม config เดียว เปลี่ยนเป็น
key ด้วย `<workspaceId>:<serverName>` แต่ละห้องรัน process ของตัวเอง แม้ config เหมือนกัน
เพราะ "เด็ดขาด" หมายถึง credential ของห้อง A ไม่อยู่ใน process ที่ห้อง B เรียกได้
ราคา: memory เพิ่มตามจำนวนห้อง × server ยอมรับ

### Migration (ทำครั้งเดียว ย้อนไม่ได้)

deny by default หมายถึง**ห้องเดิมทุกห้อง agent ใบ้ทันทีหลัง deploy** จนกว่า admin จะเปิด
migration ทำแค่:

1. ย้ายไฟล์ global เดิมไป `storage/plugins/_legacy/` ไม่ลบ ไม่ assign ให้ห้องไหน
2. `scheduled_jobs` ที่มีอยู่ ถูกปิด (`enabled=false`) และ `workspaceId = null` จนกว่า admin จะย้ายเข้าห้อง
3. system_settings เดิม (`default_agent_skills`, `agent_sql_connections`, …) คงไว้ ไม่อ่านอีก
4. หน้า Admin › Agents แสดง banner "มีของเดิม N รายการใน legacy กด import เข้า workspace นี้" ให้ admin ย้ายทีละห้อง

### Gmail / Calendar / Outlook

ตอนนี้ปิดใน multi-user mode อยู่แล้ว การแยกราย workspace ทำให้เปิดใน multi-user ได้
เพราะ config อยู่ที่ workspace ไม่ใช่ global เอา guard นั้นออก
Outlook OAuth callback ต้อง carry `workspaceId` ใน state param

### web search / image-gen key

ย้ายจาก `.env` ไป `skill_configs` ของ workspace ค่าใน `.env` เดิม**ยังใช้เป็น fallback ไม่ได้**
(deny by default) admin กรอกใหม่ต่อห้อง หน้า settings แสดงค่าจาก `.env` เดิมเป็น placeholder ให้ copy ได้

### API + สิทธิ์

ทุก endpoint เดิมเพิ่ม `:workspaceSlug` นำหน้า admin-only ทั้งหมด (`flexUserRoleValid([ROLES.admin])`)

```
/admin/workspace/:slug/agent-skills            GET/POST   enabled + configs
/admin/workspace/:slug/agent-plugins/…         (ย้ายจาก /experimental/agent-plugins)
/admin/workspace/:slug/agent-flows/…
/admin/workspace/:slug/mcp-servers/…
/admin/workspace/:slug/scheduled-jobs/…
/admin/legacy-agent-assets                     GET        list + import-to-workspace
```

endpoint เดิมทั้งหมดถอดออก ไม่ alias เพราะ alias คือทางที่ global รั่วกลับมา
`agentSkillWhitelist` (user เห็น approval ต่อ skill) คงเป็นราย user เหมือนเดิม แต่ตรวจซ้อนกับ enabled ของห้อง

### UI

หน้า `/settings/agents` เดิม เพิ่ม **workspace selector** เป็นแถบบนสุด ทุก panel ด้านล่างเป็นของห้องที่เลือก
ไม่มีมุมมอง global อีก ห้องที่ยังไม่เคยตั้งค่าแสดง empty state "ห้องนี้ยังไม่เปิด skill ใด"
มี banner legacy import ถ้ายังมีของค้างใน `_legacy`
หน้า WorkspaceSettings › Agent Configuration (manager) คงเดิม ปุ่ม "Configure Agent Skills" ลิงก์ไปหน้า admin พร้อม `?workspace=<slug>`

## แบ่ง phase (แต่ละ phase = 1 issue, ship แยกได้)

| # | phase | แตะ | ความเสี่ยง |
|---|---|---|---|
| 1 | schema + `getDefinition` กรองราย workspace + built-in on/off + admin API + UI selector | schema, defaults.js, admin endpoints, Admin/Agents | **auth/schema → Opus review** |
| 2 | custom skills + flows ย้าย storage ราย workspace + legacy import | imported.js, agentFlows, endpoints | migration |
| 3 | MCP ราย workspace + hypervisor keyed by workspace | MCP/*, endpoints | process lifecycle |
| 4 | built-in configs + credential เข้ารหัส (SQL, web search, image-gen) | systemSettings, plugins, EncryptionManager | **ความลับ → Opus review** |
| 5 | scheduled jobs ผูก workspace | schema, jobs/* | migration |
| 6 | Gmail / Calendar / Outlook ราย workspace เปิดใน multi-user | plugins/gmail, google-calendar, outlook | OAuth state |

## นอกขอบเขต

- แชร์ capability ข้ามห้อง (template / copy) — ไม่ทำ ถ้าอยากได้ทีหลังคือ feature ใหม่
- Embed chat — ไม่รัน agent อยู่แล้ว
- ย้ายค่า `.env` อัตโนมัติเข้าห้อง — ขัด deny by default

## Evidence contract (ต่อ phase 1)

```
cd server && npx vitest run utils/agents/__tests__/workspaceScoping.test.js
```

คาดว่าเจอ: `workspace A cannot see skills/flows/mcp enabled for workspace B` ผ่าน และ
`new workspace has zero enabled capabilities` ผ่าน

## คำถามที่ต้องตอบก่อนเปิด issue

ไม่มี ทุกข้อตัดสินแล้ว รอแค่ยืนยัน mockup (ขั้น 1.5)

## Phase 7 — E2E ทุก function (เพิ่ม 2026-09-05 ตามคำสั่งผู้ใช้)

หลัง phase 1-6 merge ครบ เปิด issue แยกสำหรับ E2E test ที่รันกับ server + frontend จริง (ไม่ mock) ครอบทุก capability:

- built-in skills: เปิด/ปิดราย workspace, deny by default, ห้อง A ไม่เห็นของห้อง B, alias/unknown id ถูกตัด
- custom skills / flows / MCP: สร้างในห้อง A → ห้อง B ไม่เห็น, legacy import ย้ายเข้าห้องเดียว, MCP process แยกต่อห้อง
- credential ราย workspace: SQL / web search / image-gen ใช้ค่าห้องตัวเอง, ไม่มี fallback global, เข้ารหัสใน DB
- scheduled jobs: ผูก workspaceId, รันด้วย capability ของห้องนั้นเท่านั้น
- Gmail / Calendar / Outlook: ทำงานใน multi-user mode ด้วย config ของห้อง
- API chat (`/v1/workspace/:slug/chat`) และ chat ปกติเห็น tool ชุดเดียวกับที่ UI เปิด
- สิทธิ์: manager/default แตะ endpoint admin ไม่ได้ทุกตัว
- UI: Admin › Agents สลับ workspace, save, cancel, load-failure state, legacy banner (ต้องมี Playwright ใน repo — เพิ่มใน phase นี้)

Evidence contract ของ phase 7 = ชุด E2E นี้เขียวทั้งชุดบน CI
