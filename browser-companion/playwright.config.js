import { defineConfig } from "@playwright/test";

/**
 * The browser-companion popup's E2E.
 *
 * Separate from the repo-root `e2e/playwright.config.ts` because that one
 * targets the AnythingLLM web app on a baseURL and this one targets an
 * extension loaded into a real Chrome profile — no server, no baseURL, and a
 * persistent context the fixtures build themselves.
 *
 * NO `headless: false` HERE ON PURPOSE. The launch happens in `fixtures.mjs`,
 * and the CI gate reads `.config.argv` for `--headed` — a headless run cannot
 * be told from a headed one otherwise, since Playwright does not serialise the
 * `use` block into its JSON report. So the flag is passed on the command line
 * and this file does not quietly set it, which would make the flag look
 * redundant to the next reader.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.js",
  // The build runs once inside the first worker; a second worker would build a
  // second time into the same dist and the two would race over the directory.
  workers: 1,
  // Generous: the first test pays for a real vite build plus a Chrome launch.
  timeout: 120_000,
  // Zero, deliberately. A retry that turns red green hides a flake, and the
  // gate treats flaky as a failure for the same reason.
  retries: 0,
  reporter: "list",
});
