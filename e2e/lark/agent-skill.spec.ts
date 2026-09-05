import { test, expect, login } from './fixtures';

test('admin enables Lark agent skill and reload preserves selection', async ({ page }) => {
  await login(page);
  await page.goto('/settings/agents');
  await page.getByText('Lark', { exact: true }).last().click();
  const toggle = page.getByRole('checkbox');
  await expect(toggle).not.toBeChecked();
  await toggle.press('Space');
  await expect(toggle).toBeChecked();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Unsaved Changes', { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByText('Lark', { exact: true }).last().click();
  await expect(page.getByRole('checkbox')).toBeChecked();
});
