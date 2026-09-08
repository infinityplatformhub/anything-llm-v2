import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./ui",
  testMatch: "workspace-mcp-servers.spec.ts",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: "./logs/mcp-servers-ui/results",
  reporter: [["list"], ["html", { outputFolder: "./logs/mcp-servers-ui/report", open: "never" }]],
  use: {
    baseURL: "http://localhost:3020",
    browserName: "chromium",
    headless: false,
    launchOptions: {
      slowMo: 100,
      args: [
        "--window-position=-3000,-3000",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
      ],
    },
    viewport: { width: 1440, height: 1000 },
    video: "on",
    screenshot: "on",
    trace: "retain-on-failure",
  },
});
