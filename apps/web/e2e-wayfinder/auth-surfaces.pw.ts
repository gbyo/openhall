import { expect, test, type Page } from '@playwright/test';

async function mockBootstrap(page: Page, initialized: boolean) {
  await page.route('**/api/v1/bootstrap/status', (route) =>
    route.fulfill({ json: { initialized } }),
  );
}

test('sign-in keeps discovery and OIDC start behavior intact', async ({ page }) => {
  await mockBootstrap(page, true);
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({ json: { authenticated: false } }),
  );
  await page.route('**/api/v1/auth/discovery', (route) =>
    route.fulfill({
      json: {
        tenantSelectionRequired: false,
        tenant: { id: 'tenant-1', name: 'Roosevelt Middle School', slug: 'roosevelt' },
        providers: [{ key: 'workspace', displayName: 'Google Workspace' }],
      },
    }),
  );

  await page.goto('/');
  const provider = page.getByRole('link', { name: 'Continue with Google Workspace' });
  await expect(provider).toBeVisible();
  await expect(provider).toHaveAttribute(
    'href',
    '/api/v1/auth/oidc/roosevelt/workspace/start?return_path=%2F',
  );
});

test('bootstrap begins with the setup-code unlock established by guided setup', async ({
  page,
}) => {
  await mockBootstrap(page, false);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: "Let's set up WayPass" })).toBeVisible();
  await expect(page.getByLabel('Setup code', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Enter the one-time setup code shown by your WayPass server.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Where do I find this?' })).toBeVisible();
});

test('recovery and logout-all preserve in-memory CSRF request behavior', async ({ page }) => {
  await mockBootstrap(page, true);
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        csrfToken: 'csrf-from-session',
        authenticationMethod: 'recovery',
      },
    }),
  );
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      json: {
        person: {
          id: 'person-1',
          givenName: 'Avery',
          familyName: 'Johnson',
          displayName: 'Avery Johnson',
        },
        tenant: { id: 'tenant-1', name: 'Roosevelt Middle School', slug: 'roosevelt' },
      },
    }),
  );
  await page.route('**/api/v1/auth/logout-all', (route) => route.fulfill({ status: 500 }));

  await page.goto('/');
  await expect(page.getByRole('alert').getByText('Recovery access', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Avery Johnson' })).toBeVisible();

  const requestPromise = page.waitForRequest('**/api/v1/auth/logout-all');
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  const request = await requestPromise;
  expect(request.method()).toBe('POST');
  expect(request.headers()['x-csrf-token']).toBe('csrf-from-session');
});
