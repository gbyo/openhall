import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  APPROVAL_PENDING,
  DESTINATION,
  mockPass,
  ORG,
  ORG_B,
  orgDestinations,
  orgLocations,
  PASS,
  PERSON,
  SECTION,
  shell,
  studentApis,
  studentHomeApis,
} from './fixtures';

const STUDENT = {
  affiliations: ['student'],
  capabilities: ['pass.request.self', 'pass.depart.self'],
};

const BLAKE = '00000000-0000-4000-8000-000000000016';
const BLAKE_PASS = '00000000-0000-4000-8000-000000000017';

test('waiting student sees passive approval state without repeat actions', async ({ page }) => {
  await shell(page, STUDENT);
  await studentApis(page, { current: mockPass('requested', null, APPROVAL_PENDING) });
  await page.goto(`/schools/${ORG}/pass`);
  await expect(page.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
  await expect(page.getByText('No action needed right now.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start pass' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask for staff review' })).toHaveCount(0);
});

test('student completes a lightweight pass without fabricated arrival', async ({ page }) => {
  await shell(page, STUDENT);
  const active: { current: ReturnType<typeof mockPass> | null } = {
    current: mockPass('outbound', null),
  };
  await studentApis(page, active);
  let completed = false;
  await page.route(`**/api/v1/me/passes/${PASS}/complete`, async (route) => {
    completed = true;
    active.current = mockPass('completed', null);
    await route.fulfill({
      json: { pass: active.current },
      headers: { ETag: '"pass:test:3"' },
    });
  });
  await page.goto(`/schools/${ORG}/pass`);
  await expect(page.getByRole('heading', { name: 'Pass active' })).toBeVisible();
  await expect(page.getByRole('button', { name: "I've arrived" })).toHaveCount(0);
  await page.getByRole('button', { name: "I'm back" }).click();
  expect(completed).toBe(true);
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
});

test('student starts a scheduled appointment from Upcoming', async ({ page }) => {
  await shell(page, STUDENT);
  const active: { current: ReturnType<typeof mockPass> | null } = { current: null };
  const appointment = {
    id: '00000000-0000-4000-8000-000000000030',
    organizationId: ORG,
    status: 'active',
    validFrom: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    validUntil: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    destination: { id: DESTINATION, displayName: 'Nurse', serviceType: 'nurse' },
    authorizationEtag: '"auth:test:1"',
  };
  await studentApis(page, active, [appointment]);
  await page.route(
    `**/api/v1/me/scheduled-authorizations/${appointment.id}/start`,
    async (route) => {
      expect(route.request().headers()['if-match']).toBe('"auth:test:1"');
      active.current = mockPass('ready');
      await route.fulfill({
        json: { pass: active.current },
        headers: { ETag: '"pass:test:1"' },
      });
    },
  );
  await page.goto(`/schools/${ORG}/pass`);
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready now' })).toBeVisible();
  await expect(page.getByText(/Available until/)).toBeVisible();
  await page.getByRole('button', { name: 'Start WayPass' }).click();
  await expect(page.getByRole('heading', { name: "You're ready." })).toBeVisible();
});

test('student sees future appointments without a premature Start action', async ({ page }) => {
  await shell(page, STUDENT);
  const active: { current: ReturnType<typeof mockPass> | null } = { current: null };
  const future = {
    id: '00000000-0000-4000-8000-000000000031',
    organizationId: ORG,
    status: 'active',
    validFrom: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    validUntil: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    destination: { id: DESTINATION, displayName: 'Nurse', serviceType: 'nurse' },
    authorizationEtag: '"auth:test:2"',
  };
  await studentApis(page, active, [future]);
  await page.goto(`/schools/${ORG}/pass`);
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready now' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start WayPass' })).toHaveCount(0);
});

test('appointment presentation flips at the window boundary without reload', async ({ page }) => {
  await shell(page, STUDENT);
  const active: { current: ReturnType<typeof mockPass> | null } = { current: null };
  await studentHomeApis(page, active, {
    scheduled: [
      {
        id: '00000000-0000-4000-8000-000000000032',
        organizationId: ORG,
        status: 'active',
        validFrom: new Date(Date.now() + 4000).toISOString(),
        validUntil: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        destination: { id: DESTINATION, displayName: 'Nurse', serviceType: 'nurse' },
        authorizationEtag: '"auth:test:3"',
      },
    ],
  });
  await page.goto(`/schools/${ORG}/pass`);
  await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start WayPass' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Ready now' })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Start WayPass' })).toBeVisible();
});

test('uncertain requests keep one idempotency key across Check again', async ({ page }) => {
  await shell(page, STUDENT);
  const active: { current: ReturnType<typeof mockPass> | null } = { current: null };
  await studentHomeApis(page, active);
  const keys: (string | null)[] = [];
  let attempts = 0;
  await page.route('**/api/v1/me/passes', async (route) => {
    attempts += 1;
    keys.push(route.request().headers()['idempotency-key'] ?? null);
    if (attempts === 1) {
      await route.abort('failed');
      return;
    }
    active.current = mockPass('requested', null);
    await route.fulfill({
      status: 201,
      json: { pass: active.current },
      headers: { ETag: '"pass:test:1"' },
    });
  });
  await page.goto(`/schools/${ORG}/pass`);
  await page.getByRole('button', { name: 'Nurse' }).click();
  await page.getByRole('button', { name: 'Request WayPass' }).click();
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Request a WayPass' })).toBeVisible();
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('heading', { name: 'Request received' })).toBeVisible();
  expect(attempts).toBe(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});

test('student home groups destinations into intent tiles without admin metadata', async ({
  page,
}) => {
  await shell(page, STUDENT);
  await studentHomeApis(page, { current: null });
  await page.goto(`/schools/${ORG}/pass`);
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toBeVisible();
  for (const name of ['Restroom', 'Nurse', 'Counselor', 'Library', 'More']) {
    await expect(page.getByRole('button', { name })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Nurse' })).toHaveText('Nurse');
  await expect(page.getByText('Check-in')).toHaveCount(0);
  await expect(page.getByText('Planetarium')).toHaveCount(0);
  await page.getByRole('button', { name: 'More' }).click();
  await expect(page.getByRole('heading', { name: 'Request a WayPass' })).toBeVisible();
  await expect(page.getByText('Planetarium')).toBeVisible();
});

test('ready appointments sit above the launcher in a four-column desktop grid', async ({
  page,
}) => {
  await shell(page, STUDENT);
  const active: { current: ReturnType<typeof mockPass> | null } = { current: null };
  await studentHomeApis(page, active, {
    scheduled: [
      {
        id: '00000000-0000-4000-8000-000000000030',
        organizationId: ORG,
        status: 'active',
        validFrom: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        validUntil: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        destination: { id: DESTINATION, displayName: 'Nurse', serviceType: 'nurse' },
        authorizationEtag: '"auth:test:1"',
      },
    ],
  });
  await page.goto(`/schools/${ORG}/pass`);
  const readyBox = await page.getByRole('heading', { name: 'Ready now' }).boundingBox();
  const launcherBox = await page
    .getByRole('heading', { name: 'Where do you need to go?' })
    .boundingBox();
  expect(readyBox).not.toBeNull();
  expect(launcherBox).not.toBeNull();
  if (readyBox && launcherBox) {
    expect(readyBox.y).toBeLessThan(launcherBox.y);
  }
  const columns = await page
    .getByRole('list', { name: 'Where do you need to go?' })
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
  expect(columns).toBe(4);
});

test('clicking an intent tile never posts a pass before confirmation', async ({ page }) => {
  await shell(page, STUDENT);
  const active: { current: ReturnType<typeof mockPass> | null } = { current: null };
  await studentHomeApis(page, active);
  let posted = 0;
  await page.route('**/api/v1/me/passes', async (route) => {
    posted += 1;
    active.current = mockPass('requested', null);
    await route.fulfill({
      status: 201,
      json: { pass: active.current },
      headers: { ETag: '"pass:test:1"' },
    });
  });
  await page.goto(`/schools/${ORG}/pass`);
  // Single-destination intent skips the picker and lands on confirmation.
  await page.getByRole('button', { name: 'Nurse' }).click();
  await expect(page.getByRole('heading', { name: 'Request a WayPass' })).toBeVisible();
  expect(posted).toBe(0);
  // Multi-destination intent opens an item-based picker, still without posting.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Restroom' }).click();
  await expect(page.getByRole('button', { name: 'First floor restroom' })).toBeVisible();
  expect(posted).toBe(0);
  await page.getByRole('button', { name: 'First floor restroom' }).click();
  await page.getByRole('button', { name: 'Request WayPass' }).click();
  expect(posted).toBe(1);
});

test('desktop request flow uses a dialog and pending shows Requesting', async ({ page }) => {
  await shell(page, STUDENT);
  const active: { current: ReturnType<typeof mockPass> | null } = { current: null };
  await studentHomeApis(page, active);
  let release!: (value: unknown) => void;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/me/passes', async (route) => {
    active.current = mockPass('requested', null);
    await gate;
    await route.fulfill({
      status: 201,
      json: { pass: active.current },
      headers: { ETag: '"pass:test:1"' },
    });
  });
  await page.goto(`/schools/${ORG}/pass`);
  await page.getByRole('button', { name: 'Nurse' }).click();
  await expect(page.locator('[data-slot="dialog-content"]')).toBeVisible();
  await page.getByRole('button', { name: 'Request WayPass' }).click();
  await expect(page.getByRole('button', { name: /Requesting/ })).toBeVisible();
  release(null);
  await expect(page.getByRole('heading', { name: 'Request received' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toHaveCount(0);
});

test('active traveling pass shows a live timer without mutating the pass', async ({ page }) => {
  await shell(page, STUDENT);
  const active: { current: ReturnType<typeof mockPass> | null } = {
    current: {
      ...mockPass('outbound', 'none'),
      movement: {
        readyUntil: null,
        queueEnteredAt: null,
        queueExpiresAt: null,
        expectedReturnAt: new Date(Date.now() + 8 * 60 * 1000 + 42 * 1000).toISOString(),
        effectiveCheckInMode: 'none',
        reasonCode: null,
      },
    },
  };
  await studentHomeApis(page, active);
  let completed = false;
  await page.route(`**/api/v1/me/passes/${PASS}/complete`, async (route) => {
    completed = true;
    await route.fulfill({ json: { pass: active.current } });
  });
  await page.goto(`/schools/${ORG}/pass`);
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toHaveCount(0);
  await expect(page.getByText('remaining')).toBeVisible();
  await expect(page.getByText('08:4')).toBeVisible();
  expect(completed).toBe(false);
});

test('teacher can deny a request and the row resolves', async ({ page }) => {
  await shell(page, { affiliations: ['staff'], capabilities: [] });
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
  await page.route('**/api/v1/me/pass-overrides/pending', (route) =>
    route.fulfill({ json: { overrides: [] } }),
  );
  let denied = false;
  await page.route('**/api/v1/pass-approvals/*/deny', async (route) => {
    denied = true;
    approvals = [];
    await route.fulfill({ json: { pass: mockPass('denied', null) } });
  });
  await page.goto(`/schools/${ORG}/requests`);
  await expect(page.getByText('Alex Rivera')).toBeVisible();
  await page.getByRole('button', { name: 'Deny' }).click();
  expect(denied).toBe(true);
  await expect(page.getByText('Request denied.')).toBeAttached();
  await expect(page.getByText('Alex Rivera')).toHaveCount(0);
  await expect(page.getByText('No requests need attention.')).toBeVisible();
});

test('teacher creates a pass for a student from the class roster', async ({ page }) => {
  await shell(page, {
    affiliations: ['staff'],
    capabilities: [],
    teachingSections: [
      { id: SECTION, code: 'SCI-7', title: 'Science 7', capabilities: ['pass.view.section_live'] },
    ],
  });
  await page.route(`**/api/v1/sections/${SECTION}/students`, (route) =>
    route.fulfill({
      json: {
        students: [
          { id: PERSON, displayName: 'Alex Rivera' },
          { id: BLAKE, displayName: 'Blake Chen' },
        ],
      },
    }),
  );
  const live: { passes: unknown[] } = { passes: [] };
  await page.route(`**/api/v1/sections/${SECTION}/passes/live`, (route) =>
    route.fulfill({ json: { passes: live.passes } }),
  );
  await studentApis(page, { current: null });
  let created = false;
  await page.route(`**/api/v1/students/${PERSON}/passes`, async (route) => {
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    created = true;
    live.passes = [
      {
        passId: PASS,
        passEtag: '"pass:test:9"',
        student: { id: PERSON, displayName: 'Alex Rivera' },
        destination: { id: DESTINATION, displayName: 'Nurse' },
        lifecycleState: 'outbound',
      },
    ];
    await route.fulfill({ json: { pass: mockPass('outbound', 'required') } });
  });
  await page.goto(`/schools/${ORG}/classes/${SECTION}`);
  await expect(page.getByRole('heading', { name: 'Science 7' })).toBeVisible();
  await expect(page.getByText('Blake Chen')).toBeVisible();
  await page.getByRole('tab', { name: /Out now/ }).click();
  await expect(page.getByText('No one is out right now.')).toBeVisible();
  await page.getByRole('tab', { name: 'Roster' }).click();
  const row = page.locator('[data-slot="item"]', { hasText: 'Alex Rivera' });
  await row.getByRole('button', { name: 'Create pass' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('Search destinations').fill('Nurse');
  await page.getByRole('option', { name: 'Nurse' }).click();
  await dialog.getByRole('button', { name: 'Create pass' }).click();
  expect(created).toBe(true);
  await expect(page.getByText('Out · Nurse')).toBeVisible();
  await page.getByRole('tab', { name: /Out now/ }).click();
  await expect(
    page.getByRole('list', { name: 'Students out' }).getByText('Alex Rivera'),
  ).toBeVisible();
});

test('teacher starts a ready pass from the roster', async ({ page }) => {
  await shell(page, {
    affiliations: ['staff'],
    capabilities: [],
    teachingSections: [
      { id: SECTION, code: 'SCI-7', title: 'Science 7', capabilities: ['pass.view.section_live'] },
    ],
  });
  await page.route(`**/api/v1/sections/${SECTION}/students`, (route) =>
    route.fulfill({ json: { students: [{ id: PERSON, displayName: 'Alex Rivera' }] } }),
  );
  await page.route(`**/api/v1/sections/${SECTION}/passes/live`, (route) =>
    route.fulfill({
      json: {
        passes: [
          {
            passId: PASS,
            passEtag: '"pass:test:4"',
            student: { id: PERSON, displayName: 'Alex Rivera' },
            destination: { id: DESTINATION, displayName: 'Nurse' },
            lifecycleState: 'ready',
          },
        ],
      },
    }),
  );
  await studentApis(page, { current: null });
  let ifMatch = '';
  await page.route(`**/api/v1/passes/${PASS}/depart`, async (route) => {
    ifMatch = route.request().headers()['if-match'] ?? '';
    await route.fulfill({ json: { pass: mockPass('outbound', 'required') } });
  });
  await page.goto(`/schools/${ORG}/classes/${SECTION}`);
  await expect(page.getByText('Ready · Nurse')).toBeVisible();
  await page.getByRole('button', { name: 'Start pass' }).click();
  expect(ifMatch).toBe('"pass:test:4"');
});

const STATION_CONTEXT = {
  affiliations: ['staff'],
  capabilities: [] as string[],
  staffedDestinations: [
    {
      id: DESTINATION,
      displayName: 'Nurse',
      serviceType: 'nurse',
      capabilities: ['destination.station.manage'],
    },
  ],
};

interface StationEntry {
  passId: string;
  passEtag: string;
  student: { id: string; displayName: string };
  departedAt?: string;
  expectedReturnAt?: string | null;
}

test('station moves students from on-the-way through Here with row ETags', async ({ page }) => {
  await shell(page, STATION_CONTEXT);
  const state: {
    outbound: StationEntry[];
    atDestination: StationEntry[];
    ready: unknown[];
    queued: unknown[];
  } = {
    outbound: [
      {
        passId: PASS,
        passEtag: '"pass:test:4"',
        student: { id: PERSON, displayName: 'Alex Rivera' },
        departedAt: '2026-09-21T14:00:00Z',
        expectedReturnAt: '2026-09-21T14:20:00Z',
      },
    ],
    atDestination: [
      {
        passId: BLAKE_PASS,
        passEtag: '"pass:test:6"',
        student: { id: BLAKE, displayName: 'Blake Chen' },
        expectedReturnAt: '2026-09-21T14:25:00Z',
      },
    ],
    ready: [],
    queued: [],
  };
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
        outbound: state.outbound,
        atDestination: state.atDestination,
        ready: state.ready,
        queued: state.queued,
      },
    }),
  );
  const etags: Record<string, string> = {};
  await page.route(
    `**/api/v1/destinations/${DESTINATION}/passes/${PASS}/check-in`,
    async (route) => {
      etags.checkIn = route.request().headers()['if-match'] ?? '';
      const [entry] = state.outbound.splice(0, 1);
      if (entry) state.atDestination.push({ ...entry, passEtag: '"pass:test:5"' });
      await route.fulfill({ json: { pass: mockPass('at_destination', 'required') } });
    },
  );
  await page.route(
    `**/api/v1/destinations/${DESTINATION}/passes/${PASS}/begin-return`,
    async (route) => {
      etags.beginReturn = route.request().headers()['if-match'] ?? '';
      state.atDestination = state.atDestination.filter((entry) => entry.passId !== PASS);
      await route.fulfill({ json: { pass: mockPass('returning', 'required') } });
    },
  );
  await page.route(
    `**/api/v1/destinations/${DESTINATION}/passes/${BLAKE_PASS}/complete`,
    async (route) => {
      etags.complete = route.request().headers()['if-match'] ?? '';
      state.atDestination = state.atDestination.filter((entry) => entry.passId !== BLAKE_PASS);
      await route.fulfill({ json: { pass: mockPass('completed', 'required') } });
    },
  );
  await page.goto(`/schools/${ORG}/stations/${DESTINATION}`);
  await expect(page.getByRole('heading', { name: 'Nurse' })).toBeVisible();
  await expect(page.getByText('Blake Chen')).toBeVisible();
  await page.getByRole('button', { name: 'Check in' }).click();
  expect(etags.checkIn).toBe('"pass:test:4"');
  await expect(page.getByText('2 here')).toBeVisible();
  await page
    .locator('[data-slot="item"]', { hasText: 'Alex Rivera' })
    .getByRole('button', {
      name: 'Begin return',
    })
    .click();
  expect(etags.beginReturn).toBe('"pass:test:5"');
  await expect(page.locator('[data-slot="item"]', { hasText: 'Alex Rivera' })).toHaveCount(0);
  await page
    .locator('[data-slot="item"]', { hasText: 'Blake Chen' })
    .getByRole('button', {
      name: 'Complete here',
    })
    .click();
  expect(etags.complete).toBe('"pass:test:6"');
  await expect(page.getByText('No students are checked in.')).toBeVisible();
});

test('station path surfaces a lost live connection', async ({ page }) => {
  await shell(page, STATION_CONTEXT);
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
  // Role-scoped text: the live-region element exposes its announcement as
  // content rather than a computed accessible name in this engine.
  await expect(page.getByRole('status').getByText(/reconnecting/i)).toBeVisible();
});

const OFFICE = {
  affiliations: ['staff'],
  capabilities: ['pass.view.school_live', 'pass.create.student', 'scheduled_authorization.manage'],
};

test('office searches live movement and creates a pass', async ({ page }) => {
  await shell(page, OFFICE);
  await page.route(`**/api/v1/organizations/${ORG}/passes/live`, (route) =>
    route.fulfill({
      json: {
        passes: [
          {
            passId: PASS,
            student: { id: PERSON, displayName: 'Alex Rivera' },
            destination: { id: DESTINATION, displayName: 'Nurse' },
            lifecycleState: 'outbound',
            movement: { expectedReturnAt: '2026-09-21T14:20:00Z' },
          },
          {
            passId: BLAKE_PASS,
            student: { id: BLAKE, displayName: 'Blake Chen' },
            destination: { id: DESTINATION, displayName: 'Library' },
            lifecycleState: 'at_destination',
            movement: { expectedReturnAt: null },
          },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/students*`, (route) =>
    route.fulfill({
      json: { students: [{ id: PERSON, displayName: 'Alex Rivera' }] },
    }),
  );
  await studentApis(page, { current: null });
  let created: Record<string, unknown> | null = null;
  await page.route(`**/api/v1/students/${PERSON}/passes`, async (route) => {
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    created = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { pass: mockPass('outbound', 'required') } });
  });
  await page.goto(`/schools/${ORG}/movement`);
  await expect(page.getByRole('heading', { name: 'Live movement' })).toBeVisible();
  await expect(page.getByText('Only server-confirmed movement appears here.')).toBeVisible();
  await page.getByLabel('Search live movement').fill('alex');
  await expect(page.getByText('Blake Chen')).toHaveCount(0);
  await expect(page.getByText('Alex Rivera')).toBeVisible();
  await page.getByLabel('Search live movement').fill('');
  await page.getByRole('button', { name: 'Create pass' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('Search students').fill('Alex Rivera');
  await page.getByRole('option', { name: 'Alex Rivera' }).click();
  await dialog.getByPlaceholder('Search destinations').fill('Nurse');
  await page.getByRole('option', { name: 'Nurse' }).click();
  await dialog.getByRole('button', { name: 'Create pass' }).click();
  expect(created).toMatchObject({ destinationId: DESTINATION });
});

const ADMIN = {
  affiliations: ['staff'],
  capabilities: [
    'destination.manage',
    'schedule.manage',
    'policy.manage',
    'authorization.manage',
    'people.view',
    'audit.view',
  ],
};

test('admin schedules show human blocks and templates', async ({ page }) => {
  await shell(page, ADMIN);
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
    route.fulfill({
      json: {
        templates: [
          {
            id: 'template-1',
            name: 'Regular day',
            slots: [{ blockId: 'block-1', startsAt: '08:00', endsAt: '08:45' }],
            status: 'active',
          },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/schedule/calendar*`, (route) =>
    route.fulfill({ json: { days: [] } }),
  );
  await page.goto(`/schools/${ORG}/admin/schedules`);
  await expect(page.getByRole('heading', { name: 'Schedules' })).toBeVisible();
  await expect(page.getByText('Homeroom')).toBeVisible();
  await expect(page.getByText('HR · Class')).toBeVisible();
  await page.getByRole('tab', { name: 'Templates' }).click();
  await expect(page.getByText('Regular day')).toBeVisible();
  await expect(page.getByLabel('Block')).toBeVisible();
  await expect(page.getByLabel('Start')).toBeVisible();
  await expect(page.getByLabel('End')).toBeVisible();
});

test('admin policies list human rule types and creation uses school language', async ({ page }) => {
  await shell(page, ADMIN);
  await page.route(`**/api/v1/organizations/${ORG}/policy-rules`, (route) =>
    route.fulfill({
      json: {
        rules: [
          {
            id: 'rule-1',
            name: 'Protect first period',
            ruleType: 'schedule_boundary',
            archivedAt: null,
            enabled: false,
            scope: { kind: 'organization' },
          },
        ],
      },
    }),
  );
  await page.goto(`/schools/${ORG}/admin/policies`);
  await expect(page.getByRole('heading', { name: 'Policies' })).toBeVisible();
  await expect(page.getByText('Protect first period')).toBeVisible();
  await expect(page.getByText('Schedule boundary')).toBeVisible();
  await expect(page.getByText('Whole school')).toBeVisible();
  await page.getByRole('button', { name: 'New policy' }).click();
  await expect(page.getByLabel('Rule type').locator('option')).toContainText([
    'Protect the beginning and end of class',
    'Require classroom teacher approval',
  ]);
  await expect(page.getByLabel('First minutes')).toBeVisible();
  await expect(page.getByText('Student requests')).toBeVisible();
});

test('admin staff access shows duties in school language', async ({ page }) => {
  await shell(page, ADMIN);
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
  const grantRow = page
    .getByRole('table', { name: 'Staff access grants' })
    .getByRole('row', { name: /Sam Patel/ });
  await expect(grantRow.getByText('Destination staff')).toBeVisible();
  await page.getByRole('button', { name: 'Grant access' }).click();
  const dialog = page.getByRole('dialog', { name: 'Grant access' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Duty')).toBeVisible();
  await expect(dialog.getByLabel('Staff member')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('admin destinations create in a dialog over the list', async ({ page }) => {
  await shell(page, ADMIN);
  await page.route(`**/api/v1/organizations/${ORG}/destinations`, (route) =>
    route.fulfill({ json: orgDestinations() }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/locations`, (route) =>
    route.fulfill({ json: orgLocations() }),
  );
  await page.goto(`/schools/${ORG}/admin/destinations`);
  await expect(page.getByRole('heading', { name: 'Destinations' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Destinations' }).getByText('Nurse')).toBeVisible();
  await page.getByRole('button', { name: 'New destination' }).click();
  const dialog = page.getByRole('dialog', { name: 'New destination' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Display name')).toBeVisible();
  await expect(dialog.getByLabel('Type')).toBeVisible();
  await expect(dialog.getByLabel('Location')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('admin schedules add blocks in a dialog over the list', async ({ page }) => {
  await shell(page, ADMIN);
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
  await page.getByRole('button', { name: 'New block' }).click();
  const dialog = page.getByRole('dialog', { name: 'New block' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Code')).toBeVisible();
  await expect(dialog.getByLabel('Name')).toBeVisible();
  await expect(dialog.getByLabel('Type')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('admin scheduled passes read like appointments', async ({ page }) => {
  await shell(page, ADMIN);
  const authorizations: unknown[] = [
    {
      id: 'auth-1',
      student: { id: PERSON, displayName: 'Alex Rivera' },
      destination: { id: DESTINATION, displayName: 'Nurse' },
      validFrom: '2027-01-05T15:00:00Z',
      validUntil: '2027-01-05T16:00:00Z',
      status: 'active',
    },
  ];
  await page.route(`**/api/v1/organizations/${ORG}/scheduled-authorizations`, (route) =>
    route.fulfill({ json: { authorizations } }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/students*`, (route) =>
    route.fulfill({ json: { students: [{ id: PERSON, displayName: 'Alex Rivera' }] } }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/destinations`, (route) =>
    route.fulfill({ json: orgDestinations() }),
  );
  await page.route(`**/api/v1/me/organizations/${ORG}/destinations`, (route) =>
    route.fulfill({ json: { destinations: orgDestinations().destinations } }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/locations`, (route) =>
    route.fulfill({ json: orgLocations() }),
  );
  let created = false;
  await page.unroute(`**/api/v1/organizations/${ORG}/scheduled-authorizations`);
  await page.route(`**/api/v1/organizations/${ORG}/scheduled-authorizations`, async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      created = true;
      authorizations.push({
        id: 'auth-2',
        student: { id: PERSON, displayName: 'Alex Rivera' },
        destination: { id: DESTINATION, displayName: 'Nurse' },
        validFrom: '2027-01-06T15:00:00Z',
        validUntil: '2027-01-06T16:00:00Z',
        status: 'active',
      });
      await route.fulfill({ json: { id: 'auth-2' } });
      return;
    }
    await route.fulfill({ json: { authorizations } });
  });
  await page.goto(`/schools/${ORG}/admin/scheduled-passes`);
  await expect(page).toHaveURL(new RegExp(`/schools/${ORG}/scheduled-passes`));
  await expect(page.getByRole('heading', { name: 'Scheduled passes' })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Scheduled passes' }).getByText('Alex Rivera'),
  ).toBeVisible();
  await expect(page.getByText('Upcoming', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'New scheduled pass' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('Search students').fill('Alex Rivera');
  await page.getByRole('option', { name: 'Alex Rivera' }).click();
  await dialog.getByPlaceholder('Search destinations').fill('Nurse');
  await page.getByRole('option', { name: 'Nurse' }).click();
  await dialog.getByLabel('From').fill('2027-01-06T15:00');
  await dialog.getByLabel('Until').fill('2027-01-06T16:00');
  await dialog.getByRole('radio', { name: 'Teacher approval still required' }).check();
  await expect(dialog.getByText('skips only ordinary classroom approval')).toBeVisible();
  await dialog.getByRole('button', { name: 'Schedule pass' }).click();
  expect(created).toBe(true);
  await expect(dialog).toBeHidden();
});

test('admin cancels a scheduled pass only after confirmation', async ({ page }) => {
  await shell(page, ADMIN);
  const authorizations: unknown[] = [
    {
      id: 'auth-1',
      student: { id: PERSON, displayName: 'Alex Rivera' },
      destination: { id: DESTINATION, displayName: 'Nurse' },
      validFrom: '2027-01-05T15:00:00Z',
      validUntil: '2027-01-05T16:00:00Z',
      status: 'active',
    },
  ];
  await page.route(`**/api/v1/organizations/${ORG}/scheduled-authorizations`, (route) =>
    route.fulfill({ json: { authorizations } }),
  );
  await page.route(`**/api/v1/scheduled-authorizations/auth-1`, (route) =>
    route.fulfill({ json: { id: 'auth-1' }, headers: { ETag: '"auth:test:1"' } }),
  );
  let cancelled = false;
  await page.route(`**/api/v1/scheduled-authorizations/auth-1/cancel`, async (route) => {
    expect(route.request().headers()['if-match']).toBe('"auth:test:1"');
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    cancelled = true;
    authorizations.pop();
    await route.fulfill({ json: { id: 'auth-1', status: 'cancelled' } });
  });
  await page.goto(`/schools/${ORG}/scheduled-passes`);
  await expect(page.getByRole('heading', { name: 'Scheduled passes' })).toBeVisible();
  await page.getByRole('button', { name: "Actions for Alex Rivera's scheduled pass" }).click();
  await page.getByRole('menuitem', { name: 'Cancel scheduled pass' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(
    confirm.getByRole('heading', { name: "Cancel Alex Rivera's scheduled pass?" }),
  ).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel scheduled pass' }).click();
  await expect.poll(() => cancelled).toBe(true);
  await expect(page.getByText('Alex Rivera')).toHaveCount(0);
});

test('admin manages locations through dialog and sheet, not inline forms', async ({ page }) => {
  await shell(page, ADMIN);
  let locs: Record<string, unknown>[] = [
    {
      id: '00000000-0000-4000-8000-000000000015',
      organizationId: ORG,
      parentLocationId: null,
      kind: 'room',
      name: 'Health Office',
      code: null,
      floorLabel: '1',
      status: 'active',
      revision: '1',
      createdAt: '2026-09-21T14:00:00Z',
      updatedAt: '2026-09-21T14:00:00Z',
    },
  ];
  await page.route(`**/api/v1/organizations/${ORG}/locations`, (route) =>
    route.fulfill({ json: { locations: locs } }),
  );
  let created = false;
  await page.unroute(`**/api/v1/organizations/${ORG}/locations`);
  await page.route(`**/api/v1/organizations/${ORG}/locations`, async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      created = true;
      locs = [
        ...locs,
        {
          id: '00000000-0000-4000-8000-000000000021',
          organizationId: ORG,
          parentLocationId: null,
          kind: 'room',
          name: 'Gym',
          code: null,
          floorLabel: null,
          status: 'active',
          revision: '1',
          createdAt: '2026-09-21T14:00:00Z',
          updatedAt: '2026-09-21T14:00:00Z',
        },
      ];
      await route.fulfill({ json: { id: '00000000-0000-4000-8000-000000000021' } });
      return;
    }
    await route.fulfill({ json: { locations: locs } });
  });
  await page.route(`**/api/v1/locations/00000000-0000-4000-8000-000000000015`, async (route) => {
    if (route.request().method() === 'PUT') {
      expect(route.request().headers()['if-match']).toBe('"loc:test:1"');
      locs = [{ ...locs[0], name: 'Health Office Updated' }];
      await route.fulfill({ json: { location: locs[0] } });
      return;
    }
    await route.fulfill({ json: { location: locs[0] }, headers: { ETag: '"loc:test:1"' } });
  });
  await page.route(
    `**/api/v1/locations/00000000-0000-4000-8000-000000000015/archive`,
    async (route) => {
      locs = [{ ...locs[0], status: 'archived' }];
      await route.fulfill({ json: { location: locs[0] } });
    },
  );
  await page.goto(`/schools/${ORG}/admin/locations`);
  await expect(page.getByRole('heading', { name: 'Locations' })).toBeVisible();
  await expect(page.getByText('Health Office')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add location' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New location' }).click();
  const dialog = page.getByRole('dialog', { name: 'New location' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').fill('Gym');
  await dialog.getByRole('button', { name: 'Create location' }).click();
  expect(created).toBe(true);
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Gym')).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Health Office' }).click();
  await page.getByRole('menuitem', { name: 'Edit location' }).click();
  const sheet = page.getByRole('dialog', { name: 'Edit Health Office' });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('Name').fill('Health Office Updated');
  await sheet.getByRole('button', { name: 'Save changes' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText('Health Office Updated')).toBeVisible();
  await page.getByRole('button', { name: 'Actions for Health Office Updated' }).click();
  await page.getByRole('menuitem', { name: 'Archive location' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Archive location' }).click();
  await expect.poll(() => locs[0]?.status).toBe('archived');
  await expect(page.getByText('Archived')).toBeVisible();
});

test('admin people page is a directory with sign-in management, not roster editing', async ({
  page,
}) => {
  await shell(page, ADMIN);
  await page.route(`**/api/v1/organizations/${ORG}/people*`, (route) =>
    route.fulfill({
      json: {
        people: [
          {
            personId: PERSON,
            displayName: 'Alex Rivera',
            affiliation: 'student',
            gradeLevel: 7,
            personStatus: 'active',
            account: { identityLinked: false },
          },
        ],
      },
    }),
  );
  await page.route('**/api/v1/auth/discovery*', (route) =>
    route.fulfill({
      json: {
        tenantSelectionRequired: false,
        tenant: { id: ORG, name: 'Roosevelt Schools', slug: 'roosevelt' },
        providers: [{ key: 'oidc', displayName: 'School login' }],
      },
    }),
  );
  await page.route(`**/api/v1/organizations/${ORG}/people/${PERSON}/enrollment`, (route) =>
    route.fulfill({ json: { enrollment: null }, headers: { ETag: '"enroll:test:1"' } }),
  );
  await page.goto(`/schools/${ORG}/admin/people`);
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
  await expect(page.getByText('School records remain read-only here.')).toBeVisible();
  await expect(page.getByText('Alex Rivera')).toBeVisible();
  await page.getByRole('button', { name: 'Manage sign-in' }).click();
  await expect(page.getByText('Sign-in not connected')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create School login invitation' })).toBeVisible();
});

test('admin audit shows confirmed changes without analytics', async ({ page }) => {
  await shell(page, ADMIN);
  await page.route(`**/api/v1/organizations/${ORG}/audit-events*`, (route) =>
    route.fulfill({
      json: {
        events: [
          {
            id: 'evt-1',
            occurredAt: '2026-09-21T14:05:00Z',
            actor: { kind: 'staff', displayName: 'Sam Patel' },
            action: 'pass.created',
            target: { kind: 'pass' },
            outcome: 'allowed',
            requestId: 'req-1',
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.goto(`/schools/${ORG}/admin/audit`);
  await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible();
  await expect(page.getByText('No movement analytics or scoring.')).toBeVisible();
  await expect(page.getByText('Pass created')).toBeVisible();
  await expect(page.getByText('Sam Patel')).toBeVisible();
  await expect(page.getByText('req-1')).toBeVisible();
});

test('admin locations list school places', async ({ page }) => {
  await shell(page, ADMIN);
  await page.route(`**/api/v1/organizations/${ORG}/locations`, (route) =>
    route.fulfill({ json: orgLocations() }),
  );
  await page.goto(`/schools/${ORG}/admin/locations`);
  await expect(page.getByRole('heading', { name: 'Locations' })).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Locations' }).getByText('Health Office'),
  ).toBeVisible();
});

test('school chooser lists schools and index routes a student to their pass', async ({ page }) => {
  await shell(page, STUDENT);
  await page.route('**/api/v1/me/organizations', (route) =>
    route.fulfill({
      json: {
        organizations: [
          {
            id: ORG,
            name: 'Roosevelt Middle School',
            slug: 'roosevelt-middle',
            timeZone: 'America/New_York',
            affiliations: ['student'],
          },
          {
            id: ORG_B,
            name: 'Roosevelt High School',
            slug: 'roosevelt-high',
            timeZone: 'America/New_York',
            affiliations: ['staff'],
          },
        ],
      },
    }),
  );
  await studentApis(page, { current: null });
  await page.goto('/schools');
  await expect(page.getByRole('heading', { name: 'Choose a school' })).toBeVisible();
  await expect(page.getByText('Roosevelt High School')).toBeVisible();
  await page.getByRole('link', { name: /Roosevelt Middle School/ }).click();
  await expect(page).toHaveURL(new RegExp(`/schools/${ORG}/pass`));
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toBeVisible();
});

test('an active pass in another school redirects to that school', async ({ page }) => {
  await shell(page, STUDENT, ORG, 'Roosevelt Middle School');
  await shell(page, STUDENT, ORG_B, 'Roosevelt High School');
  await page.route('**/api/v1/me/passes/active', (route) =>
    route.fulfill({
      json: { pass: mockPass('outbound', 'required', null, ORG_B) },
      headers: { ETag: '"pass:test:2"' },
    }),
  );
  await page.route('**/api/v1/me/scheduled-authorizations', (route) =>
    route.fulfill({ json: { authorizations: [] } }),
  );
  await page.goto(`/schools/${ORG}/pass`);
  await expect(page).toHaveURL(new RegExp(`/schools/${ORG_B}/pass`));
  await expect(page.getByRole('heading', { name: 'On the way to Nurse' })).toBeVisible();
});

test('student no-pass view works at 320px from the keyboard without axe violations', async ({
  page,
}) => {
  await shell(page, STUDENT);
  const active: { current: ReturnType<typeof mockPass> | null } = { current: null };
  await studentApis(page, active);
  await page.route('**/api/v1/me/passes', async (route) => {
    active.current = mockPass('ready');
    await route.fulfill({
      status: 201,
      json: { pass: active.current },
      headers: { ETag: '"pass:test:1"' },
    });
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/schools/${ORG}/pass`);
  await expect(page.getByRole('heading', { name: 'Where do you need to go?' })).toBeVisible();
  const overflow = await page
    .locator('main')
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: /Nurse/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-slot="drawer-popup"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Request a WayPass' })).toBeVisible();
  await page.getByRole('button', { name: 'Request WayPass' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: "You're ready." })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
