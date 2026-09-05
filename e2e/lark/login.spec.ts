import { test, expect, configure, mock, login, logout, state } from './fixtures';

test('Lark login provisions once, rejects denied consent and foreign tenant', async ({ page, browser }) => {
  await configure(false);
  await login(page);
  await logout(page, 'br');
  await expect(page.getByRole('button', { name: 'Login with Lark' })).toHaveCount(0);
  await configure();
  await mock({ reset: true, user: { open_id: 'ou_login', union_id: 'on_login', name: 'Browser Login', email: 'browser.login@example.com' } });
  const adminContext = await browser.newContext({ baseURL: state().baseURL });
  await adminContext.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const adminPage = await adminContext.newPage();
  try {
    await login(adminPage);
    const countUsers = async () => {
      await adminPage.goto('/settings/users');
      await expect(adminPage.getByRole('rowheader', { name: 'browseradmin', exact: true })).toBeVisible();
      return adminPage.locator('tbody tr').count();
    };
    const before = await countUsers();
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.goto('/login');
      const visited: string[] = [];
      const observe = (request: any) => { if (request.isNavigationRequest()) visited.push(request.url()); };
      page.on('request', observe);
      await page.getByRole('button', { name: 'Login with Lark' }).click();
      await expect(page).toHaveURL(`${state().baseURL}/`);
      page.off('request', observe);
      expect(visited.some(url => url.startsWith(`${state().mockLarkUrl}/open-apis/authen/v1/authorize`))).toBe(true);
      expect(visited.some(url => url.includes('/sso/lark'))).toBe(true);
      await page.getByRole('button', { name: 'br', exact: true }).click();
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await expect(page.locator('input[name="username"]')).toHaveValue('browser.login');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      expect(await countUsers()).toBe(before + 1);
      await logout(page, 'br');
    }
    await mock({ deny: true });
    await page.getByRole('button', { name: 'Login with Lark' }).click();
    await expect(page).toHaveURL(/\/login\?lark_error=denied/);
    await expect(page.getByRole('alert')).toContainText('Lark sign-in was cancelled.');
    await mock({ deny: false });
    await mock({ user: { open_id: 'ou_foreign', union_id: 'on_foreign', email: 'foreign@example.com', tenant_key: 'foreign_tenant' } });
    await page.getByRole('button', { name: 'Login with Lark' }).click();
    await expect(page).toHaveURL(/\/login\?lark_error=tenant/);
    await expect(page.getByRole('alert')).toContainText('This Lark account belongs to a different company.');
    expect(await countUsers()).toBe(before + 1);
  } finally {
    await adminContext.close();
    await mock({ reset: true });
  }
});
