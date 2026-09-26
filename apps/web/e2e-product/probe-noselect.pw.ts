import { expect, test } from '@playwright/test';
import { ORG, orgCategories, orgRooms, shell } from './fixtures';

const ADMIN = {
  affiliations: ['staff'],
  capabilities: ['room.manage', 'authorization.manage'],
};

test('probe no-select trusted click', async ({ page }) => {
  await page.addInitScript(() => {
    const css = '* { user-select: none !important; -webkit-user-select: none !important; }';
    const apply = () => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.append(style);
    };
    if (document.head) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
  });
  await shell(page, { ...ADMIN });
  await page.route(`**/api/v1/organizations/${ORG}/rooms`, (route) =>
    route.fulfill({ json: orgRooms() }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/room-categories`, (route) =>
    route.fulfill({ json: orgCategories() }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/authorization-grants`, (route) =>
    route.fulfill({ json: { grants: [] } }),
  );
  await page.goto(`/schools/${ORG}/admin/rooms`);
  const table = page.getByRole('table', { name: 'Rooms grouped by category' });
  await expect(table.getByRole('link', { name: 'Health Office' })).toBeVisible();
  const selected = await page.evaluate(() => {
    const button = document.querySelector('[aria-label="Collapse Nurse"]');
    return button ? getComputedStyle(button).userSelect : 'missing';
  });
  console.log(`USER-SELECT ${selected}`);
  const click = table.getByRole('button', { name: /Collapse Nurse/ }).click({ timeout: 15000 });
  const outcome = await Promise.race([
    click.then(() => 'RESOLVED'),
    new Promise((resolve) => setTimeout(() => resolve('STUCK'), 15000)),
  ]);
  console.log(`OUTCOME ${String(outcome)}`);
});
