import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const require = createRequire(import.meta.url);
export const helpers = path.resolve(import.meta.dirname, '../../server/__tests__/e2e/lark/helpers');
export const state = () => JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../.state/lark.json'), 'utf8'));
export const test = base.extend({
  baseURL: async ({}, use) => use(state().baseURL),
  context: async ({ context }, use) => {
    // Never let a browser redirect contact real Lark or any other remote host.
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
    });
    await use(context);
  },
});
export { expect };

export async function api(route: string, body?: object) {
  const { baseURL, token } = state();
  const response = await fetch(`${baseURL}/api${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  expect(response.ok).toBeTruthy();
  return response.json();
}

export async function configure(enabled = true) {
  const result = await api('/admin/lark-settings', {
    lark_login_enabled: enabled, lark_app_id: 'cli_browser_app',
    lark_app_secret: 'browser-app-secret', lark_tenant_key: 'tenant_e2e',
  });
  expect(result.success).toBe(true);
}

export async function mock(body = {}) {
  const { mockLarkUrl, controlKey } = state();
  const response = await fetch(`${mockLarkUrl}/__control`, {
    method: 'POST', headers: { Authorization: `Bearer ${controlKey}` }, body: JSON.stringify(body),
  });
  expect(response.ok).toBeTruthy();
  return response.json();
}

export async function login(page: Page, username = state().admin.username) {
  await page.goto('/login');
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(state().admin.password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  const recovery = page.getByRole('heading', { name: 'Recovery Codes', exact: true });
  const account = page.getByRole('button', { name: username.slice(0, 2), exact: true });
  await expect(recovery.or(account)).toBeVisible();
  if (await recovery.isVisible()) {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    await (await download).delete();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  }
  await expect(page).toHaveURL(`${state().baseURL}/`);
  await expect(account).toBeVisible();
  // Recovery-code acknowledgement starts another session check after home mounts.
  // Leaving before it settles aborts that check and clears the new login.
  await page.waitForLoadState('networkidle');
}

export async function logout(page: Page, initials: string) {
  await page.goto('/');
  await page.getByRole('button', { name: initials, exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('input[name="username"]')).toBeVisible();
}
