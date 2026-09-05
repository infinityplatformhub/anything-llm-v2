import { test, expect, configure, state, require, helpers } from './fixtures';
const { withDb, closeDb } = require(`${helpers}/db.js`);

test('single-user mode hides and denies Lark while server stays healthy', async ({ page, request }) => {
  await configure();
  const environment = state().environment;
  const previous = await withDb(environment, db => db.system_settings.findUnique({ where: { label: 'multi_user_mode' } }));
  try {
    await withDb(environment, db => db.system_settings.update({ where: { label: 'multi_user_mode' }, data: { value: 'false' } }));
    await page.goto('/login');
    await expect(page).toHaveURL(`${state().baseURL}/`);
    await expect(page.getByRole('button', { name: 'Login with Lark' })).toHaveCount(0);
    await page.goto('/settings/lark');
    await expect(page).not.toHaveURL(/\/settings\/lark/);
    await expect(page.getByRole('button', { name: 'Connect Lark' })).toHaveCount(0);
    expect((await request.get('/api/lark/status')).status()).toBe(403);
    expect((await request.get('/api/ping')).status()).toBe(200);
  } finally {
    await withDb(environment, db => db.system_settings.update({ where: { label: 'multi_user_mode' }, data: { value: previous.value } }));
    await closeDb();
  }
});
