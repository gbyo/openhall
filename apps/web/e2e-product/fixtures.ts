import type { Page } from '@playwright/test';

export const ORG = '00000000-0000-4000-8000-000000000010';
export const ORG_B = '00000000-0000-4000-8000-000000000019';
export const PERSON = '00000000-0000-4000-8000-000000000011';
export const ROOM = '00000000-0000-4000-8000-000000000012';
export const SECTION = '00000000-0000-4000-8000-000000000013';
export const PASS = '00000000-0000-4000-8000-000000000014';

export interface ShellContext {
  affiliations: string[];
  capabilities: string[];
  teachingSections?: unknown[];
  staffedRooms?: unknown[];
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
        staffedRooms: context.staffedRooms ?? [],
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

export const APPROVAL_PENDING: PassPolicy = {
  decision: 'pending_approval',
  evaluatedAt: '2026-09-21T14:00:00Z',
  reasonCodes: [],
  approvalPending: true,
  overrideAvailable: false,
  overridePending: false,
};

export interface HomeRoom {
  id: string;
  name: string;
  code: string | null;
  floorLabel: string | null;
  checkInMode: string;
  searchContext: {
    teacherNames: string[];
    sectionLabels: string[];
    roomStaffNames: string[];
  };
}

export interface HomeCategory {
  id: string;
  name: string;
  iconKey: string;
  toneKey: string;
  pickerMode: 'auto' | 'list' | 'search';
  sortOrder: number;
  rooms: HomeRoom[];
}

function room(id: string, name: string, overrides: Partial<HomeRoom> = {}): HomeRoom {
  return {
    id,
    name,
    code: null,
    floorLabel: null,
    checkInMode: 'none',
    searchContext: { teacherNames: [], sectionLabels: [], roomStaffNames: [] },
    ...overrides,
  };
}

export const HOME_CATEGORIES: HomeCategory[] = [
  {
    id: 'cat-restroom',
    name: 'Restroom',
    iconKey: 'restroom',
    toneKey: 'aqua',
    pickerMode: 'list',
    sortOrder: 10,
    rooms: [
      room(`${ROOM.slice(0, 24)}0021`, 'First floor restroom', {
        code: 'R1',
        floorLabel: 'Floor 1',
      }),
      room(`${ROOM.slice(0, 24)}0022`, 'Second floor restroom', {
        code: 'R2',
        floorLabel: 'Floor 2',
      }),
    ],
  },
  {
    id: 'cat-nurse',
    name: 'Nurse',
    iconKey: 'medical',
    toneKey: 'rose',
    pickerMode: 'list',
    sortOrder: 20,
    rooms: [
      room(ROOM, 'Nurse', {
        checkInMode: 'required',
        searchContext: { teacherNames: [], sectionLabels: [], roomStaffNames: ['Nurse Smith'] },
      }),
    ],
  },
  {
    id: 'cat-counselor',
    name: 'Counselor',
    iconKey: 'chat',
    toneKey: 'violet',
    pickerMode: 'list',
    sortOrder: 30,
    rooms: [room(`${ROOM.slice(0, 24)}0023`, 'Counseling Center', { checkInMode: 'optional' })],
  },
  {
    id: 'cat-library',
    name: 'Library',
    iconKey: 'book',
    toneKey: 'amber',
    pickerMode: 'list',
    sortOrder: 40,
    rooms: [room(`${ROOM.slice(0, 24)}0024`, 'Library Media Center', { checkInMode: 'optional' })],
  },
  {
    id: 'cat-visits',
    name: 'Room visits',
    iconKey: 'school',
    toneKey: 'blue',
    pickerMode: 'search',
    sortOrder: 50,
    rooms: [
      room(`${ROOM.slice(0, 24)}0031`, 'Science Lab 214', {
        code: '214',
        floorLabel: 'Floor 2',
        searchContext: {
          teacherNames: ['Jordan Lee'],
          sectionLabels: ['Physical Science (SCI-8A)'],
          roomStaffNames: [],
        },
      }),
      room(`${ROOM.slice(0, 24)}0032`, 'Room 118', {
        code: '118',
        floorLabel: 'Floor 1',
        searchContext: {
          teacherNames: ['Ms Smith'],
          sectionLabels: ['English 7 (ENG-7)'],
          roomStaffNames: [],
        },
      }),
    ],
  },
  {
    id: 'cat-planetarium',
    name: 'Planetarium',
    iconKey: 'generic',
    toneKey: 'neutral',
    pickerMode: 'list',
    sortOrder: 100,
    rooms: [room(`${ROOM.slice(0, 24)}0025`, 'Planetarium')],
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
    route.fulfill({ json: { authorizations: scheduled } }),
  );
}

export interface HomeCatalogRoom {
  id: string;
  name: string;
  code: string | null;
  floorLabel: string | null;
  categoryId: string | null;
  checkInMode: string;
}

export const HOME_CATALOG: HomeCatalogRoom[] = [
  {
    id: ROOM,
    name: 'Nurse',
    code: null,
    floorLabel: null,
    categoryId: 'cat-nurse',
    checkInMode: 'required',
  },
  {
    id: `${ROOM.slice(0, 24)}0021`,
    name: 'First floor restroom',
    code: 'R1',
    floorLabel: 'Floor 1',
    categoryId: 'cat-restroom',
    checkInMode: 'none',
  },
  {
    id: `${ROOM.slice(0, 24)}0022`,
    name: 'Second floor restroom',
    code: 'R2',
    floorLabel: 'Floor 2',
    categoryId: 'cat-restroom',
    checkInMode: 'none',
  },
  {
    id: `${ROOM.slice(0, 24)}0023`,
    name: 'Counseling Center',
    code: null,
    floorLabel: null,
    categoryId: 'cat-counselor',
    checkInMode: 'optional',
  },
  {
    id: `${ROOM.slice(0, 24)}0024`,
    name: 'Library Media Center',
    code: null,
    floorLabel: null,
    categoryId: 'cat-library',
    checkInMode: 'optional',
  },
  {
    id: `${ROOM.slice(0, 24)}0025`,
    name: 'Planetarium',
    code: null,
    floorLabel: null,
    categoryId: 'cat-planetarium',
    checkInMode: 'none',
  },
];

export async function studentHomeApis(
  page: Page,
  active: { current: ReturnType<typeof mockPass> | null },
  options: {
    rooms?: HomeCatalogRoom[];
    categories?: (HomeCategory & { studentSurface?: 'primary' | 'secondary' })[];
    scheduled?: unknown[];
  } = {},
) {
  await page.route('**/api/v1/me/passes/active', (route) =>
    route.fulfill({ json: { pass: active.current }, headers: { ETag: '"pass:test:1"' } }),
  );
  await page.route(`**/api/v1/me/organizations/${ORG}/rooms`, (route) =>
    route.fulfill({ json: { rooms: options.rooms ?? HOME_CATALOG } }),
  );
  const categories = (options.categories ?? HOME_CATEGORIES).map((category) => {
    if ('studentSurface' in category && category.studentSurface !== undefined) return category;
    // Planetarium exercises the generated More flow in e2e.
    if (category.id === 'cat-planetarium')
      return { ...category, studentSurface: 'secondary' as const };
    return category;
  });
  await page.route(`**/api/v1/me/organizations/${ORG}/student-room-catalog`, (route) =>
    route.fulfill({ json: { categories } }),
  );
  await page.route('**/api/v1/me/scheduled-authorizations', (route) =>
    route.fulfill({ json: { authorizations: options.scheduled ?? [] } }),
  );
}

export function orgRooms() {
  return {
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
      {
        id: `${ROOM.slice(0, 24)}0031`,
        organizationId: ORG,
        categoryId: 'cat-visits',
        name: 'Science Lab 214',
        code: '214',
        floorLabel: 'Floor 2',
        studentSelfRequestable: true,
        originSelectable: true,
        capacity: null,
        queueEnabled: false,
        checkInMode: 'none',
        defaultDurationSeconds: 600,
        maxDurationSeconds: 1200,
        readyClaimTimeoutSeconds: 120,
        queueTimeoutSeconds: 1800,
        status: 'open',
        revision: '1',
        createdAt: '2026-09-21T14:00:00Z',
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
        pickerMode: 'list',
        sortOrder: 20,
        status: 'active',
        revision: '1',
        updatedAt: '2026-09-21T14:00:00Z',
      },
      {
        id: 'cat-visits',
        organizationId: ORG,
        name: 'Room visits',
        iconKey: 'school',
        toneKey: 'blue',
        studentSurface: 'primary',
        pickerMode: 'search',
        sortOrder: 50,
        status: 'active',
        revision: '1',
        updatedAt: '2026-09-21T14:00:00Z',
      },
    ],
  };
}
