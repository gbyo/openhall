import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const ADMIN = {
  person: {
    id: '00000000-0000-4000-8000-000000000031',
    givenName: 'Gibson',
    familyName: 'Bell',
    displayName: 'Gibson Bell',
  },
  tenant: {
    id: '00000000-0000-4000-8000-000000000030',
    name: 'Ninety Six High School',
    slug: 'ninety-six-high-school',
  },
};

const ORG_ID = '00000000-0000-4000-8000-000000000032';

interface GuidedMocks {
  initialized: boolean;
  sessionMethod: 'setup' | 'recovery' | 'oidc' | null;
}

async function guidedShell(page: Page, state: GuidedMocks): Promise<void> {
  await page.route('**/api/v1/bootstrap/status', (route) =>
    route.fulfill({ json: { initialized: state.initialized } }),
  );
  await page.route('**/api/v1/bootstrap/validate', (route) =>
    route.fulfill({ json: { valid: true } }),
  );
  await page.route('**/api/v1/bootstrap/initialize', (route) => {
    state.initialized = true;
    return route.fulfill({
      json: {
        authenticated: true,
        authenticationMethod: 'setup',
        absoluteExpiresAt: '2026-09-22T14:42:00.000Z',
      },
    });
  });
  await page.route('**/api/v1/auth/session', (route) => {
    if (state.sessionMethod === null) return route.fulfill({ json: { authenticated: false } });
    return route.fulfill({
      json: {
        authenticated: true,
        csrfToken: 'csrf-test',
        absoluteExpiresAt: '2026-09-22T14:42:00.000Z',
        authenticationMethod: state.sessionMethod,
      },
    });
  });
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: ADMIN }));
  await page.route('**/api/v1/auth/discovery', (route) =>
    route.fulfill({
      json: {
        tenantSelectionRequired: false,
        tenant: ADMIN.tenant,
        providers: [],
      },
    }),
  );
  await page.route('**/api/v1/me/organizations', (route) =>
    route.fulfill({
      json: {
        organizations: [
          {
            id: ORG_ID,
            name: ADMIN.tenant.name,
            slug: ADMIN.tenant.slug,
            timeZone: 'America/New_York',
            affiliations: ['staff'],
          },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/me/organizations/${ORG_ID}/context`, (route) =>
    route.fulfill({
      json: {
        organization: {
          id: ORG_ID,
          name: ADMIN.tenant.name,
          slug: ADMIN.tenant.slug,
          timeZone: 'America/New_York',
        },
        affiliations: ['staff'],
        capabilities: ['system.manage', 'schedule.manage'],
        expectedPlacement: { kind: 'outside_schedule' },
        teachingSections: [],
        staffedDestinations: [],
      },
    }),
  );
}

async function unlock(page: Page): Promise<void> {
  await page.goto('/setup');
  await page.getByLabel('Setup code').fill('test-setup-code');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Tell us about your school' })).toBeVisible();
}

async function fillSchool(page: Page): Promise<void> {
  await page.getByLabel('School name').fill('Ninety Six High School');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Who will manage WayPass?' })).toBeVisible();
}

async function fillAdministrator(page: Page): Promise<void> {
  await page.getByLabel('First name').fill('Gibson');
  await page.getByLabel('Last name').fill('Bell');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should people sign in?' })).toBeVisible();
}

test('setup code unlock advances to the school step', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: "Let's set up WayPass" })).toBeVisible();
  await unlock(page);
  await expect(page.getByText('Question 1 of 4')).toBeVisible();
});

test('invalid setup code stays on the unlock screen', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await page.route('**/api/v1/bootstrap/validate', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      json: {
        type: 'https://openhall.dev/problems/bootstrap_token_invalid',
        title: 'Invalid bootstrap token',
        status: 401,
        code: 'bootstrap_token_invalid',
        requestId: 'test',
      },
    }),
  );
  await page.goto('/setup');
  await page.getByLabel('Setup code').fill('wrong-code');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Setup could not continue')).toBeVisible();
  await expect(page.getByRole('heading', { name: "Let's set up WayPass" })).toBeVisible();
});

test('school step defaults the timezone and hides advanced settings', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await unlock(page);
  const selected = await page.getByLabel('Time zone').inputValue();
  expect(selected.length).toBeGreaterThan(0);
  await expect(page.getByLabel('Organization name')).toBeHidden();
  await fillSchool(page);
});

test('administrator step derives the display name', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await unlock(page);
  await fillSchool(page);
  await page.getByLabel('First name').fill('Gibson');
  await page.getByLabel('Last name').fill('Bell');
  await page.getByText('Customize display name').click();
  await expect(page.getByLabel('Display name')).toHaveAttribute('placeholder', /Gibson Bell/);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should people sign in?' })).toBeVisible();
});

test('google choice exposes only client ID and secret', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await unlock(page);
  await fillSchool(page);
  await fillAdministrator(page);
  await page.getByRole('radio', { name: 'Google Workspace' }).click();
  await expect(page.getByLabel('Client ID')).toBeVisible();
  await expect(page.getByLabel('Client secret')).toBeVisible();
  await expect(page.getByLabel('Provider issuer URL')).toHaveCount(0);
  await expect(page.getByLabel('Scopes')).toHaveCount(0);
});

test('generic choice reveals fields with advanced settings hidden', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await unlock(page);
  await fillSchool(page);
  await fillAdministrator(page);
  await page.getByRole('radio', { name: 'Another OpenID Connect provider' }).click();
  await expect(page.getByLabel('Provider name')).toBeVisible();
  await expect(page.getByLabel('Issuer URL')).toBeVisible();
  await expect(page.getByLabel('Provider key')).toBeHidden();
  await page.getByText('Advanced provider settings').click();
  await expect(page.getByLabel('Provider key')).toBeVisible();
});

test('set-up-later is a first-class choice with calm copy', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await unlock(page);
  await fillSchool(page);
  await fillAdministrator(page);
  await page.getByRole('radio', { name: 'Set up sign-in later' }).click();
  await expect(page.getByText(/temporary setup access expires/)).toBeVisible();
});

test('sign-in choice is keyboard operable', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await unlock(page);
  await fillSchool(page);
  await fillAdministrator(page);
  await page.getByRole('radio', { name: 'Google Workspace' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: 'Another OpenID Connect provider' })).toBeChecked();
  await expect(page.getByText('Question 3 of 4')).toBeVisible();
  await expect(page.getByLabel('Provider name')).toBeVisible();
});

test('focus follows the current questionnaire item', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await unlock(page);
  await page.getByLabel('School name').fill('Ninety Six High School');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Who will manage WayPass?' })).toBeVisible();
  const forward = await page.evaluate(() => {
    const item = document.activeElement?.closest('[data-slot="questionnaire-item"]');
    return item?.querySelector('h1')?.textContent ?? null;
  });
  expect(forward).toBe('Who will manage WayPass?');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Tell us about your school' })).toBeVisible();
  const backward = await page.evaluate(() => {
    const item = document.activeElement?.closest('[data-slot="questionnaire-item"]');
    return item?.querySelector('h1')?.textContent ?? null;
  });
  expect(backward).toBe('Tell us about your school');
});

test('setup tolerates 200 percent text scaling without horizontal scrolling', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await page.setViewportSize({ width: 640, height: 800 });
  await unlock(page);
  await fillSchool(page);
  await fillAdministrator(page);
  await page.getByRole('radio', { name: 'Set up sign-in later' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to set up WayPass' })).toBeVisible();
  await page.evaluate(() => {
    document.body.style.zoom = '200%';
  });
  await expect(page.getByRole('heading', { name: 'Ready to set up WayPass' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

test('back preserves previously entered school details', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await unlock(page);
  await page.getByLabel('School name').fill('Ninety Six High School');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Who will manage WayPass?' })).toBeVisible();
  await expect(page.getByText('Question 2 of 4')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Tell us about your school' })).toBeVisible();
  await expect(page.getByText('Question 1 of 4')).toBeVisible();
  await expect(page.getByLabel('School name')).toHaveValue('Ninety Six High School');
});

test('review summarizes without secrets and creates with setup-later', async ({ page }) => {
  const state: GuidedMocks = { initialized: false, sessionMethod: 'setup' };
  await guidedShell(page, state);
  await unlock(page);
  await fillSchool(page);
  await fillAdministrator(page);
  await page.getByRole('radio', { name: 'Set up sign-in later' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to set up WayPass' })).toBeVisible();
  await expect(page.getByText('Question 4 of 4')).toBeVisible();
  const summary = page.getByRole('list', { name: 'Setup answers' });
  await expect(summary.getByText('Ninety Six High School')).toBeVisible();
  await expect(summary.getByText('Gibson Bell')).toBeVisible();
  await expect(page.getByText('Set up later', { exact: true })).toBeVisible();
  await expect(page.getByText('test-setup-code')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create WayPass' }).click();
  await expect(page.getByText('Finish setting up school sign-in')).toBeVisible();
});

test('submit disables while creating to prevent duplicate submit', async ({ page }) => {
  const state: GuidedMocks = { initialized: false, sessionMethod: 'setup' };
  await guidedShell(page, state);
  let calls = 0;
  await page.route('**/api/v1/bootstrap/initialize', (route) => {
    calls += 1;
    state.initialized = true;
    return new Promise((resolve) => setTimeout(resolve, 800)).then(() =>
      route.fulfill({
        json: {
          authenticated: true,
          authenticationMethod: 'setup',
          absoluteExpiresAt: '2026-09-22T14:42:00.000Z',
        },
      }),
    );
  });
  await unlock(page);
  await fillSchool(page);
  await fillAdministrator(page);
  await page.getByRole('radio', { name: 'Set up sign-in later' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to set up WayPass' })).toBeVisible();
  await page.getByRole('button', { name: 'Create WayPass' }).click();
  await expect(page.getByRole('button', { name: 'Creating…', exact: true })).toBeDisabled();
  await expect(page.getByText('Finish setting up school sign-in')).toBeVisible();
  expect(calls).toBe(1);
});

test('connect sign-in sends only genuine google input', async ({ page }) => {
  const state: GuidedMocks = { initialized: true, sessionMethod: 'setup' };
  await guidedShell(page, state);
  let body: unknown = null;
  await page.route('**/api/v1/setup/identity-provider/prepare', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { authorizationUrl: 'https://provider.example/authorize' } });
  });
  await page.goto('/connect-sign-in');
  await expect(page.getByRole('heading', { name: 'Connect school sign-in' })).toBeVisible();
  await page.getByText('Google Workspace', { exact: true }).click();
  await page.getByLabel('Client ID').fill('google-id');
  await page.getByLabel('Client secret').fill('google-secret');
  const requested = page.waitForRequest('**/api/v1/setup/identity-provider/prepare');
  await page.getByRole('button', { name: 'Connect and continue' }).click();
  await requested;
  expect(body).toMatchObject({
    providerPreset: 'google',
    clientId: 'google-id',
    clientSecret: 'google-secret',
  });
  expect(body).not.toHaveProperty('issuerUrl');
  expect(body).not.toHaveProperty('providerKey');
});

test('zero-provider login names recovery instead of an empty list', async ({ page }) => {
  await guidedShell(page, { initialized: true, sessionMethod: null });
  await page.goto('/login');
  await expect(page.getByText("School sign-in hasn't been connected yet")).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue with recovery access' })).toBeVisible();
});

test('recovery access trades a code for the connect screen', async ({ page }) => {
  const state: GuidedMocks = { initialized: true, sessionMethod: null };
  await guidedShell(page, state);
  await page.route('**/api/v1/auth/recovery', (route) => {
    state.sessionMethod = 'recovery';
    return route.fulfill({
      json: { authenticated: true, authenticationMethod: 'recovery' },
    });
  });
  await page.goto('/recovery/access');
  await page.getByLabel('Recovery code').fill('test-recovery-code');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Connect school sign-in' })).toBeVisible();
});

test('setup keyboard flow completes the unlock with Enter', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await page.goto('/setup');
  await page.getByLabel('Setup code').fill('test-setup-code');
  await page.getByLabel('Setup code').press('Enter');
  await expect(page.getByRole('heading', { name: 'Tell us about your school' })).toBeVisible();
});

test('review reflows at 320px without horizontal scrolling', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await page.setViewportSize({ width: 320, height: 568 });
  await unlock(page);
  await fillSchool(page);
  await fillAdministrator(page);
  await page.getByRole('radio', { name: 'Set up sign-in later' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to set up WayPass' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

test('setup progress exposes progress under forced colors', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await page.emulateMedia({ forcedColors: 'active' });
  await unlock(page);
  const progress = page.getByRole('progressbar', { name: 'Questionnaire progress' });
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute('aria-valuenow', '1');
  await expect(progress).toHaveAttribute('aria-valuemax', '4');
  await expect(page.getByText('Question 1 of 4')).toBeVisible();
});

async function settleForAxe(page: Page): Promise<void> {
  // Park the cursor over non-hoverable page padding so axe measures
  // deterministic resting colors instead of mid-transition hover washes.
  // Hover-state token contrast is a design-system concern outside this flow.
  await page.mouse.move(2, 2);
}

test('guided setup has no serious axe findings', async ({ page }) => {
  await guidedShell(page, { initialized: false, sessionMethod: null });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/setup');
  const welcome = await new AxeBuilder({ page }).analyze();
  expect(
    welcome.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')),
  ).toEqual([]);
  await unlock(page);
  await fillSchool(page);
  await fillAdministrator(page);
  await settleForAxe(page);
  const signin = await new AxeBuilder({ page }).analyze();
  expect(signin.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual(
    [],
  );
  await page.getByRole('radio', { name: 'Google Workspace' }).click();
  await page.getByRole('radio', { name: 'Another OpenID Connect provider' }).hover();
  const signinHover = await new AxeBuilder({ page }).analyze();
  expect(
    signinHover.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')),
  ).toEqual([]);
  await page.getByRole('radio', { name: 'Google Workspace' }).click();
  await settleForAxe(page);
  const signinStates = await new AxeBuilder({ page }).analyze();
  expect(
    signinStates.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? '')),
  ).toEqual([]);
});
