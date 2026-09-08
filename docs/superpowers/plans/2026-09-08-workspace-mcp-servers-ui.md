# Workspace-owned MCP servers from the web UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin เพิ่ม/แก้/ลบ MCP server (HTTP/SSE) ให้ workspace ได้จาก Workspace Settings › Agent Configuration โดยไม่แก้ไฟล์ และทดสอบได้ 2 ระดับ: connect + list tools (ก่อน/หลัง save) และเรียก tool จริงพร้อม args

**Architecture:** ตารางใหม่ `workspace_mcp_servers` เก็บ server definition เป็น JSON เข้ารหัสทั้งก้อนด้วย `EncryptionManager` (คอลัมน์ `config`). สถานะ enabled/token ยังอยู่ `workspace_mcp_connections` เดิม. Hypervisor ได้ `findServerConfig(name, workspace)` ที่หา workspace-owned ก่อนแล้วค่อย global file; workspace-owned ทุกตัวบูตด้วย key `<workspaceId>:<name>` ผ่าน `bootWorkspaceServer` (ตัวที่ไม่ OAuth ใช้ headers จาก config ตรงๆ). Endpoints ใหม่ `/workspace/:slug/mcp-servers` (list/create/update/delete/test/call). Frontend ต่อยอด `McpConnectors` ตาม mockup.

**Tech Stack:** Node/Express, Prisma (SQLite dev / Postgres prod), Jest, React + Vite + Tailwind, Playwright.

**Issue:** #51 · **Spec:** `docs/superpowers/specs/2026-09-08-workspace-mcp-servers-ui.md` · **Mockup:** `docs/superpowers/mockups/workspace-mcp-servers.html` @ commit `ee5e29c6`

**Evidence contract:** `cd server && node ../node_modules/jest/bin/jest.js __tests__/endpoints/workspaceMcpServers.test.js __tests__/utils/MCP/workspaceOwnedServers.test.js --silent` → `PASS __tests__/endpoints/workspaceMcpServers.test.js`

**Ledger:** `.superpowers/sdd/workspace-mcp-servers-ui/ledger.md` — ทุก ruling จด `Ruling: <what> — <why> — <cost if wrong>`

**Repo quirks (ใส่ในทุก brief):**
- jest: `cd server && node ../node_modules/jest/bin/jest.js <path>` (ห้าม npx). ถ้า import chain ดึง `jsonwebtoken` ให้ `require("../utils/lark/_polyfill")` บรรทัดแรกของเทส (Node 26 ไม่มี SlowBuffer)
- git ใน worktree ใช้ `/usr/bin/git`; eslint ใช้ `node node_modules/eslint/bin/eslint.js <paths>` จาก `frontend/` หรือ `server/`
- node_modules เป็น symlink ไป main checkout → **ห้ามรัน `prisma generate` / `prisma migrate dev`** (เขียนทับ client ของทุก checkout) เขียน `migration.sql` เองตาม pattern `20260906000000_workspace_mcp_connections` และเทสให้ mock `utils/prisma`
- endpoint tests ใช้ pattern ใน `server/__tests__/endpoints/workspaceMcpList.test.js` (fake app จับ route, รัน role middleware จริง, mock models)
- hypervisor tests ใช้ pattern ใน `server/__tests__/utils/MCP/workspaceHypervisor.test.js` (mock SDK Client/transports, `Hypervisor._instance = undefined` ใน beforeEach)
- follow-ups ของ #25 ที่ห้ามทำให้แย่ลง: `MCPHypervisor` singleton order (`singletonOrder.test.js`), `httpUrl()` ใน `utils/MCP/oauth.js` เป็นตัวกัน SSRF ตัวเดียว

---

## File map

| Path | Action | Responsibility |
|---|---|---|
| `server/prisma/schema.prisma` | modify | model `workspace_mcp_servers` + relation บน `workspaces` |
| `server/prisma/migrations/20260908000000_workspace_mcp_servers/migration.sql` | create (มือ) | additive DDL + unique index |
| `server/models/workspaceMcpServer.js` | create | CRUD ต่อ workspace, encrypt/decrypt config, `listDecrypted(workspaceId)` |
| `server/utils/MCP/serverConfig.js` | create | `validateWorkspaceServerConfig(config)` (whitelist field, stdio reject, `httpUrl`), `maskConfig(config)`, `mergeMaskedConfig(existing, incoming)`, `parseMcpServersBlock(body)` |
| `server/utils/MCP/hypervisor/index.js` | modify | `findServerConfig(name, workspace)`, `workspaceServerConfigs(workspaceId)`, `connectWorkspaceServer` รองรับ non-OAuth workspace-owned, `probeServerConfig(config)` (client ชั่วคราว list tools + close) |
| `server/utils/MCP/index.js` | modify | `activeMCPServers`, `convertServerToolsToPlugins`, handler ใช้ `findServerConfig`; `servers()` ไม่แตะ |
| `server/endpoints/mcpServers.js` | modify | `/mcp-servers/list?workspaceSlug=` รวม workspace-owned (`owner` field) |
| `server/endpoints/workspaceMcpServers.js` | create | list/create/update/delete/test/call |
| `server/endpoints/mcpOAuth.js` | modify | `target()` ใช้ `findServerConfig` ให้ workspace-owned OAuth server ใช้ flow เดิมได้ |
| `server/index.js` | modify | ลงทะเบียน `workspaceMcpServersEndpoints(apiRouter)` |
| `frontend/src/models/workspaceMcp.js` | modify | `servers/create/update/remove/test/call` |
| `frontend/src/pages/WorkspaceSettings/AgentConfig/McpConnectors/index.jsx` | modify | ปุ่ม Add, chip owner, เมนู Edit/Test/Delete, empty state ใหม่ |
| `frontend/src/pages/WorkspaceSettings/AgentConfig/McpConnectors/ServerModal.jsx` | create | ฟอร์ม + JSON tab + test connection + save |
| `frontend/src/pages/WorkspaceSettings/AgentConfig/McpConnectors/ToolTester.jsx` | create | เลือก tool → args form จาก inputSchema → call → raw result |
| `e2e/ui/workspace-mcp-servers.spec.ts` + `e2e/scripts/run-mcp-servers-ui.sh` | create | headed Playwright ต่อยอด harness `e2e/scripts/mcp-ui.cjs` |
| `server/__tests__/models/workspaceMcpServer.test.js`, `server/__tests__/utils/MCP/serverConfig.test.js`, `server/__tests__/utils/MCP/workspaceOwnedServers.test.js`, `server/__tests__/endpoints/workspaceMcpServers.test.js` | create | RED→GREEN ต่อ task |

---

## Task 1 — schema + model + config validator/masking

**Files:** `server/prisma/schema.prisma`, `server/prisma/migrations/20260908000000_workspace_mcp_servers/migration.sql`, `server/models/workspaceMcpServer.js`, `server/utils/MCP/serverConfig.js`, tests `server/__tests__/models/workspaceMcpServer.test.js`, `server/__tests__/utils/MCP/serverConfig.test.js`

- [x] **RED:** `serverConfig.test.js` — validate: ok กับ `{url,type,headers,anythingllm}`; `command`/`args`/`env` → throw `stdio_not_supported`; unknown key → `unknown_field:<key>`; headers เกิน 20 คีย์หรือรวม > 4 KB → `headers_too_large`; ค่าไม่ใช่ string → `invalid_headers`; `type` นอก sse/http/streamable → `invalid_type`; url ผ่าน `httpUrl()` จาก `utils/MCP/oauth.js` (private IP → throw); ชื่อไม่ตรง `^[a-z0-9][a-z0-9_-]{1,63}$` → `invalid_name`. mask: คีย์ที่ match `/token|key|secret|password|authorization|cookie/i` → `"••••••••"`; merge: sentinel = คงเดิม, ค่าใหม่ = ทับ, คีย์หาย = ลบ. parse: รับ `{mcpServers:{a:{},b:{}}}` → `[{name,config}]` และ `{name, config}` เดี่ยว
- [x] **RED:** `workspaceMcpServer.test.js` — mock `utils/prisma` + `EncryptionManager` (key/salt คงที่); `create` เข้ารหัสก่อนเขียน (ค่าใน `data.config` ต้องไม่มี url ดิบ), `listDecrypted` คืน config ถอดแล้ว, decrypt ล้มเหลว → ข้าม + log ชื่ออย่างเดียว, `delete` ลบ `workspace_mcp_connections` ของชื่อนั้นในห้องนั้นด้วย (ใน `$transaction`)
- [x] **GREEN:** schema + migration.sql (SQLite syntax ตาม migration เดิม; FK cascade; unique `(workspace_id, name)`), model, serverConfig
- [x] รัน 2 เทส + `singletonOrder.test.js` ยังผ่าน; eslint clean
- [x] commit `feat(mcp): workspace_mcp_servers schema, model and config validator (#51)`

## Task 2 — hypervisor dual-source + workspace-owned boot + probe

**Files:** `server/utils/MCP/hypervisor/index.js`, `server/utils/MCP/index.js`, `server/endpoints/mcpOAuth.js` (`target()` เท่านั้น), test `server/__tests__/utils/MCP/workspaceOwnedServers.test.js`

- [x] **RED:** workspace-owned non-OAuth `{url, headers:{Authorization:"Bearer x"}}` → `activeMCPServers(workspace)` บูต key `7:erp` ด้วย transport ที่ได้ headers จาก config (ไม่ต้องมี token ใน connection แต่ต้อง `enabled`); ชื่อซ้ำ global → workspace-owned ชนะเฉพาะห้องนั้น + log warning หนึ่งครั้ง; `stopWorkspaceServer` หลัง update ปิด client เดิม; `probeServerConfig(config)` คืน `{tools, latencyMs}` แล้ว `close()` เสมอแม้ listTools throw; timeout 15 s (fake timers); ห้อง B ไม่เห็น server ของห้อง A ใน `activeMCPServers`; `convertServerToolsToPlugins` + handler resolve config ผ่าน `findServerConfig` (ห้อง B เรียก tool ของห้อง A → "not enabled for this workspace")
- [x] **GREEN:** `findServerConfig`, `workspaceServerConfigs` (อ่านผ่าน `WorkspaceMcpServer.listDecrypted`), แก้ `connectWorkspaceServer` ให้แยก branch OAuth/non-OAuth, `probeServerConfig`, `mcpOAuth.js target()`
- [x] เทสเดิมทั้ง `__tests__/utils/MCP/*` + `workspaceMcpGating.test.js` + endpoint tests เดิมยังผ่าน — focused + requested regressions: 7 suites / 164 tests; `index.test.js` / `hypervisor.test.js` Node 26 load failures excluded per brief. Required Task 2 eslint clean.
- [x] commit `feat(mcp): hypervisor resolves workspace-owned servers and probes configs (#51)` — `a9b71b6d`; includes mock-only updates in four regression fixtures and allowlist-gated `callServerTool` per ledger rulings.

## Task 3 — endpoints

**Files:** `server/endpoints/workspaceMcpServers.js`, `server/endpoints/mcpServers.js` (list เท่านั้น), `server/index.js`, test `server/__tests__/endpoints/workspaceMcpServers.test.js`

- [x] **RED:** ตาม spec ตาราง API: GET list admin+manager(สมาชิก) masked; POST create form + `mcpServers` block (ตัวผิดรายงานแยก, 201), stdio 400, unknown_field 400, ชื่อชน global 409 `name_conflict`, ชื่อชน workspace-owned 409; PUT sentinel merge + `stopWorkspaceServer` ถูกเรียก; DELETE ลบ + stop; POST test ด้วย `{config}` ผ่าน validator (private IP → 400) และด้วย `{name}` saved; POST `:name/call` ผ่าน `callWorkspaceTool`, ผลลัพธ์ string ตัด 64 KB + `truncated:true`, ห้อง B → 404; manager ทุก mutate → 403/401 ตาม middleware; ซ้อน test/call เดียวกัน → 409 `busy`; error body ไม่มีค่า header
- [x] **RED:** `/mcp-servers/list?workspaceSlug=` คืน workspace-owned พร้อม `owner:"workspace"` และ global `owner:"global"` (เพิ่มเคสใน `workspaceMcpList.test.js`)
- [x] **GREEN** + register router — focused 70/70; regression 230/230 across 9 suites with Node 26 `_polyfill` via `--setupFilesAfterEnv`; unshimmed run: 221 pass, 2 legacy suites fail to load; eslint clean.
- [x] commit `feat(mcp): workspace MCP server endpoints with test and tool call (#51)` — `d10a7576`

## Task 4 — frontend per mockup

**Files:** `frontend/src/models/workspaceMcp.js`, `McpConnectors/index.jsx`, `McpConnectors/ServerModal.jsx`, `McpConnectors/ToolTester.jsx`

- [x] ต่อยอด component เดิม (ไม่เขียนใหม่): ปุ่ม `+ Add MCP server` (admin), chip `Workspace-owned`/`Shared globally`, เมนู ⚙ Edit/Test tools/Delete บน workspace-owned, ปุ่ม Test tools บน global ที่ enabled, empty state ใหม่, confirm delete ระบุลบ token/allowlist
- [x] `ServerModal`: tabs Form/JSON ตาม mockup (validation ฝั่ง client เหมือน mockup; ฝั่ง server เป็น source of truth), headers secret → `type=password`, edit prefilled mask + clear, Test connection (states idle/testing/ok/error พร้อม cancel ผ่าน AbortController), Save (disabled จน valid; warning ถ้ายังไม่ test)
- [x] `ToolTester`: arg form จาก `inputSchema` (string/number/boolean/enum; object/array → JSON textarea; required *), Run → `<pre>` result + latency + copy, error state, banner เตือน
- [x] ใช้ `Toggle`/`showToast`/class เดิมของ repo; i18n key ใน `frontend/src/locales/en/common.js` (ภาษาอื่นตกไป default ตามกลไก repo); `node node_modules/eslint/bin/eslint.js src/pages/WorkspaceSettings/AgentConfig src/models/workspaceMcp.js` clean; `yarn build` ผ่าน — `Done in 35.21s.`; frontend validation/API assert checks passed. Headed UI coverage remains Task 5.
- [x] commit `feat(mcp-ui): add, edit, test and call workspace MCP servers from Agent Configuration (#51)` — `49c06f76`

## Task 5 — headed E2E

**Files:** `e2e/ui/workspace-mcp-servers.spec.ts`, `e2e/scripts/run-mcp-servers-ui.sh` (+ `mcp-ui.cjs` ถ้าต้องเพิ่ม tool ใน fake server)

- [x] harness: real server + fake MCP (HTTP, Bearer header ตรวจค่าคงที่) ตาม `e2e/scripts/mcp-ui.cjs` — isolated temp Prisma client; shared dependencies unchanged; original OAuth self-checks retained.
- [x] cases: (1) admin add via form → test ok → save → card shows Workspace-owned → run `get_company` → result visible; (2) `@edge` paste JSON with `command`/`args`/`env` → inline stdio error, save disabled; (3) `@edge` edit: secret shows mask, save without touching → test still ok (server merged old value); (4) manager sees read-only cards with config reduced to `{anythingllm}`, no headers/URL/buttons per Task 3 contract and ledger ruling; (5) delete → card gone + catalog/allowlist GET no longer list it; (6) `@edge` invalid object JSON rejected, valid `create_invoice` object reaches fake MCP.
- [x] `npx playwright test -c e2e/mcp-servers-ui.playwright.config.ts --headed --reporter=json` ทุกเคสเขียว, ≥1 `@edge` ผ่าน — runner sets `PLAYWRIGHT_JSON_OUTPUT_FILE=.infi/e2e-report.json`; full unfiltered headed run passed, no failures/skips/flakes. Browser caught owned-toggle bug fixed separately in `9743cf1a` with unchanged assertion.
- [x] commit `test(e2e): headed coverage for workspace MCP server management (#51)` — `8891e682`

## Close-out (PMO)

- [ ] Opus security review (schema + secrets + SSRF ผ่านช่อง test/call + role gating)
- [ ] `task.sh check --issue 51 --base e5bee011` → `task.sh close`
- [ ] `infi-lessons` → PR `feat/workspace-mcp-servers-ui` → master
