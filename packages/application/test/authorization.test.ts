import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../src/authentication/principal.js';
import type { Capability } from '../src/authorization/capabilities.js';
import type {
  AuthorizationDestinationRecord,
  AuthorizationFactsRepository,
  AuthorizationGrantFact,
  AuthorizationOrganizationRecord,
  AuthorizationSectionRecord,
  OrganizationMembershipFact,
  SectionMembershipFact,
  StaffedDestinationFact,
  TeachingSectionFact,
} from '../src/authorization/ports.js';
import { RelationshipAuthorizationService } from '../src/authorization/service.js';
import type {
  AuthorizationDecision,
  AuthorizationRequest,
} from '../src/authorization/decisions.js';
import type { DestinationId, OrganizationId, PersonId, SectionId } from '@openhall/domain';
import type { TenantTransactionContext, TenantTransactionRunner } from '../src/persistence.js';

const I = (value: string): Temporal.Instant => Temporal.Instant.from(value);
const D = (value: string): Temporal.PlainDate => Temporal.PlainDate.from(value);

const AT = I('2026-09-21T14:00:00Z'); // 10:00 in America/New_York, 09:00 in Chicago

function principal(
  accountId: string,
  personId: string,
  overrides: Partial<Principal> = {},
): Principal {
  return {
    tenantId: 'tenant-a',
    accountId,
    personId,
    sessionRevision: 1n,
    authenticationMethod: 'oidc',
    ...overrides,
  };
}

class FakeFacts implements AuthorizationFactsRepository {
  organizations = new Map<string, AuthorizationOrganizationRecord>();
  sections = new Map<string, AuthorizationSectionRecord>();
  destinations = new Map<string, AuthorizationDestinationRecord>();
  memberships = new Map<PersonId, OrganizationMembershipFact[]>();
  sectionMemberships = new Map<string, SectionMembershipFact>();
  grants = new Map<string, AuthorizationGrantFact[]>();

  loadOrganization(
    _context: TenantTransactionContext,
    organizationId: OrganizationId,
  ): Promise<AuthorizationOrganizationRecord | null> {
    return Promise.resolve(this.organizations.get(organizationId) ?? null);
  }

  loadSection(
    _context: TenantTransactionContext,
    sectionId: SectionId,
  ): Promise<AuthorizationSectionRecord | null> {
    return Promise.resolve(this.sections.get(sectionId) ?? null);
  }

  loadDestination(
    _context: TenantTransactionContext,
    destinationId: DestinationId,
  ): Promise<AuthorizationDestinationRecord | null> {
    return Promise.resolve(this.destinations.get(destinationId) ?? null);
  }

  listPersonMemberships(
    _context: TenantTransactionContext,
    personId: PersonId,
  ): Promise<readonly OrganizationMembershipFact[]> {
    return Promise.resolve(this.memberships.get(personId) ?? []);
  }

  checkSectionMembership(
    _context: TenantTransactionContext,
    sectionId: SectionId,
    personId: PersonId,
    role: 'student' | 'teacher',
  ): Promise<SectionMembershipFact | null> {
    return Promise.resolve(this.sectionMemberships.get(`${sectionId}|${personId}|${role}`) ?? null);
  }

  loadAccountGrants(
    _context: TenantTransactionContext,
    accountId: string,
  ): Promise<readonly AuthorizationGrantFact[]> {
    return Promise.resolve(
      (this.grants.get(accountId) ?? []).filter((grant) => grant.status === 'active'),
    );
  }

  listActiveSchools(): Promise<readonly AuthorizationOrganizationRecord[]> {
    return Promise.resolve(
      [...this.organizations.values()]
        .filter((org) => org.kind === 'school' && org.status === 'active')
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    );
  }

  listTeachingSections(
    _context: TenantTransactionContext,
    personId: PersonId,
    organizationId: OrganizationId,
  ): Promise<readonly TeachingSectionFact[]> {
    const staffActive = (this.memberships.get(personId) ?? []).some(
      (membership) =>
        membership.organizationId === organizationId &&
        membership.affiliation === 'staff' &&
        membership.status === 'active',
    );
    if (!staffActive) return Promise.resolve([]);
    const result: TeachingSectionFact[] = [];
    for (const section of this.sections.values()) {
      if (section.organizationId !== organizationId || section.status !== 'active') continue;
      const teacher = this.sectionMemberships.get(`${section.id}|${personId}|teacher`);
      if (teacher?.status === 'active') {
        result.push({ id: section.id, code: section.code, title: section.title });
      }
    }
    return Promise.resolve(result);
  }

  listStaffedDestinations(
    _context: TenantTransactionContext,
    accountId: string,
    personId: PersonId,
    organizationId: OrganizationId,
  ): Promise<readonly StaffedDestinationFact[]> {
    const staffActive = (this.memberships.get(personId) ?? []).some(
      (membership) =>
        membership.organizationId === organizationId &&
        membership.affiliation === 'staff' &&
        membership.status === 'active',
    );
    if (!staffActive) return Promise.resolve([]);
    const result: StaffedDestinationFact[] = [];
    for (const grant of this.grants.get(accountId) ?? []) {
      if (
        grant.role !== 'destination_staff' ||
        grant.scopeKind !== 'destination' ||
        grant.status !== 'active' ||
        grant.destinationId === null
      ) {
        continue;
      }
      const destination = this.destinations.get(grant.destinationId);
      if (destination?.organizationId !== organizationId || destination.status === 'archived') {
        continue;
      }
      result.push({
        id: destination.id,
        displayName: destination.displayName ?? destination.serviceType,
        serviceType: destination.serviceType,
      });
    }
    return Promise.resolve(result);
  }
}

function school(
  id: string,
  name: string,
  timeZone: string | null = 'America/New_York',
  status: 'active' | 'archived' = 'active',
  tenantId = 'tenant-a',
): AuthorizationOrganizationRecord {
  return { id, tenantId, kind: 'school', status, timeZone, name, slug: id };
}

function membership(
  organizationId: string,
  affiliation: 'student' | 'staff' | 'other',
  overrides: Partial<OrganizationMembershipFact> = {},
): OrganizationMembershipFact {
  return {
    organizationId,
    affiliation,
    status: 'active',
    validFrom: null,
    validUntil: null,
    ...overrides,
  };
}

function sectionMembership(
  sectionId: string,
  personId: string,
  role: 'student' | 'teacher',
  overrides: Partial<SectionMembershipFact> = {},
): SectionMembershipFact {
  return {
    sectionId,
    personId,
    role,
    status: 'active',
    startsOn: null,
    endsOn: null,
    ...overrides,
  };
}

function grant(
  id: string,
  role: string,
  scopeKind: string,
  overrides: Partial<AuthorizationGrantFact> = {},
): AuthorizationGrantFact {
  return {
    id,
    role,
    scopeKind,
    organizationId: null,
    destinationId: null,
    status: 'active',
    validFrom: null,
    validUntil: null,
    ...overrides,
  };
}

function section(
  id: string,
  organizationId: string,
  status: AuthorizationSectionRecord['status'] = 'active',
): AuthorizationSectionRecord {
  return { id, tenantId: 'tenant-a', organizationId, status, code: id, title: `Title ${id}` };
}

/** Fully seeded fake covering student, teacher, destination, counselor, admin, and system_admin. */
function seeded(): { facts: FakeFacts; service: RelationshipAuthorizationService } {
  const facts = new FakeFacts();
  facts.organizations.set('school-a', school('school-a', 'A School'));
  facts.organizations.set('school-b', school('school-b', 'B School', 'America/Chicago'));
  facts.organizations.set('district-d', {
    id: 'district-d',
    tenantId: 'tenant-a',
    kind: 'district',
    status: 'active',
    timeZone: null,
    name: 'District',
    slug: 'district-d',
  });
  facts.organizations.set(
    'school-archived',
    school('school-archived', 'Old School', 'America/New_York', 'archived'),
  );
  facts.organizations.set('school-bad-tz', school('school-bad-tz', 'Bad TZ School', 'Not/AZone'));
  facts.organizations.set(
    'school-tenant-b',
    school('school-tenant-b', 'Other Tenant School', 'America/New_York', 'active', 'tenant-b'),
  );

  facts.sections.set('sec-a1', section('sec-a1', 'school-a'));
  facts.sections.set('sec-a2', section('sec-a2', 'school-a'));
  facts.sections.set('sec-planned', section('sec-planned', 'school-a', 'planned'));
  facts.sections.set('sec-b1', { ...section('sec-b1', 'school-b'), tenantId: 'tenant-a' });

  facts.destinations.set('dest-a1', {
    id: 'dest-a1',
    tenantId: 'tenant-a',
    organizationId: 'school-a',
    status: 'active',
    displayName: 'Nurse',
    serviceType: 'nurse',
    locationName: 'Clinic',
  });
  facts.destinations.set('dest-a2', {
    id: 'dest-a2',
    tenantId: 'tenant-a',
    organizationId: 'school-a',
    status: 'active',
    displayName: 'Library',
    serviceType: 'library',
    locationName: 'Library',
  });
  facts.destinations.set('dest-archived', {
    id: 'dest-archived',
    tenantId: 'tenant-a',
    organizationId: 'school-a',
    status: 'archived',
    displayName: 'Old',
    serviceType: 'office',
    locationName: null,
  });

  // Student s1 at school-a; expired membership at school-b.
  facts.memberships.set('s1', [
    membership('school-a', 'student'),
    membership('school-b', 'student', { validFrom: D('2026-01-01'), validUntil: D('2026-06-01') }),
  ]);
  // Target students.
  facts.memberships.set('s2', [membership('school-a', 'student')]);
  facts.memberships.set('s3', [membership('school-a', 'student')]);
  facts.memberships.set('s4', [membership('school-b', 'student')]);
  facts.sectionMemberships.set('sec-a1|s2|student', sectionMembership('sec-a1', 's2', 'student'));
  facts.sectionMemberships.set('sec-a2|s3|student', sectionMembership('sec-a2', 's3', 'student'));
  facts.sectionMemberships.set('sec-b1|s4|student', sectionMembership('sec-b1', 's4', 'student'));

  // Teacher t1 teaches sec-a1.
  facts.memberships.set('t1', [membership('school-a', 'staff')]);
  facts.sectionMemberships.set('sec-a1|t1|teacher', sectionMembership('sec-a1', 't1', 'teacher'));
  // Teacher t2 teaches sec-a2 with an expired section relationship.
  facts.memberships.set('t2', [membership('school-a', 'staff')]);
  facts.sectionMemberships.set(
    'sec-a2|t2|teacher',
    sectionMembership('sec-a2', 't2', 'teacher', {
      startsOn: D('2026-01-01'),
      endsOn: D('2026-06-01'),
    }),
  );
  // Teacher t3 has an active section row but inactive school staff membership.
  facts.memberships.set('t3', [membership('school-a', 'staff', { status: 'inactive' })]);
  facts.sectionMemberships.set('sec-a1|t3|teacher', sectionMembership('sec-a1', 't3', 'teacher'));

  // Staff-only user with no powers.
  facts.memberships.set('staff1', [membership('school-a', 'staff')]);

  // Destination staff d1 at dest-a1.
  facts.memberships.set('d1', [membership('school-a', 'staff')]);
  facts.grants.set('acct-d1', [
    grant('g-dest-1', 'destination_staff', 'destination', { destinationId: 'dest-a1' }),
  ]);
  // Destination staff d2 whose grant expired, and d3 without staff membership.
  facts.memberships.set('d2', [membership('school-a', 'staff')]);
  facts.grants.set('acct-d2', [
    grant('g-dest-2', 'destination_staff', 'destination', {
      destinationId: 'dest-a1',
      validFrom: I('2026-01-01T00:00:00Z'),
      validUntil: I('2026-06-01T00:00:00Z'),
    }),
  ]);
  facts.memberships.set('d3', []);
  facts.grants.set('acct-d3', [
    grant('g-dest-3', 'destination_staff', 'destination', { destinationId: 'dest-a1' }),
  ]);

  // Counselor, office staff, school admin at school-a.
  facts.memberships.set('c1', [membership('school-a', 'staff')]);
  facts.grants.set('acct-c1', [
    grant('g-c1', 'counselor', 'organization', { organizationId: 'school-a' }),
  ]);
  facts.memberships.set('o1', [membership('school-a', 'staff')]);
  facts.grants.set('acct-o1', [
    grant('g-o1', 'office_staff', 'organization', { organizationId: 'school-a' }),
  ]);
  facts.memberships.set('a1', [membership('school-a', 'staff')]);
  facts.grants.set('acct-a1', [
    grant('g-a1', 'school_admin', 'organization', { organizationId: 'school-a' }),
  ]);
  // Revoked counselor grant.
  facts.memberships.set('c2', [membership('school-a', 'staff')]);
  facts.grants.set('acct-c2', [
    {
      ...grant('g-c2', 'counselor', 'organization', { organizationId: 'school-a' }),
      status: 'revoked',
    },
  ]);

  // Tenant system admin with no school membership.
  facts.memberships.set('sys', []);
  facts.grants.set('acct-sys', [grant('g-sys', 'system_admin', 'tenant')]);

  const runner: TenantTransactionRunner = {
    run: (tenantId, operation) => operation({ tenantId } as unknown as TenantTransactionContext),
  };
  const service = new RelationshipAuthorizationService(facts, runner);
  return { facts, service };
}

async function decide(
  service: RelationshipAuthorizationService,
  request: AuthorizationRequest,
): Promise<{ allowed: boolean; basis?: unknown; reason?: unknown }> {
  const decision = await service.decide(request);
  return decision.allowed
    ? { allowed: true, basis: decision.basis }
    : { allowed: false, reason: decision.reason };
}

describe('phase 4 authorization matrix', () => {
  it('student self and school access', async () => {
    const { service } = seeded();
    const me = principal('acct-s1', 's1');

    expect(
      await decide(service, {
        principal: me,
        capability: 'pass.request.self',
        resource: { kind: 'student', organizationId: 'school-a', studentId: 's1' },
        at: AT,
      }),
    ).toMatchObject({ allowed: true });

    expect(
      await decide(service, {
        principal: me,
        capability: 'organization.context.read',
        resource: { kind: 'organization', organizationId: 'school-a' },
        at: AT,
      }),
    ).toMatchObject({ allowed: true });

    // Another student: deny.
    expect(
      await decide(service, {
        principal: me,
        capability: 'pass.request.self',
        resource: { kind: 'student', organizationId: 'school-a', studentId: 's2' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'target_not_active_student' });

    // Expired school membership: deny.
    expect(
      await decide(service, {
        principal: me,
        capability: 'organization.context.read',
        resource: { kind: 'organization', organizationId: 'school-b' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'no_active_organization_membership' });
  });

  it('system_admin cannot fabricate student self', async () => {
    const { service } = seeded();
    expect(
      await decide(service, {
        principal: principal('acct-sys', 'sys'),
        capability: 'pass.request.self',
        resource: { kind: 'student', organizationId: 'school-a', studentId: 'sys' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false });
  });

  it('staff alone gains context but no movement powers', async () => {
    const { service } = seeded();
    const staff = principal('acct-staff1', 'staff1');
    expect(
      await decide(service, {
        principal: staff,
        capability: 'organization.context.read',
        resource: { kind: 'organization', organizationId: 'school-a' },
        at: AT,
      }),
    ).toMatchObject({ allowed: true });
    expect(
      await decide(service, {
        principal: staff,
        capability: 'pass.view.school_live',
        resource: { kind: 'organization', organizationId: 'school-a' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'no_applicable_grant' });
    expect(
      await decide(service, {
        principal: staff,
        capability: 'pass.create.student',
        resource: { kind: 'student', organizationId: 'school-a', studentId: 's2' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'no_applicable_grant' });
  });

  it('teacher authority is section-scoped', async () => {
    const { service } = seeded();
    const teacher = principal('acct-t1', 't1');

    expect(
      await decide(service, {
        principal: teacher,
        capability: 'pass.view.section_live',
        resource: { kind: 'section', sectionId: 'sec-a1' },
        at: AT,
      }),
    ).toMatchObject({ allowed: true });

    expect(
      await decide(service, {
        principal: teacher,
        capability: 'pass.approve.section',
        resource: { kind: 'student_in_section', sectionId: 'sec-a1', studentId: 's2' },
        at: AT,
      }),
    ).toMatchObject({ allowed: true, basis: { kind: 'teacher_section_relationship' } });

    // Student in another section: deny.
    expect(
      await decide(service, {
        principal: teacher,
        capability: 'pass.approve.section',
        resource: { kind: 'student_in_section', sectionId: 'sec-a2', studentId: 's3' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'teacher_not_assigned' });

    // Org-level create path is not available to teachers.
    expect(
      await decide(service, {
        principal: teacher,
        capability: 'pass.create.student',
        resource: { kind: 'student', organizationId: 'school-a', studentId: 's2' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'no_applicable_grant' });

    // Teacher powers do not leak to organization scope.
    expect(
      await decide(service, {
        principal: teacher,
        capability: 'pass.view.school_live',
        resource: { kind: 'organization', organizationId: 'school-a' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false });
  });

  it('destination staff is assignment-scoped and time-bounded', async () => {
    const { service } = seeded();
    expect(
      await decide(service, {
        principal: principal('acct-d1', 'd1'),
        capability: 'destination.station.manage',
        resource: { kind: 'destination', destinationId: 'dest-a1' },
        at: AT,
      }),
    ).toMatchObject({ allowed: true, basis: { kind: 'explicit_grant' } });

    // Different destination: deny.
    expect(
      await decide(service, {
        principal: principal('acct-d1', 'd1'),
        capability: 'destination.station.manage',
        resource: { kind: 'destination', destinationId: 'dest-a2' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'no_applicable_grant' });

    // Expired grant: deny.
    expect(
      await decide(service, {
        principal: principal('acct-d2', 'd2'),
        capability: 'destination.station.manage',
        resource: { kind: 'destination', destinationId: 'dest-a1' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'no_applicable_grant' });

    // No active staff membership: deny even with a valid grant row.
    expect(
      await decide(service, {
        principal: principal('acct-d3', 'd3'),
        capability: 'destination.station.manage',
        resource: { kind: 'destination', destinationId: 'dest-a1' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'staff_membership_required' });

    // Archived destination: deny.
    expect(
      await decide(service, {
        principal: principal('acct-d1', 'd1'),
        capability: 'destination.station.manage',
        resource: { kind: 'destination', destinationId: 'dest-archived' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'resource_inactive' });
  });

  it('grant validity uses half-open instant semantics', async () => {
    const { facts, service } = seeded();
    facts.memberships.set('db1', [membership('school-a', 'staff')]);
    facts.grants.set('acct-db1', [
      grant('g-bound', 'destination_staff', 'destination', {
        destinationId: 'dest-a1',
        validFrom: I('2026-09-21T14:00:00Z'),
        validUntil: I('2026-09-22T14:00:00Z'),
      }),
    ]);
    const actor = principal('acct-db1', 'db1');
    const request = (at: Temporal.Instant): AuthorizationRequest<'destination.station.manage'> => ({
      principal: actor,
      capability: 'destination.station.manage',
      resource: { kind: 'destination', destinationId: 'dest-a1' },
      at,
    });
    expect(await decide(service, request(I('2026-09-21T13:59:59Z')))).toMatchObject({
      allowed: false,
    });
    expect(await decide(service, request(I('2026-09-21T14:00:00Z')))).toMatchObject({
      allowed: true,
    });
    expect(await decide(service, request(I('2026-09-22T13:59:59Z')))).toMatchObject({
      allowed: true,
    });
    // Exactly valid_until: deny.
    expect(await decide(service, request(I('2026-09-22T14:00:00Z')))).toMatchObject({
      allowed: false,
    });
  });

  it('counselor, office staff, and revoked grants', async () => {
    const { service } = seeded();
    for (const [account, person] of [
      ['acct-c1', 'c1'],
      ['acct-o1', 'o1'],
    ] as const) {
      for (const capability of [
        'pass.create.student',
        'pass.view.school_live',
        'scheduled_authorization.manage',
      ] as const satisfies readonly Capability[]) {
        const resource =
          capability === 'pass.create.student'
            ? { kind: 'student', organizationId: 'school-a', studentId: 's2' }
            : { kind: 'organization', organizationId: 'school-a' };
        expect(
          await decide(service, {
            principal: principal(account, person),
            capability,
            resource,
            at: AT,
          } as AuthorizationRequest),
        ).toMatchObject({ allowed: true });
      }
      // No historical browsing or admin powers by default.
      expect(
        await decide(service, {
          principal: principal(account, person),
          capability: 'pass.view.school_history',
          resource: { kind: 'organization', organizationId: 'school-a' },
          at: AT,
        }),
      ).toMatchObject({ allowed: false });
      expect(
        await decide(service, {
          principal: principal(account, person),
          capability: 'policy.manage',
          resource: { kind: 'organization', organizationId: 'school-a' },
          at: AT,
        }),
      ).toMatchObject({ allowed: false });
    }

    // Counselor at a different school: deny.
    expect(
      await decide(service, {
        principal: principal('acct-c1', 'c1'),
        capability: 'pass.view.school_live',
        resource: { kind: 'organization', organizationId: 'school-b' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false });

    // Revoked grant: deny.
    expect(
      await decide(service, {
        principal: principal('acct-c2', 'c2'),
        capability: 'pass.view.school_live',
        resource: { kind: 'organization', organizationId: 'school-a' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false });
  });

  it('school admin is exact-school and excludes identity/system powers', async () => {
    const { service } = seeded();
    const admin = principal('acct-a1', 'a1');
    for (const capability of [
      'pass.view.school_history',
      'schedule.manage',
      'people.manage',
      'policy.manage',
      'authorization.manage',
      'audit.view',
      'destination.manage',
    ] as const satisfies readonly Capability[]) {
      expect(
        await decide(service, {
          principal: admin,
          capability,
          resource: { kind: 'organization', organizationId: 'school-a' },
          at: AT,
        }),
      ).toMatchObject({ allowed: true });
    }
    for (const capability of ['identity.manage', 'system.manage'] as const) {
      expect(
        await decide(service, {
          principal: admin,
          capability,
          resource: { kind: 'tenant' },
          at: AT,
        }),
      ).toMatchObject({ allowed: false, reason: 'no_applicable_grant' });
    }
    // Different school: deny (no district inheritance).
    expect(
      await decide(service, {
        principal: admin,
        capability: 'schedule.manage',
        resource: { kind: 'organization', organizationId: 'school-b' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false });
  });

  it('system admin is tenant-wide but tenant-bound', async () => {
    const { service } = seeded();
    const sys = principal('acct-sys', 'sys');
    expect(
      await decide(service, {
        principal: sys,
        capability: 'audit.view',
        resource: { kind: 'organization', organizationId: 'school-a' },
        at: AT,
      }),
    ).toMatchObject({ allowed: true, basis: { kind: 'system_admin' } });
    expect(
      await decide(service, {
        principal: sys,
        capability: 'system.manage',
        resource: { kind: 'tenant' },
        at: AT,
      }),
    ).toMatchObject({ allowed: true });

    // Another tenant: deny even with a valid UUID from that tenant.
    expect(
      await decide(service, {
        principal: sys,
        capability: 'audit.view',
        resource: { kind: 'organization', organizationId: 'school-tenant-b' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'tenant_mismatch' });
  });

  it('recovery sessions are restricted to self and identity repair', async () => {
    const { service } = seeded();
    const recoverySys = principal('acct-sys', 'sys', { authenticationMethod: 'recovery' });
    expect(
      await decide(service, {
        principal: recoverySys,
        capability: 'self.read',
        resource: { kind: 'self' },
        at: AT,
      }),
    ).toMatchObject({ allowed: true, basis: { kind: 'self' } });
    expect(
      await decide(service, {
        principal: recoverySys,
        capability: 'identity.manage',
        resource: { kind: 'tenant' },
        at: AT,
      }),
    ).toMatchObject({ allowed: true });
    for (const [capability, resource] of [
      ['organization.context.read', { kind: 'organization', organizationId: 'school-a' }],
      ['pass.request.self', { kind: 'student', organizationId: 'school-a', studentId: 'sys' }],
      ['audit.view', { kind: 'organization', organizationId: 'school-a' }],
      ['system.manage', { kind: 'tenant' }],
    ] as const) {
      expect(
        await decide(service, {
          principal: recoverySys,
          capability,
          resource,
          at: AT,
        }),
      ).toMatchObject({ allowed: false, reason: 'recovery_session_restricted' });
    }
    // Recovery without an effective system_admin grant cannot identity.manage.
    const recoveryNobody = principal('acct-s1', 's1', { authenticationMethod: 'recovery' });
    expect(
      await decide(service, {
        principal: recoveryNobody,
        capability: 'identity.manage',
        resource: { kind: 'tenant' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false });
  });

  it('membership dates evaluate on the school local date', async () => {
    const { facts, service } = seeded();
    facts.memberships.set('s5', [
      membership('school-a', 'student', { validFrom: D('2026-09-21'), validUntil: null }),
    ]);
    const actor = principal('acct-s5', 's5');
    const context: Omit<AuthorizationRequest<'organization.context.read'>, 'at'> = {
      principal: actor,
      capability: 'organization.context.read',
      resource: { kind: 'organization', organizationId: 'school-a' },
    };
    // 2026-09-21T03:00Z is still Sept 20 in New York: deny.
    expect(await decide(service, { ...context, at: I('2026-09-21T03:00:00Z') })).toMatchObject({
      allowed: false,
      reason: 'no_active_organization_membership',
    });
    // 2026-09-21T04:30Z is Sept 21 in New York: allow. UTC date alone would agree here,
    // so the first case above is the falsifying one (UTC date != school local date).
    expect(await decide(service, { ...context, at: AT })).toMatchObject({ allowed: true });
  });

  it('rejects invalid capability/resource shapes and unknown resources', async () => {
    const { service } = seeded();
    const me = principal('acct-s1', 's1');
    expect(
      await decide(service, {
        principal: me,
        capability: 'schedule.manage',
        resource: { kind: 'self' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'capability_not_applicable' });

    expect(
      await decide(service, {
        principal: me,
        capability: 'organization.context.read',
        resource: { kind: 'organization', organizationId: 'missing-school' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'resource_not_found' });

    // District organizations are not valid school contexts.
    expect(
      await decide(service, {
        principal: principal('acct-sys', 'sys'),
        capability: 'organization.context.read',
        resource: { kind: 'organization', organizationId: 'district-d' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'organization_not_school' });

    // Archived schools deny operational access.
    expect(
      await decide(service, {
        principal: principal('acct-sys', 'sys'),
        capability: 'organization.context.read',
        resource: { kind: 'organization', organizationId: 'school-archived' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'resource_inactive' });

    // Unusable school time zone fails closed.
    expect(
      await decide(service, {
        principal: principal('acct-sys', 'sys'),
        capability: 'organization.context.read',
        resource: { kind: 'organization', organizationId: 'school-bad-tz' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'invalid_school_time_zone' });

    // Non-active sections carry no live teacher relationship.
    expect(
      await decide(service, {
        principal: principal('acct-t1', 't1'),
        capability: 'pass.view.section_live',
        resource: { kind: 'section', sectionId: 'sec-planned' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'resource_inactive' });
  });

  it('canonical ownership wins over client-supplied organization', async () => {
    const { service } = seeded();
    // Teacher t1 (school-a) names a section that canonically belongs to
    // school-b: evaluated as school-b, where t1 holds nothing.
    expect(
      await decide(service, {
        principal: principal('acct-t1', 't1'),
        capability: 'pass.approve.section',
        resource: { kind: 'student_in_section', sectionId: 'sec-b1', studentId: 's4' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false });
  });

  it('expired and inactive teacher relationships deny', async () => {
    const { service } = seeded();
    expect(
      await decide(service, {
        principal: principal('acct-t2', 't2'),
        capability: 'pass.view.section_live',
        resource: { kind: 'section', sectionId: 'sec-a2' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'teacher_not_assigned' });

    expect(
      await decide(service, {
        principal: principal('acct-t3', 't3'),
        capability: 'pass.approve.section',
        resource: { kind: 'student_in_section', sectionId: 'sec-a1', studentId: 's2' },
        at: AT,
      }),
    ).toMatchObject({ allowed: false, reason: 'teacher_not_assigned' });
  });

  it('organization snapshots share enforcement semantics', async () => {
    const { service } = seeded();
    const context = { tenantId: 'tenant-a' } as unknown as TenantTransactionContext;

    const student = await service.evaluateOrganizationSnapshot(
      context,
      principal('acct-s1', 's1'),
      'school-a',
      AT,
    );
    expect(student?.capabilities).toEqual(['organization.context.read', 'pass.request.self']);
    expect(student?.teachingSections).toEqual([]);
    expect(student?.isActiveStudent).toBe(true);

    const teacher = await service.evaluateOrganizationSnapshot(
      context,
      principal('acct-t1', 't1'),
      'school-a',
      AT,
    );
    // Section-scoped powers stay on the assignment, never top-level.
    expect(teacher?.capabilities).toEqual(['organization.context.read']);
    expect(teacher?.teachingSections).toEqual([
      {
        id: 'sec-a1',
        code: 'sec-a1',
        title: 'Title sec-a1',
        capabilities: ['pass.create.student', 'pass.approve.section', 'pass.view.section_live'],
      },
    ]);

    const counselor = await service.evaluateOrganizationSnapshot(
      context,
      principal('acct-c1', 'c1'),
      'school-a',
      AT,
    );
    expect(counselor?.capabilities).toEqual([
      'organization.context.read',
      'pass.create.student',
      'pass.view.school_live',
      'scheduled_authorization.manage',
    ]);

    const admin = await service.evaluateOrganizationSnapshot(
      context,
      principal('acct-a1', 'a1'),
      'school-a',
      AT,
    );
    expect(admin?.capabilities).toContain('pass.view.school_history');
    expect(admin?.capabilities).toContain('audit.view');
    expect(admin?.capabilities).not.toContain('identity.manage');
    expect(admin?.capabilities).not.toContain('system.manage');
    // Broad grants never copy every section into the teaching array.
    expect(admin?.teachingSections).toEqual([]);

    const sys = await service.evaluateOrganizationSnapshot(
      context,
      principal('acct-sys', 'sys'),
      'school-a',
      AT,
    );
    expect(sys?.affiliations).toEqual([]);
    expect(sys?.capabilities).toContain('pass.view.school_history');

    // Unknown organizations produce no snapshot (HTTP maps to 404).
    expect(
      await service.evaluateOrganizationSnapshot(
        context,
        principal('acct-s1', 's1'),
        'missing',
        AT,
      ),
    ).toBeNull();
  });

  it('the enforcement entry point statically pairs capability and resource', async () => {
    const { service } = seeded();
    const me = principal('acct-t1', 't1');
    const pending: Promise<AuthorizationDecision>[] = [];
    pending.push(
      service.decide({
        principal: me,
        capability: 'pass.approve.section',
        resource: { kind: 'student_in_section', sectionId: 'sec-a1', studentId: 's2' },
        at: AT,
      }),
    );
    pending.push(
      service.decide({
        principal: me,
        capability: 'pass.approve.section',
        // @ts-expect-error tenant is not a valid resource for pass.approve.section.
        resource: { kind: 'tenant' },
        at: AT,
      }),
    );
    const [decision] = await Promise.all(pending);
    expect(decision?.allowed).toBe(true);
  });

  it('accessible organizations list current schools once', async () => {
    const { facts, service } = seeded();
    facts.memberships.set('multi', [
      membership('school-a', 'student'),
      membership('school-a', 'staff'),
      membership('school-b', 'staff'),
    ]);
    const context = { tenantId: 'tenant-a' } as unknown as TenantTransactionContext;
    const listed = await service.listAccessibleOrganizations(
      context,
      principal('acct-multi', 'multi'),
      AT,
    );
    expect(listed.map((entry) => entry.id)).toEqual(['school-a', 'school-b']);
    expect(listed[0]?.affiliations).toEqual(['staff', 'student']);

    const sys = await service.listAccessibleOrganizations(
      context,
      principal('acct-sys', 'sys'),
      AT,
    );
    expect(sys.map((entry) => entry.id)).toEqual(['school-a', 'school-b']);
    expect(sys[0]?.affiliations).toEqual([]);
  });
});
