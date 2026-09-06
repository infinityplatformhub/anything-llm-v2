import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./ui",
  testMatch: "workspace-mcp-connectors.spec.ts",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: "./logs/mcp-ui/results",
  reporter: [["list"], ["html", { outputFolder: "./logs/mcp-ui/report", open: "never" }]],
  use: {
    baseURL: "http://localhost:3020",
    browserName: "chromium",
    headless: false,
    launchOptions: { slowMo: 300 },
    viewport: { width: 1440, height: 1000 },
    video: "on",
    screenshot: "on",
    trace: "retain-on-failure",
  },
});
