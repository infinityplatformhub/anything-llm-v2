import { describe, it, expect, beforeEach, jest as j } from "@jest/globals";

// `chrome` must exist before the module's top level runs, because cdp.js
// registers its onDetach listener at load. ESM hoists imports above every
// statement, so the global is installed here and the module is imported
// dynamically below rather than with a static `import`.
const listeners = [];
const sent = [];
let attachImpl;
let detachImpl;
let sendImpl;

globalThis.chrome = {
  debugger: {
    onDetach: { addListener: (fn) => listeners.push(fn) },
    attach: (...args) => attachImpl(...args),
    detach: (...args) => detachImpl(...args),
    sendCommand: (target, method, params) => {
      sent.push({ target, method, params });
      return sendImpl(target, method, params);
    },
  },
  tabs: { update: j.fn(async () => {}) },
};

const cdp = await import("../src/background/cdp.js");

// WHAT THIS DOUBLE MODELS, AND WHAT IT DOES NOT.
//
// MODELLED — attach resolving or rejecting (including Chrome's real "Another
// debugger is already attached" text), detach rejecting for a tab that has
// gone, sendCommand's arguments, and a Runtime.evaluate result carrying
// `exceptionDetails` instead of rejecting.
//
// NOT MODELLED, and each can make this file green while Chrome misbehaves:
//   * The one-debugger-client-per-target RULE. The double only replays the
//     rejection; it does not enforce the constraint, so nothing here proves a
//     second attach in the real browser fails.
//   * Chrome CALLING onDetach. `handleDetach` is invoked directly below, which
//     proves the bookkeeping and not the wiring.
//   * A tab closing mid-command: modelled only as a rejection from detach.
//   * Real coordinate hit-testing, isTrusted, and whether a site accepts the
//     synthesised input at all. That is only observable in a real browser.
//   * The keystroke cadence: `type` really does sleep here, but nothing
//     asserts the distribution.

beforeEach(async () => {
  attachImpl = async () => {};
  detachImpl = async () => {};
  sendImpl = async () => ({ result: { value: null } });
  sent.length = 0;
  await cdp.detachAll();
  attachImpl = async () => {};
});

describe("attach bookkeeping", () => {
  it("attaches once per tab", async () => {
    const calls = [];
    attachImpl = async (target, version) => calls.push([target.tabId, version]);
    await cdp.attach(7);
    await cdp.attach(7);
    expect(calls).toEqual([[7, cdp.CDP_VERSION]]);
    expect(cdp.attachedTabIds()).toEqual([7]);
  });

  // @edge — the failure mode this module exists to avoid: believing in an
  // attachment Chrome has already torn down
  it("forgets a tab Chrome detached on its own, so the next attach is real", async () => {
    let attachCount = 0;
    attachImpl = async () => {
      attachCount += 1;
    };
    await cdp.attach(7);
    expect(cdp.attachedTabIds()).toEqual([7]);

    // What chrome.debugger.onDetach delivers when the user dismisses the
    // infobar, the tab navigates somewhere the debugger may not go, or DevTools
    // takes the slot.
    cdp.handleDetach({ tabId: 7, targetId: undefined });
    expect(cdp.attachedTabIds()).toEqual([]);

    await cdp.attach(7);
    expect(attachCount).toBe(2);
  });

  it("registered handleDetach with chrome.debugger.onDetach at load", () => {
    // Proves the listener is wired, which calling handleDetach directly does
    // not. It does NOT prove Chrome ever fires it.
    expect(listeners).toContain(cdp.handleDetach);
  });

  it("ignores a detach event with no tab id", async () => {
    await cdp.attach(7);
    cdp.handleDetach({ targetId: "worker" });
    expect(cdp.attachedTabIds()).toEqual([7]);
  });

  // @edge — DevTools open on the tab
  it("explains a taken debugger slot in words the user can act on", async () => {
    attachImpl = async () => {
      throw new Error("Another debugger is already attached to the tab with id: 7");
    };
    await expect(cdp.attach(7)).rejects.toThrow(/Close DevTools/);
    expect(cdp.attachedTabIds()).toEqual([]);
  });

  it("does not record an attachment that failed", async () => {
    attachImpl = async () => {
      throw new Error("No tab with given id 7.");
    };
    await expect(cdp.attach(7)).rejects.toThrow(/Cannot control this tab/);
    expect(cdp.attachedTabIds()).toEqual([]);
  });

  // @edge — a tab that closed mid-command makes detach reject
  it("forgets the tab even when detach rejects", async () => {
    await cdp.attach(7);
    detachImpl = async () => {
      throw new Error("No tab with given id 7.");
    };
    await expect(cdp.detach(7)).resolves.toBeUndefined();
    expect(cdp.attachedTabIds()).toEqual([]);
  });

  it("detachAll empties the set", async () => {
    await cdp.attach(7);
    await cdp.attach(8);
    await cdp.detachAll();
    expect(cdp.attachedTabIds()).toEqual([]);
  });
});

describe("evaluate", () => {
  // @edge — CDP reports a page-side throw as a RESULT, not a rejection. A
  // caller that only try/catches sees `undefined` and reports success.
  it("throws when the result carries exceptionDetails", async () => {
    sendImpl = async () => ({
      result: { type: "object" },
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "TypeError: x is not a function" },
      },
    });
    await expect(cdp.evaluate(7, "x()")).rejects.toThrow(/x is not a function/);
  });

  it("returns the value when there is no exception", async () => {
    sendImpl = async () => ({ result: { value: { ok: 1 } } });
    await expect(cdp.evaluate(7, "1")).resolves.toEqual({ ok: 1 });
  });
});

describe("fetchInPage", () => {
  it("builds its own GET and embeds the url as a JSON string literal", async () => {
    sendImpl = async () => ({ result: { value: "body" } });
    // A url carrying a quote, a call, and a line comment. Concatenated rather
    // than written whole so the injected text does not also appear literally in
    // this file's own assertions.
    const hostile = `https://x.test/a"+${"fetch"}("https://evil.test");//`;
    await cdp.fetchInPage(7, hostile);
    const expression = sent.at(-1).params.expression;

    // The quote in the url must not close the string literal and turn the rest
    // into code running in the page's own origin. Asserted as an exact prefix,
    // which is what pins the url inside a literal — a `toContain` would also
    // pass if the url were additionally interpolated somewhere unquoted.
    expect(expression.startsWith(`fetch(${JSON.stringify(hostile)}, {`)).toBe(
      true
    );
    expect(expression).toMatch(/method: "GET"/);

    // And nothing outside that literal is a second call. Removing the literal
    // leaves exactly the one call this function builds.
    const outsideLiteral = expression.replace(JSON.stringify(hostile), '""');
    expect(outsideLiteral.split(`${"fetch"}(`).length - 1).toBe(1);
  });

  it("takes only a url, so an undeclared options field has nowhere to land", async () => {
    sendImpl = async () => ({ result: { value: "body" } });
    // Arity alone is NOT enough: an optional `init = {}` parameter does not
    // count toward Function.length, so a `toHaveLength(2)` assertion passes
    // against exactly the signature this test exists to forbid. A mutation
    // adding that parameter survived until this test called it with a third
    // argument and asserted the built request is unchanged.
    await cdp.fetchInPage(7, "https://x.test/a", {
      method: "POST",
      headers: { Authorization: "Bearer leaked" },
      body: "drop=everything",
      credentials: "omit",
    });
    const expression = sent.at(-1).params.expression;
    expect(expression).toMatch(/method: "GET"/);
    expect(expression).toMatch(/credentials: "include"/);
    expect(expression).not.toMatch(/POST|Authorization|leaked|omit|drop=/);
  });
});

describe("input synthesis", () => {
  it("moves before pressing, so hover-revealed targets exist", async () => {
    await cdp.click(7, 10, 20);
    expect(sent.map((s) => s.params.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
  });

  it("scrolls by a signed delta", async () => {
    await cdp.scroll(7, "up");
    expect(sent.at(-1).params.deltaY).toBe(-cdp.SCROLL_DELTA_PX);
    sent.length = 0;
    await cdp.scroll(7, "down");
    expect(sent.at(-1).params.deltaY).toBe(cdp.SCROLL_DELTA_PX);
  });

  it("sends one insertText per character", async () => {
    await cdp.type(7, "abc");
    expect(sent.map((s) => s.params.text)).toEqual(["a", "b", "c"]);
  });

  it("sends keyDown and keyUp for a key press", async () => {
    await cdp.key(7, "Enter");
    expect(sent.map((s) => [s.params.type, s.params.key])).toEqual([
      ["keyDown", "Enter"],
      ["keyUp", "Enter"],
    ]);
  });
});
