import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  DESTINATION,
  mockPass,
  ORG,
  orgDestinations,
  PASS,
  PERSON,
  SECTION,
  shell,
  studentApis,
} from './fixtures';

const STUDENT = {
  affiliations: ['student'],
  capabilities: ['pass.request.self', 'pass.depart.self'],
};

function listenForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function hasVisibleShadowColor(shadow: string): boolean {
  if (shadow === '' || shadow === 'none') return false;
  const colors =
    shadow.match(
      /(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|#[\da-f]{3,8}\b|\btransparent\b/gi,
    ) ?? [];

  return colors.some((color) => {
    const normalized = color.toLowerCase();
    if (normalized === 'transparent') return false;

    const slashAlpha = /\/\s*([\d.]+%?)\s*\)$/.exec(normalized);
    const commaAlpha = /(?:rgba|hsla)\([^)]*,\s*([\d.]+%?)\s*\)$/.exec(normalized);
    const alpha = slashAlpha?.[1] ?? commaAlpha?.[1];
    if (alpha !== undefined) {
      const value = Number.parseFloat(alpha);
      return Number.isFinite(value) && value > 0;
    }

    if (/^#[\da-f]{4}$/i.test(normalized)) return !normalized.endsWith('0');
    if (/^#[\da-f]{8}$/i.test(normalized)) return !normalized.endsWith('00');
    return true;
  });
}

async function openStudentNoPass(page: Page): Promise<string[]> {
  const errors = listenForErrors(page);
  await shell(page, STUDENT);
  await studentApis(page, { current: null });
  await page.goto(`/schools/${ORG}/pass`);
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toBeVisible();
  return errors;
}

async function openTeacherRequests(page: Page): Promise<string[]> {
  const errors = listenForErrors(page);
  await shell(page, { affiliations: ['staff'], capabilities: [] });
  await page.route('**/api/v1/me/pass-approvals/pending', (route) =>
    route.fulfill({
      json: {
        approvals: [
          {
            approvalId: '00000000-0000-4000-8000-000000000020',
            organizationId: ORG,
            passEtag: '"pass:test:1"',
            student: { id: PERSON, displayName: 'Alex Rivera' },
            destination: { id: DESTINATION, displayName: 'Nurse', serviceType: 'nurse' },
            requiredSection: { id: SECTION, title: 'Science 7' },
            requestedAt: '2026-09-21T14:00:00Z',
          },
        ],
      },
    }),
  );
  await page.route('**/api/v1/me/pass-overrides/pending', (route) =>
    route.fulfill({ json: { overrides: [] } }),
  );
  await page.goto(`/schools/${ORG}/requests`);
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();
  return errors;
}

test('teacher requests render coherently at a Chromebook-sized viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const errors = await openTeacherRequests(page);
  await expect(page.getByText('Alex Rivera')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('teacher can approve from the keyboard with a visible focus indicator', async ({ page }) => {
  const errors = await openTeacherRequests(page);
  // Registered after the helper so it wins on refetch: resolving the
  // approval clears the row instead of re-rendering the seeded feed.
  let approvals: unknown[] = [
    {
      approvalId: '00000000-0000-4000-8000-000000000020',
      organizationId: ORG,
      passEtag: '"pass:test:1"',
      student: { id: PERSON, displayName: 'Alex Rivera' },
      destination: { id: DESTINATION, displayName: 'Nurse', serviceType: 'nurse' },
      requiredSection: { id: SECTION, title: 'Science 7' },
      requestedAt: '2026-09-21T14:00:00Z',
    },
  ];
  await page.route('**/api/v1/me/pass-approvals/pending', (route) =>
    route.fulfill({ json: { approvals } }),
  );
  let approved = false;
  await page.route('**/api/v1/pass-approvals/*/approve', async (route) => {
    approved = true;
    approvals = [];
    await route.fulfill({ json: { pass: mockPass('ready') } });
  });
  const approve = page.getByRole('button', { name: 'Approve' });
  await approve.focus();
  await expect(approve).toBeFocused();
  const focus = await approve.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      style: style.outlineStyle,
      width: style.outlineWidth,
      color: style.outlineColor,
      shadow: style.boxShadow,
    };
  });
  const hasOutlineRing =
    (focus.style !== 'none' &&
      Number.parseFloat(focus.width) > 0 &&
      focus.color !== 'rgba(0, 0, 0, 0)') ||
    hasVisibleShadowColor(focus.shadow);
  expect(hasOutlineRing).toBe(true);
  const box = await approve.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: window.innerHeight };
  });
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(box.height);
  await page.keyboard.press('Enter');
  expect(approved).toBe(true);
  await expect(page.getByText('Alex Rivera')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('student no-pass view stays usable at 200 percent text size', async ({ page }) => {
  const errors = await openStudentNoPass(page);
  await page.locator('html').evaluate((element) => {
    element.style.fontSize = '200%';
  });
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Switch school, current school Roosevelt Middle School' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Account, signed in as Avery Johnson' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Nurse/ })).toBeVisible();
  const clipped = await page
    .locator('main')
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(clipped).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('product honors reduced motion on the live-connection banner', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors = listenForErrors(page);
  await shell(page, {
    affiliations: ['staff'],
    capabilities: [],
    staffedDestinations: [
      {
        id: DESTINATION,
        displayName: 'Nurse',
        serviceType: 'nurse',
        capabilities: ['destination.station.manage'],
      },
    ],
  });
  await page.route(`**/api/v1/organizations/${ORG}/events`, (route) => route.abort());
  await page.route(`**/api/v1/destinations/${DESTINATION}/station`, (route) =>
    route.fulfill({
      json: {
        destination: {
          id: DESTINATION,
          displayName: 'Nurse',
          serviceType: 'nurse',
          checkInMode: 'required',
          capacity: 3,
        },
        occupancy: { consumingReservations: 0, availableCapacity: 3 },
        queueCount: 0,
        outbound: [],
        atDestination: [],
        ready: [],
        queued: [],
      },
    }),
  );
  await page.goto(`/schools/${ORG}/stations/${DESTINATION}`);
  await expect(page.getByRole('heading', { name: 'Nurse' })).toBeVisible();
  await expect(page.getByRole('status').getByText(/reconnecting/i)).toBeVisible();
  await expect(page.locator('.wf-connection-status__pulse')).toHaveCSS('animation-name', 'none');
  expect(
    await page
      .locator('html')
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue('--wf-motion-standard').trim(),
      ),
  ).toBe('1ms');
  expect(errors).toEqual([]);
});

test('station actions stay available in forced colors', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  const errors = listenForErrors(page);
  await shell(page, {
    affiliations: ['staff'],
    capabilities: [],
    staffedDestinations: [
      {
        id: DESTINATION,
        displayName: 'Nurse',
        serviceType: 'nurse',
        capabilities: ['destination.station.manage'],
      },
    ],
  });
  await page.route(`**/api/v1/destinations/${DESTINATION}/station`, (route) =>
    route.fulfill({
      json: {
        destination: {
          id: DESTINATION,
          displayName: 'Nurse',
          serviceType: 'nurse',
          checkInMode: 'required',
          capacity: 3,
        },
        occupancy: { consumingReservations: 1, availableCapacity: 2 },
        queueCount: 0,
        outbound: [
          {
            passId: PASS,
            passRevision: '4',
            passEtag: '"pass:test:4"',
            student: { id: PERSON, displayName: 'Alex Rivera' },
            departedAt: '2026-09-21T14:00:00Z',
            expectedReturnAt: '2026-09-21T14:20:00Z',
          },
        ],
        atDestination: [],
        ready: [],
        queued: [],
      },
    }),
  );
  await page.goto(`/schools/${ORG}/stations/${DESTINATION}`);
  await expect(page.getByRole('heading', { name: 'Nurse' })).toBeVisible();
  await expect(page.getByText('Alex Rivera')).toBeVisible();
  const checkIn = page.getByRole('button', { name: 'Check in' });
  await expect(checkIn).toBeVisible();
  await expect(checkIn).toBeEnabled();
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    ),
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test('admin schedules have no page-level horizontal overflow at 320px', async ({ page }) => {
  const errors = listenForErrors(page);
  await page.setViewportSize({ width: 320, height: 900 });
  await shell(page, { affiliations: ['staff'], capabilities: ['schedule.manage'] });
  await page.route(`**/api/v1/organizations/${ORG}/schedule/blocks`, (route) =>
    route.fulfill({
      json: {
        blocks: [
          {
            id: 'block-1',
            code: 'HR',
            displayName: 'Homeroom',
            kind: 'instructional',
            status: 'active',
          },
        ],
      },
      headers: { ETag: '"schedule:test:1"' },
    }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/schedule/templates`, (route) =>
    route.fulfill({ json: { templates: [] } }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/schedule/calendar*`, (route) =>
    route.fulfill({ json: { days: [] } }),
  );
  await page.goto(`/schools/${ORG}/admin/schedules`);
  await expect(page.getByRole('heading', { name: 'Schedules' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});

test('staff access has no serious axe findings', async ({ page }) => {
  const errors = listenForErrors(page);
  await shell(page, { affiliations: ['staff'], capabilities: ['authorization.manage'] });
  await page.route(`**/api/v1/organizations/${ORG}/authorization-grants`, (route) =>
    route.fulfill({
      json: {
        grants: [
          {
            id: 'grant-1',
            role: 'destination_staff',
            person: { id: PERSON, displayName: 'Sam Patel' },
            destination: { id: DESTINATION, displayName: 'Nurse' },
            status: 'active',
          },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/people*`, (route) =>
    route.fulfill({
      json: { people: [{ personId: 'staff-2', displayName: 'Jordan Lee' }] },
    }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/destinations`, (route) =>
    route.fulfill({ json: orgDestinations() }),
  );
  await page.goto(`/schools/${ORG}/admin/staff-access`);
  await expect(page.getByRole('heading', { name: 'Staff access' })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    ),
  ).toEqual([]);
  expect(errors).toEqual([]);
});
