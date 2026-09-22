import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const ORG = '00000000-0000-4000-8000-000000000010';
const PERSON = '00000000-0000-4000-8000-000000000011';
const ROOM = '00000000-0000-4000-8000-000000000012';
const SECTION = '00000000-0000-4000-8000-000000000013';
const PASS = '00000000-0000-4000-8000-000000000014';
interface Context {
  affiliations: string[];
  capabilities: string[];
  teachingSections?: unknown[];
  staffedRooms?: unknown[];
}

async function shell(page: Page, context: Context): Promise<void> {
  await page.route('**/api/v1/bootstrap/status', (route) =>
    route.fulfill({ json: { initialized: true } }),
  );
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      json: { authenticated: true, csrfToken: 'csrf-test', authenticationMethod: 'oidc' },
    }),
  );
  await page.route('**/api/v1/me', (route) =>
    route.fulfill({
      json: {
        person: {
          id: PERSON,
          givenName: 'Avery',
          familyName: 'Johnson',
          displayName: 'Avery Johnson',
        },
        tenant: { id: ORG, name: 'Roosevelt Schools', slug: 'roosevelt' },
      },
    }),
  );
  await page.route('**/api/v1/me/organizations', (route) =>
    route.fulfill({
      json: {
        organizations: [
          {
            id: ORG,
            name: 'Roosevelt Middle School',
            slug: 'roosevelt-middle',
            timeZone: 'America/New_York',
            affiliations: context.affiliations,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/me/organizations/${ORG}/context`, (route) =>
    route.fulfill({
      json: {
        organization: {
          id: ORG,
          name: 'Roosevelt Middle School',
          slug: 'roosevelt-middle',
          timeZone: 'America/New_York',
        },
        affiliations: context.affiliations,
        capabilities: context.capabilities,
        expectedPlacement: { kind: 'outside_schedule' },
        teachingSections: context.teachingSections ?? [],
        staffedRooms: context.staffedRooms ?? [],
      },
    }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/events`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: resync\ndata: {}\n\n',
    }),
  );
}

function pass(state: string, mode: 'none' | 'optional' | 'required' | null = null) {
  return {
    id: PASS,
    organizationId: ORG,
    studentId: PERSON,
    policy: null,
    destination: {
      id: ROOM,
      name: 'Nurse',
      checkInMode: 'required',
      category: { id: 'cat-nurse', name: 'Nurse', iconKey: 'medical', toneKey: 'rose' },
    },
    origin: {
      placementKind: 'resolved',
      block: null,
      section: { id: SECTION, code: 'SCI-7', title: 'Science 7' },
      room: { id: '00000000-0000-4000-8000-000000000016', name: 'Room 214' },
    },
    requestSource: 'student_web',
    scheduledAuthorizationId: null,
    requestedAt: '2026-09-21T14:00:00Z',
    lifecycleState: state,
    revision: state === 'ready' ? '1' : '2',
    movement: {
      readyUntil: state === 'ready' ? '2026-09-21T14:10:00Z' : null,
      queueEnteredAt: state === 'queued' ? '2026-09-21T14:00:00Z' : null,
      queueExpiresAt: null,
      expectedReturnAt: state === 'outbound' ? '2026-09-21T14:20:00Z' : null,
      effectiveCheckInMode: mode,
      reasonCode: null,
    },
  };
}

async function studentApis(page: Page, active: { current: ReturnType<typeof pass> | null }) {
  await page.route('**/api/v1/me/passes/active', (route) =>
    route.fulfill({ json: { pass: active.current }, headers: { ETag: '"pass:test:1"' } }),
  );
  await page.route(`**/api/v1/me/organizations/${ORG}/rooms`, (route) =>
    route.fulfill({
      json: {
        rooms: [
          {
            id: ROOM,
            name: 'Nurse',
            code: null,
            floorLabel: null,
            categoryId: 'cat-nurse',
            checkInMode: 'required',
          },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/me/organizations/${ORG}/student-room-catalog`, (route) =>
    route.fulfill({
      json: {
        categories: [
          {
            id: 'cat-nurse',
            name: 'Nurse',
            iconKey: 'medical',
            toneKey: 'rose',
            pickerMode: 'list',
            sortOrder: 20,
            rooms: [
              {
                id: ROOM,
                name: 'Nurse',
                code: null,
                floorLabel: null,
                checkInMode: 'required',
                searchContext: { teacherNames: [], sectionLabels: [], roomStaffNames: [] },
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route('**/api/v1/me/scheduled-authorizations', (route) =>
    route.fulfill({ json: { authorizations: [] } }),
  );
}

test('student requests and starts one authoritative WayPass', async ({ page }) => {
  await shell(page, {
    affiliations: ['student'],
    capabilities: ['pass.request.self', 'pass.depart.self'],
  });
  const active: { current: ReturnType<typeof pass> | null } = { current: null };
  await studentApis(page, active);
  await page.route('**/api/v1/me/passes', async (route) => {
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    active.current = pass('ready');
    await route.fulfill({
      status: 201,
      json: { pass: active.current },
      headers: { ETag: '"pass:test:1"' },
    });
  });
  await page.route(`**/api/v1/me/passes/${PASS}/depart`, async (route) => {
    expect(route.request().headers()['if-match']).toBe('"pass:test:1"');
    active.current = pass('outbound', 'required');
    await route.fulfill({ json: { pass: active.current }, headers: { ETag: '"pass:test:2"' } });
  });

  await page.goto(`/schools/${ORG}/pass`);
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toBeVisible();
  await page.getByRole('button', { name: /Nurse/ }).click();
  await expect(page.getByRole('heading', { name: 'Request a WayPass' })).toBeVisible();
  await page.getByRole('button', { name: 'Request WayPass' }).click();
  await expect(page.getByRole('heading', { name: "You're ready." })).toBeVisible();
  await page.getByRole('button', { name: 'Start WayPass' }).click();
  await expect(page.getByRole('heading', { name: 'On the way to Nurse' })).toBeVisible();
  await expect(page.getByText('Station staff will record it.')).toBeVisible();
});

test('queued student sees a numeric position without an invented estimate', async ({ page }) => {
  await shell(page, {
    affiliations: ['student'],
    capabilities: ['pass.request.self', 'pass.depart.self'],
  });
  const active = { current: pass('queued') };
  await studentApis(page, active);
  await page.route(`**/api/v1/me/passes/${PASS}/queue-status`, (route) =>
    route.fulfill({ json: { position: 3, ahead: 2 } }),
  );
  await page.goto(`/schools/${ORG}/pass`);
  await expect(page.getByRole('heading', { name: "You're in line." })).toBeVisible();
  await expect(page.getByText('2', { exact: true })).toBeVisible();
  await expect(page.getByText(/estimated/i)).toHaveCount(0);
});

test('teacher can approve the oldest request and open a roster', async ({ page }) => {
  await shell(page, {
    affiliations: ['staff'],
    capabilities: [],
    teachingSections: [
      { id: SECTION, code: 'SCI-7', title: 'Science 7', capabilities: ['pass.view.section_live'] },
    ],
  });
  await page.route('**/api/v1/me/pass-approvals/pending', (route) =>
    route.fulfill({
      json: {
        approvals: [
          {
            approvalId: '00000000-0000-4000-8000-000000000020',
            organizationId: ORG,
            passEtag: '"pass:test:1"',
            student: { id: PERSON, displayName: 'Alex Rivera' },
            destination: { id: ROOM, name: 'Nurse' },
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
  let approved = false;
  await page.route('**/api/v1/pass-approvals/*/approve', async (route) => {
    approved = true;
    await route.fulfill({ json: { pass: pass('ready') } });
  });
  await page.goto(`/schools/${ORG}/requests`);
  await expect(page.getByText('Alex Rivera')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  expect(approved).toBe(true);
});

test('room station uses minimized rows and exact row ETags', async ({ page }) => {
  await shell(page, {
    affiliations: ['staff'],
    capabilities: [],
    staffedRooms: [
      {
        id: ROOM,
        name: 'Nurse',
        capabilities: ['room.station.manage'],
      },
    ],
  });
  await page.route(`**/api/v1/rooms/${ROOM}/station`, (route) =>
    route.fulfill({
      json: {
        room: {
          id: ROOM,
          name: 'Nurse',
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
  let ifMatch = '';
  await page.route(`**/api/v1/rooms/${ROOM}/passes/${PASS}/check-in`, async (route) => {
    ifMatch = route.request().headers()['if-match'] ?? '';
    await route.fulfill({ json: { pass: pass('at_destination', 'required') } });
  });
  await page.goto(`/schools/${ORG}/stations/${ROOM}`);
  await expect(page.getByRole('heading', { name: 'Nurse' })).toBeVisible();
  await expect(page.getByText('Alex Rivera')).toBeVisible();
  await page.getByRole('button', { name: 'Check in' }).click();
  expect(ifMatch).toBe('"pass:test:4"');
  await expect(page.getByText(/grade|policy|email/i)).toHaveCount(0);
});

test('admin rooms deep link and product shell reflow accessibly', async ({ page }) => {
  await shell(page, {
    affiliations: ['staff'],
    capabilities: ['room.manage', 'pass.view.school_live'],
  });
  await page.route(`**/api/v1/organizations/${ORG}/rooms`, (route) =>
    route.fulfill({
      json: {
        rooms: [
          {
            id: ROOM,
            organizationId: ORG,
            categoryId: 'cat-nurse',
            name: 'Health Office',
            code: null,
            floorLabel: '1',
            studentSelfRequestable: true,
            originSelectable: true,
            capacity: 3,
            queueEnabled: true,
            checkInMode: 'required',
            defaultDurationSeconds: 600,
            maxDurationSeconds: 1200,
            readyClaimTimeoutSeconds: 120,
            queueTimeoutSeconds: 1800,
            status: 'open',
            revision: '2',
            createdAt: '2026-09-21T14:00:00Z',
            updatedAt: '2026-09-21T14:00:00Z',
          },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/room-categories`, (route) =>
    route.fulfill({
      json: {
        categories: [
          {
            id: 'cat-nurse',
            organizationId: ORG,
            name: 'Nurse',
            iconKey: 'medical',
            toneKey: 'rose',
            studentSurface: 'primary',
            pickerMode: 'list',
            sortOrder: 20,
            status: 'active',
            revision: '1',
            updatedAt: '2026-09-21T14:00:00Z',
          },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/authorization-grants`, (route) =>
    route.fulfill({ json: { grants: [] } }),
  );
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/schools/${ORG}/admin/rooms`);
  await expect(page.getByRole('heading', { name: 'Rooms' })).toBeVisible();
  await expect(page.getByText('Health Office')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    ),
  ).toEqual([]);
});

test('enrollment scrubs the fragment and sends the bearer only in Authorization', async ({
  page,
}) => {
  let authorization = '';
  await page.route('**/api/v1/auth/enrollment/start', async (route) => {
    authorization = route.request().headers().authorization ?? '';
    await route.fulfill({
      status: 502,
      contentType: 'application/problem+json',
      json: { code: 'auth_provider_unavailable', status: 502, requestId: 'request-1' },
    });
  });
  await page.goto('/enroll#secret-invitation-token');
  await expect(page).toHaveURL(/\/enroll$/);
  expect(authorization).toBe('Enrollment secret-invitation-token');
  await expect(
    page.getByRole('heading', { name: "Couldn't connect to your school sign-in" }),
  ).toBeVisible();
  await expect(page.getByText('secret-invitation-token')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});
