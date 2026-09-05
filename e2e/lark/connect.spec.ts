import { test, expect, configure, mock, login } from './fixtures';

test('password user connects and disconnects Lark without exposing tokens', async ({ page }) => {
  await configure();
  await mock({ reset: true, user: { open_id: 'ou_connect', union_id: 'on_connect', email: 'connect@example.com', name: 'Browser Connect' } });
  await login(page, 'browseruser');
  await page.goto('/settings/lark');
  await page.getByRole('button', { name: 'Connect Lark', exact: true }).click();
  await expect(page.getByText('Lark account connected.', { exact: true })).toBeVisible();
  await expect(page.getByText('Browser Connect', { exact: true })).toBeVisible();
  await expect(page.getByText('connect@example.com', { exact: true })).toBeVisible();
  const { issued } = await mock();
  expect(issued.length).toBeGreaterThan(0);
  for (const { accessToken, refreshToken } of issued) {
    expect(await page.content()).not.toContain(accessToken);
    expect(await page.content()).not.toContain(refreshToken);
  }
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByText('Disconnect Lark?', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Connect Lark', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Connect Lark', exact: true })).toBeVisible();
});
