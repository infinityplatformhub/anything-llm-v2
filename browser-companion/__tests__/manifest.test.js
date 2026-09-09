import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  entries,
  entryFileNames,
  SERVICE_WORKER_FILENAME,
} from "../build.entries.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const readJSON = (relativePath) =>
  JSON.parse(readFileSync(path.join(packageRoot, relativePath), "utf8"));

/** True only if the path exists AND is a regular file. */
const isFile = (relativePath) => {
  try {
    return statSync(path.join(packageRoot, relativePath)).isFile();
  } catch {
    return false;
  }
};

// Parse the file that ships, not a literal written next to the assertion.
const manifest = readJSON("public/manifest.json");

describe("public/manifest.json", () => {
  it("declares MV3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("carries the fields Chrome rejects an extension without", () => {
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name.length).toBeGreaterThan(0);
    // Chrome requires 1-4 dot-separated integers, each 0-65535, no leading zeros.
    expect(manifest.version).toMatch(/^\d+(\.\d+){0,3}$/);
    for (const part of manifest.version.split(".")) {
      expect(Number(part)).toBeLessThanOrEqual(65535);
      expect(part).toBe(String(Number(part)));
    }
  });

  it("registers the service worker as an ES module, matching the vite output", () => {
    // `type: module` is load-bearing: the bundle vite emits uses `import`, and a
    // classic worker registration would fail at load with a syntax error.
    expect(manifest.background).toEqual({
      service_worker: SERVICE_WORKER_FILENAME,
      type: "module",
    });
  });

  it("keeps its version in step with package.json", () => {
    // Two files stating the same number is a fact Chrome cannot check for us;
    // a drifted manifest version ships as a silently un-upgradeable extension.
    expect(manifest.version).toBe(readJSON("package.json").version);
  });
});

describe("manifest permissions match what the design needs", () => {
  // Each declared permission must be justified, because an unused permission is
  // attack surface asked for free and an extra install-time warning to the user.
  const REQUIRED = [
    // trusted CDP input via chrome.debugger — the capability this feature exists for
    "debugger",
    // the agent opens tabs and reads their URLs
    "tabs",
    // the allowlist and the server URL/key persist across service-worker restarts
    "storage",
    // reconnect scheduling after the ~30s MV3 idle teardown
    "alarms",
  ];

  it("declares exactly the permissions the design needs, and no others", () => {
    expect([...manifest.permissions].sort()).toEqual([...REQUIRED].sort());
  });

  it("does not declare permissions belonging to the other extension", () => {
    // contextMenus/notifications are browser-extension/'s job, not this one's.
    for (const notOurs of ["contextMenus", "notifications", "scripting"]) {
      expect(manifest.permissions).not.toContain(notOurs);
    }
  });

  it("requests host access, which chrome.debugger attach needs per-origin", () => {
    expect(manifest.host_permissions).toContain("<all_urls>");
  });

  // A baked-in host would be wrong for every self-hosted install, and would also
  // widen the extension's reach beyond what the user consented to.
  //
  // The scheme axis matters more than the host axis here: task 8's socket client
  // connects over ws:// / wss://, so a hardcoded websocket URL is the exact
  // mistake this guard exists to catch. An http-only pattern would wave it
  // through. Bare `host:port` and bare dotted hostnames are covered too, since a
  // default server can be written with no scheme at all.
  //
  // A bare dotted name is the one ambiguous case: `llm.acme.co` is a host but
  // `background.js` is a filename, and the manifest legitimately contains the
  // latter. They are told apart by the final label — a web asset extension is
  // not a TLD. The negative control below is what keeps this honest.
  const ASSET_EXTENSION =
    "js|mjs|cjs|jsx|ts|tsx|html|htm|json|css|map|png|jpg|jpeg|gif|svg|ico|woff|woff2|txt|md";
  const HARDCODED_SERVER = new RegExp(
    [
      // any scheme's authority, incl. ws:// and wss://, and `//host`; `[::1]` too
      String.raw`(?:[a-z][a-z0-9+.-]*:)?//(?!\*)\[?[a-z0-9:._-]+\]?`,
      String.raw`\blocalhost\b`,
      String.raw`\b\d{1,3}(?:\.\d{1,3}){3}\b`, // IPv4
      String.raw`\b[a-z0-9-]+(?:\.[a-z0-9-]+)*:\d{2,5}\b`, // host:port, no scheme
      // bare dotted hostname whose last label is a TLD rather than a file type
      String.raw`\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?!(?:${ASSET_EXTENSION})\b)[a-z]{2,24}\b`,
    ].join("|"),
    "i"
  );

  // The guard must reject; these prove it is not vacuous, i.e. that it really
  // does fire on the shapes a wrongly-configured manifest would carry.
  it.each([
    ["ws with port", "ws://myhost:3001"],
    ["wss with hostname", "wss://llm.acme.co"],
    ["ws with IPv6 literal", "ws://[::1]:3001"],
    ["bare hostname, no scheme", "llm.acme.co"],
    ["bare host:port, no scheme", "myhost:3001"],
    ["http with port", "http://localhost:3001"],
    ["https with hostname", "https://dev2.example.com"],
    ["bare IPv4", "10.0.0.5"],
  ])("would catch a server address written as %s", (_label, value) => {
    expect(JSON.stringify({ ...manifest, default_server: value })).toMatch(
      HARDCODED_SERVER
    );
  });

  it("does not fire on the manifest's own legitimate contents", () => {
    // Negative control. If this fails the guard is over-broad and its passes
    // above would be worthless, since a pattern matching everything "catches"
    // everything. `<all_urls>` and `background.js` must not read as a server.
    expect(HARDCODED_SERVER.test(JSON.stringify(manifest))).toBe(false);
  });

  it("hardcodes no AnythingLLM server, since the user supplies that at runtime", () => {
    expect(JSON.stringify(manifest)).not.toMatch(HARDCODED_SERVER);
  });
});

describe("entry points named by the manifest exist on disk", () => {
  it("has the popup document the action opens", () => {
    // Vite emits dist/index.html from this source file; the manifest names
    // index.html, so the source must be there for the build to produce it.
    expect(manifest.action.default_popup).toBe("index.html");
    expect(isFile("index.html")).toBe(true);
  });

  it("has a source file for every rollup input", () => {
    for (const [name, source] of Object.entries(entries)) {
      // Pair the name into the assertion so a failure says WHICH entry is missing.
      expect([name, isFile(source)]).toEqual([name, true]);
    }
  });

  it("emits the service worker under the exact filename the manifest names", () => {
    expect(entryFileNames({ name: "background" })).toBe(
      manifest.background.service_worker
    );
  });

  it("content-hashes every entry that is not the service worker", () => {
    // The popup is referenced by generated HTML, so it may be hashed; the worker
    // is referenced by a hand-written manifest, so it may not be.
    expect(entryFileNames({ name: "main" })).toContain("[hash]");
  });

  it("references main.jsx from the popup document, and that file exists", () => {
    const html = readFileSync(path.join(packageRoot, "index.html"), "utf8");
    const src = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
    expect(src).toBeTruthy();
    expect(isFile(src.replace(/^\//, ""))).toBe(true);
  });
});
