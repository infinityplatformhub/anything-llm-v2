/**
 * Where the build toolchain (vite, react) is resolved from.
 *
 * WHY THIS IS NOT JUST `import "vite"`
 *
 * In the ordinary case — a developer who has run `yarn install` in
 * `browser-companion/` — the toolchain is in this package's own
 * `node_modules` and a bare import finds it. That is the default below and
 * nothing needs configuring.
 *
 * It is overridable because this repository is also worked on in git worktrees
 * that deliberately share one install rather than duplicating several hundred
 * megabytes per branch, and in that layout `vite` is resolvable from the shared
 * checkout and not from the worktree. An absolute path written into the source
 * would be one machine's layout committed as everyone's; an environment
 * variable is the deployment-varying value it actually is.
 *
 * Set `COMPANION_TOOLCHAIN` to a directory that CONTAINS a `node_modules` with
 * vite, @vitejs/plugin-react, react and react-dom in it.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/** This package's root, i.e. `browser-companion/`. */
export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/**
 * The directory whose `node_modules` the build tools are loaded from.
 * Defaults to this package, which is where `yarn install` puts them.
 */
export const TOOLCHAIN_ROOT = process.env.COMPANION_TOOLCHAIN
  ? path.resolve(process.env.COMPANION_TOOLCHAIN)
  : PACKAGE_ROOT;

/**
 * Resolve a package from the toolchain root.
 *
 * @param {string} specifier
 * @returns {string} absolute path to the resolved module
 * @throws {Error} naming the package AND the override, because "Cannot find
 *   module 'vite'" tells a reader nothing about which of the two roots was
 *   searched or how to point it somewhere else.
 */
export function resolveTool(specifier) {
  // `createRequire` against a file INSIDE the root, so node walks that root's
  // node_modules rather than this file's.
  const require = createRequire(path.join(TOOLCHAIN_ROOT, "noop.js"));
  try {
    return require.resolve(specifier);
  } catch (error) {
    throw new Error(
      `Could not resolve "${specifier}" from ${TOOLCHAIN_ROOT}/node_modules. ` +
        `Run \`yarn install\` in ${PACKAGE_ROOT}, or set COMPANION_TOOLCHAIN to a ` +
        `directory whose node_modules has vite, @vitejs/plugin-react, react and ` +
        `react-dom. (${String(error?.message ?? error)})`
    );
  }
}

/**
 * Import a package from the toolchain root, flattened past CJS interop.
 *
 * `require.resolve` picks a package's `main`, which for vite is its CJS entry
 * — and importing a CJS file from ESM puts every named export behind
 * `default`. So `import("vite")` yields the real API while `importTool("vite")`
 * yielded `{default, defineConfig, "module.exports"}` and `build` was
 * `undefined`, which fails as "build is not a function" several layers from the
 * cause. Merging the namespace over its own `default` makes both shapes read
 * the same way.
 *
 * @param {string} specifier
 * @returns {Promise<object>}
 */
export async function importTool(specifier) {
  const namespace = await import(pathToFileURL(resolveTool(specifier)).href);
  const flat = namespace?.default;
  if (flat && typeof flat === "object") return { ...flat, ...namespace };
  return namespace;
}

/**
 * Whether a build is possible at all right now.
 *
 * Checked and REPORTED rather than discovered as a stack trace three layers
 * down: "the bundler is not installed" and "the popup is broken" are different
 * problems with different fixes, and a test run must not confuse them.
 *
 * @returns {{ok: true} | {ok: false, missing: string[], root: string}}
 */
export function toolchainStatus() {
  const missing = [];
  for (const specifier of [
    "vite",
    "@vitejs/plugin-react",
    "react",
    "react-dom",
  ]) {
    try {
      resolveTool(specifier);
    } catch {
      missing.push(specifier);
    }
  }
  if (missing.length) return { ok: false, missing, root: TOOLCHAIN_ROOT };
  return { ok: true };
}

/**
 * Aliases pointing React at the toolchain's copy.
 *
 * Needed only when the toolchain is somewhere other than this package: vite
 * resolves a bare `react` import relative to the project root, which in that
 * layout has no `node_modules`. When the toolchain IS this package the aliases
 * resolve to the same files a bare import would have found, so they are
 * harmless rather than conditional.
 *
 * ONE COPY OF REACT MATTERS: two would give the popup a second, separate
 * hook dispatcher and every `useState` would throw "invalid hook call".
 *
 * @returns {Array<{find: RegExp, replacement: string}>}
 */
export function reactAliases() {
  const entries = [
    ["react", "react"],
    ["react-dom", "react-dom"],
    ["react-dom/client", "react-dom/client"],
    ["react/jsx-runtime", "react/jsx-runtime"],
    ["react/jsx-dev-runtime", "react/jsx-dev-runtime"],
  ];
  const aliases = [];
  for (const [specifier, target] of entries) {
    let resolved;
    try {
      resolved = resolveTool(target);
    } catch {
      continue; // Reported by `toolchainStatus`, not swallowed here.
    }
    aliases.push({
      // Anchored, so `react` does not also rewrite `react-dom`.
      find: new RegExp(`^${specifier.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}$`),
      replacement: resolved,
    });
  }
  const scheduler = (() => {
    try {
      return resolveTool("scheduler");
    } catch {
      return null;
    }
  })();
  if (scheduler)
    aliases.push({ find: /^scheduler$/, replacement: scheduler });
  return aliases;
}

/** @param {string} p @returns {boolean} */
export const isFile = (p) => existsSync(p);
