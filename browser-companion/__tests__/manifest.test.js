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

  it("hardcodes no AnythingLLM server, since the user supplies that at runtime", () => {
    // A baked-in host would be wrong for every self-hosted install, and would
    // also widen the extension's reach beyond what the user consented to.
    expect(JSON.stringify(manifest)).not.toMatch(
      /https?:\/\/(?!\*)[a-z0-9.-]+|localhost|\b\d{1,3}(\.\d{1,3}){3}\b/i
    );
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
