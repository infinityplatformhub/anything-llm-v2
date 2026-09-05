# Agent skills E2E suite (per-workspace isolation + security)

วันที่ 2026-09-05 · สถานะ: รอคนอนุมัติ (ผู้ใช้อนุมัติแนวทางแล้วผ่านคำถาม 4 ข้อ; รายละเอียดนี้ตัดสินโดย PMO)

## ตัดสินใจแล้ว (จากคำตอบผู้ใช้)

| ข้อ | คำตอบ |
|---|---|
| ขอบเขต | phase 1 ตอนนี้ แล้ว**ต่อยอด**ทุก phase ลง suite เดียวกัน (phase 7 ทำไปเรื่อย ๆ) |
| DB engines | Postgres + MySQL + MSSQL (ทุกตัวที่ `SQLConnectors` รองรับ) ผ่าน Docker |
| runner | jest ยิง HTTP ใส่ server จริง + Playwright เฉพาะหน้า Admin › Agents |
| ที่รัน | local เท่านั้น ไม่ขึ้น CI |
| LLM | gateway `https://aig.infinityplatform.tech/v1` model `aix-qwen3.8-flash-next` ผ่าน `LLM_PROVIDER=generic-openai` |
| ต้องพิสูจน์ | (1) ทุก skill **ทำงานได้จริง**เมื่อเปิด (2) **แยกกันจริง**ราย workspace (3) **security ไม่หลุดข้าม workspace** |

## หลักการ

1. **ไม่ mock LLM** ทุก case ที่ต้องให้ agent เรียก tool ยิง gateway จริง ผลที่ assert คือ**หลักฐานข้างเคียง** (ไฟล์ที่ถูกสร้าง, row ใน DB, tool-call log จาก server) ไม่ใช่ข้อความที่โมเดลพิมพ์ เพราะข้อความไม่ deterministic
2. **case ที่รันจริงไม่ได้ = skipped พร้อมเหตุผล ไม่ใช่เขียวปลอม** (Gmail/Calendar/Outlook ต้อง OAuth จริง; image-gen ถ้า gateway ไม่มี image endpoint)
3. **security case ต้องลองเจาะจริง** ไม่ใช่อ่านโค้ดแล้วบอกว่าปลอดภัย ทุก case เขียนเป็น "ยิง request ที่ควรถูกปฏิเสธ แล้ว assert ว่าถูกปฏิเสธ + ไม่มี side effect"
4. **ทุก case ต้องเคยแดง** ก่อนรับเข้า suite: อย่างน้อยหนึ่ง negative control ต่อกลุ่ม (เช่น ปิด filter ใน `defaults.js` ชั่วคราวแล้ว isolation suite ต้องแดง)

## โครงสร้าง

```
e2e/
  docker-compose.e2e.yml      # postgres, mysql, mssql(azure-sql-edge), anythingllm server
  seed/
    postgres.sql  mysql.sql  mssql.sql   # ตาราง customers คนละชุดต่อ DB, มี marker row ระบุ DB
  jest.e2e.config.cjs
  lib/
    api.js        # client: auth, workspaces, admin skills, /v1 chat, agent-invoke helper
    llm.js        # gateway health check (skip suite ถ้าไม่ตอบ)
    evidence.js   # อ่าน server log / storage dir / DB rows เป็นหลักฐาน
  suites/
    00-preflight.test.js
    10-skill-<name>.test.js   # หนึ่งไฟล์ต่อ built-in skill (13 ไฟล์)
    20-isolation.test.js      # cross-workspace matrix
    30-security.test.js       # role / route / smuggling / enumeration
  ui/
    admin-agents.spec.ts      # Playwright
package.json: "test:e2e", "test:e2e:ui", "e2e:up", "e2e:down"
```

รัน: `yarn e2e:up && yarn test:e2e` (server ใน compose ใช้ env จาก `e2e/.env.e2e` ที่ gitignore; key gateway อ่านจาก `AIG_API_KEY` env ของ shell ไม่ commit)

## Fixtures

- 3 workspaces: `ws-alpha`, `ws-beta`, `ws-gamma` (gamma = ห้องควบคุม ไม่เปิดอะไรเลยตลอด)
- แต่ละ suite reset `enabled_skills` ของทุกห้องเป็น `[]` ใน `beforeEach`
- documents: embed ไฟล์ text `alpha-secret.txt` ("ALPHA-TOKEN-7731") เข้า alpha, `beta-secret.txt` ("BETA-TOKEN-9942") เข้า beta
- SQL: postgres DB `alpha_db` (ตาราง `customers` 3 แถว marker `PG-ALPHA`), mysql `beta_db` (`MY-BETA`), mssql `gamma_db` (`MS-GAMMA`)
- filesystem/create-files: `STORAGE_DIR` ของ container ถูก mount ออกมาให้ jest อ่านได้

## Test matrix ต่อ skill (13 built-in)

รูปแบบเดียวกันทุก skill, 3 case บังคับ + case เฉพาะ:

| # | case | assert |
|---|---|---|
| A | **ปิด → เรียกไม่ได้** ห้อง alpha ไม่เปิด skill, `@agent` ขอให้ใช้ | server log ไม่มี `Attached <skill>`; ไม่มี side effect (ไฟล์/row/network mock) |
| B | **เปิด → ทำงานจริง** เปิดใน alpha, `@agent` ขอใช้ | side effect เกิดจริง (ดูตาราง) |
| C | **เปิดใน alpha ไม่ติดไป beta** เปิดใน alpha เท่านั้น, ยิง `@agent` ใน beta | beta log ไม่มี `Attached <skill>`, ไม่มี side effect ใน beta |

| skill | B พิสูจน์ด้วย | ข้อจำกัด phase 1 |
|---|---|---|
| rag-memory | ถาม "what is the alpha token" ใน alpha → response มี `ALPHA-TOKEN-7731`; ใน beta ที่เปิด rag เหมือนกัน ถามคำเดียวกัน → **ไม่มี** `ALPHA-TOKEN` (vector namespace แยกอยู่แล้ว) | — |
| document-summarizer | ขอ list documents ใน alpha → มี `alpha-secret.txt` ไม่มี `beta-secret.txt` | — |
| web-scraping | scrape URL ของ static server ในตัว compose (`http://fixture-web/page.html` มี marker) → response มี marker | ต้องมี collector รัน |
| web-browsing | provider `duckduckgo-engine` (ไม่ต้อง key) ถาม query แปลก ๆ → log มี `web-browsing` call และ response มี citation | ผล search ไม่ deterministic; assert แค่ tool ถูกเรียก + มี URL ในคำตอบ |
| sql-agent | ตั้ง `agent_sql_connections` = 3 DB; alpha ถาม "count rows in customers on alpha_db" → ได้ 3 และ log query hit postgres | **connection เป็น global ใน phase 1**: case "alpha query beta_db ได้" จะ**ผ่าน**ตอนนี้ และต้อง**แดง**หลัง phase 4 → เขียนเป็น `test.todo` ที่ระบุ phase |
| create-chart | ขอ chart จาก inline data → socket event `rechartVisualize` ปรากฏใน chat response JSON | — |
| generate-image | ถ้า gateway ไม่มี `/v1/images/generations` → `skip` ทั้ง B พร้อมเหตุผล; A และ C ยังรัน | provider config global |
| filesystem | ขอสร้างไฟล์ `alpha-note.txt` → ไฟล์โผล่ใน `anythingllm-fs/` | **dir ร่วมกันทุกห้อง phase 1**: case "beta อ่าน alpha-note.txt ได้" ผ่านตอนนี้ → `test.todo` phase 4 |
| create-files | ขอสร้าง text file → `generated-files/text-*.txt` โผล่ + เนื้อหาตรง | เหมือน filesystem |
| create-scheduled-job | ใน single-user mode เท่านั้น: ขอสร้าง job → row ใน `scheduled_jobs` | multi-user ถูก gate ด้วย `SINGLE_USER_ONLY_SKILLS`; suite รันทั้งสองโหมด assert ว่า multi-user ไม่ attach |
| gmail / google-calendar / outlook | B = `skip` (ต้อง OAuth/Apps Script จริง) A, C รัน + case พิเศษ: multi-user mode ต้อง**ไม่ attach แม้เปิด** (guard ใน lib.js) | phase 6 จะปลด guard นี้ ต้องมา flip case |

## Isolation suite (20-isolation)

matrix 13 skills × {alpha on, beta off} → ทุก skill: beta ไม่ attach; plus:
- เปิดทุก skill ใน alpha, ไม่เปิดใน gamma → gamma `@agent` ตอบ NONE และ log ไม่มี `Attached` นอกจาก `httpSocket`
- alias smuggling: `POST enabledSkills: ["memory","docSummarizer"]` → เก็บเป็น `[]` และ agent ไม่มี tool
- stale id: เขียน `["ghost-skill"]` ตรงลง sqlite → GET คืน `[]`, agent ไม่ crash
- API chat (`/v1/workspace/:slug/chat`) และ UI chat (`/workspace/:slug/stream-chat`) เห็น tool ชุดเดียวกัน
- เปลี่ยน enabled ขณะ session agent เปิดอยู่ → session ถัดไปเห็นค่าใหม่

## Security suite (30-security) — multi-user mode

setup: admin, manager (member ของ alpha), default user (member ของ alpha), ไม่มีใครเป็น member ของ beta

| case | expect |
|---|---|
| manager `GET/POST /admin/workspace/alpha/agent-skills` | 403 (ไม่ใช่ 401), DB ไม่เปลี่ยน |
| default user เดียวกัน | 403 |
| manager `POST /workspace/alpha/update` body `{enabled_skills:["sql-agent"], agent_settings:{...}}` | 200 แต่ `enabled_skills` ยัง `[]` (whitelist ทิ้ง) |
| manager `POST /admin/system-preferences` `{default_agent_skills:"sql-agent"}` | ถูกกรอง/ปฏิเสธ และ runtime ไม่เห็น sql-agent ในห้องใด |
| admin เปิด sql-agent ใน beta เท่านั้น; default user (member alpha) `@agent` ใน alpha ขอ query DB | ไม่ attach, ไม่มี query hit DB |
| default user ยิง `/v1/workspace/beta/chat` (ไม่ใช่ member) | 403 ก่อนถึง agent |
| slug enumeration: manager `GET /admin/workspace/<random>/agent-skills` | 403 ไม่ใช่ 404 (ไม่บอกว่ามีห้องไหม) |
| body 1MB / 10k ids / nested objects | 400 หรือถูกตัดเหลือ canonical, server ไม่ล้ม |
| filesystem path traversal: alpha เปิด filesystem, `@agent` ขออ่าน `../../.env.development` | ถูกปฏิเสธ, response ไม่มี `GENERIC_OPEN_AI_API_KEY` |
| SQL injection ผ่าน agent: alpha ขอ "DROP TABLE customers" | DB ยังมี 3 แถว (connector read-only guard) |
| log leak: หลังทุก suite grep server log | ไม่มี connection string password, ไม่มี gateway key |

## UI suite (Playwright, single-user)

1. `/settings/agents?workspace=alpha` → dropdown แสดง alpha, ทุก toggle off, empty note
2. toggle RAG on → Save → toast → reload → ยัง on; API GET ตรงกัน
3. เปลี่ยน dropdown ไป beta → toggle ทั้งหมด off; back → alpha ยัง on
4. toggle แล้ว Cancel → กลับ off
5. ปิด server (หยุด container) → reload → error state, Save disabled, toggles disabled
6. Workspace Settings › Agent Configuration ปุ่ม Configure → URL มี `?workspace=alpha`

## Negative controls (ต้องทำก่อนรับ suite)

- comment บรรทัด `if (!enabled.includes(...))` filter ใน `defaults.js` → `20-isolation` ต้องแดง ≥ 13 case
- ถอด `flexUserRoleValid([ROLES.admin])` ออกจาก GET route → `30-security` case แรกต้องแดง
- ชี้ `VITE_API_BASE` ผิด port → UI suite ต้องแดงที่ case 1 ไม่ใช่ timeout เงียบ

## Evidence contract

```
yarn e2e:up && yarn test:e2e
```
expect: `Tests:` มี `0 failed`, จำนวน `skipped` ตรงกับรายการ skip ที่ประกาศในไฟล์ `e2e/SKIPS.md` (ทุก skip ต้องมีเหตุผล) และ `yarn test:e2e:ui` → `6 passed`

## ต่อยอด phase 2–6

แต่ละ phase เพิ่มไฟล์ `10-skill-*` / case ใหม่ และ**flip** `test.todo` ที่ระบุ phase นั้นให้เป็น test จริง (sql connection ราย workspace, filesystem dir ราย workspace, custom skill/flow/MCP ราย workspace, scheduled job ผูก workspace, Gmail ใน multi-user) `SKIPS.md` ต้องสั้นลงทุก phase

## นอกขอบเขต

- CI (ผู้ใช้เลือก local เท่านั้น)
- ทดสอบคุณภาพคำตอบ LLM
- Gmail/Calendar/Outlook ส่งของจริง
