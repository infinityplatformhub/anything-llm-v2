# Browser Companion Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ให้ agent ในแอปสั่ง Chrome ตัวจริงของผู้ใช้ (กด/พิมพ์/อ่าน/ยิง GET) ผ่าน `chrome.debugger` เพื่อเข้าเว็บหลัง login และผ่าน antibot ได้

**Architecture:** extension เดิม (`browser-companion/`) เปิด WebSocket ค้างไว้กับ server, server เก็บ registry `user_id → socket`, agent plugin ยิงคำสั่งเข้า socket รอผลตาม `requestId`, extension เช็ค allowlist แล้ว attach `chrome.debugger` ยิง `Input.dispatchMouseEvent`/`dispatchKeyEvent` = trusted event ที่ antibot จับไม่ได้ **server ไม่ถือ session ของเว็บปลายทางเลย** — session อยู่ใน Chrome ของผู้ใช้ฝั่งเดียว

**Tech Stack:** Node/Express + express-ws (`app.ws()` มีอยู่แล้ว) · Prisma (ไม่แตะ schema) · MV3 Chrome extension + React 18 + Vite · Jest · Playwright

**Spec:** `docs/superpowers/specs/2026-09-09-browser-companion-bridge-design.md`

**Issue:** #60

## Global Constraints

- **ไม่แตะ Prisma schema** — ใช้ `browser_extension_api_keys` ที่มีอยู่ ห้ามเพิ่มตาราง/คอลัมน์
- **ไม่เพิ่ม runtime dependency ใหม่** ทั้งฝั่ง server และ extension — `express-ws` มีอยู่แล้ว, extension ใช้ `WebSocket` ของเบราว์เซอร์
- **route ตาม `user_id` เท่านั้น ไม่ใช่ workspace** — `browser_extension_api_keys.user_id` ↔ `workspaceAgentInvocation.user_id`
- **key ที่ `user_id` เป็น `null` ใช้ได้เฉพาะ single-user mode** — multi-user mode ต้องปฏิเสธ
- **agent ที่ไม่มี user (scheduled job) ต้องได้ `browser offline`** — ห้ามหยิบ socket ของคนที่บังเอิญออนไลน์
- **หนึ่ง user = หนึ่ง socket** — เครื่องที่ 2 เตะเครื่องแรก และเครื่องที่ถูกเตะต้องรู้ตัว
- **allowlist gate อยู่ฝั่ง extension** — default deny, server ที่ถูก compromise ต้องสั่งอะไรไม่ได้
- **`page_fetch` รับ GET เท่านั้น** — การเขียนต้องมาจาก `page_click` ที่คนเห็น
- **agent เปิดแท็บใหม่ของตัวเอง** ไม่แตะแท็บที่ผู้ใช้เปิดอยู่
- **browser offline = ตอบทันที** ไม่รอ ไม่ retry เงียบ
- ค่าที่ต่างตาม environment (URL, port, timeout, keepalive interval) อยู่ใน env/config ไม่ hardcode
- test runner (server, CJS): `cd server && node ../node_modules/jest/bin/jest.js <path> --silent`
- test runner (extension, ESM): `cd browser-companion && NODE_OPTIONS=--experimental-vm-modules node ../node_modules/jest/bin/jest.js <path>`
- **extension code lives in `browser-companion/`** — `browser-extension/` is a git submodule of a third-party repo and must not be touched

---

## File Structure

**Server**

| ไฟล์ | หน้าที่ |
|---|---|
| `server/utils/browserCompanion/registry.js` (สร้าง) | เก็บ `userId → socket` เดียว, resolve socket จาก user, เตะ socket เก่า |
| `server/utils/browserCompanion/protocol.js` (สร้าง) | ส่งคำสั่ง + จับคู่ `requestId` + timeout |
| `server/endpoints/browserExtension.js` (แก้) | route `app.ws("/browser-companion/agent-socket")` |
| `server/utils/agents/aibitat/plugins/browser-companion.js` (สร้าง) | agent plugin 11 tool |
| `server/utils/agents/aibitat/plugins/index.js` (แก้) | ลงทะเบียน plugin |
| `server/models/workspaceAgentSettings.js` (แก้) | **ไม่ใส่ใน `DEFAULT_ENABLED_SKILLS`** — opt-in เท่านั้น |
| `frontend/src/pages/Admin/Agents/skills.jsx` (แก้) | toggle ใน UI |

แยก `registry.js` ออกจาก `protocol.js` เพราะ registry ตอบคำถาม "socket ของใคร" (security) ส่วน protocol ตอบ "คำสั่งไหนคู่กับผลไหน" (correctness) — คนละความรับผิดชอบ และ registry คือไฟล์ที่ security review ต้องอ่านละเอียดสุด

**Extension** — `background.js` วันนี้ถูก `cp` เข้า `dist/` ตรงๆ ไม่ผ่าน bundler (ดู `package.json` script) เพิ่มโค้ดขนาดนี้ในไฟล์เดียวคือหนี้ จึงเปลี่ยน build ให้ bundle service worker เป็น input ที่สองของ vite

| ไฟล์ | หน้าที่ |
|---|---|
| `browser-companion/src/background/index.js` (สร้าง) | entry ของ service worker — ย้ายโค้ดเดิมจาก `public/background.js` มา + ต่อ WS |
| `browser-companion/src/background/socket.js` (สร้าง) | WS client + keepalive + reconnect |
| `browser-companion/src/background/allowlist.js` (สร้าง) | **ด่านความปลอดภัย** — default deny, match โดเมน |
| `browser-companion/src/background/cdp.js` (สร้าง) | attach/detach + `Input.dispatch*` + human delay |
| `browser-companion/src/background/pageState.js` (สร้าง) | `Runtime.evaluate` เก็บผัง element ติด `[id]` |
| `browser-companion/src/background/auditLog.js` (สร้าง) | บันทึกทุกคำสั่ง (รวมที่ deny) ลง `chrome.storage.local` |
| `browser-companion/src/background/dispatch.js` (สร้าง) | รับคำสั่งจาก socket → allowlist → cdp/pageState → ตอบกลับ |
| `browser-companion/public/manifest.json` (แก้) | `"debugger"` permission + `background.type: "module"` |
| `browser-companion/vite.config.js` (แก้) | เพิ่ม input `background` |
| `browser-companion/package.json` (แก้) | ลบ `cp public/background.js dist/` |
| `browser-companion/src/components/CompanionPanel/*.jsx` (สร้าง) | popup 4 แท็บ |

---

### Task 1: socket registry — ใครสั่งเบราว์เซอร์ของใครได้

**Files:**
- Create: `server/utils/browserCompanion/registry.js`
- Test: `server/__tests__/utils/browserCompanion/registry.test.js`

**Interfaces:**
- Consumes: `SystemSettings.isMultiUserMode()` จาก `server/models/systemSettings.js`
- Produces:
  - `register({ userId, socket })` → `{ evicted: <socket|null> }` — คืน socket ที่ถูกเตะออก
  - `unregister({ userId, socket })` → `void` — ลบเฉพาะเมื่อ socket ตรงกับที่เก็บไว้ (กัน socket เก่าที่ปิดช้าลบตัวใหม่)
  - `resolve({ userId, multiUserMode })` → `{ socket, error }` — `error` เป็น string เมื่อ resolve ไม่ได้
  - `SINGLE_USER_KEY` — sentinel สำหรับ `user_id === null` ใน single-user mode

- [ ] **Step 1: เขียน test ที่ต้องแดง**

```javascript
/* global jest */
const { describe, it, expect, beforeEach } = require("@jest/globals");
const registry = require("../../../utils/browserCompanion/registry");

function fakeSocket(name) {
  return { name, closed: false, close() { this.closed = true; } };
}

describe("browserCompanion registry", () => {
  beforeEach(() => registry.__reset());

  it("resolves the socket registered for that user", () => {
    const s = fakeSocket("a");
    registry.register({ userId: 7, socket: s });
    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBe(s);
  });

  it("never hands one user's socket to another user", () => {
    registry.register({ userId: 7, socket: fakeSocket("a") });
    const { socket, error } = registry.resolve({ userId: 9, multiUserMode: true });
    expect(socket).toBeNull();
    expect(error).toMatch(/not connected/i);
  });

  it("evicts the previous socket when a second device connects", () => {
    const first = fakeSocket("first");
    registry.register({ userId: 7, socket: first });
    const { evicted } = registry.register({ userId: 7, socket: fakeSocket("second") });
    expect(evicted).toBe(first);
  });

  it("unregister ignores a stale socket so it cannot drop the live one", () => {
    const stale = fakeSocket("stale");
    registry.register({ userId: 7, socket: stale });
    const live = fakeSocket("live");
    registry.register({ userId: 7, socket: live });
    registry.unregister({ userId: 7, socket: stale });
    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBe(live);
  });

  // @edge — null user_id key ต้องใช้ไม่ได้เมื่อเปิด multi-user mode
  it("refuses a null-user key in multi-user mode", () => {
    registry.register({ userId: null, socket: fakeSocket("legacy") });
    const { socket, error } = registry.resolve({ userId: null, multiUserMode: true });
    expect(socket).toBeNull();
    expect(error).toMatch(/multi-user/i);
  });

  it("allows the null-user key in single-user mode", () => {
    const s = fakeSocket("solo");
    registry.register({ userId: null, socket: s });
    expect(registry.resolve({ userId: null, multiUserMode: false }).socket).toBe(s);
  });

  // @edge — agent ที่ไม่มี user ห้ามยืมเบราว์เซอร์ของคนที่บังเอิญออนไลน์
  it("refuses to resolve for an agent with no user in multi-user mode", () => {
    registry.register({ userId: 7, socket: fakeSocket("a") });
    const { socket, error } = registry.resolve({ userId: undefined, multiUserMode: true });
    expect(socket).toBeNull();
    expect(error).toMatch(/no user/i);
  });
});
```

- [ ] **Step 2: รัน test ยืนยันว่าแดง**

Run: `cd server && node ../node_modules/jest/bin/jest.js __tests__/utils/browserCompanion/registry.test.js`
Expected: FAIL — `Cannot find module '../../../utils/browserCompanion/registry'`

- [ ] **Step 3: เขียน implementation**

```javascript
// Sentinel for the single-user-mode key whose user_id is null. A real user id is
// never null, so this cannot collide with one.
const SINGLE_USER_KEY = "__single_user__";

/** @type {Map<number|string, object>} one socket per user — see plan Global Constraints */
const sockets = new Map();

function keyFor(userId) {
  return userId === null ? SINGLE_USER_KEY : userId;
}

function register({ userId, socket }) {
  const key = keyFor(userId);
  const previous = sockets.get(key) ?? null;
  sockets.set(key, socket);
  return { evicted: previous === socket ? null : previous };
}

function unregister({ userId, socket }) {
  const key = keyFor(userId);
  // Only drop the entry when it is still this socket. A socket that closes late
  // must not evict the replacement that already took its place.
  if (sockets.get(key) === socket) sockets.delete(key);
}

function resolve({ userId, multiUserMode }) {
  if (userId === undefined)
    return { socket: null, error: "This agent run has no user, so there is no browser to drive." };

  if (userId === null) {
    if (multiUserMode)
      return {
        socket: null,
        error:
          "This browser extension key predates multi-user mode and is not tied to a user. Reconnect the extension to get a key bound to your account.",
      };
    const socket = sockets.get(SINGLE_USER_KEY) ?? null;
    return socket ? { socket, error: null } : { socket: null, error: "Browser extension is not connected." };
  }

  const socket = sockets.get(userId) ?? null;
  return socket ? { socket, error: null } : { socket: null, error: "Browser extension is not connected." };
}

function __reset() {
  sockets.clear();
}

module.exports = { register, unregister, resolve, __reset, SINGLE_USER_KEY };
```

- [ ] **Step 4: รัน test ยืนยันว่าเขียว**

Run: `cd server && node ../node_modules/jest/bin/jest.js __tests__/utils/browserCompanion/registry.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add server/utils/browserCompanion/registry.js server/__tests__/utils/browserCompanion/registry.test.js
git commit -m "feat(browser-companion): socket registry routed by user_id (#60)"
```

---

### Task 2: wire protocol — คำสั่งไหนคู่กับผลไหน

**Files:**
- Create: `server/utils/browserCompanion/protocol.js`
- Test: `server/__tests__/utils/browserCompanion/protocol.test.js`

**Interfaces:**
- Consumes: socket object ที่มี `send(string)` และ `on("message", handler)` (express-ws socket ทำได้ทั้งคู่)
- Produces:
  - `attach(socket)` → `void` — ผูก message handler เข้ากับ socket ครั้งเดียวตอน connect
  - `send({ socket, cmd, payload, timeoutMs })` → `Promise<{ ok, data, error }>`
  - `handleMessage({ socket, raw })` → `void` — จับคู่ผลกลับเข้า promise ที่รออยู่

- [ ] **Step 1: เขียน test ที่ต้องแดง**

```javascript
/* global jest */
const { describe, it, expect, beforeEach } = require("@jest/globals");
const protocol = require("../../../utils/browserCompanion/protocol");

function fakeSocket() {
  const sent = [];
  return {
    sent,
    send(raw) { sent.push(JSON.parse(raw)); },
    lastRequestId() { return sent[sent.length - 1].requestId; },
  };
}

describe("browserCompanion protocol", () => {
  beforeEach(() => protocol.__reset());

  it("resolves with the reply carrying the matching requestId", async () => {
    const socket = fakeSocket();
    const pending = protocol.send({ socket, cmd: "click", payload: { id: 12 } });
    protocol.handleMessage({
      socket,
      raw: JSON.stringify({ requestId: socket.lastRequestId(), ok: true, data: { url: "https://x.test/" } }),
    });
    await expect(pending).resolves.toEqual({ ok: true, data: { url: "https://x.test/" }, error: null });
  });

  // @edge — คำสั่งซ้อนกันต้องไม่สลับผลกัน
  it("keeps concurrent commands paired with their own replies", async () => {
    const socket = fakeSocket();
    const first = protocol.send({ socket, cmd: "read", payload: {} });
    const firstId = socket.lastRequestId();
    const second = protocol.send({ socket, cmd: "click", payload: { id: 3 } });
    const secondId = socket.lastRequestId();

    expect(firstId).not.toBe(secondId);
    protocol.handleMessage({ socket, raw: JSON.stringify({ requestId: secondId, ok: true, data: "second" }) });
    protocol.handleMessage({ socket, raw: JSON.stringify({ requestId: firstId, ok: true, data: "first" }) });

    expect((await first).data).toBe("first");
    expect((await second).data).toBe("second");
  });

  it("passes an extension-side failure through as error", async () => {
    const socket = fakeSocket();
    const pending = protocol.send({ socket, cmd: "click", payload: { id: 1 } });
    protocol.handleMessage({
      socket,
      raw: JSON.stringify({ requestId: socket.lastRequestId(), ok: false, error: "denied: domain not in allowlist" }),
    });
    await expect(pending).resolves.toEqual({ ok: false, data: null, error: "denied: domain not in allowlist" });
  });

  it("times out instead of hanging when no reply arrives", async () => {
    const socket = fakeSocket();
    const result = await protocol.send({ socket, cmd: "click", payload: { id: 1 }, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  // @edge — ผลที่ไม่มีใครรอ ต้องทิ้งเงียบ ไม่ throw
  it("drops a reply whose requestId nobody is waiting on", () => {
    const socket = fakeSocket();
    expect(() =>
      protocol.handleMessage({ socket, raw: JSON.stringify({ requestId: "r_nobody", ok: true }) })
    ).not.toThrow();
  });

  it("ignores malformed json rather than crashing the socket", () => {
    const socket = fakeSocket();
    expect(() => protocol.handleMessage({ socket, raw: "not json" })).not.toThrow();
  });
});
```

- [ ] **Step 2: รัน test ยืนยันว่าแดง**

Run: `cd server && node ../node_modules/jest/bin/jest.js __tests__/utils/browserCompanion/protocol.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: เขียน implementation**

```javascript
const { randomUUID } = require("crypto");

// A browser command that gets no reply must not hang the agent turn. Overridable
// because a slow page load is environment-dependent.
const DEFAULT_TIMEOUT_MS = Number(process.env.BROWSER_COMPANION_TIMEOUT_MS ?? 20_000);

/** @type {Map<string, {resolve: Function, timer: NodeJS.Timeout}>} */
const pending = new Map();

function send({ socket, cmd, payload = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const requestId = `r_${randomUUID()}`;
  return new Promise((resolveOuter) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolveOuter({
        ok: false,
        data: null,
        error: `Browser command "${cmd}" timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);

    pending.set(requestId, { resolve: resolveOuter, timer });
    socket.send(JSON.stringify({ requestId, cmd, ...payload }));
  });
}

function handleMessage({ raw }) {
  let parsed;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
  } catch {
    return; // A malformed frame must not take the socket down.
  }

  const entry = pending.get(parsed?.requestId);
  if (!entry) return; // Late reply after a timeout, or a frame we never asked for.

  pending.delete(parsed.requestId);
  clearTimeout(entry.timer);
  entry.resolve(
    parsed.ok
      ? { ok: true, data: parsed.data ?? null, error: null }
      : { ok: false, data: null, error: parsed.error ?? "Browser command failed." }
  );
}

function attach(socket) {
  socket.on("message", (raw) => handleMessage({ socket, raw }));
}

function __reset() {
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
}

module.exports = { send, handleMessage, attach, __reset, DEFAULT_TIMEOUT_MS };
```

- [ ] **Step 4: รัน test ยืนยันว่าเขียว**

Run: `cd server && node ../node_modules/jest/bin/jest.js __tests__/utils/browserCompanion/protocol.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add server/utils/browserCompanion/protocol.js server/__tests__/utils/browserCompanion/protocol.test.js
git commit -m "feat(browser-companion): wire protocol with requestId correlation (#60)"
```

---

### Task 3: WS endpoint — ทางเข้าที่ต้องผ่าน auth

**Files:**
- Modify: `server/endpoints/browserExtension.js` (เพิ่ม route ต่อท้าย route ที่มีอยู่ ก่อน `module.exports`)
- Test: `server/__tests__/endpoints/browserExtensionSocket.test.js`

**Interfaces:**
- Consumes: `registry.register/unregister` (Task 1), `protocol.attach` (Task 2), `BrowserExtensionApiKey.validate`, `SystemSettings.isMultiUserMode`, `User.get`
- Produces: `app.ws("/browser-companion/agent-socket")` — auth ด้วย query param `?key=brx-...`
  (WebSocket ฝั่งเบราว์เซอร์ **ตั้ง header ไม่ได้** จึงส่ง key ทาง query — ไม่ใช่ทางเลือกด้านสไตล์)

- [ ] **Step 1: เขียน test ที่ต้องแดง**

```javascript
/* global jest */
const { describe, it, expect, beforeEach, afterEach } = require("@jest/globals");
const registry = require("../../utils/browserCompanion/registry");

jest.mock("../../models/browserExtensionApiKey", () => ({
  BrowserExtensionApiKey: { validate: jest.fn() },
}));
jest.mock("../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
}));
jest.mock("../../models/user", () => ({ User: { get: jest.fn() } }));

const { BrowserExtensionApiKey } = require("../../models/browserExtensionApiKey");
const { SystemSettings } = require("../../models/systemSettings");
const { User } = require("../../models/user");
const { browserExtensionEndpoints } = require("../../endpoints/browserExtension");

const ROUTE = "/browser-companion/agent-socket";
let wsRoutes;

function fakeApp() {
  wsRoutes = {};
  return {
    get() {}, post() {}, delete() {},
    ws(path, handler) { wsRoutes[path] = handler; },
  };
}

function fakeSocket() {
  const handlers = {};
  return {
    sent: [], closed: false, closeCode: null,
    send(raw) { this.sent.push(JSON.parse(raw)); },
    close(code) { this.closed = true; this.closeCode = code ?? null; },
    on(evt, fn) { handlers[evt] = fn; },
    emit(evt, ...args) { handlers[evt]?.(...args); },
  };
}

async function connect(key) {
  const socket = fakeSocket();
  await wsRoutes[ROUTE](socket, { query: { key } });
  return socket;
}

describe("browser-companion agent socket", () => {
  beforeEach(() => {
    registry.__reset();
    jest.clearAllMocks();
    browserExtensionEndpoints(fakeApp());
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
  });
  afterEach(() => registry.__reset());

  it("registers the socket for the key's user", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: false });

    const socket = await connect("brx-good");
    expect(socket.closed).toBe(false);
    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBe(socket);
  });

  // @edge — key ผิดต้องถูกปิด และต้องไม่มีอะไรถูกลงทะเบียน
  it("closes the socket when the key is invalid", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue(null);
    const socket = await connect("brx-bad");
    expect(socket.closed).toBe(true);
    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBeNull();
  });

  it("closes the socket when no key is supplied at all", async () => {
    const socket = await connect(undefined);
    expect(socket.closed).toBe(true);
    expect(BrowserExtensionApiKey.validate).not.toHaveBeenCalled();
  });

  // @edge — ผู้ใช้ที่ถูกระงับ ต่อไม่ได้
  it("closes the socket for a suspended user", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: true });

    const socket = await connect("brx-good");
    expect(socket.closed).toBe(true);
  });

  it("tells the evicted device it was replaced, then closes it", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: false });

    const first = await connect("brx-good");
    await connect("brx-good");

    expect(first.sent.some((m) => m.event === "evicted")).toBe(true);
    expect(first.closed).toBe(true);
  });

  it("unregisters on close", async () => {
    BrowserExtensionApiKey.validate.mockResolvedValue({ id: 1, user_id: 7 });
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    User.get.mockResolvedValue({ id: 7, suspended: false });

    const socket = await connect("brx-good");
    socket.emit("close");
    expect(registry.resolve({ userId: 7, multiUserMode: true }).socket).toBeNull();
  });
});
```

- [ ] **Step 2: รัน test ยืนยันว่าแดง**

Run: `cd server && node ../node_modules/jest/bin/jest.js __tests__/endpoints/browserExtensionSocket.test.js`
Expected: FAIL — `wsRoutes["/browser-companion/agent-socket"] is not a function`

- [ ] **Step 3: เขียน implementation**

เพิ่ม require ที่หัวไฟล์ `server/endpoints/browserExtension.js`:

```javascript
const registry = require("../utils/browserCompanion/registry");
const protocol = require("../utils/browserCompanion/protocol");
const { SystemSettings } = require("../models/systemSettings");
const { User } = require("../models/user");
```

เพิ่ม route ต่อท้าย route สุดท้ายใน `browserExtensionEndpoints(app)` ก่อนปิดฟังก์ชัน:

```javascript
  // Long-lived socket the extension holds open so agent tools can drive the
  // user's own Chrome. Browser WebSocket cannot set headers, so the key travels
  // as a query param — the same key /browser-companion/check accepts as a bearer.
  app.ws("/browser-companion/agent-socket", async function (socket, request) {
    try {
      const key = request?.query?.key;
      if (!key) return socket.close(4401);

      const apiKey = await BrowserExtensionApiKey.validate(String(key));
      if (!apiKey) return socket.close(4401);

      const multiUserMode = await SystemSettings.isMultiUserMode();
      if (multiUserMode) {
        if (apiKey.user_id === null) return socket.close(4403);
        const user = await User.get({ id: apiKey.user_id });
        if (!user || user.suspended) return socket.close(4403);
      }

      const { evicted } = registry.register({ userId: apiKey.user_id, socket });
      if (evicted) {
        // The replaced device must know why it went quiet — a silent drop reads
        // as a bug to whoever is watching that popup.
        try {
          evicted.send(JSON.stringify({ event: "evicted", reason: "Another device connected with this account." }));
          evicted.close(4409);
        } catch {
          // Already gone — nothing to tell.
        }
      }

      protocol.attach(socket);
      socket.on("close", () => registry.unregister({ userId: apiKey.user_id, socket }));
    } catch (error) {
      console.error("browser-companion agent socket error", error);
      try { socket.close(1011); } catch { /* already closed */ }
    }
  });
```

- [ ] **Step 4: รัน test ยืนยันว่าเขียว**

Run: `cd server && node ../node_modules/jest/bin/jest.js __tests__/endpoints/browserExtensionSocket.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add server/endpoints/browserExtension.js server/__tests__/endpoints/browserExtensionSocket.test.js
git commit -m "feat(browser-companion): authed WS endpoint with device eviction (#60)"
```

---

### Task 4: agent plugin — 11 tool ที่ agent มองเห็น

**Files:**
- Create: `server/utils/agents/aibitat/plugins/browser-companion.js`
- Modify: `server/utils/agents/aibitat/plugins/index.js`
- Modify: `frontend/src/pages/Admin/Agents/skills.jsx`
- Test: `server/__tests__/utils/agents/plugins/browser-companion.test.js`

**Interfaces:**
- Consumes: `registry.resolve` (Task 1), `protocol.send` (Task 2)
- Produces: `browserCompanion` plugin object, `browserCompanion.name === "browser-companion"`
  และ helper ที่ test เรียกตรงได้: `runCommand({ cmd, payload, userId, multiUserMode })` → `Promise<string>`

**หมายเหตุการลงทะเบียน:** **ห้ามใส่ `"browser-companion"` ใน `DEFAULT_ENABLED_SKILLS`** ของ
`server/models/workspaceAgentSettings.js` — เหตุผลเดียวกับที่ `sql-agent`/`filesystem-agent`/`web-scraping`
เป็น opt-in (#48 review): มันเข้าถึงของที่อยู่นอก workspace โดยไม่มี approval prompt ที่นี่หนักกว่านั้นอีก
เพราะเข้าถึง session ทุกอย่างในเบราว์เซอร์ผู้ใช้

- [ ] **Step 1: เขียน test ที่ต้องแดง**

```javascript
/* global jest */
const { describe, it, expect, beforeEach } = require("@jest/globals");
const registry = require("../../../../utils/browserCompanion/registry");
const { browserCompanion, runCommand } = require("../../../../utils/agents/aibitat/plugins/browser-companion");

function fakeSocket() {
  return { sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, on() {} };
}

describe("browser-companion plugin", () => {
  beforeEach(() => registry.__reset());

  it("exposes all eleven page tools", () => {
    expect(browserCompanion.name).toBe("browser-companion");
    const names = browserCompanion.toolNames;
    expect(names).toEqual(
      expect.arrayContaining([
        "page_state", "page_click", "page_type", "page_read", "page_scroll",
        "page_key", "page_tabs", "page_switch", "page_navigate", "page_close", "page_fetch",
      ])
    );
    expect(names).toHaveLength(11);
  });

  // @edge — browser ไม่ได้ต่อ ต้องตอบทันที ไม่ค้าง
  it("returns an offline message instead of hanging when nothing is connected", async () => {
    const out = await runCommand({ cmd: "click", payload: { id: 1 }, userId: 7, multiUserMode: true });
    expect(out).toMatch(/not connected/i);
  });

  // @edge — agent ที่ไม่มี user ห้ามได้เบราว์เซอร์ของคนอื่น
  it("refuses for an agent run with no user even when another user is connected", async () => {
    registry.register({ userId: 7, socket: fakeSocket() });
    const out = await runCommand({ cmd: "read", payload: {}, userId: undefined, multiUserMode: true });
    expect(out).toMatch(/no user/i);
  });

  // @edge — page_fetch ต้องรับ GET เท่านั้น และต้องไม่ส่งอะไรออก socket เลย
  it("rejects a non-GET page_fetch before it reaches the socket", async () => {
    const socket = fakeSocket();
    registry.register({ userId: 7, socket });
    const out = await runCommand({
      cmd: "fetch",
      payload: { url: "https://x.test/a", method: "POST" },
      userId: 7,
      multiUserMode: true,
    });
    expect(out).toMatch(/GET/);
    expect(socket.sent).toHaveLength(0);
  });

  it("sends the command over the resolved socket", async () => {
    const socket = fakeSocket();
    registry.register({ userId: 7, socket });
    runCommand({ cmd: "click", payload: { id: 12 }, userId: 7, multiUserMode: true });
    // send() is fire-then-await; the frame is written synchronously.
    expect(socket.sent[0]).toMatchObject({ cmd: "click", id: 12 });
    expect(socket.sent[0].requestId).toMatch(/^r_/);
  });
});
```

- [ ] **Step 2: รัน test ยืนยันว่าแดง**

Run: `cd server && node ../node_modules/jest/bin/jest.js __tests__/utils/agents/plugins/browser-companion.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: เขียน implementation**

```javascript
const registry = require("../../../browserCompanion/registry");
const protocol = require("../../../browserCompanion/protocol");
const { SystemSettings } = require("../../../../models/systemSettings");

// page_fetch exists to read what the DOM cannot show (canvas-drawn apps like
// Google Sheets) using the user's own session. Reads only: anything that writes
// must go through page_click, where the user can see what happened.
const ALLOWED_FETCH_METHOD = "GET";

async function runCommand({ cmd, payload = {}, userId, multiUserMode }) {
  if (cmd === "fetch") {
    const method = (payload.method ?? ALLOWED_FETCH_METHOD).toUpperCase();
    if (method !== ALLOWED_FETCH_METHOD)
      return `page_fetch only performs ${ALLOWED_FETCH_METHOD} requests. To change something on the page, use page_click so the user can see it happen.`;
  }

  const { socket, error } = registry.resolve({ userId, multiUserMode });
  if (!socket) return error;

  const result = await protocol.send({ socket, cmd, payload });
  if (!result.ok) return `Browser command failed: ${result.error}`;
  return typeof result.data === "string" ? result.data : JSON.stringify(result.data);
}

const TOOLS = [
  { name: "page_state", cmd: "state", description: "List the interactive elements on the agent's browser tab, each with an [id] to act on. Call this before page_click or page_type — a stale map means clicking the wrong thing.", properties: {} },
  { name: "page_click", cmd: "click", description: "Click an element by the [id] from page_state.", properties: { id: { type: "number", description: "The element [id] from page_state." } }, required: ["id"] },
  { name: "page_type", cmd: "type", description: "Type text into an element by the [id] from page_state.", properties: { id: { type: "number", description: "The element [id] from page_state." }, text: { type: "string", description: "Text to type." } }, required: ["id", "text"] },
  { name: "page_read", cmd: "read", description: "Read the visible text of the agent's browser tab as markdown.", properties: {} },
  { name: "page_scroll", cmd: "scroll", description: "Scroll the agent's browser tab.", properties: { direction: { type: "string", enum: ["up", "down"], description: "Which way to scroll." } }, required: ["direction"] },
  { name: "page_key", cmd: "key", description: "Press a key such as Enter, Tab or Escape.", properties: { key: { type: "string", description: "Key name, e.g. Enter." } }, required: ["key"] },
  { name: "page_tabs", cmd: "tabs", description: "List the tabs the agent has open.", properties: {} },
  { name: "page_switch", cmd: "switch", description: "Switch the agent to one of its own open tabs by URL substring.", properties: { url: { type: "string", description: "Substring of the target tab's URL." } }, required: ["url"] },
  { name: "page_navigate", cmd: "navigate", description: "Open a URL in the agent's own browser tab. The domain must be one the user allowed in the extension.", properties: { url: { type: "string", format: "uri", description: "Full URL including protocol." } }, required: ["url"] },
  { name: "page_close", cmd: "close", description: "Close one of the agent's own tabs.", properties: {} },
  { name: "page_fetch", cmd: "fetch", description: "GET a URL from inside the agent's tab, using the user's logged-in session, and return the body. Use for export endpoints and APIs behind a login — for example a Google Sheets CSV export, which page_read cannot see because the grid is drawn on canvas. Same-origin with the current tab only.", properties: { url: { type: "string", format: "uri", description: "Full URL to GET. Must be same-origin as the agent's current tab." } }, required: ["url"] },
];

const browserCompanion = {
  name: "browser-companion",
  toolNames: TOOLS.map((t) => t.name),
  startupConfig: { params: {} },
  plugin: function () {
    return {
      name: this.name,
      setup(aibitat) {
        for (const tool of TOOLS) {
          aibitat.function({
            super: aibitat,
            name: tool.name,
            description: tool.description,
            parameters: {
              $schema: "http://json-schema.org/draft-07/schema#",
              type: "object",
              properties: tool.properties,
              ...(tool.required ? { required: tool.required } : {}),
              additionalProperties: false,
            },
            handler: async function (args = {}) {
              try {
                const multiUserMode = await SystemSettings.isMultiUserMode();
                return await runCommand({
                  cmd: tool.cmd,
                  payload: args,
                  userId: aibitat?.handlerProps?.invocation?.user_id,
                  multiUserMode,
                });
              } catch (error) {
                const message = error?.message ?? JSON.stringify(error);
                this.super.handlerProps.log(`${tool.name} error: ${message}`);
                this.super.introspect(`${this.caller}: ${tool.name} error: ${message}`);
                return `The browser command could not run. Tell the user this error: ${message}`;
              }
            },
          });
        }
      },
    };
  },
};

module.exports = { browserCompanion, runCommand };
```

ใน `server/utils/agents/aibitat/plugins/index.js` เพิ่ม require, เพิ่มใน `module.exports` และเพิ่ม alias:

```javascript
const { browserCompanion } = require("./browser-companion.js");
// ...ใน module.exports:
  browserCompanion,
// ...ในบล็อก alias:
  [browserCompanion.name]: browserCompanion,
```

ใน `frontend/src/pages/Admin/Agents/skills.jsx` เพิ่ม entry ตามรูปแบบของ `"web-browsing"` ที่บรรทัด 117:

```javascript
  "browser-companion": {
    title: "Browser companion",
    description:
      "Let the agent click, type and read in your own Chrome through the AnythingLLM browser extension. Only the domains you allow in the extension can be touched.",
    skill: "browser-companion",
  },
```

- [ ] **Step 4: รัน test ยืนยันว่าเขียว**

Run: `cd server && node ../node_modules/jest/bin/jest.js __tests__/utils/agents/plugins/browser-companion.test.js`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add server/utils/agents/aibitat/plugins/browser-companion.js server/utils/agents/aibitat/plugins/index.js frontend/src/pages/Admin/Agents/skills.jsx server/__tests__/utils/agents/plugins/browser-companion.test.js
git commit -m "feat(browser-companion): agent plugin with 11 page tools, opt-in only (#60)"
```

---

### Task 5: scaffold the new extension

**Files:**
- Create: `browser-companion/package.json`
- Create: `browser-companion/vite.config.js`
- Create: `browser-companion/jest.config.mjs`
- Create: `browser-companion/.gitignore`
- Create: `browser-companion/index.html`
- Create: `browser-companion/public/manifest.json`
- Create: `browser-companion/src/background/index.js`
- Create: `browser-companion/src/main.jsx`
- Create: `browser-companion/src/App.jsx`
- Create: `browser-companion/README.md`

**Interfaces:**
- Produces: `dist/background.js` — bundled ES-module service worker that later tasks
  add imports to; and `dist/index.html` — the popup React root Task 9 fills in.

**ทำไมเป็นโฟลเดอร์ใหม่ ไม่ใช่แก้ `browser-extension/`:** `browser-extension/` เป็น git submodule
ชี้ไป `github.com/Mintplex-Labs/anythingllm-extension.git` (ดู `.gitmodules`) — commit ที่ลงในนั้น
เข้า repo ของ Mintplex ไม่ใช่ PR นี้ และ gate ของเราไม่ครอบ repo นอก ผู้ใช้ตัดสินให้สร้างใหม่ (2026-09-09)
submodule เดิมไม่ถูกแตะเลย

- [ ] **Step 1: สร้าง package.json**

```json
{
  "name": "anythingllm-browser-companion",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite build --watch",
    "build": "vite build",
    "test": "NODE_OPTIONS=--experimental-vm-modules node ../node_modules/jest/bin/jest.js",
    "lint": "prettier --ignore-path ../.prettierignore --write ./src"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.3.4"
  }
}
```

jest ไม่อยู่ใน devDependencies เพราะมีอยู่ที่ root ของ repo แล้ว (`../node_modules/jest`) —
เพิ่มซ้ำคือสองเวอร์ชันให้ดูแล ตรงกับที่ `server/package.json` ทำอยู่

- [ ] **Step 2: สร้าง vite.config.js**

```javascript
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "url";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        background: "src/background/index.js",
      },
      output: {
        // manifest.json names the service worker by a fixed filename, so this one
        // entry must not get a content hash the way the popup chunks do.
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
      },
    },
    outDir: "dist",
  },
  resolve: {
    alias: [{ find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) }],
  },
});
```

- [ ] **Step 3: สร้าง jest.config.mjs**

```javascript
// The service worker runs as an ES module, so its source is ESM. Jest reads it
// natively under --experimental-vm-modules rather than through a babel transform,
// which would be a second toolchain to keep in step with vite for no gain.
export default {
  testEnvironment: "node",
  transform: {},
};
```

- [ ] **Step 4: สร้าง .gitignore, index.html, main.jsx, App.jsx**

`.gitignore`:
```
node_modules
dist
```

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>AnythingLLM Browser Companion</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

`src/main.jsx`:
```javascript
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
```

`src/App.jsx` — Task 9 แทนที่ด้วย popup จริง ตัวนี้มีเพื่อให้ build ผ่านและพิสูจน์ว่า bundle ถูกทาง:
```javascript
export default function App() {
  return (
    <main style={{ width: 376, padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 15, margin: 0 }}>AnythingLLM Companion</h1>
      <p style={{ fontSize: 13, color: "#555" }}>
        Connect this browser to AnythingLLM to let an agent read and click here.
      </p>
    </main>
  );
}
```

- [ ] **Step 5: สร้าง public/manifest.json**

```json
{
  "manifest_version": 3,
  "name": "AnythingLLM Browser Companion",
  "version": "0.1.0",
  "description": "Let an AnythingLLM agent read and click in this browser, on the domains you allow.",
  "permissions": ["storage", "alarms", "tabs", "debugger"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "index.html"
  }
}
```

`"debugger"` คือ permission ที่ทำให้ทั้งงานนี้เป็นไปได้ — ยิง trusted input ผ่าน CDP
`"tabs"` จำเป็นเพราะ agent เปิดและอ่าน URL ของแท็บตัวเอง
ไม่ใส่ `"contextMenus"`/`"notifications"` เพราะ extension นี้ไม่มีเมนูคลิกขวา (นั่นเป็นงานของ
`browser-extension` ตัวเดิม) — permission ที่ไม่ได้ใช้คือพื้นที่โจมตีที่ขอมาเปล่าๆ

- [ ] **Step 6: สร้าง src/background/index.js — โครงที่ task 8 ต่อ**

```javascript
// Service worker entry. Task 8 wires the socket client in here; this file exists
// now so the vite build has its second input and the bundle path is proven.
console.info("AnythingLLM Browser Companion service worker loaded.");
```

- [ ] **Step 7: สร้าง README.md**

```markdown
# AnythingLLM Browser Companion

Lets an AnythingLLM agent read and click in your own Chrome, on the domains you
allow, using trusted CDP input via `chrome.debugger`.

This is a separate extension from `browser-extension/` (the save-to-workspace
companion, which is a git submodule of Mintplex's repo). Both can be installed.

## Install (unpacked)

1. `yarn install && yarn build`
2. Open `chrome://extensions`, enable Developer mode
3. Load unpacked, select this folder's `dist/`
4. Click the extension, paste your AnythingLLM browser-extension API key
5. Open the domains you want the agent to touch — everything is off by default

Chrome shows a "DevTools is debugging this tab" bar on any tab the agent drives.
That bar cannot be hidden; it is Chrome telling you the truth about what is happening.

## Test

    yarn test
```

- [ ] **Step 8: install แล้ว build ยืนยันว่าได้ไฟล์จริง**

```bash
cd browser-companion && yarn install && yarn build
test -f dist/background.js && test -f dist/index.html && echo "BUNDLE OK"
```
Expected: `BUNDLE OK`

- [ ] **Step 9: Commit**

```bash
git add browser-companion
git commit -m "build(browser-companion): scaffold new MV3 extension with debugger permission (#60)"
```

### Task 6: allowlist gate — ด่านความปลอดภัยฝั่งผู้ใช้

**Files:**
- Create: `browser-companion/src/background/allowlist.js`
- Create: `browser-companion/src/background/auditLog.js`
- Test: `browser-companion/__tests__/allowlist.test.js`
(package.json + jest.config.mjs สร้างแล้วใน Task 5 — task นี้ไม่แตะ build config)

**Interfaces:**
- Consumes: `chrome.storage.local`
- Produces:
  - `isAllowed(url, allowlist)` → `boolean` — pure function, test ได้ไม่ต้องมี chrome
  - `loadAllowlist()` → `Promise<string[]>` — อ่านจาก storage, ไม่มี = `[]`
  - `auditLog.record({ cmd, url, outcome, detail })` → `Promise<void>`

**ทำไม gate อยู่ฝั่งนี้:** server ถูก compromise ได้ แต่ extension คือของที่ผู้ใช้ติดตั้งเอง
ถ้า allowlist อยู่ที่ server อย่างเดียว server ที่ถูกแฮ็กสั่งอะไรก็ได้ในทุก session ที่ผู้ใช้ login ค้าง

- [ ] **Step 1: เขียน test ที่ต้องแดง**

```javascript
import { describe, it, expect } from "@jest/globals";
import { isAllowed } from "../src/background/allowlist.js";

describe("allowlist", () => {
  it("denies everything when the list is empty", () => {
    expect(isAllowed("https://www.linkedin.com/feed/", [])).toBe(false);
  });

  it("allows an exact host match", () => {
    expect(isAllowed("https://www.linkedin.com/feed/", ["www.linkedin.com"])).toBe(true);
  });

  it("allows a subdomain under a wildcard entry", () => {
    expect(isAllowed("https://app.flowaccount.com/x", ["*.flowaccount.com"])).toBe(true);
  });

  // @edge — wildcard ต้องไม่ครอบโดเมนแม่ที่ไม่ได้ขอ
  it("does not let a wildcard entry match a lookalike domain", () => {
    expect(isAllowed("https://flowaccount.com.evil.test/", ["*.flowaccount.com"])).toBe(false);
  });

  // @edge — สตริงต่อท้ายห้ามผ่าน (notlinkedin.com)
  it("does not match a host that merely ends with an allowed host", () => {
    expect(isAllowed("https://notlinkedin.com/", ["linkedin.com"])).toBe(false);
  });

  it("denies a non-http scheme even if the host is allowed", () => {
    expect(isAllowed("file:///etc/passwd", ["*"])).toBe(false);
    expect(isAllowed("chrome://settings", ["*"])).toBe(false);
  });

  it("denies a malformed url rather than throwing", () => {
    expect(isAllowed("not a url", ["linkedin.com"])).toBe(false);
  });

  it("is case-insensitive on the host", () => {
    expect(isAllowed("https://WWW.LinkedIn.com/", ["www.linkedin.com"])).toBe(true);
  });
});
```

- [ ] **Step 2: รัน test ยืนยันว่าแดง**



และสร้าง `browser-companion/jest.config.mjs`:

```javascript
// The service worker runs as an ES module, so its source is ESM. Jest reads it
// natively with --experimental-vm-modules rather than through a babel transform,
// which would be a second toolchain to keep in step with vite for no gain.
export default { testEnvironment: "node", transform: {} };
```

Run: `cd browser-companion && NODE_OPTIONS=--experimental-vm-modules node ../node_modules/jest/bin/jest.js __tests__/allowlist.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: เขียน implementation**

`src/background/allowlist.js`:

```javascript
const STORAGE_KEY = "companionAllowlist";

// chrome.debugger can only attach to http(s) pages, and any other scheme is a
// way to reach outside the web (file://) so it is refused before host matching.
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * @param {string} url
 * @param {string[]} allowlist hosts, optionally prefixed "*." for subdomains
 * @returns {boolean}
 */
export function isAllowed(url, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;

  let host;
  try {
    const parsed = new URL(url);
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }

  return allowlist.some((raw) => {
    const entry = String(raw).trim().toLowerCase();
    if (!entry) return false;
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      // "*.example.com" covers example.com and its subdomains, and nothing that
      // merely contains the string — "example.com.evil.test" must not match.
      return host === base || host.endsWith(`.${base}`);
    }
    return host === entry;
  });
}

export async function loadAllowlist() {
  const stored = await chrome.storage.local.get([STORAGE_KEY]);
  const list = stored?.[STORAGE_KEY];
  return Array.isArray(list) ? list : [];
}

export async function saveAllowlist(list) {
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
}

export { STORAGE_KEY };
```

`src/background/auditLog.js`:

```javascript
const STORAGE_KEY = "companionAuditLog";

// Enough to review a full agent run without letting extension storage grow
// without bound. Not environment-dependent, so it stays inline.
const MAX_ENTRIES = 500;

export async function record({ cmd, url = null, outcome, detail = null }) {
  const stored = await chrome.storage.local.get([STORAGE_KEY]);
  const entries = Array.isArray(stored?.[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
  entries.push({ at: new Date().toISOString(), cmd, url, outcome, detail });
  await chrome.storage.local.set({ [STORAGE_KEY]: entries.slice(-MAX_ENTRIES) });
}

export async function readAll() {
  const stored = await chrome.storage.local.get([STORAGE_KEY]);
  return Array.isArray(stored?.[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
}

export async function clear() {
  await chrome.storage.local.remove([STORAGE_KEY]);
}

export { STORAGE_KEY, MAX_ENTRIES };
```

- [ ] **Step 4: รัน test ยืนยันว่าเขียว**

Run: `cd browser-companion && NODE_OPTIONS=--experimental-vm-modules node ../node_modules/jest/bin/jest.js __tests__/allowlist.test.js`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add browser-companion/src/background/allowlist.js browser-companion/src/background/auditLog.js browser-companion/__tests__/allowlist.test.js browser-companion/package.json browser-companion/yarn.lock
git commit -m "feat(browser-companion): extension-side allowlist gate and audit log (#60)"
```

---

### Task 7: CDP layer — trusted input + page_state + page_fetch

**Files:**
- Create: `browser-companion/src/background/cdp.js`
- Create: `browser-companion/src/background/pageState.js`
- Create: `browser-companion/src/background/dispatch.js`
- Test: `browser-companion/__tests__/dispatch.test.js`

**Interfaces:**
- Consumes: `isAllowed`/`loadAllowlist` (Task 6), `auditLog.record` (Task 6), `chrome.debugger`, `chrome.tabs`
- Produces:
  - `cdp.attach(tabId)` / `cdp.detachAll()` → `Promise<void>`
  - `cdp.click(tabId, x, y)` / `cdp.type(tabId, text)` / `cdp.key(tabId, key)` → `Promise<void>`
  - `pageState.capture(tabId)` → `Promise<{elements: Array<{id, tag, text, x, y}>}>`
  - `dispatch.handle(command, deps)` → `Promise<{requestId, ok, data|error}>` — deps ฉีดได้เพื่อ test

- [ ] **Step 1: เขียน test ที่ต้องแดง**

```javascript
import { describe, it, expect, jest as j } from "@jest/globals";
import { handle } from "../src/background/dispatch.js";

function deps(overrides = {}) {
  return {
    loadAllowlist: async () => ["www.linkedin.com"],
    record: j.fn(async () => {}),
    agentTabUrl: async () => "https://www.linkedin.com/feed/",
    ensureAgentTab: j.fn(async () => 391),
    cdp: {
      attach: j.fn(async () => {}),
      click: j.fn(async () => {}),
      type: j.fn(async () => {}),
      key: j.fn(async () => {}),
      fetch: j.fn(async () => "col_a,col_b\n1,2\n"),
      navigate: j.fn(async () => {}),
      detachAll: j.fn(async () => {}),
    },
    pageState: { capture: j.fn(async () => ({ elements: [{ id: 12, tag: "button", text: "Message", x: 412, y: 268 }] })) },
    lookup: j.fn(async (tabId, id) => (id === 12 ? { x: 412, y: 268 } : null)),
    ...overrides,
  };
}

describe("dispatch", () => {
  it("echoes the requestId back on every reply", async () => {
    const out = await handle({ requestId: "r_1", cmd: "state" }, deps());
    expect(out.requestId).toBe("r_1");
    expect(out.ok).toBe(true);
  });

  it("clicks at the coordinates the element map gave", async () => {
    const d = deps();
    await handle({ requestId: "r_2", cmd: "click", id: 12 }, d);
    expect(d.cdp.click).toHaveBeenCalledWith(391, 412, 268);
  });

  // @edge — โดเมนที่ไม่ได้อนุญาต ต้องถูกปฏิเสธก่อน attach และต้องถูกบันทึก
  it("denies a command on a domain outside the allowlist before attaching", async () => {
    const d = deps({ agentTabUrl: async () => "https://docs.google.com/x" });
    const out = await handle({ requestId: "r_3", cmd: "read" }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/allowlist/i);
    expect(d.cdp.attach).not.toHaveBeenCalled();
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  // @edge — navigate ต้องเช็ค URL เป้าหมาย ไม่ใช่ URL ปัจจุบัน
  it("checks the target url on navigate, not the current one", async () => {
    const d = deps();
    const out = await handle({ requestId: "r_4", cmd: "navigate", url: "https://docs.google.com/x" }, d);
    expect(out.ok).toBe(false);
    expect(d.cdp.navigate).not.toHaveBeenCalled();
  });

  // @edge — page_fetch ต้อง same-origin กับแท็บที่เปิดอยู่
  it("refuses a cross-origin page_fetch", async () => {
    const d = deps();
    const out = await handle({ requestId: "r_5", cmd: "fetch", url: "https://docs.google.com/export" }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/same-origin/i);
    expect(d.cdp.fetch).not.toHaveBeenCalled();
  });

  it("returns the body of a same-origin page_fetch", async () => {
    const d = deps();
    const out = await handle({ requestId: "r_6", cmd: "fetch", url: "https://www.linkedin.com/api/x" }, d);
    expect(out.ok).toBe(true);
    expect(out.data).toBe("col_a,col_b\n1,2\n");
  });

  // @edge — id ที่ไม่มีในผังต้องได้ error ที่บอกให้เรียก page_state ใหม่
  it("tells the agent to re-read page_state when the id is unknown", async () => {
    const d = deps({ lookup: async () => null });
    const out = await handle({ requestId: "r_7", cmd: "click", id: 999 }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/page_state/);
  });

  it("records every successful command in the audit log", async () => {
    const d = deps();
    await handle({ requestId: "r_8", cmd: "click", id: 12 }, d);
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({ cmd: "click", outcome: "ok" }));
  });
});
```

- [ ] **Step 2: รัน test ยืนยันว่าแดง**

Run: `cd browser-companion && NODE_OPTIONS=--experimental-vm-modules node ../node_modules/jest/bin/jest.js __tests__/dispatch.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: เขียน implementation**

`src/background/cdp.js`:

```javascript
const CDP_VERSION = "1.3";

// Randomized gap between keystrokes. A fixed cadence is itself a bot signal —
// the same reason open-computer/services/interface-service/utils/cdp-input.js
// randomizes. Range chosen to sit inside human typing speed.
const KEYSTROKE_MIN_MS = 30;
const KEYSTROKE_JITTER_MS = 60;

const attached = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function send(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, CDP_VERSION);
  attached.add(tabId);
}

export async function detachAll() {
  for (const tabId of [...attached]) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Tab already gone; nothing to detach.
    }
    attached.delete(tabId);
  }
}

export async function click(tabId, x, y) {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

export async function type(tabId, text) {
  for (const char of String(text)) {
    await send(tabId, "Input.insertText", { text: char });
    await sleep(KEYSTROKE_MIN_MS + Math.floor(Math.random() * KEYSTROKE_JITTER_MS));
  }
}

export async function key(tabId, keyName) {
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: keyName });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: keyName });
}

export async function scroll(tabId, direction) {
  const deltaY = direction === "up" ? -600 : 600;
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY });
}

export async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
}

export async function evaluate(tabId, expression) {
  const result = await send(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed");
  return result?.result?.value;
}

export async function fetchInPage(tabId, url) {
  return await evaluate(
    tabId,
    `fetch(${JSON.stringify(url)}, { credentials: "include" }).then((r) => r.text())`
  );
}
```

`src/background/pageState.js`:

```javascript
import { evaluate } from "./cdp.js";

// Cap the map so a huge page cannot blow past the model's context. The agent can
// scroll and re-read rather than receive a truncated 5000-element dump.
const MAX_ELEMENTS = 150;

const CAPTURE_EXPRESSION = `(() => {
  const selector = 'a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]';
  const out = [];
  let id = 1;
  for (const el of document.querySelectorAll(selector)) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.bottom < 0 || rect.top > innerHeight) continue;
    out.push({
      id: id++,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    });
    if (out.length >= ${MAX_ELEMENTS}) break;
  }
  return { url: location.href, title: document.title, elements: out };
})()`;

/** @type {Map<number, Map<number, {x:number,y:number}>>} tabId → element id → point */
const maps = new Map();

export async function capture(tabId) {
  const state = await evaluate(tabId, CAPTURE_EXPRESSION);
  const points = new Map();
  for (const el of state?.elements ?? []) points.set(el.id, { x: el.x, y: el.y });
  maps.set(tabId, points);
  return state;
}

export async function lookup(tabId, id) {
  return maps.get(tabId)?.get(Number(id)) ?? null;
}

export { MAX_ELEMENTS };
```

`src/background/dispatch.js`:

```javascript
import { isAllowed } from "./allowlist.js";

// Commands that read or act on the page the agent is already on, so the gate
// checks the tab's current url. "navigate" is not here: it carries its own
// target, which is what must be checked instead.
const CURRENT_URL_COMMANDS = new Set(["state", "click", "type", "read", "scroll", "key", "close"]);

function reply(requestId, patch) {
  return { requestId, ...patch };
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * @param {{requestId: string, cmd: string, [k: string]: any}} command
 * @param {object} deps injected so this is testable without a real browser
 */
export async function handle(command, deps) {
  const { requestId, cmd } = command;
  const { loadAllowlist, record, agentTabUrl, ensureAgentTab, cdp, pageState, lookup } = deps;

  try {
    if (cmd === "tabs" || cmd === "switch") {
      const url = await agentTabUrl();
      await record({ cmd, url, outcome: "ok" });
      return reply(requestId, { ok: true, data: { url } });
    }

    const allowlist = await loadAllowlist();

    // The url the gate must judge differs by command: navigate is judged on
    // where it is going, everything else on where the tab already is.
    const currentUrl = await agentTabUrl();
    const subject =
      cmd === "navigate" ? command.url : cmd === "fetch" ? command.url : currentUrl;

    if (!isAllowed(subject, allowlist)) {
      await record({ cmd, url: subject, outcome: "denied", detail: "not in allowlist" });
      return reply(requestId, {
        ok: false,
        error: `denied: ${subject} is not in the allowlist the user set in the extension.`,
      });
    }

    if (cmd === "fetch" && !sameOrigin(command.url, currentUrl)) {
      await record({ cmd, url: command.url, outcome: "denied", detail: "cross-origin" });
      return reply(requestId, {
        ok: false,
        error: `denied: page_fetch must be same-origin as the current tab (${currentUrl}). Use page_navigate first.`,
      });
    }

    const tabId = await ensureAgentTab();
    await cdp.attach(tabId);

    switch (cmd) {
      case "state": {
        const data = await pageState.capture(tabId);
        await record({ cmd, url: currentUrl, outcome: "ok" });
        return reply(requestId, { ok: true, data });
      }
      case "click":
      case "type": {
        const point = await lookup(tabId, command.id);
        if (!point) {
          await record({ cmd, url: currentUrl, outcome: "error", detail: `unknown id ${command.id}` });
          return reply(requestId, {
            ok: false,
            error: `No element [${command.id}] on this page. Call page_state again — the page changed since the last map.`,
          });
        }
        await cdp.click(tabId, point.x, point.y);
        if (cmd === "type") await cdp.type(tabId, command.text);
        await record({ cmd, url: currentUrl, outcome: "ok", detail: `id ${command.id}` });
        return reply(requestId, { ok: true, data: { url: currentUrl } });
      }
      case "read": {
        const data = await pageState.capture(tabId);
        await record({ cmd, url: currentUrl, outcome: "ok" });
        return reply(requestId, { ok: true, data });
      }
      case "scroll": {
        await cdp.scroll(tabId, command.direction);
        await record({ cmd, url: currentUrl, outcome: "ok" });
        return reply(requestId, { ok: true, data: { url: currentUrl } });
      }
      case "key": {
        await cdp.key(tabId, command.key);
        await record({ cmd, url: currentUrl, outcome: "ok", detail: command.key });
        return reply(requestId, { ok: true, data: { url: currentUrl } });
      }
      case "navigate": {
        await cdp.navigate(tabId, command.url);
        await record({ cmd, url: command.url, outcome: "ok" });
        return reply(requestId, { ok: true, data: { url: command.url } });
      }
      case "fetch": {
        const body = await cdp.fetch(tabId, command.url);
        await record({ cmd, url: command.url, outcome: "ok" });
        return reply(requestId, { ok: true, data: body });
      }
      case "close": {
        await cdp.detachAll();
        await record({ cmd, url: currentUrl, outcome: "ok" });
        return reply(requestId, { ok: true, data: null });
      }
      default:
        return reply(requestId, { ok: false, error: `Unknown command "${cmd}".` });
    }
  } catch (error) {
    const detail = error?.message ?? String(error);
    await record({ cmd, url: null, outcome: "error", detail });
    return reply(requestId, { ok: false, error: detail });
  }
}

export { CURRENT_URL_COMMANDS };
```

- [ ] **Step 4: รัน test ยืนยันว่าเขียว**

Run: `cd browser-companion && NODE_OPTIONS=--experimental-vm-modules node ../node_modules/jest/bin/jest.js __tests__/dispatch.test.js`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add browser-companion/src/background/cdp.js browser-companion/src/background/pageState.js browser-companion/src/background/dispatch.js browser-companion/__tests__/dispatch.test.js
git commit -m "feat(browser-companion): CDP trusted input, page_state map, same-origin page_fetch (#60)"
```

---

### Task 8: socket client + keepalive + agent tab

**Files:**
- Create: `browser-companion/src/background/socket.js`
- Modify: `browser-companion/src/background/index.js`
- Test: `browser-companion/__tests__/socket.test.js`

**Interfaces:**
- Consumes: `handle` (Task 7), `chrome.storage.sync` (apiBase/apiKey ที่ Config.jsx เขียนไว้แล้ว), `chrome.alarms`
- Produces:
  - `connect({ apiBase, apiKey, onCommand })` → `Promise<void>`
  - `wsUrlFor(apiBase, apiKey)` → `string` — แปลง `http(s)://host/api` → `ws(s)://host/api/browser-companion/agent-socket?key=...`
  - `ensureAgentTab()` → `Promise<number>` — แท็บของ agent เอง สร้างใหม่ถ้ายังไม่มี
  - `state()` → `{ status: "idle"|"online"|"evicted", lastError }`

**ทำไมต้องมี keepalive:** MV3 service worker ตายเมื่อ idle ~30 วิ — WS ที่ตายไปพร้อมกันทำให้ agent เห็น offline
ตลอด `chrome.alarms` ที่ต่ำกว่า 1 นาทีทำงานเฉพาะ unpacked extension ซึ่งตรงกับแผนแจกรอบนี้
(สเปกข้อจำกัดข้อ 3) — **บิลมาถึงถ้าขึ้น Web Store: ต้องเปลี่ยนไปใช้ WS ping จากฝั่ง server แทน**

- [ ] **Step 1: เขียน test ที่ต้องแดง**

```javascript
import { describe, it, expect } from "@jest/globals";
import { wsUrlFor } from "../src/background/socket.js";

describe("wsUrlFor", () => {
  it("upgrades https to wss and keeps the api path", () => {
    expect(wsUrlFor("https://workspace.approof.studio/api", "brx-abc")).toBe(
      "wss://workspace.approof.studio/api/browser-companion/agent-socket?key=brx-abc"
    );
  });

  it("upgrades http to ws for a local server", () => {
    expect(wsUrlFor("http://localhost:3001/api", "brx-abc")).toBe(
      "ws://localhost:3001/api/browser-companion/agent-socket?key=brx-abc"
    );
  });

  it("tolerates a trailing slash on apiBase", () => {
    expect(wsUrlFor("https://x.test/api/", "brx-abc")).toBe(
      "wss://x.test/api/browser-companion/agent-socket?key=brx-abc"
    );
  });

  // @edge — key ต้องถูก encode ไม่ใช่ต่อสตริงดิบ
  it("url-encodes the key", () => {
    expect(wsUrlFor("https://x.test/api", "brx-a b&c")).toContain("key=brx-a%20b%26c");
  });

  it("throws on a malformed apiBase instead of building a broken url", () => {
    expect(() => wsUrlFor("not a url", "brx-abc")).toThrow();
  });
});
```

- [ ] **Step 2: รัน test ยืนยันว่าแดง**

Run: `cd browser-companion && NODE_OPTIONS=--experimental-vm-modules node ../node_modules/jest/bin/jest.js __tests__/socket.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: เขียน implementation**

`src/background/socket.js`:

```javascript
const SOCKET_PATH = "browser-companion/agent-socket";

// MV3 kills an idle service worker at ~30s. An alarm under a minute only fires
// for an unpacked extension, which matches this round's distribution plan
// (spec limitation 3). On the Web Store this must move to a server-side ping.
const KEEPALIVE_ALARM = "companionKeepalive";
const KEEPALIVE_MINUTES = 25 / 60;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let socket = null;
let status = "idle";
let lastError = null;
let reconnectDelay = RECONNECT_BASE_MS;
let agentTabId = null;

export function wsUrlFor(apiBase, apiKey) {
  const base = new URL(String(apiBase).replace(/\/+$/, "") + "/");
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(SOCKET_PATH, base);
  url.searchParams.set("key", apiKey);
  return url.toString();
}

export function state() {
  return { status, lastError };
}

export async function ensureAgentTab() {
  if (agentTabId !== null) {
    try {
      const tab = await chrome.tabs.get(agentTabId);
      if (tab) return agentTabId;
    } catch {
      agentTabId = null; // Closed by the user.
    }
  }
  // The agent gets its own tab so it never takes over what the user is reading.
  // Same profile, so it still carries the user's cookies and session.
  const created = await chrome.tabs.create({ url: "about:blank", active: false });
  agentTabId = created.id;
  return agentTabId;
}

export async function agentTabUrl() {
  const tabId = await ensureAgentTab();
  const tab = await chrome.tabs.get(tabId);
  return tab?.url ?? "about:blank";
}

export async function connect({ apiBase, apiKey, onCommand }) {
  if (!apiBase || !apiKey) {
    status = "idle";
    return;
  }

  socket = new WebSocket(wsUrlFor(apiBase, apiKey));

  socket.onopen = () => {
    status = "online";
    lastError = null;
    reconnectDelay = RECONNECT_BASE_MS;
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MINUTES });
  };

  socket.onmessage = async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return; // A frame we cannot read is not a frame we can answer.
    }

    if (message.event === "evicted") {
      status = "evicted";
      lastError = message.reason ?? "Another device connected with this account.";
      return; // Server closes this socket next; do not reconnect over the new one.
    }

    const result = await onCommand(message);
    socket?.send(JSON.stringify(result));
  };

  socket.onclose = () => {
    chrome.alarms.clear(KEEPALIVE_ALARM);
    if (status === "evicted") return;
    status = "idle";
    setTimeout(() => connect({ apiBase, apiKey, onCommand }), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  };

  socket.onerror = () => {
    lastError = "Could not reach the AnythingLLM server.";
  };
}

export function ping() {
  // Any traffic resets the MV3 idle timer, which is the whole point.
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event: "ping" }));
}

export { KEEPALIVE_ALARM };
```

ใน `src/background/index.js` เพิ่มที่ท้ายไฟล์:

```javascript
import { handle } from "./dispatch.js";
import { loadAllowlist } from "./allowlist.js";
import { record } from "./auditLog.js";
import * as cdp from "./cdp.js";
import * as pageState from "./pageState.js";
import * as socket from "./socket.js";

async function startCompanion() {
  const { apiBase, apiKey } = await chrome.storage.sync.get(["apiBase", "apiKey"]);
  await socket.connect({
    apiBase,
    apiKey,
    onCommand: (command) =>
      handle(command, {
        loadAllowlist,
        record,
        agentTabUrl: socket.agentTabUrl,
        ensureAgentTab: socket.ensureAgentTab,
        cdp: { ...cdp, fetch: cdp.fetchInPage },
        pageState,
        lookup: pageState.lookup,
      }),
  });
}

chrome.runtime.onStartup.addListener(startCompanion);
chrome.runtime.onInstalled.addListener(startCompanion);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes.apiBase || changes.apiKey)) startCompanion();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === socket.KEEPALIVE_ALARM) socket.ping();
});
```

- [ ] **Step 4: รัน test ยืนยันว่าเขียว**

Run: `cd browser-companion && NODE_OPTIONS=--experimental-vm-modules node ../node_modules/jest/bin/jest.js __tests__/socket.test.js`
Expected: PASS — 5 tests

- [ ] **Step 5: build ยืนยันว่า bundle ไม่พัง**

```bash
cd browser-companion && yarn build && grep -q "agent-socket" dist/background.js && echo "BUNDLE OK"
```
Expected: `BUNDLE OK`

- [ ] **Step 6: Commit**

```bash
git add browser-companion/src/background/socket.js browser-companion/src/background/index.js browser-companion/__tests__/socket.test.js
git commit -m "feat(browser-companion): socket client, keepalive, agent-owned tab (#60)"
```

---

### Task 9: popup UI 4 แท็บ + E2E headed

**Files:**
- Create: `browser-companion/src/components/CompanionPanel/index.jsx`
- Create: `browser-companion/src/components/CompanionPanel/DomainsTab.jsx`
- Create: `browser-companion/src/components/CompanionPanel/ActivityTab.jsx`
- Create: `browser-companion/src/components/CompanionPanel/HistoryTab.jsx`
- Modify: `browser-companion/src/App.jsx`
- Test: `e2e/browser-companion-popup.spec.js`

**Interfaces:**
- Consumes: `loadAllowlist`/`saveAllowlist` (Task 6), `auditLog.readAll` (Task 6), `socket.state()` (Task 8)
- Produces: popup ตาม mockup `docs/superpowers/mockups/browser-companion-bridge.html` (commit `f73f0cc7`)

**ต้องมีตาม mockup:**
- 4 แท็บ: เชื่อมต่อ / โดเมน / กำลังทำ / ประวัติ
- **ปุ่ม "ตัดทุกแท็บ" อยู่ทุกแท็บ** ไม่ใช่แท็บเดียว — เวลาจะหยุด ไม่ควรต้องหาว่าปุ่มอยู่ไหน
- allowlist toggle ปิดหมดตั้งแต่แรก
- pause / resume สำหรับ captcha/OTP + **ปุ่มพาไปแท็บของ agent**
- แจ้งเมื่อถูกเตะ (status `evicted`)
- ดาวน์โหลด audit log

- [ ] **Step 1: เขียน E2E ที่ต้องแดง**

```javascript
import { test, expect } from "@playwright/test";

// The popup is a plain React page, so it loads over http for E2E. chrome.* is
// stubbed because the assertions here are about the UI contract, not CDP.
const POPUP = "/index.html";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const store = { companionAllowlist: [], companionAuditLog: [] };
    window.chrome = {
      storage: {
        local: {
          get: async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, store[k]])),
          set: async (patch) => Object.assign(store, patch),
          remove: async (keys) => [].concat(keys).forEach((k) => delete store[k]),
        },
        sync: { get: async () => ({ apiBase: "http://localhost:3001/api", apiKey: "brx-test" }) },
      },
      runtime: { sendMessage: async () => ({ status: "online", lastError: null }) },
      tabs: { update: async () => {} },
    };
  });
  await page.goto(POPUP);
});

test("kill switch is reachable from every tab", async ({ page }) => {
  for (const tab of ["เชื่อมต่อ", "โดเมน", "กำลังทำ", "ประวัติ"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("button", { name: /ตัดทุกแท็บ/ })).toBeVisible();
  }
});

test("the allowlist starts empty so nothing is reachable by default @edge", async ({ page }) => {
  await page.getByRole("tab", { name: "โดเมน" }).click();
  await expect(page.getByText(/ยังไม่ได้เปิดโดเมนไหน/)).toBeVisible();
  await expect(page.getByRole("switch")).toHaveCount(0);
});

test("a domain the user adds starts switched off @edge", async ({ page }) => {
  await page.getByRole("tab", { name: "โดเมน" }).click();
  await page.getByRole("button", { name: /เพิ่มโดเมน/ }).click();
  await page.getByRole("textbox", { name: /โดเมน/ }).fill("www.linkedin.com");
  await page.getByRole("button", { name: /บันทึก/ }).click();
  await expect(page.getByRole("switch", { name: "www.linkedin.com" })).toHaveAttribute("aria-checked", "false");
});

test("pause offers a way to reach the agent's tab", async ({ page }) => {
  await page.getByRole("tab", { name: "กำลังทำ" }).click();
  await expect(page.getByRole("button", { name: /ไปที่แท็บของ agent/ })).toBeVisible();
});
```

- [ ] **Step 2: รัน E2E ยืนยันว่าแดง**

Run: `cd browser-companion && npx playwright test --headed e2e/browser-companion-popup.spec.js`
Expected: FAIL — ไม่มีแท็บใน UI

- [ ] **Step 3: เขียน popup ตาม mockup**

สร้าง component ตาม mockup `docs/superpowers/mockups/browser-companion-bridge.html` commit `f73f0cc7`
โครงที่ต้องมี (ไม่ลอก HTML mockup มาเป็นโค้ดจริง — mockup เป็นของทิ้ง):

- `index.jsx` — tab state + `<KillSwitch />` render ทุกแท็บ
- `DomainsTab.jsx` — `loadAllowlist()` → list + toggle → `saveAllowlist()` · empty state "ยังไม่ได้เปิดโดเมนไหน — agent แตะอะไรไม่ได้"
- `ActivityTab.jsx` — status จาก `socket.state()` · pause/resume · ปุ่ม "ไปที่แท็บของ agent" (`chrome.tabs.update(agentTabId, {active:true})`) · แจ้งเมื่อ `evicted`
- `HistoryTab.jsx` — `auditLog.readAll()` + ปุ่มดาวน์โหลด

- [ ] **Step 4: รัน E2E headed ยืนยันว่าเขียว + เขียน report ให้ gate**

```bash
cd browser-companion
npx playwright test --headed --reporter=json e2e/browser-companion-popup.spec.js > ../.infi/e2e-report.json
```
Expected: ทุก case PASS และมี `@edge` ผ่านอย่างน้อย 1 case

- [ ] **Step 5: Commit**

```bash
git add browser-companion/src/components/CompanionPanel browser-companion/src/App.jsx browser-companion/e2e
git commit -m "feat(browser-companion): popup with allowlist, kill switch, audit log (#60)"
```

---

## Self-Review

**1. Spec coverage**

| requirement ในสเปก | task |
|---|---|
| WS route + socket registry + auth | 1, 3 |
| route ตาม user_id ไม่ใช่ workspace | 1 (test: "never hands one user's socket to another") |
| key null ใช้ได้เฉพาะ single-user | 1 (test @edge) + 3 (close 4403) |
| agent ไม่มี user ได้ offline | 1 (test @edge) + 4 (test @edge) |
| หนึ่ง user หนึ่ง socket + แจ้งเมื่อถูกเตะ | 1 (evict), 3 (ส่ง event), 8 (status), 9 (UI) |
| wire protocol + requestId | 2 |
| debugger permission + attach/detach | 5 (manifest), 7 (cdp.js) |
| allowlist gate ฝั่ง extension default deny | 6 |
| CDP input + human delay | 7 (cdp.js) |
| page_state element map + [id] | 7 (pageState.js) |
| page_fetch GET only + same-origin | 4 (GET gate), 7 (same-origin gate) |
| agent เปิดแท็บใหม่เอง | 8 (`ensureAgentTab`) |
| browser offline ตอบทันที | 2 (timeout), 4 (resolve error) |
| keepalive + reconnect | 8 |
| popup 4 แท็บ + kill switch + audit log | 6 (auditLog), 9 (UI) |
| ปุ่มพาไปแท็บ agent | 9 |
| E2E headed + @edge | 9 |
| ไม่แตะ schema | ทุก task — ไม่มี migration ในแผน |
| opt-in ไม่ใส่ DEFAULT_ENABLED_SKILLS | 4 |

ไม่มีข้อไหนไม่มี task

**2. Placeholder scan** — ไม่มี TBD/TODO · ทุก step ที่ต้องเขียนโค้ดมี code block จริง · ไม่มี "similar to Task N"

**3. Type consistency**

- `registry.resolve({userId, multiUserMode})` → `{socket, error}` — ใช้ตรงกันใน task 1, 3, 4
- `protocol.send({socket, cmd, payload, timeoutMs})` → `{ok, data, error}` — task 2, 4
- `handle(command, deps)` → `{requestId, ok, data|error}` — task 7 (impl), 8 (`onCommand`)
- `pageState.capture(tabId)` / `pageState.lookup(tabId, id)` — task 7 (impl), 8 (inject)
- `cdp.fetchInPage` ถูก map เป็น `cdp.fetch` ใน task 8 ตรงกับที่ `dispatch` เรียก (`deps.cdp.fetch`) — ตรงกัน
- `isAllowed(url, allowlist)` — task 6 (impl), 7 (import)
- `loadAllowlist()` / `saveAllowlist(list)` — task 6, 8, 9
- `auditLog.record({cmd,url,outcome,detail})` / `readAll()` — task 6, 7, 9
- `socket.state()` → `{status, lastError}` — task 8, 9

**หมายเหตุ 1: task ถูกแบ่งเป็น 9 ไม่ใช่ 8** — สเปกรวมงาน scaffold ไว้ในงาน extension
แต่ extension ต้องมีตัวตนก่อน (package.json, vite input, manifest) ไม่งั้นทุกไฟล์ของ task 6-8
`import` ไม่ได้เลย จึงแยกเป็น task 5

**หมายเหตุ 2: extension อยู่ที่ `browser-companion/` ไม่ใช่ `browser-extension/`** —
`browser-extension/` เป็น git submodule ชี้ไป `github.com/Mintplex-Labs/anythingllm-extension.git`
(ดู `.gitmodules`) commit ที่ลงในนั้นจะเข้า repo ของ Mintplex ไม่ใช่ PR นี้ และ gate ของเราไม่ครอบ
repo นอก ผู้ใช้ตัดสินให้สร้างใหม่ (2026-09-09) submodule เดิมไม่ถูกแตะ

**หมายเหตุ 3: คำสั่ง test** — server ใช้ `cd server && node ../node_modules/jest/bin/jest.js <path> --silent`
(jest อยู่ที่ root ของ repo ไม่ใช่ใน `server/node_modules` — ตรงกับที่ `server/package.json` ใช้อยู่)
extension ใช้ `NODE_OPTIONS=--experimental-vm-modules node ../node_modules/jest/bin/jest.js` เพราะ
service worker เป็น ES module — test ฝั่ง extension จึงเขียนด้วย `import` ไม่ใช่ `require` ต่างจาก
test ฝั่ง server ที่เป็น CJS
