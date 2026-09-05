import { test, expect, login, logout, state, require, helpers } from './fixtures';

test('admin tests unsaved credentials, saves masked settings, and excludes managers', async ({ page }) => {
  const { withDb, closeDb } = require(`${helpers}/db.js`);
  try {
    await withDb(state().environment, db => db.system_settings.deleteMany({ where: { label: { startsWith: 'lark_' } } }));
  } finally {
    await closeDb();
  }
  await login(page);
  await page.goto('/settings/authentication/lark');
  await page.getByTestId('lark-test-connection').click();
  await expect(page.getByTestId('lark-test-result')).toHaveText('Enter App ID and App Secret first.');
  await page.getByTestId('lark-app-id').fill('cli_browser_app');
  await page.getByTestId('lark-app-secret').fill('browser-app-secret');
  await page.route('**/api/admin/lark-settings/test', route => route.fulfill({
    json: { ok: true, tenant_key: null, tenant_name: null },
  }));
  await page.getByTestId('lark-test-connection').click();
  await expect(page.getByTestId('lark-test-result')).toHaveText('Connection successful, but the tenant could not be read. Add the tenant:tenant:readonly scope in Lark Developer Console or enter the tenant_key manually.');
  await expect(page.getByTestId('lark-tenant-key')).toHaveValue('');
  await page.unroute('**/api/admin/lark-settings/test');
  await page.getByTestId('lark-test-connection').click();
  await expect(page.getByTestId('lark-test-result')).toHaveText('Connection successful. Tenant: E2E Tenant');
  await expect(page.getByTestId('lark-tenant-key')).toHaveValue('tenant_e2e');
  await page.getByTestId('lark-enabled').press('Space');
  await page.getByTestId('lark-save').click();
  await expect(page.getByText('Lark settings saved.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('lark-app-secret')).toHaveValue('********');
  await expect(page.getByTestId('lark-app-id')).toHaveValue('cli_browser_app');
  await expect(page.getByTestId('lark-tenant-key')).toHaveValue('tenant_e2e');
  await expect(page.getByTestId('lark-enabled')).toBeChecked();
  await logout(page, 'br');
  await login(page, 'browsermanager');
  await page.goto('/settings/users');
  await expect(page.getByRole('button', { name: 'Add user' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Lark', exact: true })).toHaveCount(0);
  await page.goto('/settings/authentication/lark');
  await expect(page).not.toHaveURL(/settings\/authentication\/lark/);
  await expect(page.getByTestId('lark-save')).toHaveCount(0);
});
