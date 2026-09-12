import { describe, it, expect } from "@jest/globals";
import {
  isAllowed,
  isSameOrigin,
  parseEntry,
  STORAGE_KEY,
} from "../src/background/allowlist.js";

// These tests exercise the real `URL` from the runtime, not a stand-in. That is
// deliberate: the gate's correctness IS the parser's behaviour on hostile input
// (IDNA folding, userinfo, backslashes), so a mocked URL would test a belief
// about the parser rather than the parser. Nothing here is doubled.

describe("allowlist — the brief's contract", () => {
  it("denies everything when the list is empty", () => {
    expect(isAllowed("https://www.linkedin.com/feed/", [])).toBe(false);
  });

  it("allows an exact host match", () => {
    expect(isAllowed("https://www.linkedin.com/feed/", ["www.linkedin.com"])).toBe(
      true
    );
  });

  it("allows a subdomain under a wildcard entry", () => {
    expect(isAllowed("https://app.flowaccount.com/x", ["*.flowaccount.com"])).toBe(
      true
    );
  });

  // @edge — a wildcard must not cover a lookalike parent that was never asked for
  it("does not let a wildcard entry match a lookalike domain", () => {
    expect(
      isAllowed("https://flowaccount.com.evil.test/", ["*.flowaccount.com"])
    ).toBe(false);
  });

  // @edge — a trailing string match must not pass (notlinkedin.com)
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
    expect(isAllowed("https://WWW.LinkedIn.com/", ["www.linkedin.com"])).toBe(
      true
    );
  });
});

describe("default deny — the state a fresh install is in", () => {
  // Every shape of "no usable list" has to mean allow-nothing. The dangerous
  // failure is a missing list being read as an absent restriction.
  it.each([
    ["empty array", []],
    ["undefined", undefined],
    ["null", null],
    ["a string that looks like a host", "linkedin.com"],
    ["a string containing the host", "*"],
    ["an object", { "linkedin.com": true }],
    ["a number", 1],
    ["a Set of the right hosts", new Set(["linkedin.com"])],
  ])("denies an allowed-looking url when the list is %s", (_label, list) => {
    expect(isAllowed("https://linkedin.com/", list)).toBe(false);
  });

  it("denies when the list holds only unusable entries", () => {
    expect(
      isAllowed("https://linkedin.com/", ["", "   ", null, undefined, 42, {}, []])
    ).toBe(false);
  });

  it("still allows when one good entry sits among unusable ones", () => {
    // Negative control for the rule above: entry rejection must drop only the
    // bad entries, not quietly disable the whole list.
    expect(isAllowed("https://linkedin.com/", [null, "linkedin.com", {}])).toBe(
      true
    );
  });
});

describe("scheme axis", () => {
  it.each([
    ["https", "https://linkedin.com/", true],
    ["http", "http://linkedin.com/", true],
    ["uppercase scheme", "HTTPS://linkedin.com/", true],
    ["scheme-relative special form", "https:linkedin.com", true],
    ["file with a host-shaped authority", "file://linkedin.com/x", false],
    ["file to disk", "file:///etc/passwd", false],
    ["chrome", "chrome://settings", false],
    ["chrome-extension", "chrome-extension://abc/page.html", false],
    ["devtools", "devtools://devtools/bundled/inspector.html", false],
    ["about", "about:blank", false],
    ["javascript", "javascript:fetch('https://linkedin.com')", false],
    ["data", "data:text/html,<b>linkedin.com</b>", false],
    ["blob over an allowed origin", "blob:https://linkedin.com/uuid", false],
    ["ws", "ws://linkedin.com/socket", false],
    ["wss", "wss://linkedin.com/socket", false],
    ["ftp", "ftp://linkedin.com/x", false],
    ["view-source over an allowed page", "view-source:https://linkedin.com/", false],
  ])("%s → %s", (_label, url, expected) => {
    // The list names the host in every case, so only the scheme decides.
    expect(isAllowed(url, ["linkedin.com", "*.linkedin.com"])).toBe(expected);
  });
});

describe("host axis — the shapes that impersonate an allowed host", () => {
  it.each([
    // Each of these is a URL that some string-matching gate would admit.
    ["host in the query", "https://evil.test/?next=https://linkedin.com/", false],
    ["host in the path", "https://evil.test/linkedin.com/feed", false],
    ["host in the fragment", "https://evil.test/#linkedin.com", false],
    ["host as userinfo", "https://linkedin.com@evil.test/", false],
    ["host as user:password", "https://linkedin.com:x@evil.test/", false],
    ["userinfo with password", "https://user:pw@evil.test/", false],
    ["allowed host as the password", "https://u:linkedin.com@evil.test/", false],
    ["suffix domain", "https://notlinkedin.com/", false],
    ["suffix with a dash", "https://not-linkedin.com/", false],
    ["prefix domain", "https://linkedin.com.evil.test/", false],
    ["host embedded mid-name", "https://xlinkedin.comx.test/", false],
    ["backslash instead of slash", "https://evil.test\\linkedin.com", false],
    ["subdomain without a wildcard entry", "https://www.linkedin.com/", false],
    // and the ones that must genuinely pass
    ["the exact host", "https://linkedin.com/", true],
    ["exact host with a port", "https://linkedin.com:8443/", true],
    ["exact host, fully qualified with root dot", "https://linkedin.com./", true],
    ["exact host with credentials attached", "https://u:p@linkedin.com/", true],
  ])("%s → %s", (_label, url, expected) => {
    expect(isAllowed(url, ["linkedin.com"])).toBe(expected);
  });

  it("treats a doubled trailing dot as a name that matches nothing", () => {
    // One trailing dot is the DNS root label; two is not a name, and must not be
    // trimmed down into one that matches.
    expect(isAllowed("https://linkedin.com../", ["linkedin.com"])).toBe(false);
  });
});

describe("wildcard axis", () => {
  it.each([
    ["the bare base domain", "https://flowaccount.com/", true],
    ["the base with the root dot", "https://flowaccount.com./", true],
    ["a direct subdomain", "https://app.flowaccount.com/", true],
    ["a nested subdomain", "https://a.b.c.flowaccount.com/", true],
    ["a lookalike parent", "https://flowaccount.com.evil.test/", false],
    ["a suffix domain", "https://notflowaccount.com/", false],
    ["a dashed suffix", "https://my-flowaccount.com/", false],
    ["the base as a path on another host", "https://evil.test/flowaccount.com", false],
    ["a similar name", "https://flowaccounts.com/", false],
  ])("*.flowaccount.com vs %s → %s", (_label, url, expected) => {
    expect(isAllowed(url, ["*.flowaccount.com"])).toBe(expected);
  });

  it("does not let a wildcard reach a sibling of the base", () => {
    expect(isAllowed("https://evilflowaccount.com/", ["*.flowaccount.com"])).toBe(
      false
    );
  });

  it("does not treat a public suffix entry as special, since that is the user's call", () => {
    // Documenting real behaviour rather than asserting a wish: `*.co.uk` really
    // does admit every .co.uk. The popup should warn; the matcher does not
    // second-guess an explicit entry.
    expect(isAllowed("https://anything.co.uk/", ["*.co.uk"])).toBe(true);
  });
});

describe("port axis", () => {
  it.each([
    ["default https port", "https://linkedin.com/", true],
    ["explicit default port", "https://linkedin.com:443/", true],
    ["a non-default port", "https://linkedin.com:8080/", true],
    ["a port on a denied host", "https://evil.test:443/", false],
  ])("%s → %s", (_label, url, expected) => {
    // A host rule is a host rule: the allowlist has no port syntax, so a port on
    // an allowed host must not change the answer in either direction.
    expect(isAllowed(url, ["linkedin.com"])).toBe(expected);
  });

  it("rejects an entry that carries a port rather than silently dropping it", () => {
    // `linkedin.com:8080` would truncate to the host `linkedin.com` and quietly
    // authorise every port — broader than what the user typed.
    expect(parseEntry("linkedin.com:8080")).toBeNull();
    expect(isAllowed("https://linkedin.com/", ["linkedin.com:8080"])).toBe(false);
  });
});

describe("case and unicode axis", () => {
  it.each([
    ["uppercase url host", "https://LINKEDIN.COM/", ["linkedin.com"], true],
    ["uppercase entry", "https://linkedin.com/", ["LINKEDIN.COM"], true],
    ["mixed case both sides", "https://LinkedIn.Com/", ["lInKeDiN.cOm"], true],
    ["entry with surrounding whitespace", "https://linkedin.com/", ["  linkedin.com  "], true],
    ["ideographic full stop as the dot", "https://linkedin。com/", ["linkedin.com"], true],
  ])("%s → %s", (_label, url, list, expected) => {
    expect(isAllowed(url, list)).toBe(expected);
  });

  it.each([
    // U+0261 LATIN SMALL LETTER SCRIPT G — renders as `google.com`, is not.
    ["script-g homograph", "https://ɡoogle.com/", false],
    // U+03BF GREEK SMALL LETTER OMICRON in place of `o`.
    ["greek-omicron homograph", "https://gοogle.com/", false],
    // Cyrillic `о` — the classic paypal/apple attack shape.
    ["cyrillic homograph", "https://gооgle.com/", false],
    ["the real host", "https://google.com/", true],
  ])("%s against an entry for google.com → %s", (_label, url, expected) => {
    expect(isAllowed(url, ["google.com"])).toBe(expected);
  });

  it("matches an IDN host across its unicode and punycode spellings", () => {
    // Both directions, because the user may type either and Chrome reports the
    // punycode form. Getting this wrong locks a user out of their own entry.
    expect(isAllowed("https://münchen.de/", ["münchen.de"])).toBe(true);
    expect(isAllowed("https://xn--mnchen-3ya.de/", ["münchen.de"])).toBe(true);
    expect(isAllowed("https://münchen.de/", ["xn--mnchen-3ya.de"])).toBe(true);
    expect(isAllowed("https://a.münchen.de/", ["*.xn--mnchen-3ya.de"])).toBe(true);
  });

  it("does not let a punycode entry admit a different punycode host", () => {
    expect(isAllowed("https://ɡoogle.com/", ["xn--mnchen-3ya.de"])).toBe(false);
  });
});

describe("malformed input axis", () => {
  it.each([
    ["a bare sentence", "not a url"],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["a bare host with no scheme", "linkedin.com"],
    ["a protocol-relative url", "//linkedin.com/x"],
    ["a path only", "/feed/"],
    ["a scheme with nothing after it", "https://"],
    ["an unencoded space in the host", "https://linked in.com/"],
    ["a null byte in the host", "https://linkedin .com/"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", {}],
    ["a URL instance rather than a string", new URL("https://linkedin.com/")],
    ["an object stringifying to an allowed url", { toString: () => "https://linkedin.com/" }],
  ])("denies %s without throwing", (_label, url) => {
    expect(() => isAllowed(url, ["linkedin.com", "*.linkedin.com"])).not.toThrow();
    expect(isAllowed(url, ["linkedin.com", "*.linkedin.com"])).toBe(false);
  });
});

describe("entry parsing — a malformed entry must never widen the gate", () => {
  it.each([
    ["a bare star", "*"],
    ["a star with a dot", "*."],
    ["a star as a whole label", "*.*.com"],
    ["a star inside a name", "link*.com"],
    ["a trailing star", "linkedin.*"],
    // A star with no following dot. Pins `startsWith("*.")` against being
    // loosened to `startsWith("*")`, which would read `*xlinkedin.com` as a
    // wildcard for linkedin.com — authorising the real site from a typo.
    ["a star with no following dot", "*linkedin.com"],
    ["a star before a lookalike label", "*xlinkedin.com"],
    ["a star then a space", "* linkedin.com"],
    ["a star then a dash", "*-linkedin.com"],
    ["an empty entry", ""],
    ["whitespace only", "   "],
    ["a lone dot", "."],
    ["a leading dot", ".com"],
    ["a doubled trailing dot", "linkedin.com.."],
    ["an entry with a scheme", "https://linkedin.com"],
    ["an entry with a scheme and path", "https://linkedin.com/feed"],
    ["an entry with a path", "linkedin.com/feed"],
    ["an entry with a port", "linkedin.com:8080"],
    ["an entry with userinfo", "user@linkedin.com"],
    ["an entry with a query", "linkedin.com?x=1"],
    ["an entry with a fragment", "linkedin.com#top"],
    ["an entry with a backslash", "evil.test\\linkedin.com"],
    ["an entry with an inner space", "a b"],
    ["a percent-encoded traversal", "%2e%2e"],
  ])("rejects %s", (_label, entry) => {
    expect(parseEntry(entry)).toBeNull();
  });

  it.each([
    ["a plain host", "linkedin.com", { host: "linkedin.com", wildcard: false }],
    ["a wildcard host", "*.linkedin.com", { host: "linkedin.com", wildcard: true }],
    ["a padded, mixed-case host", " LinkedIn.COM ", { host: "linkedin.com", wildcard: false }],
    ["a fully qualified host", "linkedin.com.", { host: "linkedin.com", wildcard: false }],
    ["an IDN host", "münchen.de", { host: "xn--mnchen-3ya.de", wildcard: false }],
    ["an IPv4 literal", "127.0.0.1", { host: "127.0.0.1", wildcard: false }],
    ["a single-label host", "localhost", { host: "localhost", wildcard: false }],
  ])("accepts %s", (_label, entry, expected) => {
    // Negative control for the rejection table above. A parser that returned
    // null for everything would pass every rejection test and gate nothing —
    // these are what prove the rejections are discriminating, not blanket.
    expect(parseEntry(entry)).toEqual(expected);
  });

  it("rejects every non-string rather than coercing it", () => {
    // `String({})` is "[object Object]", and `String(["linkedin.com"])` is the
    // host itself — coercion would turn stored junk into a live rule.
    for (const value of [null, undefined, 0, 1, true, {}, [], ["linkedin.com"], () => "linkedin.com", { toString: () => "linkedin.com" }]) {
      expect(parseEntry(value)).toBeNull();
    }
  });

  it("does not let a star entry become allow-everything", () => {
    for (const star of ["*", "*.", " * ", "*.*"]) {
      expect(isAllowed("https://evil.test/", [star])).toBe(false);
      expect(isAllowed("https://linkedin.com/", [star])).toBe(false);
    }
  });
});

describe("isSameOrigin — page_fetch's rule, which no server enforces", () => {
  it.each([
    ["identical urls", "https://linkedin.com/a", "https://linkedin.com/a", true],
    ["same origin, different paths", "https://linkedin.com/a", "https://linkedin.com/b?q=1", true],
    ["same origin, explicit default port", "https://linkedin.com/a", "https://linkedin.com:443/b", true],
    ["different host", "https://linkedin.com/a", "https://evil.test/a", false],
    ["different subdomain", "https://linkedin.com/a", "https://www.linkedin.com/a", false],
    ["different scheme", "https://linkedin.com/a", "http://linkedin.com/a", false],
    ["different port", "https://linkedin.com:8080/a", "https://linkedin.com:9090/a", false],
    ["userinfo does not change the origin", "https://linkedin.com/a", "https://u:p@linkedin.com/b", true],
    ["a host smuggled as userinfo", "https://linkedin.com/a", "https://linkedin.com@evil.test/", false],
  ])("%s → %s", (_label, a, b, expected) => {
    expect(isSameOrigin(a, b)).toBe(expected);
  });

  // Both operands are checked independently, so both orders must be asserted.
  // Testing only one side leaves the other check able to be deleted with the
  // suite still green — which is exactly what the mutation run caught.
  it.each([
    ["file", "file:///a", "file:///b"],
    ["data", "data:text/plain,a", "data:text/plain,b"],
    ["about", "about:blank", "about:blank"],
    ["blob", "blob:https://linkedin.com/u", "blob:https://linkedin.com/u"],
    ["ws", "ws://linkedin.com/s", "ws://linkedin.com/s"],
  ])("refuses %s on both sides, whose origins serialise to the string null", (_label, a, b) => {
    // Two opaque origins both serialise to "null" and so compare equal, which is
    // how a file:// or data:// fetch would slip through a bare `origin ===`.
    expect(isSameOrigin(a, b)).toBe(false);
  });

  it.each([
    ["left", "file:///etc/passwd", "https://linkedin.com/"],
    ["right", "https://linkedin.com/", "file:///etc/passwd"],
    ["left ws", "ws://linkedin.com/", "https://linkedin.com/"],
    ["right ws", "https://linkedin.com/", "ws://linkedin.com/"],
  ])("refuses a disallowed scheme in the %s operand", (_label, a, b) => {
    expect(isSameOrigin(a, b)).toBe(false);
  });

  it.each([
    ["blob as the right operand", "https://linkedin.com/a", "blob:https://linkedin.com/u"],
    ["blob as the left operand", "blob:https://linkedin.com/u", "https://linkedin.com/a"],
    ["filesystem url", "https://linkedin.com/a", "filesystem:https://linkedin.com/temporary/x"],
  ])("refuses a %s that borrows an allowed page's origin", (_label, a, b) => {
    // Not a redundant restatement of the opaque-origin tests: `blob:` is the
    // case that makes the per-operand check load-bearing. Unlike file: or data:,
    // `new URL("blob:https://linkedin.com/u").origin` is "https://linkedin.com"
    // — a REAL origin, equal to the page's. So a guard checking only one operand
    // returns true here and lets a blob URL pass as same-origin with the page.
    expect(isSameOrigin(a, b)).toBe(false);
  });

  it("still admits a genuine same-origin pair", () => {
    // Negative control for the two tables above: a guard that refused every
    // scheme would pass all of them while making page_fetch useless.
    expect(isSameOrigin("https://linkedin.com/a", "https://linkedin.com/b")).toBe(true);
    expect(isSameOrigin("http://linkedin.com/a", "http://linkedin.com/b")).toBe(true);
  });

  it("denies malformed or non-string input rather than throwing", () => {
    for (const bad of ["not a url", "", null, undefined, 42, {}]) {
      expect(isSameOrigin("https://linkedin.com/", bad)).toBe(false);
      expect(isSameOrigin(bad, "https://linkedin.com/")).toBe(false);
    }
  });
});

describe("storage key", () => {
  it("names the key the popup and service worker both read", () => {
    // Two modules agreeing on a literal is the kind of fact nothing else checks.
    expect(STORAGE_KEY).toBe("companionAllowlist");
  });
});
