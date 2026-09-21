import { expect, test, type Page } from '@playwright/test';
import { DESTINATION, ORG, ORG_B, shell, studentApis } from './fixtures';

const STUDENT = {
  affiliations: ['student'],
  capabilities: ['pass.request.self', 'pass.depart.self'],
};

interface ErrorCapture {
  pageErrors: string[];
  consoleErrors: string[];
}

function captureErrors(page: Page): ErrorCapture {
  const captured: ErrorCapture = { pageErrors: [], consoleErrors: [] };
  page.on('pageerror', (error) => captured.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') captured.consoleErrors.push(message.text());
  });
  return captured;
}

function expectClean(captured: ErrorCapture): void {
  expect(captured.pageErrors).toEqual([]);
  expect(captured.consoleErrors).toEqual([]);
}

async function openStudentShell(page: Page): Promise<ErrorCapture> {
  const captured = captureErrors(page);
  await shell(page, STUDENT);
  await studentApis(page, { current: null });
  await page.goto(`/schools/${ORG}/pass`);
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toBeVisible();
  return captured;
}

test('school switcher opens without menu context errors', async ({ page }) => {
  const captured = await openStudentShell(page);
  // A second school turns the sidebar switcher into a dropdown menu.
  await page.route('**/api/v1/me/organizations', (route) =>
    route.fulfill({
      json: {
        organizations: [
          {
            id: ORG,
            name: 'Roosevelt Middle School',
            slug: 'roosevelt-middle',
            timeZone: 'America/New_York',
            affiliations: STUDENT.affiliations,
          },
          {
            id: ORG_B,
            name: 'Roosevelt High School',
            slug: 'roosevelt-high',
            timeZone: 'America/New_York',
            affiliations: STUDENT.affiliations,
          },
        ],
      },
    }),
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toBeVisible();
  await page
    .getByRole('button', { name: 'Switch school, current school Roosevelt Middle School' })
    .click();
  await expect(page.getByText('Schools', { exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Roosevelt Middle School/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Roosevelt High School/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'View all schools' })).toBeVisible();
  await expect(page.getByText('WayPass hit a problem')).toHaveCount(0);
  expectClean(captured);
});

test('account menu opens without menu context errors', async ({ page }) => {
  const captured = await openStudentShell(page);
  await page.getByRole('button', { name: 'Account, signed in as Avery Johnson' }).click();
  await expect(page.getByRole('menuitem', { name: 'View all schools' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page.getByText('WayPass hit a problem')).toHaveCount(0);
  expectClean(captured);
});

test('scheduled start renders no action before the appointment window opens', async ({ page }) => {
  const captured = captureErrors(page);
  await shell(page, STUDENT);
  const active: { current: null } = { current: null };
  const opensAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const closesAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  await studentApis(page, active, [
    {
      id: '00000000-0000-4000-8000-000000000031',
      organizationId: ORG,
      status: 'active',
      validFrom: opensAt,
      validUntil: closesAt,
      destination: { id: DESTINATION, displayName: 'Nurse', serviceType: 'nurse' },
      authorizationEtag: '"auth:test:2"',
    },
  ]);
  await page.goto(`/schools/${ORG}/pass`);
  await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start WayPass' })).toHaveCount(0);
  await expect(page.getByText('WayPass hit a problem')).toHaveCount(0);
  expectClean(captured);
});

test('unknown route renders the error page with a working return link', async ({ page }) => {
  const captured = captureErrors(page);
  await shell(page, STUDENT);
  await studentApis(page, { current: null });
  await page.goto('/definitely-not-a-route');
  await expect(page.getByText('WayPass hit a problem')).toBeVisible();
  const returnAction = page.getByRole('button', { name: 'Return to WayPass' });
  await expect(returnAction).toBeVisible();
  // The action keeps its anchor semantics (href) while Base UI presents it
  // as a button; nativeButton={false} is what silences the Base UI warning.
  await expect(returnAction).toHaveAttribute('href', '/');
  await returnAction.click();
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toBeVisible();
  await expect(page.getByText('WayPass hit a problem')).toHaveCount(0);
  expectClean(captured);
});
