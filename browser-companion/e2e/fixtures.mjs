/**
 * Playwright fixtures that load the REAL built extension into a real browser.
 *
 * WHAT IS REAL HERE, stated plainly because the value of this suite rests on it:
 *   - the bundle is the production vite build of the actual source;
 *   - it is loaded by Chrome as an unpacked MV3 extension, so `chrome.storage`,
 *     `chrome.runtime.sendMessage` and the service worker are Chrome's own, not
 *     doubles;
 *   - the popup is opened at its real `chrome-extension://<id>/index.html`
 *     origin, so a bundle that fails to load fails the test.
 *
 * WHAT IS NOT REAL: there is no AnythingLLM server, so the socket never reaches
 * `online` — the states this suite drives are the ones reachable without one,
 * which happen to be the states that matter most in this UI (empty allowlist,
 * failed write, terminal close). A test asserting `online` would need a server
 * and is not attempted rather than faked.
 */
import { test as base, chromium, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { buildExtension } from "./build-extension.mjs";

/**
 * Where an already-downloaded "Chrome for Testing" lives, if the default one
 * for this Playwright version is not installed.
 *
 * WHY THIS FALLBACK EXISTS RATHER THAN JUST LETTING PLAYWRIGHT PICK. Playwright
 * pins one chromium revision per release and refuses to launch when that exact
 * build is absent. On a machine where `npx playwright install` has not been run
 * for this version — including this repository's shared-install worktree layout
 * — that is a hard stop, and the honest options are to fail with a message
 * naming the fix, or to use a Chrome for Testing build that IS present. Both
 * are better than silently falling back to branded Chrome, which loads no
 * extension at all (see the launch below).
 *
 * The override is an environment variable because a browser path is exactly the
 * kind of value that varies by machine.
 *
 * @returns {string|undefined} an executable path, or undefined to let
 *   Playwright use its own pinned build
 */
function chromeForTestingPath() {
  if (process.env.COMPANION_CHROME) return process.env.COMPANION_CHROME;

  const cache = path.join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;

  // Highest revision first: a newer build is the closer match to the one this
  // Playwright wanted.
  const builds = readdirSync(cache)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));

  for (const build of builds) {
    for (const arch of ["chrome-mac-arm64", "chrome-mac"]) {
      const executable = path.join(
        cache,
        build,
        arch,
        "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
      );
      if (existsSync(executable)) return executable;
    }
  }
  return undefined;
}

/**
 * Chrome flags the run depends on, with the reason each is here.
 *
 * The window is moved off-screen rather than run headless: the gate requires
 * `--headed` on the command line, and a real headed window that is merely out
 * of the way keeps a person able to watch when they want to.
 *
 * The three backgrounding flags are NOT optional dressing. Chrome throttles
 * timers and stops rendering a window it believes is occluded — which an
 * off-screen one is — and without them the popup's poll interval stalls and
 * screenshots come back blank, which reads as a bug in the popup.
 */
const CHROME_ARGS = Object.freeze([
  "--window-position=-3000,-3000",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
]);

/** Built once per worker; the build is deterministic and takes seconds. */
let distPromise = null;
const distOnce = () => (distPromise ??= buildExtension());

export const test = base.extend({
  /** The persistent context Chrome needs to load an extension at all. */
  context: async ({}, use) => {
    const dist = await distOnce();
    const profile = mkdtempSync(path.join(tmpdir(), "companion-e2e-"));
    const context = await chromium.launchPersistentContext(profile, {
      // PLAYWRIGHT'S OWN CHROMIUM ("Chrome for Testing"), NOT `channel:
      // "chrome"`. This was measured, not assumed: branded Chrome 137+ ships a
      // kill switch for `--load-extension`, and on Chrome 152 the flag is
      // accepted and then ignored — `chrome://version` shows it on the command
      // line, `chrome://extensions` lists nothing, and no service worker is
      // ever registered. `--disable-features=DisableLoadExtensionCommandLineSwitch`
      // and `--enable-unsafe-extension-debugging` were both tried and neither
      // brings it back. The failure mode is the dangerous one: the browser
      // launches, the tests run, and every extension-dependent assertion fails
      // for a reason that looks like a bug in the popup.
      //
      // Chrome for Testing is the build without that policy, and it is what
      // Playwright installs, so the E2E depends on nothing beyond a normal
      // `npx playwright install chromium`.
      headless: false,
      executablePath: chromeForTestingPath(),
      args: [
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
        ...CHROME_ARGS,
      ],
    });
    await use(context);
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  },

  /**
   * The extension's id, read from the service worker Chrome actually started.
   *
   * Waiting for the worker is what proves the BACKGROUND half loaded: a bundle
   * whose service worker throws at import never registers, and this fixture
   * times out rather than letting the popup tests pass around a dead worker.
   */
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    await use(new URL(worker.url()).host);
  },

  /** The popup, at its real extension origin. */
  popup: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/index.html`);
    await use(page);
  },
});

export { expect };
