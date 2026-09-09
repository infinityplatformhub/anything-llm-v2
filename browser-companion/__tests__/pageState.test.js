import { describe, it, expect, beforeEach, jest as j } from "@jest/globals";

// `chrome` before the import, because cdp.js — which pageState.js imports —
// registers a listener at load. ESM hoists static imports above every
// statement, so this module is loaded dynamically below.
let evaluateResult;
globalThis.chrome = {
  debugger: {
    onDetach: { addListener: () => {} },
    attach: async () => {},
    detach: async () => {},
    sendCommand: async () => ({ result: { value: evaluateResult } }),
  },
  tabs: { update: j.fn(async () => {}) },
};

const pageState = await import("../src/background/pageState.js");

// WHAT IS DOUBLED: only `chrome.debugger.sendCommand`, which returns whatever
// `evaluateResult` holds — so these tests exercise the REAL map bookkeeping
// (capture/lookup/invalidate) against a canned page.
//
// NOT MODELLED, and named because a green file here is not a working capture:
//   * The CAPTURE_EXPRESSION and READ_EXPRESSION themselves. They are strings
//     evaluated by a real page, and nothing here parses or runs them — no DOM,
//     no getBoundingClientRect, no getComputedStyle. Whether the selector picks
//     the right elements, whether the visibility rules are correct, and whether
//     the coordinates land on the element are ALL unverified by this file and
//     are only observable in a real browser.
//   * The MV3 service worker teardown that clears `maps` in production.

const page = (elements) => ({
  url: "https://www.linkedin.com/feed/",
  title: "Feed",
  elements,
});

beforeEach(() => {
  evaluateResult = page([]);
  pageState.invalidate(1);
  pageState.invalidate(2);
});

describe("the element map", () => {
  it("remembers the point for each captured id", async () => {
    evaluateResult = page([
      { id: 1, tag: "button", text: "A", x: 10, y: 20 },
      { id: 2, tag: "a", text: "B", x: 30, y: 40 },
    ]);
    await pageState.capture(1);
    await expect(pageState.lookup(1, 2)).resolves.toEqual({ x: 30, y: 40 });
  });

  it("keeps each tab's map separate", async () => {
    evaluateResult = page([{ id: 1, tag: "button", text: "A", x: 10, y: 20 }]);
    await pageState.capture(1);
    await expect(pageState.lookup(2, 1)).resolves.toBeNull();
  });

  // @edge — THE staleness hazard. A merge would leave an id from the previous
  // page resolvable, so a click aimed at "Message" lands wherever that id used
  // to be on a page that has since changed.
  it("replaces the previous map wholesale instead of merging into it", async () => {
    evaluateResult = page([
      { id: 1, tag: "button", text: "Message", x: 10, y: 20 },
      { id: 2, tag: "button", text: "Delete", x: 30, y: 40 },
    ]);
    await pageState.capture(1);

    // The page changed and now exposes one element.
    evaluateResult = page([{ id: 1, tag: "button", text: "Follow", x: 99, y: 99 }]);
    await pageState.capture(1);

    await expect(pageState.lookup(1, 1)).resolves.toEqual({ x: 99, y: 99 });
    // id 2 is gone. If it still resolved, a click on [2] would hit whatever now
    // occupies (30, 40).
    await expect(pageState.lookup(1, 2)).resolves.toBeNull();
  });

  // @edge — `Number(id)` alone turns "", null and [12] into usable ids, so an
  // id the agent never sent would resolve to a real element.
  it.each([
    ["a numeric string", "1"],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a boxed array", [1]],
    ["a float", 1.5],
    ["NaN", NaN],
    ["an object with valueOf", { valueOf: () => 1 }],
  ])("refuses %s as an element id", async (_label, id) => {
    evaluateResult = page([{ id: 1, tag: "button", text: "A", x: 10, y: 20 }]);
    await pageState.capture(1);
    await expect(pageState.lookup(1, id)).resolves.toBeNull();
  });

  it("resolves a genuine integer id", async () => {
    evaluateResult = page([{ id: 1, tag: "button", text: "A", x: 10, y: 20 }]);
    await pageState.capture(1);
    await expect(pageState.lookup(1, 1)).resolves.toEqual({ x: 10, y: 20 });
  });

  it("really drops the map on invalidate", async () => {
    evaluateResult = page([{ id: 1, tag: "button", text: "A", x: 10, y: 20 }]);
    await pageState.capture(1);
    expect(pageState.hasMap(1)).toBe(true);

    pageState.invalidate(1);

    expect(pageState.hasMap(1)).toBe(false);
    // The observable consequence, not just the flag: the id no longer resolves,
    // so the dispatcher tells the agent to call page_state again.
    await expect(pageState.lookup(1, 1)).resolves.toBeNull();
  });

  it("survives a capture that returns nothing", async () => {
    evaluateResult = undefined;
    await expect(pageState.capture(1)).resolves.toBeUndefined();
    await expect(pageState.lookup(1, 1)).resolves.toBeNull();
  });
});

describe("the capture expression", () => {
  // These assert the STRING, which is all that is checkable without a browser.
  // They cannot tell you the expression works — only that the limits it is
  // supposed to carry are in it.
  it("caps the element count and the label length", async () => {
    let sentExpression;
    globalThis.chrome.debugger.sendCommand = async (_t, _m, params) => {
      sentExpression = params.expression;
      return { result: { value: page([]) } };
    };
    await pageState.capture(1);
    expect(sentExpression).toContain(`>= ${pageState.MAX_ELEMENTS}`);
    expect(sentExpression).toContain(`slice(0, ${pageState.MAX_LABEL_CHARS})`);
  });

  it("caps the text a page_read can return", async () => {
    let sentExpression;
    globalThis.chrome.debugger.sendCommand = async (_t, _m, params) => {
      sentExpression = params.expression;
      return { result: { value: { url: "u", title: "t", text: "" } } };
    };
    await pageState.read(1);
    expect(sentExpression).toContain(`> ${pageState.MAX_TEXT_CHARS}`);
  });
});
