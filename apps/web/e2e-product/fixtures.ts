import type { Page } from '@playwright/test';

export const ORG = '00000000-0000-4000-8000-000000000010';
export const ORG_B = '00000000-0000-4000-8000-000000000019';
export const PERSON = '00000000-0000-4000-8000-000000000011';
export const DESTINATION = '00000000-0000-4000-8000-000000000012';
export const SECTION = '00000000-0000-4000-8000-000000000013';
export const PASS = '00000000-0000-4000-8000-000000000014';
export const LOCATION = '00000000-0000-4000-8000-000000000015';

export interface ShellContext {
  affiliations: string[];
  capabilities: string[];
  teachingSections?: unknown[];
  staffedDestinations?: unknown[];
}

export async function shell(
  page: Page,
  context: ShellContext,
  orgId = ORG,
  orgName = 'Roosevelt Middle School',
): Promise<void> {
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
            id: orgId,
            name: orgName,
            slug: 'roosevelt-middle',
            timeZone: 'America/New_York',
            affiliations: context.affiliations,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/me/organizations/${orgId}/context`, (route) =>
    route.fulfill({
      json: {
        organization: {
          id: orgId,
          name: orgName,
          slug: 'roosevelt-middle',
          timeZone: 'America/New_York',
        },
        affiliations: context.affiliations,
        capabilities: context.capabilities,
        expectedPlacement: { kind: 'outside_schedule' },
        teachingSections: context.teachingSections ?? [],
        staffedDestinations: context.staffedDestinations ?? [],
      },
    }),
  );
  await page.route(`**/api/v1/organizations/${orgId}/events`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: resync\ndata: {}\n\n',
    }),
  );
}

export interface PassPolicy {
  decision: string;
  evaluatedAt: string;
  reasonCodes: string[];
  approvalPending: boolean;
  overrideAvailable: boolean;
  overridePending: boolean;
}

export function mockPass(
  state: string,
  mode: 'none' | 'optional' | 'required' | null = null,
  policy: PassPolicy | null = null,
  organizationId: string = ORG,
) {
  return {
    id: PASS,
    organizationId,
    studentId: PERSON,
    policy,
    destination: {
      id: DESTINATION,
      displayName: 'Nurse',
      serviceType: 'nurse',
      checkInMode: 'required',
      category: { id: 'cat-nurse', name: 'Nurse', iconKey: 'medical', toneKey: 'rose' },
    },
    origin: {
      placementKind: 'resolved',
      block: null,
      section: { id: SECTION, code: 'SCI-7', title: 'Science 7' },
      location: { id: LOCATION, name: 'Room 214' },
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

export const APPROVAL_PENDING: PassPolicy = {
  decision: 'pending_approval',
  evaluatedAt: '2026-09-21T14:00:00Z',
  reasonCodes: [],
  approvalPending: true,
  overrideAvailable: false,
  overridePending: false,
};

export interface HomeCategory {
  id: string;
  name: string;
  iconKey: string;
  toneKey: string;
  studentSurface: 'primary' | 'secondary';
  sortOrder: number;
  destinations: {
    id: string;
    displayName: string;
    location: { id: string; name: string };
    checkInMode: string;
  }[];
}

export const HOME_CATEGORIES: HomeCategory[] = [
  {
    id: 'cat-restroom',
    name: 'Restroom',
    iconKey: 'restroom',
    toneKey: 'aqua',
    studentSurface: 'primary',
    sortOrder: 10,
    destinations: [
      {
        id: `${DESTINATION.slice(0, 24)}0021`,
        displayName: 'First floor restroom',
        location: { id: LOCATION, name: 'Main hallway' },
        checkInMode: 'none',
      },
      {
        id: `${DESTINATION.slice(0, 24)}0022`,
        displayName: 'Second floor restroom',
        location: { id: LOCATION, name: 'Science wing' },
        checkInMode: 'none',
      },
    ],
  },
  {
    id: 'cat-nurse',
    name: 'Nurse',
    iconKey: 'medical',
    toneKey: 'rose',
    studentSurface: 'primary',
    sortOrder: 20,
    destinations: [
      {
        id: DESTINATION,
        displayName: 'Nurse',
        location: { id: LOCATION, name: 'Health Office' },
        checkInMode: 'required',
      },
    ],
  },
  {
    id: 'cat-counselor',
    name: 'Counselor',
    iconKey: 'chat',
    toneKey: 'violet',
    studentSurface: 'primary',
    sortOrder: 30,
    destinations: [
      {
        id: `${DESTINATION.slice(0, 24)}0023`,
        displayName: 'Counseling Center',
        location: { id: LOCATION, name: 'Counseling Center' },
        checkInMode: 'optional',
      },
    ],
  },
  {
    id: 'cat-library',
    name: 'Library',
    iconKey: 'book',
    toneKey: 'amber',
    studentSurface: 'primary',
    sortOrder: 40,
    destinations: [
      {
        id: `${DESTINATION.slice(0, 24)}0024`,
        displayName: 'Library Media Center',
        location: { id: LOCATION, name: 'Library' },
        checkInMode: 'optional',
      },
    ],
  },
  {
    id: 'cat-planetarium',
    name: 'Planetarium',
    iconKey: 'generic',
    toneKey: 'neutral',
    studentSurface: 'secondary',
    sortOrder: 100,
    destinations: [
      {
        id: `${DESTINATION.slice(0, 24)}0025`,
        displayName: 'Planetarium',
        location: { id: LOCATION, name: 'Science wing' },
        checkInMode: 'none',
      },
    ],
  },
];

export async function studentApis(
  page: Page,
  active: { current: ReturnType<typeof mockPass> | null },
  scheduled: unknown[] = [],
) {
  await page.route('**/api/v1/me/passes/active', (route) =>
    route.fulfill({ json: { pass: active.current }, headers: { ETag: '"pass:test:1"' } }),
  );
  await page.route(`**/api/v1/me/organizations/${ORG}/destinations`, (route) =>
    route.fulfill({
      json: {
        destinations: [
          {
            id: DESTINATION,
            displayName: 'Nurse',
            serviceType: 'nurse',
            categoryId: 'cat-nurse',
            checkInMode: 'required',
          },
        ],
      },
    }),
  );
  await page.route(`**/api/v1/me/organizations/${ORG}/student-destination-catalog`, (route) =>
    route.fulfill({
      json: {
        categories: [
          {
            id: 'cat-nurse',
            name: 'Nurse',
            iconKey: 'medical',
            toneKey: 'rose',
            studentSurface: 'primary',
            sortOrder: 20,
            destinations: [
              {
                id: DESTINATION,
                displayName: 'Nurse',
                location: { id: LOCATION, name: 'Health Office' },
                checkInMode: 'required',
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route('**/api/v1/me/scheduled-authorizations', (route) =>
    route.fulfill({ json: { authorizations: scheduled } }),
  );
}

export interface HomeDestination {
  id: string;
  displayName: string;
  serviceType: string;
  checkInMode: string;
}

export const HOME_CATALOG: HomeDestination[] = [
  { id: DESTINATION, displayName: 'Nurse', serviceType: 'nurse', checkInMode: 'required' },
  {
    id: `${DESTINATION.slice(0, 24)}0021`,
    displayName: 'First floor restroom',
    serviceType: 'restroom',
    checkInMode: 'none',
  },
  {
    id: `${DESTINATION.slice(0, 24)}0022`,
    displayName: 'Second floor restroom',
    serviceType: 'restroom',
    checkInMode: 'none',
  },
  {
    id: `${DESTINATION.slice(0, 24)}0023`,
    displayName: 'Counseling Center',
    serviceType: 'counseling',
    checkInMode: 'optional',
  },
  {
    id: `${DESTINATION.slice(0, 24)}0024`,
    displayName: 'Library Media Center',
    serviceType: 'library',
    checkInMode: 'optional',
  },
  {
    id: `${DESTINATION.slice(0, 24)}0025`,
    displayName: 'Planetarium',
    serviceType: 'planetarium',
    checkInMode: 'none',
  },
];

export async function studentHomeApis(
  page: Page,
  active: { current: ReturnType<typeof mockPass> | null },
  options: {
    destinations?: HomeDestination[];
    categories?: HomeCategory[];
    scheduled?: unknown[];
  } = {},
) {
  await page.route('**/api/v1/me/passes/active', (route) =>
    route.fulfill({ json: { pass: active.current }, headers: { ETag: '"pass:test:1"' } }),
  );
  await page.route(`**/api/v1/me/organizations/${ORG}/destinations`, (route) =>
    route.fulfill({ json: { destinations: options.destinations ?? HOME_CATALOG } }),
  );
  await page.route(`**/api/v1/me/organizations/${ORG}/student-destination-catalog`, (route) =>
    route.fulfill({ json: { categories: options.categories ?? HOME_CATEGORIES } }),
  );
  await page.route('**/api/v1/me/scheduled-authorizations', (route) =>
    route.fulfill({ json: { authorizations: options.scheduled ?? [] } }),
  );
}

export function orgDestinations() {
  return {
    destinations: [
      {
        id: DESTINATION,
        organizationId: ORG,
        locationId: LOCATION,
        categoryId: 'cat-nurse',
        studentSelfRequestable: true,
        serviceType: 'nurse',
        displayName: 'Nurse',
        capacity: 3,
        queueEnabled: true,
        checkInMode: 'required',
        defaultDurationSeconds: 600,
        maxDurationSeconds: 1200,
        readyClaimTimeoutSeconds: 120,
        queueTimeoutSeconds: 1800,
        status: 'active',
        revision: '2',
        updatedAt: '2026-09-21T14:00:00Z',
      },
    ],
  };
}

export function orgCategories() {
  return {
    categories: [
      {
        id: 'cat-nurse',
        organizationId: ORG,
        name: 'Nurse',
        iconKey: 'medical',
        toneKey: 'rose',
        studentSurface: 'primary',
        pickerMode: 'auto',
        sortOrder: 20,
        status: 'active',
        revision: '1',
        updatedAt: '2026-09-21T14:00:00Z',
      },
    ],
  };
}

export function orgLocations() {
  return {
    locations: [
      {
        id: LOCATION,
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
    ],
  };
}

export function orgPlaces() {
  return {
    places: [
      {
        id: LOCATION,
        organizationId: ORG,
        name: 'Room 214',
        kind: 'classroom',
        code: '214',
        floorLabel: '2nd floor',
        parentLocationId: null,
        parentName: null,
        status: 'active',
        classUsage: {
          sectionCount: 1,
          teacherNames: ['Ms. Smith'],
          classes: [],
        },
        destinationSummary: { count: 0, destinations: [] },
        revision: '1',
        updatedAt: '2026-09-21T14:00:00Z',
      },
    ],
  };
}

export function placeDetail() {
  const [place] = orgPlaces().places;
  return {
    place: {
      ...place,
      classUsage: {
        sectionCount: 1,
        teacherNames: ['Ms. Smith'],
        classes: [{ title: 'Algebra II', code: 'ALG-2', teacherNames: ['Ms. Smith'] }],
      },
    },
  };
}
