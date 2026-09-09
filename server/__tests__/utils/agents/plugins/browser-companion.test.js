process.env.STORAGE_DIR = __dirname;

// Set BEFORE requiring protocol.js: it reads this once, at require time, into
// DEFAULT_TIMEOUT_MS. A short value lets the no-reply case be asserted for real
// (the production default is 20s) and, more importantly, pins that `runCommand`
// passes NO timeoutMs of its own — if it ever did, the text below would name
// that number instead of this one.
process.env.BROWSER_COMPANION_TIMEOUT_MS = "60";

// Node >= 24 removed buffer.SlowBuffer; the aibitat require chain reaches
// jsonwebtoken -> buffer-equal-constant-time, which still reads it.
const buffer = require("buffer");
if (!buffer.SlowBuffer) buffer.SlowBuffer = buffer.Buffer;

const { describe, it, expect, beforeEach } = require("@jest/globals");

// The real collaborators, deliberately. registry.resolve is the whole security
// story of this plugin and protocol.send is its only exit; doubling either one
// would leave the assertions here agreeing with a fiction.
const registry = require("../../../../utils/browserCompanion/registry");
const protocol = require("../../../../utils/browserCompanion/protocol");

// SystemSettings is the one collaborator that cannot run for real here: it
// queries Prisma. It is mocked to return a value, and every assertion that uses
// it checks the BEHAVIOUR that value produces through the real registry, never
// merely that the mock was called.
jest.mock("../../../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
}));
const { SystemSettings } = require("../../../../models/systemSettings");

const {
  browserCompanion,
  runCommand,
} = require("../../../../utils/agents/aibitat/plugins/browser-companion");
const AgentPlugins = require("../../../../utils/agents/aibitat/plugins");
const {
  DEFAULT_ENABLED_SKILLS,
} = require("../../../../models/workspaceAgentSettings");
const AIbitat = require("../../../../utils/agents/aibitat");

const EXPECTED_TOOLS = [
  "page_state",
  "page_click",
  "page_type",
  "page_read",
  "page_scroll",
  "page_key",
  "page_tabs",
  "page_switch",
  "page_navigate",
  "page_close",
  "page_fetch",
];

/** A socket that records frames and never answers unless a test answers for it. */
function fakeSocket() {
  return {
    sent: [],
    send(raw) {
      this.sent.push(JSON.parse(raw));
    },
    on() {},
    lastRequestId() {
      return this.sent[this.sent.length - 1].requestId;
    },
  };
}

/** Answer the newest frame on a socket the way the extension would. */
function reply(socket, body) {
  protocol.handleMessage({
    socket,
    raw: JSON.stringify({ requestId: socket.lastRequestId(), ...body }),
  });
}

/**
 * Let the event loop turn over, not just the microtask queue.
 *
 * `await somePromise` drains microtasks only, so a second send issued from a
 * timer, a retry or anything else that goes through the event loop lands AFTER
 * the assertions and is invisible. Awaiting a `setTimeout` puts the assertions
 * behind the macrotask queue, where such a duplicate has already arrived.
 * Measured: without this, a `setTimeout(…, 0)` duplicate shows 1 frame and
 * pendingCount 0; with it, 2 frames and pendingCount 2.
 */
function drainMacrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Every tool, with arguments valid for it and the wire verb it must send. */
const TOOL_CALLS = [
  { name: "page_state", cmd: "state", args: {} },
  { name: "page_click", cmd: "click", args: { id: 12 } },
  { name: "page_type", cmd: "type", args: { id: 4, text: "hello" } },
  { name: "page_read", cmd: "read", args: {} },
  { name: "page_scroll", cmd: "scroll", args: { direction: "down" } },
  { name: "page_key", cmd: "key", args: { key: "Enter" } },
  { name: "page_tabs", cmd: "tabs", args: {} },
  { name: "page_switch", cmd: "switch", args: { url: "x.test" } },
  { name: "page_navigate", cmd: "navigate", args: { url: "https://x.test/" } },
  { name: "page_close", cmd: "close", args: {} },
  { name: "page_fetch", cmd: "fetch", args: { url: "https://x.test/a" } },
];

/** A real AIbitat with the plugin installed — no doubles on the registration path. */
function aibitatWith(invocation) {
  const aibitat = new AIbitat({
    handlerProps: { invocation, log: () => {} },
  });
  aibitat.introspect = () => {};
  aibitat.use(browserCompanion.plugin());
  return aibitat;
}

describe("browser-companion plugin", () => {
  beforeEach(() => {
    registry.__reset();
    protocol.__reset();
    SystemSettings.isMultiUserMode.mockReset();
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
  });

  it("exposes all eleven page tools", () => {
    expect(browserCompanion.name).toBe("browser-companion");
    const names = browserCompanion.toolNames;
    expect(names).toEqual(expect.arrayContaining(EXPECTED_TOOLS));
    expect(names).toHaveLength(11);
  });

  // @edge — browser ไม่ได้ต่อ ต้องตอบทันที ไม่ค้าง
  it("returns an offline message instead of hanging when nothing is connected", async () => {
    const out = await runCommand({
      cmd: "click",
      payload: { id: 1 },
      userId: 7,
      multiUserMode: true,
    });
    expect(out).toMatch(/not connected/i);
  });

  // @edge — agent ที่ไม่มี user ห้ามได้เบราว์เซอร์ของคนอื่น
  it("refuses for an agent run with no user even when another user is connected", async () => {
    registry.register({ userId: 7, socket: fakeSocket() });
    const out = await runCommand({
      cmd: "read",
      payload: {},
      userId: undefined,
      multiUserMode: true,
    });
    expect(out).toMatch(/no user/i);
  });

  // @edge — legacy null-user key ต้องไม่แมตช์ใครใน multi-user mode
  it("passes the legacy-key refusal through instead of reporting it as offline", async () => {
    registry.register({ userId: null, socket: fakeSocket() });
    const out = await runCommand({
      cmd: "read",
      payload: {},
      userId: null,
      multiUserMode: true,
    });
    expect(out).toMatch(/predates multi-user mode/i);
    expect(out).not.toMatch(/is not connected/i);
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

  // The guard runs before `registry.resolve`, not merely before `send`. Both
  // orderings write nothing, so only the message distinguishes them: with
  // nobody connected, a POST must still be refused for being a POST rather
  // than reported as an offline browser. Pins the ordering the module comment
  // claims — without this, moving the guard below resolve passes.
  it("refuses a non-GET fetch before it resolves a socket at all", async () => {
    const out = await runCommand({
      cmd: "fetch",
      payload: { url: "https://x.test/a", method: "POST" },
      userId: 7,
      multiUserMode: true,
    });
    expect(out).toMatch(/GET/);
    expect(out).not.toMatch(/not connected/i);
  });

  // @edge — ตัวพิมพ์เล็กต้องโดนบล็อกเหมือนกัน ไม่ใช่เทียบสตริงตรง ๆ
  it("rejects a lower-case non-GET method too", async () => {
    const socket = fakeSocket();
    registry.register({ userId: 7, socket });
    const out = await runCommand({
      cmd: "fetch",
      payload: { url: "https://x.test/a", method: "delete" },
      userId: 7,
      multiUserMode: true,
    });
    expect(out).toMatch(/GET/);
    expect(socket.sent).toHaveLength(0);
  });

  // @edge — method ที่ไม่ใช่สตริง ต้องถูกปฏิเสธ ไม่ใช่ทำให้ทั้ง turn พัง
  it("refuses a non-string fetch method instead of throwing on it", async () => {
    const socket = fakeSocket();
    registry.register({ userId: 7, socket });
    for (const method of [123, { toUpperCase: null }, ["POST"]]) {
      const out = await runCommand({
        cmd: "fetch",
        payload: { url: "https://x.test/a", method },
        userId: 7,
        multiUserMode: true,
      });
      expect(out).toMatch(/GET/);
    }
    expect(socket.sent).toHaveLength(0);
  });

  // @edge — "" ไม่ใช่ "ไม่ได้ระบุ": `||` จะกลืนมันเป็น GET เงียบ ๆ
  it("refuses an empty-string method rather than reading it as an unspecified GET", async () => {
    const socket = fakeSocket();
    registry.register({ userId: 7, socket });
    const out = await runCommand({
      cmd: "fetch",
      payload: { url: "https://x.test/a", method: "" },
      userId: 7,
      multiUserMode: true,
    });
    expect(out).toMatch(/GET/);
    expect(socket.sent).toHaveLength(0);
  });

  // Awaited past the macrotask queue, not just to promise resolution: a command
  // sent a second time is invisible to a synchronous count AND to a plain
  // `await`, because `await` drains microtasks only. A duplicated click or
  // navigate is a real action taken twice in the user's own browser, with no
  // undo — so every tool gets this, on both axes, not just fetch and click.
  it("sends an allowed fetch exactly once, whether the method is absent or an explicit get", async () => {
    const socket = fakeSocket();
    registry.register({ userId: 7, socket });

    const first = runCommand({
      cmd: "fetch",
      payload: { url: "https://x.test/a" },
      userId: 7,
      multiUserMode: true,
    });
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({
      cmd: "fetch",
      url: "https://x.test/a",
    });
    reply(socket, { ok: true, data: "a" });
    await expect(first).resolves.toBe("a");
    await drainMacrotasks();
    expect(socket.sent).toHaveLength(1);
    expect(protocol.__pendingCount()).toBe(0);

    const second = runCommand({
      cmd: "fetch",
      payload: { url: "https://x.test/b", method: "get" },
      userId: 7,
      multiUserMode: true,
    });
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1]).toMatchObject({
      cmd: "fetch",
      url: "https://x.test/b",
    });
    reply(socket, { ok: true, data: "b" });
    await expect(second).resolves.toBe("b");
    await drainMacrotasks();
    expect(socket.sent).toHaveLength(2);
    expect(protocol.__pendingCount()).toBe(0);
  });

  // Same property for an acting command: one call, one frame, no duplicate on a
  // later tick of either queue.
  it("sends a click exactly once", async () => {
    const socket = fakeSocket();
    registry.register({ userId: 7, socket });
    const pending = runCommand({
      cmd: "click",
      payload: { id: 2 },
      userId: 7,
      multiUserMode: true,
    });
    reply(socket, { ok: true, data: "clicked" });
    await expect(pending).resolves.toBe("clicked");
    await drainMacrotasks();
    expect(socket.sent).toHaveLength(1);
    expect(protocol.__pendingCount()).toBe(0);
  });

  // Every tool, one at a time, each on its own socket and its own suite entry —
  // so a duplicate names the tool that duplicated rather than reddening some
  // unrelated test through a leaked timer. Driven through the REGISTERED
  // handler, not runCommand: that is the path a duplicate would really take.
  describe.each(TOOL_CALLS)("$name sends exactly one frame", ({ name, cmd, args }) => {
    it("issues one frame per call and leaves nothing pending", async () => {
      const socket = fakeSocket();
      registry.register({ userId: 7, socket });
      const aibitat = aibitatWith({ user_id: 7 });

      const pending = aibitat.functions
        .get(name)
        .handler.call({ super: aibitat, caller: "agent" }, args);

      // Past the handler's `await SystemSettings.isMultiUserMode()` and past any
      // duplicate riding a timer, before the frame is counted.
      await drainMacrotasks();
      expect(socket.sent).toHaveLength(1);
      expect(socket.sent[0].cmd).toBe(cmd);

      reply(socket, { ok: true, data: "ok" });
      await expect(pending).resolves.toBe("ok");
      await drainMacrotasks();

      // Both assertions matter: `sent` catches the extra write, and
      // `__pendingCount` catches a duplicate whose reply never came — a leaked
      // correlation entry that would otherwise outlive the test.
      expect(socket.sent).toHaveLength(1);
      expect(protocol.__pendingCount()).toBe(0);
    });
  });

  it("sends the command over the resolved socket", async () => {
    const socket = fakeSocket();
    registry.register({ userId: 7, socket });
    const pending = runCommand({
      cmd: "click",
      payload: { id: 12 },
      userId: 7,
      multiUserMode: true,
    });
    // send() is fire-then-await; the frame is written synchronously.
    expect(socket.sent[0]).toMatchObject({ cmd: "click", id: 12 });
    expect(socket.sent[0].requestId).toMatch(/^r_/);

    reply(socket, { ok: true, data: "clicked" });
    await expect(pending).resolves.toBe("clicked");
  });

  it("resolves only the calling user's own socket", async () => {
    const mine = fakeSocket();
    const theirs = fakeSocket();
    registry.register({ userId: 7, socket: mine });
    registry.register({ userId: 9, socket: theirs });

    runCommand({ cmd: "read", payload: {}, userId: 7, multiUserMode: true });

    expect(mine.sent).toHaveLength(1);
    expect(theirs.sent).toHaveLength(0);
  });

  it("serialises structured replies and passes string replies through untouched", async () => {
    const socket = fakeSocket();
    registry.register({ userId: 7, socket });

    const structured = runCommand({
      cmd: "state",
      payload: {},
      userId: 7,
      multiUserMode: true,
    });
    reply(socket, { ok: true, data: { elements: [{ id: 1, tag: "button" }] } });
    await expect(structured).resolves.toBe(
      JSON.stringify({ elements: [{ id: 1, tag: "button" }] })
    );

    const text = runCommand({
      cmd: "read",
      payload: {},
      userId: 7,
      multiUserMode: true,
    });
    reply(socket, { ok: true, data: "# Heading" });
    await expect(text).resolves.toBe("# Heading");
  });

  it("reports a failed browser command as text the agent can read", async () => {
    const socket = fakeSocket();
    registry.register({ userId: 7, socket });
    const pending = runCommand({
      cmd: "click",
      payload: { id: 3 },
      userId: 7,
      multiUserMode: true,
    });
    reply(socket, { ok: false, error: "No element with id 3." });
    await expect(pending).resolves.toBe(
      "Browser command failed: No element with id 3."
    );
  });

  // @edge — ไม่ส่ง timeoutMs เอง ต้องได้ค่า default ของ protocol
  it("leaves the timeout to the protocol module rather than supplying its own", async () => {
    const socket = fakeSocket();
    registry.register({ userId: 7, socket });
    const out = await runCommand({
      cmd: "state",
      payload: {},
      userId: 7,
      multiUserMode: true,
    });
    // 60 comes from BROWSER_COMPANION_TIMEOUT_MS at the top of this file.
    expect(out).toMatch(/timed out after 60ms/);
    expect(protocol.__pendingCount()).toBe(0);
  });

  // @edge — multiUserMode ที่ไม่ใช่ boolean คือบั๊กโปรแกรม ต้องโยนออกมา ไม่ใช่กลายเป็น "offline"
  it("lets the registry TypeError surface instead of masking it as a disconnected browser", async () => {
    registry.register({ userId: 7, socket: fakeSocket() });
    await expect(
      runCommand({ cmd: "read", payload: {}, userId: 7, multiUserMode: undefined })
    ).rejects.toThrow(TypeError);
  });

  describe("tool registration on a real AIbitat", () => {
    it("registers every tool with a schema the model can call", () => {
      const aibitat = aibitatWith({ user_id: 7 });
      for (const name of EXPECTED_TOOLS) {
        const fn = aibitat.functions.get(name);
        expect(fn).toBeDefined();
        expect(typeof fn.description).toBe("string");
        expect(fn.parameters.type).toBe("object");
        expect(typeof fn.handler).toBe("function");
      }
      expect(aibitat.functions.size).toBe(11);
    });

    // The wire frame is {...payload, requestId, cmd}: a payload field with
    // either name is silently dropped rather than forging the envelope. No tool
    // may declare one — this asserts that for every tool, not by inspection.
    it("declares no payload field that would collide with the protocol envelope", () => {
      const aibitat = aibitatWith({ user_id: 7 });
      for (const name of EXPECTED_TOOLS) {
        const properties = Object.keys(
          aibitat.functions.get(name).parameters.properties ?? {}
        );
        expect(properties).not.toContain("requestId");
        expect(properties).not.toContain("cmd");
      }
    });

    // page_state builds the [id] map the acting tools consume. A model that
    // only ever reads these descriptions has to be told the ordering, or it
    // clicks against a stale map.
    it("tells the model to call page_state before acting on an element id", () => {
      const aibitat = aibitatWith({ user_id: 7 });
      for (const name of ["page_click", "page_type"]) {
        expect(aibitat.functions.get(name).description).toMatch(/page_state/);
      }
      expect(aibitat.functions.get("page_state").description).toMatch(
        /page_click|page_type/
      );
    });

    // Token presence for the four map-invalidating tools. Kept as the weakest
    // and most obvious statement of the property — the allowlist below subsumes
    // it, but this one names the tools, so a dropped tool reads as "page_scroll
    // stopped mentioning page_state" rather than as a regex miss.
    it("tells the model to re-run page_state after anything that changes the page", () => {
      const aibitat = aibitatWith({ user_id: 7 });
      for (const name of [
        "page_scroll",
        "page_key",
        "page_switch",
        "page_navigate",
      ]) {
        expect(aibitat.functions.get(name).description).toMatch(/page_state/);
      }
    });

    // ALLOWLIST, not a blocklist — this is the load-bearing guard.
    //
    // A blocklist of "ids persist" phrasings cannot work here, and that is not
    // a gap to be closed by adding phrasings. Two of the evasions that beat the
    // previous blocklist state nothing false at all:
    //
    //   "Re-running page_state before each click wastes a turn"
    //   "prefer an [id] you already have over spending another call"
    //
    // Both are true sentences that steer the model straight into the stale-map
    // failure. No vocabulary list can catch a true sentence, so the assertion
    // has to be that the required INSTRUCTION is present, not that forbidden
    // words are absent. An allowlist cannot be evaded by inventing new words
    // for the wrong claim, because the wrong claim will not contain the right
    // instruction.
    //
    // Deliberate failure direction: if an honest rewrite uses a directive verb
    // this list lacks, the test goes RED and someone widens ACCEPTED_DIRECTIVE.
    // That is a false alarm on a good edit — annoying, and the safe way round.
    // A blocklist fails the other way: silent green on a bad edit.
    const ACCEPTED_DIRECTIVE =
      /\b(call|re-?call|re-?run|rerun|re-?read|reread|refresh|redo|repeat|request|ask for|get|grab|take|capture|update|renew|check|list|query)\b[^.;:]{0,40}\bpage_state\b/i;

    // Ordering words that put the page_state call BEFORE the action. "in the
    // same turn" counts: it is the phrasing the shipped description uses and it
    // carries the same instruction.
    const ORDERING =
      /\b(before|beforehand|first|prior to|same turn|each time|every time|again)\b/i;

    // Every tool that changes the page invalidates the [id] map, and the model
    // reads only these descriptions. Each must positively instruct the re-read.
    it("requires every page-changing tool to instruct a fresh page_state call", () => {
      const aibitat = aibitatWith({ user_id: 7 });
      for (const name of [
        "page_scroll",
        "page_key",
        "page_switch",
        "page_navigate",
      ]) {
        const description = aibitat.functions.get(name).description;
        expect(`${name}: ${description}`).toMatch(ACCEPTED_DIRECTIVE);
      }
    });

    // The acting tools need the instruction AND the ordering: "call page_state"
    // with no "before/first/same turn" leaves the model free to call it after.
    it("requires page_click and page_type to instruct a page_state call up front", () => {
      const aibitat = aibitatWith({ user_id: 7 });
      for (const name of ["page_click", "page_type"]) {
        const description = aibitat.functions.get(name).description;
        expect(`${name}: ${description}`).toMatch(ACCEPTED_DIRECTIVE);
        expect(`${name}: ${description}`).toMatch(ORDERING);
      }
    });

    // page_state itself has no directive to carry — it IS the tool being
    // directed to. What it must assert is the limited lifetime of what it
    // returns, which is the fact every other description depends on. A rewrite
    // saying the ids last the session cannot state this and passes nothing.
    it("requires page_state to say its ids are only good for the current page", () => {
      const aibitat = aibitatWith({ user_id: 7 });
      const description = aibitat.functions.get("page_state").description;
      expect(description).toMatch(/page_click|page_type/);
      expect(description).toMatch(
        /\b(stale|only valid|no longer valid|invalidat\w*|right now|as it is now|out of date|outdated)\b/i
      );
    });

    // Cheap second line, kept deliberately: it catches the two reversals a
    // careless edit actually produces — they are the natural way to write the
    // mistake — before the allowlist has to reason about them. It is NOT relied
    // on to be complete; the allowlist above is what holds when someone invents
    // new vocabulary. Extended with the wording families that beat its first
    // version (stable, deterministic, carry over, survives, shared between,
    // does not shift, untouched).
    it("never tells the model that element ids stay valid", () => {
      const aibitat = aibitatWith({ user_id: 7 });
      const CONTRADICTS_INVALIDATION =
        /(do|does|don't|do not|need not|no need)[^.]{0,40}\bcall page_state\b|\bstays? valid\b|\bstay valid\b|\bremain valid\b|\breuse the same\b|\bcached\b|\bonly (?:need|call) (?:this|it) once\b|\bforever\b|\bstable identifier\b|\bdeterministic\b|\bdoes not shift\b|\bcarry over\b|\bcarries over\b|\bsurvives?\b|\buntouched\b|\bshared between\b|\brest of the session\b|\bnever renumbers?\b|\bwastes a turn\b|\bsecond time\b/i;
      for (const [name, fn] of aibitat.functions) {
        expect(
          `${name}: ${fn.description}`.match(CONTRADICTS_INVALIDATION)
        ).toBeNull();
      }
    });

    it("advertises exactly the tool names it registers", () => {
      const aibitat = aibitatWith({ user_id: 7 });
      expect([...browserCompanion.toolNames].sort()).toEqual(
        [...aibitat.functions.keys()].sort()
      );
    });

    // Pins every tool to the wire verb the extension switches on. A swapped or
    // renamed `cmd` here is invisible to a per-tool test that only checks its
    // own arguments.
    it("sends each tool under its own wire command", async () => {
      const socket = fakeSocket();
      registry.register({ userId: 7, socket });
      const aibitat = aibitatWith({ user_id: 7 });
      const expected = {
        page_state: "state",
        page_click: "click",
        page_type: "type",
        page_read: "read",
        page_scroll: "scroll",
        page_key: "key",
        page_tabs: "tabs",
        page_switch: "switch",
        page_navigate: "navigate",
        page_close: "close",
        page_fetch: "fetch",
      };
      for (const [name, cmd] of Object.entries(expected)) {
        aibitat.functions
          .get(name)
          .handler.call({ super: aibitat, caller: "agent" }, {});
        await new Promise((resolve) => setImmediate(resolve));
        expect(socket.sent[socket.sent.length - 1].cmd).toBe(cmd);
      }
      expect(socket.sent).toHaveLength(11);
    });

    // The GET guard keys off the wire verb, so it only protects page_fetch
    // while page_fetch is still wired to "fetch". Asserted through the real
    // handler rather than through runCommand, which is handed the verb directly.
    it("enforces GET through the registered page_fetch handler", async () => {
      const socket = fakeSocket();
      registry.register({ userId: 7, socket });
      const aibitat = aibitatWith({ user_id: 7 });

      const out = await aibitat.functions
        .get("page_fetch")
        .handler.call(
          { super: aibitat, caller: "agent" },
          { url: "https://x.test/a", method: "POST" }
        );

      expect(out).toMatch(/GET/);
      expect(socket.sent).toHaveLength(0);
    });

    it("drives the invocation's own user, not whoever is connected", async () => {
      const socket = fakeSocket();
      registry.register({ userId: 7, socket });
      const aibitat = aibitatWith({ user_id: 9 });

      const out = await aibitat.functions.get("page_read").handler.call(
        { super: aibitat, caller: "agent" },
        {}
      );

      expect(out).toMatch(/not connected/i);
      expect(socket.sent).toHaveLength(0);
    });

    it("sends the tool arguments as the command payload", async () => {
      const socket = fakeSocket();
      registry.register({ userId: 7, socket });
      const aibitat = aibitatWith({ user_id: 7 });

      const pending = aibitat.functions.get("page_type").handler.call(
        { super: aibitat, caller: "agent" },
        { id: 4, text: "hello" }
      );
      // The handler awaits isMultiUserMode before sending, so let that settle.
      await new Promise((resolve) => setImmediate(resolve));

      expect(socket.sent[0]).toMatchObject({ cmd: "type", id: 4, text: "hello" });
      reply(socket, { ok: true, data: "typed" });
      await expect(pending).resolves.toBe("typed");
    });

    // The real multi-user flag has to reach the registry: a hardcoded `false`
    // would open the legacy null key to every agent run on a multi-user server.
    it("uses the live multi-user setting, so the null key resolves only in single-user mode", async () => {
      const socket = fakeSocket();
      registry.register({ userId: null, socket });
      const aibitat = aibitatWith({ user_id: null });
      const call = () =>
        aibitat.functions
          .get("page_read")
          .handler.call({ super: aibitat, caller: "agent" }, {});

      SystemSettings.isMultiUserMode.mockResolvedValue(true);
      await expect(call()).resolves.toMatch(/predates multi-user mode/i);
      expect(socket.sent).toHaveLength(0);

      SystemSettings.isMultiUserMode.mockResolvedValue(false);
      const pending = call();
      await new Promise((resolve) => setImmediate(resolve));
      expect(socket.sent).toHaveLength(1);
      reply(socket, { ok: true, data: "ok" });
      await expect(pending).resolves.toBe("ok");
    });

    // No invocation at all (a scheduled job) is `undefined`, which the registry
    // treats as "no user" — distinct from the single-user null key.
    it("treats a run with no invocation as having no user", async () => {
      registry.register({ userId: null, socket: fakeSocket() });
      SystemSettings.isMultiUserMode.mockResolvedValue(false);
      const aibitat = aibitatWith(undefined);

      const out = await aibitat.functions
        .get("page_read")
        .handler.call({ super: aibitat, caller: "agent" }, {});

      expect(out).toMatch(/no user/i);
    });

    // The setting is read per call, not captured at setup: switching multi-user
    // mode on mid-session must stop the legacy null key resolving immediately.
    it("re-reads the multi-user setting on every call, not once at setup", async () => {
      const socket = fakeSocket();
      registry.register({ userId: null, socket });
      SystemSettings.isMultiUserMode.mockResolvedValue(false);
      const aibitat = aibitatWith({ user_id: null });
      const call = () =>
        aibitat.functions
          .get("page_read")
          .handler.call({ super: aibitat, caller: "agent" }, {});

      const first = call();
      await new Promise((resolve) => setImmediate(resolve));
      expect(socket.sent).toHaveLength(1);
      reply(socket, { ok: true, data: "ok" });
      await expect(first).resolves.toBe("ok");

      SystemSettings.isMultiUserMode.mockResolvedValue(true);
      await expect(call()).resolves.toMatch(/predates multi-user mode/i);
      expect(socket.sent).toHaveLength(1);
    });

    // The TypeError from a non-boolean flag must not be reported as an offline
    // browser. It stops at the agent boundary, named.
    it("surfaces a registry TypeError as an error, never as an offline browser", async () => {
      registry.register({ userId: 7, socket: fakeSocket() });
      SystemSettings.isMultiUserMode.mockResolvedValue("true");
      const aibitat = aibitatWith({ user_id: 7 });

      const out = await aibitat.functions
        .get("page_read")
        .handler.call({ super: aibitat, caller: "agent" }, {});

      expect(out).toMatch(/explicit boolean multiUserMode/);
      expect(out).not.toMatch(/not connected/i);
    });

    it("returns the error text when the multi-user lookup itself fails", async () => {
      SystemSettings.isMultiUserMode.mockRejectedValue(
        new Error("settings unavailable")
      );
      const aibitat = aibitatWith({ user_id: 7 });

      const out = await aibitat.functions
        .get("page_read")
        .handler.call({ super: aibitat, caller: "agent" }, {});

      expect(out).toMatch(/settings unavailable/);
      expect(out).not.toMatch(/not connected/i);
    });
  });

  describe("skill registration", () => {
    it("is reachable by slug from the plugin index", () => {
      expect(AgentPlugins["browser-companion"]).toBe(browserCompanion);
      expect(AgentPlugins.browserCompanion).toBe(browserCompanion);
    });

    // It reaches every session the user is logged into anywhere in their
    // browser. Opt-in only, like sql-agent and web-scraping (#48 review).
    it("is not enabled by default on a new workspace", () => {
      expect(DEFAULT_ENABLED_SKILLS).not.toContain("browser-companion");
    });
  });
});
