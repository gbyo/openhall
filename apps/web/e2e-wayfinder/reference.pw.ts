import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function openReference(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/__wayfinder');
  await expect(
    page.getByRole('heading', { name: 'Clear movement. Honest evidence.' }),
  ).toBeVisible();
  return errors;
}

test('loads the development reference and every canonical state', async ({ page }) => {
  const errors = await openReference(page);
  for (const heading of [
    'Foundations',
    'Accessible primitives',
    'WayPass patterns',
    'Canonical student states',
    'Accessibility & resilience',
  ]) {
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  await expect(
    page.getByTestId('canonical-student-states').locator('.wf-student-state-example'),
  ).toHaveCount(11);
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

test('representative controls work from the keyboard', async ({ page }) => {
  await openReference(page);
  const start = page.getByRole('button', { name: 'Start pass' }).first();
  await start.focus();
  await expect(start).toBeFocused();
  expect(await start.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
    'none',
  );

  const combo = page.getByRole('combobox', { name: 'Destination' });
  await combo.focus();
  await combo.pressSequentially('Res');
  await expect(page.getByRole('option', { name: /Restroom/ })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(combo).toHaveValue('Restroom');

  const statusTab = page.getByRole('tab', { name: 'Status' });
  await statusTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Rules' })).toHaveAttribute('aria-selected', 'true');

  const menuTrigger = page.getByRole('button', { name: 'Actions' });
  await menuTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: /Rename destination/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menuTrigger).toBeFocused();

  const dialogTrigger = page.getByRole('button', { name: 'Close Nurse' });
  await dialogTrigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Close Nurse?' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialogTrigger).toBeFocused();
});

test('reflows without horizontal overflow at 320 CSS pixels', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await openReference(page);
  const overflow = await page
    .locator('html')
    .evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start pass' }).first()).toBeVisible();
});

test('renders coherently at a Chromebook-sized viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const errors = await openReference(page);
  await expect(page.getByRole('heading', { name: 'WayPass patterns' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('honors reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openReference(page);
  await expect(page.locator('.wf-motion-demo span')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.wf-connection-status__pulse').first()).toHaveCSS(
    'animation-name',
    'none',
  );
  expect(
    await page
      .locator('html')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--wf-motion-standard').trim(),
      ),
  ).toBe('1ms');
});

test('preserves controls and truthful route structure in forced colors', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await openReference(page);
  await expect(page.getByRole('button', { name: 'Start pass' }).first()).toBeVisible();
  await expect(page.getByText('Departed', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Destination', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.wf-route-stop__marker').first()).toHaveCSS(
    'border-top-style',
    'solid',
  );
  await expect(page.locator('.wf-route-stop--intended .wf-route-stop__marker').first()).toHaveCSS(
    'border-top-style',
    'dashed',
  );
});

test('renders no enabled action without its handler', async ({ page }) => {
  await openReference(page);
  await expect(page.getByRole('button', { name: 'Review latest version' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
});

test('associates the search field description with its input', async ({ page }) => {
  await openReference(page);
  const search = page.getByRole('searchbox', { name: 'Search destinations' });
  const descriptionText = await search.evaluate((element) => {
    const firstId = (element.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .slice(0, 1)
      .join('');
    return document.getElementById(firstId)?.textContent ?? '';
  });
  expect(descriptionText).toBe('Results update as you type.');
});

test('declares pass cards as inline-size query containers', async ({ page }) => {
  await openReference(page);
  await expect(page.locator('.wf-pass-card').first()).toHaveCSS('container-type', 'inline-size');
});

test('keeps selected options legible in forced colors', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await openReference(page);
  const selectors = await page.evaluate(() => {
    const found: string[] = [];
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule && rule.conditionText.includes('forced-colors')) {
          for (const inner of rule.cssRules) {
            if (
              inner instanceof CSSStyleRule &&
              inner.selectorText.includes('[data-selected]') &&
              (inner.selectorText.includes('.wf-listbox__item') ||
                inner.selectorText.includes('.wf-menu__item'))
            ) {
              found.push(inner.selectorText);
            }
          }
        }
      }
    }
    return found;
  });
  expect(selectors.length).toBeGreaterThan(0);
});

test('keeps content and controls usable at 200 percent text size', async ({ page }) => {
  await openReference(page);
  await page.locator('html').evaluate((element) => {
    element.style.fontSize = '200%';
  });
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start pass' }).first()).toBeVisible();
  const clipped = await page
    .locator('[data-testid="canonical-student-states"]')
    .evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(clipped).toBe(false);
});
