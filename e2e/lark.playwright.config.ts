import { defineConfig, chromium } from '@playwright/test';
import { homedir } from 'node:os';
import fs from 'node:fs';

const bundled = chromium.executablePath();
const legacyMac = `${homedir()}/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium`;
const executablePath = fs.existsSync(bundled) ? bundled : fs.existsSync(legacyMac) ? legacyMac : undefined;

export default defineConfig({
  testDir: './lark',
  globalSetup: './lark/global-setup.ts',
  globalTeardown: './lark/global-teardown.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    browserName: 'chromium',
    launchOptions: { executablePath },
    trace: 'retain-on-failure',
  },
});
