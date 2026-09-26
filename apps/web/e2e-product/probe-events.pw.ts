import { expect, test } from '@playwright/test';
import { ORG, orgCategories, orgRooms, shell } from './fixtures';

const ADMIN = {
  affiliations: ['staff'],
  capabilities: ['room.manage', 'authorization.manage'],
};

test('probe trusted event trace', async ({ page }) => {
  page.on('console', (message) => {
    if (message.text().startsWith('EVT ')) console.log(`PAGE-${message.text()}`);
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
  await page.evaluate(() => {
    for (const kind of [
      'pointerover', 'pointerenter', 'pointerdown', 'pointerup', 'pointercancel',
      'mousedown', 'mouseup', 'click', 'dblclick', 'focusin', 'focus', 'focusout',
      'selectstart', 'selectionchange', 'scroll', 'auxclick', 'contextmenu',
      'gotpointercapture', 'lostpointercapture', 'dragstart',
    ]) {
      document.addEventListener(
        kind,
        (event) => {
          const target = event.target as Element | null;
          const label =
            target instanceof Element
              ? (target.getAttribute('aria-label') ?? target.tagName)
              : '?';
          console.log(`EVT ${kind} <- ${String(label).slice(0, 40)} trusted=${event.isTrusted}`);
        },
        true,
      );
    }
    document.addEventListener(
      'scroll',
      () => console.log('EVT scroll-capture'),
      true,
    );
  });
  const box = await table.getByRole('button', { name: /Collapse Nurse/ }).boundingBox();
  if (!box) throw new Error('no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  console.log('MOVE-OK');
  await page.mouse.down({ timeout: 8000 });
  console.log('DOWN-OK');
  await page.waitForTimeout(1500);
  const up = page.mouse.up({ timeout: 12000 });
  const outcome = await Promise.race([
    up.then(() => 'UP-RESOLVED'),
    new Promise((resolve) => setTimeout(() => resolve('UP-STUCK'), 12000)),
  ]);
  console.log(`UP-OUTCOME ${String(outcome)}`);
});
