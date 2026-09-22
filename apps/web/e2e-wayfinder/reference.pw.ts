import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function openReference(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/__ui');
  await expect(
    page.getByRole('heading', { name: 'WayPass, built with shadcn Maia' }),
  ).toBeVisible();
  return errors;
}

test('loads the UI 0.3 reference and its required state groups', async ({ page }) => {
  const errors = await openReference(page);
  for (const heading of [
    'Foundation',
    'Controls and fields',
    'Async and feedback states',
    'Task-appropriate content',
    'Task surfaces',
  ]) {
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByText('No matching students', { exact: true })).toBeVisible();
  const overflow = await page
    .locator('html')
    .evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});

test('has no serious or critical axe violations', async ({ page }) => {
  await openReference(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  );
  expect(blocking).toEqual([]);
});

test('Base UI task surfaces work from the keyboard and restore focus', async ({ page }) => {
  await openReference(page);

  const primary = page.getByRole('button', { name: 'Create pass', exact: true }).first();
  await primary.focus();
  await expect(primary).toBeFocused();
  const focusStyles = await primary.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineStyle, shadow: style.boxShadow };
  });
  expect(focusStyles.outline !== 'none' || focusStyles.shadow !== 'none').toBe(true);

  const tableTab = page.getByRole('tab', { name: 'Table' });
  await tableTab.focus();
  await page.keyboard.press('Enter');
  await expect(tableTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('cell', { name: 'Avery Johnson' })).toBeVisible();

  const menuTrigger = page.getByRole('button', { name: 'Open row actions' });
  await menuTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Edit room' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menuTrigger).toBeFocused();

  const dialogTrigger = page.getByRole('button', { name: 'New room' });
  await dialogTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'New room' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialogTrigger).toBeFocused();
});

test('pending dialog actions stay in place and prevent duplicate submit', async ({ page }) => {
  await openReference(page);
  await page.getByRole('button', { name: 'New room' }).click();
  const submit = page.getByRole('button', { name: 'Create room' });
  await submit.click();
  const pending = page.getByRole('button', { name: 'Creating…' });
  await expect(pending).toBeDisabled();
  await expect(pending).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('dialog', { name: 'New room' })).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue('Library');
});

test('associates local search status copy with its input', async ({ page }) => {
  await openReference(page);
  const search = page.getByRole('textbox', { name: 'Search people' });
  await expect(search).toHaveAttribute('aria-describedby', 'reference-search-description');
  await expect(page.locator('#reference-search-description')).toHaveText(
    'Current results remain visible during refresh.',
  );
});

test('reflows without horizontal page overflow at 320 CSS pixels', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await openReference(page);
  const overflow = await page
    .locator('html')
    .evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
  await expect(page.getByRole('button', { name: 'New room' })).toBeVisible();
  await expect(page.getByText('No matching students', { exact: true })).toBeVisible();
});

test('renders coherently at a Chromebook-sized viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const errors = await openReference(page);
  await expect(page.getByRole('heading', { name: 'Task-appropriate content' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('reduces component motion without removing state feedback', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openReference(page);
  await expect(page.locator('[data-slot="spinner"]').first()).toHaveCSS(
    'animation-duration',
    '0.001s',
  );
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeVisible();
});

test('keeps semantic controls and states visible in forced colors', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await openReference(page);
  await expect(
    page.getByRole('button', { name: 'Create pass', exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Action required', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert').first()).toBeVisible();
});

test('keeps content and controls usable at 200 percent text size', async ({ page }) => {
  await openReference(page);
  await page.locator('html').evaluate((element) => {
    element.style.fontSize = '200%';
  });
  await expect(page.getByRole('heading', { name: 'Controls and fields' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New room' })).toBeVisible();
  const overflow = await page
    .locator('html')
    .evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
});
