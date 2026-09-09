// Single source of truth for this extension's build entry points.
//
// It lives outside vite.config.js, and imports nothing from vite, so that the
// manifest test can read the real values the build uses without the build
// toolchain being installed. If this were inline in vite.config.js the test could
// only restate the filenames, and a test that restates its subject cannot fail.
//
// ADDING AN ENTRY POINT: add it here, not in vite.config.js. An input declared
// straight into the rollup config still builds, so nothing will complain — it is
// simply invisible to the manifest test, which is the only thing checking that
// every entry has a real source file and that the service worker keeps the exact
// filename manifest.json names. Splitting the list is how that check silently
// stops covering the new entry.

/**
 * Rollup inputs, as paths relative to this directory.
 * `main` is the popup document; `background` is the MV3 service worker.
 */
export const entries = {
  main: "index.html",
  background: "src/background/index.js",
};

/**
 * manifest.json names the service worker by a fixed filename, so that one entry
 * must not get a content hash the way the popup chunks do.
 */
export const SERVICE_WORKER_FILENAME = "background.js";

/** @param {{ name: string }} chunk */
export function entryFileNames(chunk) {
  return chunk.name === "background"
    ? SERVICE_WORKER_FILENAME
    : "assets/[name]-[hash].js";
}
