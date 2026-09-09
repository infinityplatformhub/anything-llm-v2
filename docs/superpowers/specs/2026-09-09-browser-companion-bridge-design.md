# Browser Companion Bridge — ให้ agent สั่ง Chrome ตัวจริงของผู้ใช้

วันที่: 2026-09-09 · mockup: `docs/superpowers/mockups/browser-companion-bridge.html`

## ปัญหา

agent ในแอปอ่านเว็บได้ (`web-scraping`, `web-browsing`) แต่:

- **กดไม่ได้** — อ่านได้อย่างเดียว ไม่มี click/type/scroll
- **ติด antibot** — HTTP fetch ไม่มี session, ไม่มี cookie, ไม่มี browser fingerprint → LinkedIn/Cloudflare block
- **เว็บหลัง login เข้าไม่ถึง** — ต้อง auth ในเบราว์เซอร์ที่ผู้ใช้ login อยู่แล้ว

`open-computer/` มี CDP bridge ที่แก้ปัญหานี้ได้แล้ว (`services/interface-service/utils/cdp-input.js` +
`services/extensions/browser-agent.ts` 10 tool) แต่รันใน QEMU VM — profile/cookie ไม่ใช่ของผู้ใช้ และกิน RAM/CPU ทั้ง VM

## ทางที่เลือก

ต่อ **extension เดิม** (`browser-extension/`) เข้ากับ `chrome.debugger` API แล้วให้ agent plugin ฝั่ง server
สั่งผ่าน WebSocket

### ทำไม `chrome.debugger` ไม่ใช่ทางอื่น

| | open-computer VM | Playwright CDP-attach | **extension + chrome.debugger** |
|---|---|---|---|
| profile/cookie จริงของผู้ใช้ | ไม่ | ได้ (profile แยก) | **ได้ profile ที่ใช้อยู่จริง** |
| `navigator.webdriver` | false | **true** (`--enable-automation`) | **false** |
| `isTrusted` event | ได้ | ได้ | **ได้** |
| ต้นทุน runtime | VM ทั้งลูก | Chrome แยกตัว | **ศูนย์** |

content script กดผ่าน `el.click()` ให้ `isTrusted: false` — antibot จับได้ทันที นั่นคือเหตุผลที่ต้องเป็น
`chrome.debugger` + `Input.dispatchMouseEvent` ไม่ใช่ content script

## สถาปัตยกรรม

ทางเดินของคำสั่งหนึ่งครั้ง (5 hop):

1. **agent plugin** (`server/utils/agents/aibitat/plugins/browser-companion.js`) — agent เรียก `page_click({ id: 12 })`
2. **server** (`server/endpoints/browserExtension.js`) — หา socket จาก `apiKeyId` ส่งคำสั่งเข้าไป รอผลตาม `requestId`
3. **extension service worker** — เช็ค allowlist ก่อน ถ้าผ่านจึง `chrome.debugger.attach`
4. **CDP** — `Input.dispatchMouseEvent` / `dispatchKeyEvent` เว้นจังหวะพิมพ์สุ่ม 30–90ms
5. **หน้าเว็บ** — ได้ event `isTrusted: true`, `navigator.webdriver === false`

### ช่องคุย: WebSocket ค้างไว้

`app.ws()` มีอยู่แล้วในโปรเจกต์ (express-ws — ดู `server/endpoints/agentWebsocket.js`) ไม่ต้องเพิ่ม infra

route ใหม่: `app.ws("/browser-extension/agent-socket", ...)` auth ด้วย `BrowserExtensionApiKey` ที่มีอยู่ —
**ไม่แตะ schema**

ที่เลือก WS ไม่ใช่ long-poll: agent กด 20–30 step ติดกัน long-poll เพิ่ม 0–500ms ต่อ step และต้องมีตาราง
queue ใน DB = แตะ schema

**ราคาที่จ่าย และต้องเขียนโค้ดรับ:**

- MV3 service worker ตายเมื่อ idle 30 วิ → ต้องมี keepalive (`chrome.alarms` 25 วิ + WS ping) และ reconnect ทุกครั้งที่ตื่น
- server ถือ `apiKeyId → socket` ใน memory → หลาย replica ต้อง sticky session
  dev2 รัน replica เดียว ยังไม่เจ็บ **แต่บิลมาถึงตอน scale — ต้องเขียนไว้ใน README ของ endpoint**

### agent หาเบราว์เซอร์ของใคร — route ตาม user ไม่ใช่ workspace

**server ไม่ถือ session ของเว็บปลายทางเลย** — session อยู่ใน Chrome ของผู้ใช้ฝั่งเดียว
extension คือแขนที่ยืมมือ Chrome นั้นกด นี่คือความต่างสำคัญจากการที่ server เก็บ cookie ไว้เอง:
server ที่ถูก compromise ไม่มี session ของใครให้ขโมย

การ route: `browser_extension_api_keys.user_id` ↔ `workspaceAgentInvocation.user_id`
คน A ถาม agent → สั่งได้แค่เบราว์เซอร์ของ A คน B ในเวิร์กสเปซเดียวกันไม่ถูกแตะ
**workspace แชร์กันไม่เกี่ยว เพราะ socket ผูกคน ไม่ได้ผูก workspace**

**ข้อบังคับ 3 ข้อที่มาจากการอ่านโค้ดจริง ไม่ใช่การเดา:**

1. **key ที่ `user_id` เป็น `null` ใช้ได้เฉพาะตอน single-user mode**
   `BrowserExtensionApiKey.create()` รับ `userId = null` เป็น default และ `workspaceAgentInvocation.new()`
   ก็เขียน `user_id: user?.id` → ทั้งสองเป็น `null` ใน single-user mode ถ้าเปิด multi-user ทีหลัง
   key เก่าที่ `null` จะ match ใครก็ได้ ต้องปฏิเสธชัดเจน ไม่ใช่ปล่อยให้ match
2. **agent ที่ไม่มี user (scheduled job) ต้องได้คำตอบ offline** — ห้ามหยิบ socket ของใครก็ได้ที่ต่ออยู่
   นี่เป็น privilege escalation ที่เงียบที่สุดในงานนี้: job ที่ไม่มีเจ้าของยืมเบราว์เซอร์ของคนที่บังเอิญออนไลน์
3. **หนึ่ง user = หนึ่ง socket (รอบนี้)** — เครื่องที่ 2 ต่อเข้ามาเตะเครื่องแรกออก popup ของเครื่องที่ถูกเตะ
   ต้องบอกว่าโดนเตะ ไม่ใช่เงียบไป
   ที่เลือกแบบนี้เพราะผู้ใช้ยืนยันว่าลงเครื่องเดียว (2026-09-09) — **บิลมาถึงตอนอยากใช้หลายเครื่อง:**
   ต้องเพิ่ม UI ตั้งชื่อเครื่อง + param เลือกเครื่องใน tool ทุกตัว protocol รองรับอยู่แล้ว (`requestId` แยกคำสั่งได้)
   จึงเป็นการเพิ่ม UI ไม่ใช่รื้อ

### แท็บที่ agent ทำงาน

agent **เปิดแท็บใหม่ของตัวเอง** ไม่แตะแท็บที่ผู้ใช้เปิดอยู่ — profile เดียวกันจึงได้ cookie/session
เหมือนกันทุกอย่าง งานของผู้ใช้ไม่หาย และ infobar "DevTools is debugging" โผล่แค่แท็บของ agent

ผลตามมาที่ต้องรับ: ผู้ใช้สลับมือ (captcha/OTP) ต้องไปกดที่แท็บของ agent — popup ต้องมีปุ่มพาไปแท็บนั้น
ไม่ใช่ปล่อยให้หาเอง

### เมื่อเบราว์เซอร์ไม่ได้ต่อ

tool ตอบว่า browser offline ให้ agent หาทางอื่น (fallback ไป `web-scraping` หรือบอกผู้ใช้) —
**ไม่รอ ไม่ retry เงียบ** เพราะการรอ 30 วิทุกคำสั่งตอน Chrome ปิดจริงคือ agent ค้าง

### wire protocol

server → extension:
```json
{ "requestId": "r_8f2a", "cmd": "click", "tabId": 391, "id": 12 }
```

extension → server:
```json
{ "requestId": "r_8f2a", "ok": true, "url": "https://www.linkedin.com/messaging/" }
```
หรือ `{ "requestId": "r_8f2a", "ok": false, "error": "denied: domain not in allowlist" }`

`requestId` จำเป็นเพราะ agent อาจยิงหลายคำสั่งซ้อนกัน — ตอบผิดคู่ = agent เข้าใจหน้าเว็บผิด

## Agent tool

ยืม tool shape จาก `open-computer/services/extensions/browser-agent.ts` ที่พิสูจน์แล้วว่าใช้งานได้จริง:

| tool | ทำอะไร |
|---|---|
| `page_state` | อ่านผัง element ในหน้า ติด `[id]` ให้ agent อ้างถึง |
| `page_click` | กด element ตาม `[id]` |
| `page_type` | พิมพ์ลง element ตาม `[id]` |
| `page_read` | อ่านข้อความในหน้า (markdown) |
| `page_scroll` | เลื่อนหน้า |
| `page_key` | กดปุ่ม (Enter/Tab/Escape) |
| `page_tabs` | ดูรายการแท็บที่เปิดอยู่ |
| `page_switch` | สลับแท็บตาม URL substring |
| `page_navigate` | เปิด URL |
| `page_close` | ปิดแท็บ |
| `page_fetch` | ยิง GET จากในบริบทแท็บที่ login อยู่ ส่ง body กลับ |

agent ไม่เห็นพิกเซล — เห็น `[id]` ที่ `page_state` ส่งมา นี่เป็นเหตุผลที่ `page_state` ต้องถูกเรียกก่อน
`page_click` เสมอ (state เก่า = กดผิดปุ่ม)

### ทำไมต้องมี `page_fetch`

แอปที่วาดด้วย canvas อ่านจาก DOM ไม่ได้ — **Google Sheets เป็นตัวอย่างที่ชัดที่สุด**: ตารางทั้งผืนวาดบน
canvas ไม่ใช่ DOM element `page_read` จะได้แค่ toolbar กับชื่อชีต ตัวเลขในเซลล์ไม่มีใน DOM เลย

ทางที่ใช้ได้คือยิง export endpoint จากในแท็บที่ผู้ใช้ login อยู่:

```
https://docs.google.com/spreadsheets/d/<id>/export?format=csv&gid=<gid>
```

cookie ของผู้ใช้ผ่าน permission ให้เอง — ได้ CSV ทั้งชีต แม่นกว่าอ่านจอ และครอบชีต private ที่
`web-scraping` เดิมทำไม่ได้ (ไม่มี cookie ก็เจอหน้า login)

กลุ่มอื่นที่ `page_fetch` แก้ด้วย: API ภายในหลัง login · endpoint export ของ SaaS · JSON API ที่ต้องมี session

**ข้อจำกัดที่มาพร้อมกัน:** ยิงในบริบทของแท็บนั้น จึงต้อง **same-origin กับแท็บที่เปิดอยู่** — ยิง Sheets
จากแท็บ LinkedIn ไม่ได้ agent ต้อง `page_navigate` ไปโดเมนนั้นก่อน และโดเมนนั้นต้องอยู่ใน allowlist
เหมือนทุก tool

**เหตุผลที่ต้องผ่าน allowlist ด่านเดียวกัน ไม่มีข้อยกเว้น:** `page_fetch` เป็น tool ที่ดึงข้อมูลออกได้เยอะที่สุด
ในชุดนี้ — GET เดียวได้ทั้งสเปรดชีต ถ้าหลุด allowlist ไปได้ = อ่านทุกอย่างที่ session ผู้ใช้เข้าถึงได้
จำกัดเป็น GET เท่านั้น ไม่รับ POST/PUT/DELETE เพราะการ *เขียน* ต้องมาจาก `page_click` ที่คนเห็นว่าเกิดอะไรขึ้น

## ความปลอดภัย — ไม่ใช่ optional

**นี่คือ path ที่ให้ agent สั่งเบราว์เซอร์ที่มี session ของผู้ใช้ทุกอย่าง (ธนาคาร อีเมล) — ทุกข้อต้องมี**

1. **domain allowlist ปิดหมดก่อน (default deny)** — ผู้ใช้เปิดเองทีละโดเมน
   **ด่านนี้อยู่ในฝั่ง extension ไม่ใช่ server** — เพราะ server ถูก compromise ได้ แต่ extension คือของที่ผู้ใช้ติดตั้งเอง
   ถ้าอยู่ที่ server อย่างเดียว server ที่ถูกแฮ็กสั่งอะไรก็ได้
2. **kill switch** — ปุ่ม "ตัดทุกแท็บ" อยู่ทุกแท็บของ popup (`chrome.debugger.detach` ทุก target)
   เวลาจะหยุด ไม่ควรต้องหาว่าปุ่มอยู่แท็บไหน
3. **pause / resume** — agent เจอ captcha/OTP หยุดเอง คนกดต่อในแท็บนั้น แล้วสั่ง resume
4. **audit log** — ทุกคำสั่งที่เข้าเบราว์เซอร์ (รวมที่ถูก deny) เก็บใน `chrome.storage.local` ให้ดาวน์โหลดได้

## ข้อจำกัดที่แก้ไม่ได้ — เขียนไว้เพื่อไม่ให้ถูกไปตามหาว่าเป็น bug

1. แถบ **"DevTools is debugging this tab"** โผล่ทุกแท็บที่ attach — Chrome บังคับ ซ่อนไม่ได้
2. `chrome://*` และ Chrome Web Store **attach ไม่ได้** — Chrome กันไว้
3. Web Store review เข้มมากกับ `debugger` permission — แผนแจกคือ **unpacked / enterprise policy** ไปก่อน
   ถ้าจะขึ้น Web Store ต้องเป็นงานรอบแยกที่มีเอกสาร justification
4. LinkedIn ToS ห้าม automate ทุกรูปแบบ — ความเสี่ยงอยู่ที่ **บัญชีผู้ใช้** ไม่ใช่โค้ด
   ผู้ใช้รับทราบและตัดสินใจแล้ว (2026-09-09)

## ที่ตัดออกจากงานนี้

**E2E test ของแอปเราเอง ไม่ใช้ bridge นี้** — localhost ไม่มี antibot ให้ผ่าน Playwright headed +
`gate-e2e` เดิมตอบได้ครบ ถ้าเอา bridge ไปทำ E2E จะได้ test ที่พึ่ง Chrome บนเครื่องคน → รันใน CI ไม่ได้
ผู้ใช้เห็นด้วยแล้ว (2026-09-09)

## แบ่งงาน

งานนี้แตะ path ที่รับคำสั่งจาก server เข้ามาสั่งเบราว์เซอร์ที่มี session ผู้ใช้ — **ทุก task ต้องผ่าน
security review (Opus)** ไม่ใช่แค่ final review

| # | task | ไฟล์ | พึ่งงานไหน |
|---|---|---|---|
| 1 | WS route + socket registry + auth (route ตาม user_id, กัน null key, เตะ socket เก่า) | `server/endpoints/browserExtension.js` | — |
| 2 | wire protocol + requestId correlation (ทั้งสองฝั่ง) | server + extension bg | 1 |
| 3 | extension: `debugger` permission + attach/detach + allowlist gate | `browser-extension/` manifest + bg | — |
| 4 | extension: CDP input (click/type/key/scroll) + `page_fetch` (GET only) + human delay | `browser-extension/` bg | 3 |
| 5 | extension: `page_state` element map + `[id]` | `browser-extension/` bg | 3 |
| 6 | extension popup UI 4 แท็บ (ตาม mockup) + kill switch + audit log + ปุ่มพาไปแท็บ agent + แจ้งเมื่อถูกเตะ | `browser-extension/src/` | 3 |
| 7 | agent plugin 11 tool | `server/utils/agents/aibitat/plugins/browser-companion.js` | 1, 2 |
| 8 | keepalive + reconnect (MV3 service worker) | `browser-extension/` bg | 1, 3 |

## หลักฐานที่จะพิสูจน์ว่างานเสร็จ

evidence contract: unit test ต้องเขียวทั้งหมด —

- allowlist gate ปฏิเสธโดเมนที่ไม่ได้เปิด
- `requestId` จับคู่ผลถูกคู่เมื่อมีคำสั่งซ้อนกัน
- `page_fetch` ปฏิเสธ method ที่ไม่ใช่ GET
- **key ที่ `user_id` เป็น null ถูกปฏิเสธเมื่อ multi-user mode เปิด**
- **agent ที่ไม่มี user ได้ offline ไม่ได้ socket ของคนอื่น**
เพราะ contract ที่ต้อง attach Chrome จริงไม่สามารถรันใน gate อัตโนมัติได้ (ต้องมีคน login อยู่)

E2E headed (`gate-e2e`) ครอบ popup UI — allowlist toggle, kill switch, pause/resume, `@edge` = โดเมนไม่อยู่ใน
allowlist ต้องถูก deny (ครอบ `page_fetch` ด้วย ไม่ใช่แค่ `page_click`)

**การพิสูจน์ว่า antibot ไม่จับ ต้องมีคนดูจริง** — ไม่ใช่สิ่งที่ gate ตรวจได้ ต้องสาธิตให้ผู้ใช้เห็นก่อนปิด issue
