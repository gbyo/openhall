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
  mode: 'optional' | 'required' | null = null,
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
            checkInMode: 'required',
          },
        ],
      },
    }),
  );
  await page.route('**/api/v1/me/scheduled-authorizations', (route) =>
    route.fulfill({ json: { authorizations: scheduled } }),
  );
}

export function orgDestinations() {
  return {
    destinations: [
      {
        id: DESTINATION,
        organizationId: ORG,
        locationId: LOCATION,
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
