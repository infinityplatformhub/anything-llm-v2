import { describe, it, expect, jest as j } from "@jest/globals";
import {
  handle,
  COMMANDS,
  GATE_KINDS,
  GATE_RESOLVERS,
  assertCommandTable,
  withDefaults,
} from "../src/background/dispatch.js";

// WHAT IS DOUBLED HERE, AND WHAT IS NOT.
//
// NOT doubled: `isAllowed`, `isSameOrigin` and the real `URL`. The gate's
// correctness IS that code's behaviour on hostile input, so these tests run the
// real allowlist module. `loadAllowlist` is injected only because it reads
// chrome.storage; the matching itself is real.
//
// Doubled: `chrome.debugger` and `chrome.tabs`, via the `cdp` and tab-accessor
// deps. These are the dangerous doubles, so what they model is stated:
//
//   MODELLED — a call happening or not happening (which is what every gate
//   assertion below rests on), a rejection from attach, a rejection from a CDP
//   command, and a tab list whose entries have urls.
//
//   NOT MODELLED — any of these can make a green suite here and a broken layer
//   in Chrome, and each is named rather than assumed away:
//     * CDP returning an ERROR OBJECT instead of rejecting. `chrome.debugger`
//       reports a page-side throw as a result carrying `exceptionDetails`;
//       `cdp.evaluate` converts that to a throw, and NOTHING here exercises
//       that conversion, because it needs a real `chrome.debugger.sendCommand`.
//     * The one-client-per-target rule. A user with DevTools open makes attach
//       fail for real; the double only simulates the rejection, not the rule.
//     * A tab that closes mid-command, and Chrome's own `onDetach` firing.
//       `cdp.handleDetach` is unit-tested below by calling it directly, which
//       proves the bookkeeping and NOT that Chrome ever calls it.
//     * Timing: `cdp.type` sleeps between keystrokes in the real module. The
//       double resolves at once, so nothing here would catch a change to that
//       cadence.
//     * The element map's real content. `lookup` is injected, so the CDP
//       expression that builds the map is not exercised at all.

function deps(overrides = {}) {
  return {
    loadAllowlist: async () => ["www.linkedin.com"],
    record: j.fn(async () => {}),
    agentTabUrl: async () => "https://www.linkedin.com/feed/",
    ensureAgentTab: j.fn(async () => 391),
    listAgentTabs: j.fn(async () => [
      { id: 391, url: "https://www.linkedin.com/feed/", title: "Feed" },
    ]),
    switchToTab: j.fn(async () => {}),
    closeTab: j.fn(async () => {}),
    cdp: {
      attach: j.fn(async () => {}),
      detach: j.fn(async () => {}),
      detachAll: j.fn(async () => {}),
      click: j.fn(async () => {}),
      type: j.fn(async () => {}),
      key: j.fn(async () => {}),
      scroll: j.fn(async () => {}),
      navigate: j.fn(async () => {}),
      fetch: j.fn(async () => "col_a,col_b\n1,2\n"),
    },
    pageState: {
      capture: j.fn(async () => ({
        url: "https://www.linkedin.com/feed/",
        title: "Feed",
        elements: [{ id: 12, tag: "button", text: "Message", x: 412, y: 268 }],
      })),
      read: j.fn(async () => ({
        url: "https://www.linkedin.com/feed/",
        title: "Feed",
        text: "# Feed",
      })),
      invalidate: j.fn(),
    },
    lookup: j.fn(async (tabId, id) => (id === 12 ? { x: 412, y: 268 } : null)),
    ...overrides,
  };
}

/**
 * One frame per command that reaches its handler on a well-formed request.
 *
 * Derived from COMMANDS, not hand-listed: `everyCommand` below asserts this
 * covers the real table, so adding a twelfth command without adding its args
 * fails rather than silently narrowing the enumeration.
 */
const ARGS = {
  state: {},
  read: {},
  click: { id: 12 },
  type: { id: 12, text: "hello" },
  key: { key: "Enter" },
  scroll: { direction: "down" },
  navigate: { url: "https://www.linkedin.com/jobs/" },
  fetch: { url: "https://www.linkedin.com/api/x" },
  tabs: {},
  switch: { url: "linkedin.com/feed" },
  close: {},
};

describe("dispatch — the brief's contract", () => {
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

  // @edge — a domain outside the allowlist must be refused before attaching
  it("denies a command on a domain outside the allowlist before attaching", async () => {
    const d = deps({ agentTabUrl: async () => "https://docs.google.com/x" });
    const out = await handle({ requestId: "r_3", cmd: "read" }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/allowlist/i);
    expect(d.cdp.attach).not.toHaveBeenCalled();
    expect(d.ensureAgentTab).not.toHaveBeenCalled();
    expect(d.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "denied" })
    );
  });

  // @edge — navigate is judged on where it is going, not where it is
  it("checks the target url on navigate, not the current one", async () => {
    const d = deps();
    const out = await handle(
      { requestId: "r_4", cmd: "navigate", url: "https://docs.google.com/x" },
      d
    );
    expect(out.ok).toBe(false);
    expect(d.cdp.navigate).not.toHaveBeenCalled();
  });

  // @edge — page_fetch must be same-origin with the tab it runs in
  it("refuses a cross-origin page_fetch", async () => {
    // Both origins allowlisted, so the ONLY thing that can refuse this is the
    // same-origin rule. With docs.google.com absent from the list the allowlist
    // would deny it first and this test would pass while proving nothing.
    const d = deps({
      loadAllowlist: async () => ["www.linkedin.com", "docs.google.com"],
    });
    const out = await handle(
      { requestId: "r_5", cmd: "fetch", url: "https://docs.google.com/export" },
      d
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/same-origin/i);
    expect(d.cdp.fetch).not.toHaveBeenCalled();
  });

  it("returns the body of a same-origin page_fetch", async () => {
    const d = deps();
    const out = await handle(
      { requestId: "r_6", cmd: "fetch", url: "https://www.linkedin.com/api/x" },
      d
    );
    expect(out.ok).toBe(true);
    expect(out.data).toBe("col_a,col_b\n1,2\n");
  });

  // @edge — an id absent from the map must tell the agent to re-read
  it("tells the agent to re-read page_state when the id is unknown", async () => {
    const d = deps({ lookup: async () => null });
    const out = await handle({ requestId: "r_7", cmd: "click", id: 999 }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/page_state/);
    expect(d.cdp.click).not.toHaveBeenCalled();
  });

  it("focuses the field by clicking it before typing into it", async () => {
    // Order matters and is the whole point: text typed into an unfocused page
    // goes wherever the site last put focus, which is silently the wrong field
    // rather than a visible failure.
    const order = [];
    const d = deps();
    d.cdp.click.mockImplementation(async (...a) => void order.push(["click", ...a]));
    d.cdp.type.mockImplementation(async (...a) => void order.push(["type", ...a]));

    await handle({ requestId: "r_9", cmd: "type", id: 12, text: "hi" }, d);
    expect(order).toEqual([
      ["click", 391, 412, 268],
      ["type", 391, "hi"],
    ]);
  });

  it("records every successful command in the audit log", async () => {
    const d = deps();
    await handle({ requestId: "r_8", cmd: "click", id: 12 }, d);
    expect(d.record).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "click", outcome: "ok" })
    );
  });
});

/* ------------------------------------------------------------------------- */
/* The gate is the path — enumerated from the real table                      */
/* ------------------------------------------------------------------------- */

describe("the allowlist gate cannot be bypassed by any command", () => {
  // THE TEST THIS TASK EXISTS FOR. It reads the real COMMANDS table rather
  // than a list written here, so a twelfth tool added without a gate turns it
  // red without anyone remembering to extend this file.
  const everyCommand = Object.keys(COMMANDS);

  it("has an argument fixture for every command in the real table", () => {
    // Guards the enumeration below: without this a new command missing from
    // ARGS would simply not be enumerated, and "every command is gated" would
    // quietly mean "every command I remembered".
    expect(Object.keys(ARGS).sort()).toEqual([...everyCommand].sort());
  });

  it.each(everyCommand)(
    "denies %s when the allowlist is empty, before any browser call",
    async (cmd) => {
      const d = deps({ loadAllowlist: async () => [] });
      const out = await handle({ requestId: `r_${cmd}`, cmd, ...ARGS[cmd] }, d);

      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/^denied:/);

      // Not one CDP call, not one tab mutation, and no attachment.
      for (const [name, fn] of Object.entries(d.cdp))
        expect([name, fn.mock.calls.length]).toEqual([name, 0]);
      expect(d.ensureAgentTab).not.toHaveBeenCalled();
      expect(d.switchToTab).not.toHaveBeenCalled();
      expect(d.closeTab).not.toHaveBeenCalled();
      expect(d.pageState.capture).not.toHaveBeenCalled();
      expect(d.pageState.read).not.toHaveBeenCalled();

      // A silent denial is a support call nobody can answer.
      expect(d.record).toHaveBeenCalledWith(
        expect.objectContaining({ cmd, outcome: "denied" })
      );
    }
  );

  it.each(everyCommand)(
    "denies %s when the tab sits on a domain outside the allowlist",
    async (cmd) => {
      // A non-empty list that admits nothing in play: distinct from the empty
      // case, which `isAllowed` short-circuits on before any matching runs.
      const d = deps({
        loadAllowlist: async () => ["example.test"],
        agentTabUrl: async () => "https://docs.google.com/spreadsheets/d/1",
        listAgentTabs: async () => [
          { id: 391, url: "https://docs.google.com/spreadsheets/d/1", title: "S" },
        ],
      });
      const out = await handle({ requestId: `r2_${cmd}`, cmd, ...ARGS[cmd] }, d);
      expect(out.ok).toBe(false);
      for (const [name, fn] of Object.entries(d.cdp))
        expect([name, fn.mock.calls.length]).toEqual([name, 0]);
    }
  );

  it("declares a gate from the closed set for every command", () => {
    for (const [cmd, spec] of Object.entries(COMMANDS))
      expect([cmd, GATE_KINDS.includes(spec.gate)]).toEqual([cmd, true]);
  });

  it("refuses to load a command table with an ungated command", () => {
    // The structural guarantee, exercised: `assertCommandTable` runs at module
    // load, so an ungated command cannot be imported at all.
    expect(() =>
      assertCommandTable({ evil: { run: async () => ({}) } })
    ).toThrow(/must name the url/i);
    expect(() =>
      assertCommandTable({ evil: { gate: "none", run: async () => ({}) } })
    ).toThrow(/not one of/i);
  });

  it("has every resolver return an array of urls, so the loop cannot be skipped", async () => {
    // `handle` treats a non-array as a denial, and that branch is defensive:
    // no resolver here can produce one today. This is what keeps it that way —
    // a future resolver returning a bare url string would make the gate loop
    // iterate the url's CHARACTERS, each of which `isAllowed` denies, so the
    // symptom would be "everything is denied" rather than a bypass. Asserted
    // as a contract on the resolvers, since the guard itself is unreachable.
    const ctx = {
      command: { url: "https://www.linkedin.com/feed/" },
      deps: deps(),
      currentUrl: async () => "https://www.linkedin.com/feed/",
    };
    for (const [name, resolve] of Object.entries(GATE_RESOLVERS)) {
      const out = await resolve(ctx);
      expect([name, Array.isArray(out.urls)]).toEqual([name, true]);
    }
  });

  // THE LIST IS INJECTABLE, THE JUDGEMENT IS NOT.
  //
  // `loadAllowlist` through deps is harmless — it changes WHICH domains are
  // allowed. `isAllowed` through deps would not be: any caller, or any future
  // refactor, could pass a permissive stub and the entire gate would evaporate
  // with every test still green. That is the failure shape this branch has
  // found repeatedly — a double standing in for the real thing, agreed with by
  // a green suite. So dispatch.js imports the judgement directly and these
  // assert it cannot be reached through the injection seam.
  it("ignores an isAllowed stub passed through deps", async () => {
    const permissive = j.fn(() => true);
    const d = deps({
      loadAllowlist: async () => [],
      agentTabUrl: async () => "https://evil.test/x",
      isAllowed: permissive,
    });
    const out = await handle({ requestId: "r_j1", cmd: "state" }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^denied:/);
    // Not consulted at all — the real one was used.
    expect(permissive).not.toHaveBeenCalled();
    expect(d.cdp.attach).not.toHaveBeenCalled();
  });

  it("ignores an isSameOrigin stub passed through deps", async () => {
    const permissive = j.fn(() => true);
    const d = deps({
      loadAllowlist: async () => ["www.linkedin.com", "docs.google.com"],
      isSameOrigin: permissive,
    });
    const out = await handle(
      { requestId: "r_j2", cmd: "fetch", url: "https://docs.google.com/export" },
      d
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/same-origin/i);
    expect(permissive).not.toHaveBeenCalled();
    expect(d.cdp.fetch).not.toHaveBeenCalled();
  });

  it("does not expose the judgement on the resolved dependency object", () => {
    // Belt and braces: even if a caller passes them, they must not become part
    // of what the dispatcher hands to a resolver or a run().
    const d = withDefaults({ isAllowed: () => true, isSameOrigin: () => true });
    // They may sit on the object (spread from deps) but nothing reads them.
    // What matters is that the module's own bindings are the imported ones,
    // which the two behavioural tests above prove. This pins the narrower fact
    // that no defaulting step ever ADDS them.
    const bare = withDefaults({});
    expect(bare.isAllowed).toBeUndefined();
    expect(bare.isSameOrigin).toBeUndefined();
    expect(typeof d.loadAllowlist).toBe("function");
  });

  it("never invents a missing cdp or pageState method", () => {
    // A defaulting layer with a fallback for unknown keys would turn a typo in
    // a future command into a silent no-op: the command reports success and
    // the browser does nothing at all.
    const d = withDefaults({ cdp: {}, pageState: {} });
    expect(d.cdp.thisDoesNotExist).toBeUndefined();
    expect(d.pageState.thisDoesNotExist).toBeUndefined();
    // And the real implementations are still there when not overridden.
    expect(typeof d.cdp.click).toBe("function");
    expect(typeof d.pageState.capture).toBe("function");
  });

  it("records an unknown command rather than dropping it silently", async () => {
    // A run of unknown verbs is what a compromised or version-mismatched
    // server looks like from here, and the audit log is where the user sees it.
    const d = deps();
    await handle({ requestId: "r_unk", cmd: "page_wipe_disk" }, d);
    expect(d.record).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "page_wipe_disk",
        outcome: "denied",
        detail: "unknown command",
      })
    );
  });

  it("offers no gate kind that skips the allowlist", () => {
    // There is no `gate: "none"` to reach for. If one is ever added, this fails
    // and whoever added it has to justify it in review.
    expect(GATE_KINDS).not.toContain("none");
    expect(GATE_KINDS).not.toContain("skip");
  });

  // @edge — a multi-url gate must judge EVERY url, not just one of them.
  //
  // page_fetch is the only two-url command, and the trap is that the
  // same-origin rule refuses BOTH of these cases too. A test asserting only
  // `ok === false` therefore passes even when the gate loop reads a single url:
  // a mutation doing exactly that survived until these assertions named the
  // reason and the offending host. The reason is the evidence, not the verdict.
  it("names the ALLOWLIST and the forbidden target when only the target is refused", async () => {
    const d = deps({ agentTabUrl: async () => "https://www.linkedin.com/feed/" });
    const out = await handle(
      { requestId: "r_m1", cmd: "fetch", url: "https://evil.test/export" },
      d
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/allowlist/i);
    expect(out.error).toMatch(/evil\.test/);
    expect(d.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        detail: expect.stringMatching(/not in allowlist/),
      })
    );
  });

  it("names the ALLOWLIST and the forbidden page when only the page is refused", async () => {
    const d = deps({ agentTabUrl: async () => "https://evil.test/x" });
    const out = await handle(
      {
        requestId: "r_m2",
        cmd: "fetch",
        url: "https://www.linkedin.com/api/x",
      },
      d
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/allowlist/i);
    expect(out.error).toMatch(/evil\.test/);
  });

  it("does not treat an inherited Object property as a command", async () => {
    const d = deps();
    const out = await handle({ requestId: "r_proto", cmd: "constructor" }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unknown browser command/i);
    expect(d.ensureAgentTab).not.toHaveBeenCalled();
  });
});

describe("per-command gate subjects", () => {
  // @edge — page_close is gated on the tab it closes. Task 6 left it ungated
  // because it has no url argument; closing a page IS acting on it.
  it("denies page_close when the tab is on a domain outside the allowlist", async () => {
    const d = deps({ agentTabUrl: async () => "https://docs.google.com/x" });
    const out = await handle({ requestId: "r_c", cmd: "close" }, d);
    expect(out.ok).toBe(false);
    expect(d.closeTab).not.toHaveBeenCalled();
  });

  it("closes the tab and detaches when the tab is allowed", async () => {
    const d = deps();
    const out = await handle({ requestId: "r_c2", cmd: "close" }, d);
    expect(out.ok).toBe(true);
    expect(d.cdp.detach).toHaveBeenCalledWith(391);
    expect(d.closeTab).toHaveBeenCalledWith(391);
  });

  // @edge — page_fetch checks BOTH urls, so an allowed target read from a
  // forbidden page is refused too
  it("denies a fetch whose target is allowed but whose page is not", async () => {
    const d = deps({
      agentTabUrl: async () => "https://docs.google.com/x",
      loadAllowlist: async () => ["www.linkedin.com"],
    });
    const out = await handle(
      { requestId: "r_f", cmd: "fetch", url: "https://www.linkedin.com/api/x" },
      d
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/docs\.google\.com/);
    expect(d.cdp.fetch).not.toHaveBeenCalled();
  });

  // @edge — page_switch is gated on the MATCHED tab's url, not the current one
  it("denies a switch to a tab whose url is outside the allowlist", async () => {
    const d = deps({
      listAgentTabs: async () => [
        { id: 391, url: "https://www.linkedin.com/feed/", title: "Feed" },
        { id: 392, url: "https://docs.google.com/secret", title: "Secret" },
      ],
    });
    const out = await handle(
      { requestId: "r_s", cmd: "switch", url: "docs.google.com" },
      d
    );
    expect(out.ok).toBe(false);
    expect(d.switchToTab).not.toHaveBeenCalled();
  });

  it("switches to the tab the gate judged, by id", async () => {
    const d = deps({
      listAgentTabs: async () => [
        { id: 400, url: "https://www.linkedin.com/jobs/", title: "Jobs" },
      ],
    });
    const out = await handle(
      { requestId: "r_s2", cmd: "switch", url: "linkedin.com/jobs" },
      d
    );
    expect(out.ok).toBe(true);
    expect(d.switchToTab).toHaveBeenCalledWith(400);
  });

  // @edge — a resolver that matches nothing must DENY, not pass vacuously
  it("denies a switch whose substring matches no tab", async () => {
    const d = deps({ listAgentTabs: async () => [] });
    const out = await handle(
      { requestId: "r_s3", cmd: "switch", url: "linkedin.com" },
      d
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no page/i);
    expect(d.switchToTab).not.toHaveBeenCalled();
  });

  // @edge — a fetch to an allowed, same-origin target from an allowed page is
  // the ONLY combination that runs. This pins that the gate reads BOTH urls
  // rather than one of them twice: the page is allowed and the target is not,
  // and they are same-origin by host but not by scheme, so nothing but a
  // genuine two-url check can refuse it.
  it("denies a fetch whose target is same-host but on a forbidden origin", async () => {
    const d = deps({
      loadAllowlist: async () => ["www.linkedin.com"],
      agentTabUrl: async () => "https://www.linkedin.com/feed/",
    });
    const out = await handle(
      {
        requestId: "r_f2",
        cmd: "fetch",
        // Different port: same host, so a host-only comparison would allow it;
        // a different origin, so the same-origin rule refuses it.
        url: "https://www.linkedin.com:8443/api/x",
      },
      d
    );
    expect(out.ok).toBe(false);
    expect(d.cdp.fetch).not.toHaveBeenCalled();
  });

  // @edge — the tab list may hold entries the gate never judged. A resolver
  // that named the matched tab but a `run` that re-found one would act on a
  // tab nobody checked.
  it("does not act on an unjudged tab when several match the substring", async () => {
    const d = deps({
      listAgentTabs: async () => [
        { id: 401, url: "https://www.linkedin.com/feed/", title: "Feed" },
        // Also contains "linkedin.com" — and is NOT allowlisted, being a
        // subdomain the plain entry does not cover.
        { id: 402, url: "https://ads.linkedin.com/campaigns", title: "Ads" },
      ],
    });
    const out = await handle(
      { requestId: "r_s4", cmd: "switch", url: "linkedin.com" },
      d
    );
    // The first match is the allowed one, so this succeeds — and must switch to
    // exactly that tab, never to the last one in the list.
    expect(out.ok).toBe(true);
    expect(d.switchToTab).toHaveBeenCalledWith(401);
    expect(d.switchToTab).not.toHaveBeenCalledWith(402);
  });

  // @edge — page_close must be judged on the tab it closes even when OTHER
  // allowed tabs exist. A close gated on "some tab is allowed" would pass here.
  it("denies page_close on a forbidden tab even while allowed tabs are open", async () => {
    const d = deps({
      agentTabUrl: async () => "https://docs.google.com/spreadsheets/d/1",
      listAgentTabs: async () => [
        { id: 391, url: "https://www.linkedin.com/feed/", title: "Feed" },
        { id: 392, url: "https://docs.google.com/spreadsheets/d/1", title: "S" },
      ],
    });
    const out = await handle({ requestId: "r_c3", cmd: "close" }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/docs\.google\.com/);
    expect(d.closeTab).not.toHaveBeenCalled();
    expect(d.cdp.detach).not.toHaveBeenCalled();
  });

  // @edge — THE BLOB BYPASS. task-7-brief.md specified a LOCAL `sameOrigin`
  // helper doing a bare `new URL(a).origin === new URL(b).origin`. That returns
  // TRUE for a blob: url against its own page: unlike file: or data:, whose
  // origins serialise to the string "null", a blob: url reports the REAL origin
  // it was minted from. Verified by execution — the naive compare says true,
  // task 6's `isSameOrigin` says false.
  //
  // WHAT THESE TESTS ACTUALLY PROVE, stated precisely because the honest answer
  // is narrower than "the blob bypass is tested". Verified by running the real
  // dispatcher: a blob: url is refused by the ALLOWLIST's scheme guard
  // (ALLOWED_SCHEMES is http/https only), which runs BEFORE the same-origin
  // check. So the same-origin layer is never reached, and these assert
  // defence-in-depth — the outer gate holds — rather than exercising
  // `isSameOrigin`'s blob handling.
  //
  // A mutation replacing this module's `isSameOrigin` with the brief's naive
  // helper consequently SURVIVES the suite, and is reported as a survivor
  // rather than hidden: no dispatch-level input can reach that check with a
  // blob, because the allowlist eats it first. task 6's own tests cover
  // `isSameOrigin(blob, page) === false` directly, which is the right place for
  // it. Asserted on BOTH sides here anyway, since the original defect was
  // one-sided.
  it("refuses a blob: url on an allowlisted host as a page_fetch TARGET", async () => {
    const d = deps();
    const out = await handle(
      {
        requestId: "r_b1",
        cmd: "fetch",
        url: "blob:https://www.linkedin.com/1234-abcd",
      },
      d
    );
    expect(out.ok).toBe(false);
    expect(d.cdp.fetch).not.toHaveBeenCalled();
  });

  it("refuses a blob: url on an allowlisted host as the PAGE", async () => {
    const d = deps({
      agentTabUrl: async () => "blob:https://www.linkedin.com/1234-abcd",
    });
    const out = await handle(
      {
        requestId: "r_b2",
        cmd: "fetch",
        url: "https://www.linkedin.com/api/x",
      },
      d
    );
    expect(out.ok).toBe(false);
    expect(d.cdp.fetch).not.toHaveBeenCalled();
  });

  it("refuses a blob: page for every page-touching command, not just fetch", async () => {
    // The allowlist gate refuses the scheme outright, so the blob never
    // depends on the same-origin rule to be caught.
    const d = deps({
      agentTabUrl: async () => "blob:https://www.linkedin.com/1234-abcd",
    });
    const out = await handle({ requestId: "r_b3", cmd: "click", id: 12 }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/allowlist/i);
    expect(d.cdp.click).not.toHaveBeenCalled();
  });

  // @edge — page_tabs must not become a way to enumerate the user's browsing
  it("hides tabs outside the allowlist from page_tabs but says how many", async () => {
    const d = deps({
      listAgentTabs: async () => [
        { id: 391, url: "https://www.linkedin.com/feed/", title: "Feed" },
        { id: 392, url: "https://mail.google.com/inbox", title: "Inbox" },
        { id: 393, url: "https://bank.example/accounts", title: "Bank" },
      ],
    });
    const out = await handle({ requestId: "r_t", cmd: "tabs" }, d);
    expect(out.ok).toBe(true);
    expect(out.data.tabs).toEqual([
      { id: 391, url: "https://www.linkedin.com/feed/", title: "Feed" },
    ]);
    expect(out.data.withheld).toBe(2);
    expect(JSON.stringify(out.data)).not.toMatch(/bank\.example|mail\.google/);
  });
});

describe("untrusted fields on the frame", () => {
  // The server-side plugin records that its schema is advisory: aibitat
  // validates nothing, so undeclared fields reach the wire.
  it("ignores headers, body, credentials and method on a page_fetch frame", async () => {
    const d = deps();
    await handle(
      {
        requestId: "r_u1",
        cmd: "fetch",
        url: "https://www.linkedin.com/api/x",
        method: "POST",
        headers: { Authorization: "Bearer leaked" },
        body: "drop=everything",
        credentials: "omit",
      },
      d
    );
    // One url argument and nothing else: there is no options object for an
    // undeclared field to ride in on.
    expect(d.cdp.fetch).toHaveBeenCalledWith(391, "https://www.linkedin.com/api/x");
    expect(d.cdp.fetch.mock.calls[0]).toHaveLength(2);
  });

  // @edge — a huge server-controlled string must not reach the audit log or the
  // agent transcript at full size. Task 6's auditLog caps its own fields too;
  // this is the second bound, and the one that also covers the error STRING
  // this module builds, which the log's cap does not reach.
  it("bounds a giant url before it reaches the log or the reply", async () => {
    const huge = `https://evil.test/${"A".repeat(5_000_000)}`;
    const d = deps();
    const out = await handle(
      { requestId: "r_big", cmd: "navigate", url: huge },
      d
    );
    expect(out.ok).toBe(false);
    expect(out.error.length).toBeLessThan(3000);
    expect(out.error).toMatch(/truncated/);
    const [entry] = d.record.mock.calls[0];
    expect(entry.url.length).toBeLessThan(3000);
    expect(entry.detail.length).toBeLessThan(3000);
  });

  it("bounds a giant cmd on the unknown-command path", async () => {
    // Recorded BEFORE any check passes, so an unbounded cmd is a way to write
    // arbitrarily large entries into the log without being allowlisted at all.
    const d = deps();
    const out = await handle(
      { requestId: "r_big2", cmd: "x".repeat(5_000_000) },
      d
    );
    expect(out.ok).toBe(false);
    expect(out.error.length).toBeLessThan(3000);
    const [entry] = d.record.mock.calls[0];
    expect(entry.cmd.length).toBeLessThan(3000);
  });

  it("bounds a giant error message from the browser", async () => {
    const d = deps();
    d.cdp.attach.mockRejectedValueOnce(new Error("E".repeat(5_000_000)));
    const out = await handle({ requestId: "r_big3", cmd: "state" }, d);
    expect(out.ok).toBe(false);
    expect(out.error.length).toBeLessThan(3000);
  });

  it("refuses a non-string url rather than coercing it", async () => {
    const d = deps();
    const out = await handle(
      { requestId: "r_u2", cmd: "navigate", url: { toString: () => "https://www.linkedin.com/" } },
      d
    );
    expect(out.ok).toBe(false);
    expect(d.cdp.navigate).not.toHaveBeenCalled();
  });

  it("refuses an empty-string url rather than letting it reach the gate", async () => {
    // "" parses as no URL at all, so `isAllowed` would deny it anyway — but the
    // refusal must come from the argument contract, and say which field is
    // wrong, rather than telling the agent its allowlist is at fault.
    const d = deps();
    const out = await handle({ requestId: "r_u6", cmd: "navigate", url: "" }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/"url" must be a non-empty string/);
    expect(d.cdp.navigate).not.toHaveBeenCalled();
  });

  it("refuses an empty-string switch substring instead of matching any tab", async () => {
    // The dangerous one: `"".includes` is true for every tab, so an empty
    // needle without this check silently means "the first tab you have".
    const d = deps({
      listAgentTabs: async () => [
        { id: 392, url: "https://docs.google.com/secret", title: "Secret" },
      ],
    });
    const out = await handle({ requestId: "r_u7", cmd: "switch", url: "" }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/"url" must be a non-empty string/);
    expect(d.switchToTab).not.toHaveBeenCalled();
  });

  it("refuses an empty key press", async () => {
    const d = deps();
    const out = await handle({ requestId: "r_u8", cmd: "key", key: "" }, d);
    expect(out.ok).toBe(false);
    expect(d.cdp.key).not.toHaveBeenCalled();
  });

  it("refuses a scroll direction outside the enum", async () => {
    const d = deps();
    const out = await handle(
      { requestId: "r_u3", cmd: "scroll", direction: "sideways" },
      d
    );
    expect(out.ok).toBe(false);
    expect(d.cdp.scroll).not.toHaveBeenCalled();
  });

  it("refuses a non-string text on page_type before clicking anything", async () => {
    const d = deps();
    const out = await handle(
      { requestId: "r_u4", cmd: "type", id: 12, text: { evil: true } },
      d
    );
    expect(out.ok).toBe(false);
    expect(d.cdp.click).not.toHaveBeenCalled();
    expect(d.cdp.type).not.toHaveBeenCalled();
  });

  it("does not record the typed text in the audit log", async () => {
    const d = deps();
    await handle(
      { requestId: "r_u5", cmd: "type", id: 12, text: "hunter2-the-password" },
      d
    );
    const entries = d.record.mock.calls.map(([e]) => JSON.stringify(e)).join(" ");
    expect(entries).not.toMatch(/hunter2/);
    // The length is kept — it is what makes a log entry auditable at all —
    // while the content is not. "hunter2-the-password" is 20 characters.
    expect(entries).toMatch(/20 chars/);
  });
});

describe("failures from the browser", () => {
  it("reports an attach failure as an error, not as a success", async () => {
    const d = deps();
    d.cdp.attach.mockRejectedValueOnce(
      new Error(
        "Cannot control this tab: something else is already debugging it."
      )
    );
    const out = await handle({ requestId: "r_e1", cmd: "state" }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/already debugging/);
    expect(d.record).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "state", outcome: "error" })
    );
  });

  it("reports a CDP command failure and never rejects", async () => {
    const d = deps();
    d.cdp.click.mockRejectedValueOnce(
      new Error("Debugger is not attached to the tab with id: 391")
    );
    const out = await handle({ requestId: "r_e2", cmd: "click", id: 12 }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not attached/);
    expect(out.requestId).toBe("r_e2");
  });

  it("survives a tab accessor that rejects", async () => {
    const d = deps({
      ensureAgentTab: async () => {
        throw new Error("No such tab.");
      },
    });
    const out = await handle({ requestId: "r_e3", cmd: "state" }, d);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/No such tab/);
  });

  it("denies rather than throwing when the tab has no url at all", async () => {
    // A tab mid-navigation, or one that closed between commands.
    const d = deps({ agentTabUrl: async () => undefined });
    const out = await handle({ requestId: "r_e4", cmd: "state" }, d);
    expect(out.ok).toBe(false);
    expect(d.cdp.attach).not.toHaveBeenCalled();
  });
});

describe("the element map is dropped when the page moves", () => {
  it.each([
    ["click", { id: 12 }],
    ["type", { id: 12, text: "x" }],
    ["key", { key: "Enter" }],
    ["scroll", { direction: "down" }],
    ["navigate", { url: "https://www.linkedin.com/jobs/" }],
  ])("invalidates the map after %s", async (cmd, args) => {
    const d = deps();
    const out = await handle({ requestId: `r_i_${cmd}`, cmd, ...args }, d);
    expect(out.ok).toBe(true);
    expect(d.pageState.invalidate).toHaveBeenCalledWith(391);
  });

  it("keeps the map after a read-only command", async () => {
    const d = deps();
    await handle({ requestId: "r_i_state", cmd: "state" }, d);
    expect(d.pageState.invalidate).not.toHaveBeenCalled();
  });
});
