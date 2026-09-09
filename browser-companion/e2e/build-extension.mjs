/**
 * Build the real extension into `dist/`, for the E2E to load unpacked.
 *
 * THIS IS THE PRODUCTION BUILD, NOT A TEST FIXTURE. It runs the same
 * `vite.config.js`, the same `build.entries.js` and the same
 * `public/manifest.json` that ship — the only thing it adds is where the
 * toolchain is resolved from (see toolchain.mjs) and the React aliases that
 * makes necessary.
 *
 * WHY THAT MATTERS MORE THAN CONVENIENCE. An E2E that rendered the popup from a
 * hand-written HTML harness would pass while the real bundle failed to build,
 * failed to load as an extension, or rendered against a `chrome` object that
 * does not exist in a page context. Every one of those is a total feature
 * failure invisible to such a test. Building the real artefact and loading it
 * as a real unpacked extension is what makes the run mean anything.
 */
import { rmSync } from "node:fs";
import path from "node:path";
import {
  PACKAGE_ROOT,
  importTool,
  reactAliases,
  toolchainStatus,
} from "./toolchain.mjs";

export const DIST = path.join(PACKAGE_ROOT, "dist");

/**
 * @returns {Promise<string>} the absolute path to the built, loadable extension
 * @throws {Error} when the toolchain is not installed, naming what is missing
 */
export async function buildExtension() {
  const status = toolchainStatus();
  if (!status.ok) {
    throw new Error(
      `Cannot build the extension: ${status.missing.join(", ")} ` +
        `not resolvable from ${status.root}/node_modules. Run \`yarn install\` in ` +
        `${PACKAGE_ROOT}, or set COMPANION_TOOLCHAIN to a checkout that has them.`
    );
  }

  const { build } = await importTool("vite");
  const reactPluginModule = await importTool("@vitejs/plugin-react");
  const react = reactPluginModule.default ?? reactPluginModule;
  const { entries, entryFileNames } = await import("../build.entries.js");

  // Removed rather than relied on `emptyOutDir`, so a stale bundle from an
  // earlier run can never be what the browser loads — which would be a green
  // test against code that is no longer in the tree.
  rmSync(DIST, { recursive: true, force: true });

  await build({
    root: PACKAGE_ROOT,
    // The popup is loaded from `chrome-extension://<id>/index.html`, so its
    // asset URLs must be relative; the default absolute `/assets/...` resolves
    // to the extension root and happens to work, but only by luck of the
    // origin's shape.
    base: "./",
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    resolve: { alias: reactAliases() },
    build: {
      outDir: DIST,
      emptyOutDir: true,
      rollupOptions: { input: entries, output: { entryFileNames } },
    },
  });

  return DIST;
}
