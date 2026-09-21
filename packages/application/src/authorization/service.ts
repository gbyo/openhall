import { Temporal } from '@js-temporal/polyfill';
import type { Clock } from '@openhall/domain';
import type { Principal } from '../authentication/principal.js';
import type { TenantTransactionContext, TenantTransactionRunner } from '../persistence.js';
import { sortCapabilities, type Capability } from './capabilities.js';
import type {
  AuthorizationBasis,
  AuthorizationDecision,
  AuthorizationDenialReason,
  AuthorizationRequest,
  ExplicitRole,
} from './decisions.js';
import { isExplicitRole } from './roles.js';
import { ROLE_CAPABILITIES, SYSTEM_ADMIN_CAPABILITIES } from './roles.js';
import type {
  AuthorizationFactsRepository,
  AuthorizationGrantFact,
  OrganizationMembershipFact,
} from './ports.js';
import type {
  DestinationResource,
  OrganizationResource,
  SectionResource,
  StudentInSectionResource,
  StudentResource,
} from './resources.js';

export interface OrganizationAuthorizationSnapshot {
  readonly affiliations: readonly ('student' | 'staff' | 'other')[];
  readonly capabilities: readonly Capability[];
  readonly teachingSections: readonly {
    readonly id: string;
    readonly code: string | null;
    readonly title: string;
    readonly capabilities: readonly Capability[];
  }[];
  readonly staffedDestinations: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly serviceType: string;
    readonly capabilities: readonly Capability[];
  }[];
  readonly isActiveStudent: boolean;
}

const RECOVERY_ALLOWED: readonly Capability[] = ['self.read', 'identity.manage'];

const SECTION_SCOPED_TEACHER_CAPS: readonly Capability[] = [
  'pass.create.student',
  'pass.depart.student',
  'pass.approve.section',
  'pass.view.section_live',
  'pass.override.request.student',
  'pass.override.resolve.section',
];

function deny(reason: AuthorizationDenialReason): AuthorizationDecision {
  return { allowed: false, reason };
}

function grantEffectiveAt(grant: AuthorizationGrantFact, at: Temporal.Instant): boolean {
  if (grant.status !== 'active') return false;
  const time = at.epochMilliseconds;
  if (grant.validFrom !== null && grant.validFrom.epochMilliseconds > time) return false;
  if (grant.validUntil !== null && time >= grant.validUntil.epochMilliseconds) return false;
  return true;
}

function membershipActiveOn(
  membership: OrganizationMembershipFact,
  date: Temporal.PlainDate,
): boolean {
  if (membership.status !== 'active') return false;
  if (membership.validFrom !== null && Temporal.PlainDate.compare(membership.validFrom, date) > 0)
    return false;
  if (membership.validUntil !== null && Temporal.PlainDate.compare(date, membership.validUntil) > 0)
    return false;
  return true;
}

function schoolDateFor(at: Temporal.Instant, timeZone: string): Temporal.PlainDate | null {
  try {
    return at.toZonedDateTimeISO(timeZone).toPlainDate();
  } catch {
    return null;
  }
}

function isUsableTimeZone(timeZone: string): boolean {
  try {
    Temporal.Instant.from('2000-01-01T00:00:00Z').toZonedDateTimeISO(timeZone);
    return true;
  } catch {
    return false;
  }
}

function capabilityAllowsResourceKind(capability: Capability, kind: string): boolean {
  switch (capability) {
    case 'self.read':
    case 'pass.view.self':
    case 'pass.cancel.self':
    case 'pass.progress.self':
      return kind === 'self';
    case 'organization.context.read':
    case 'pass.view.school_live':
    case 'pass.view.school_history':
    case 'scheduled_authorization.manage':
    case 'schedule.view':
    case 'schedule.manage':
    case 'people.view':
    case 'people.manage':
    case 'policy.manage':
    case 'authorization.manage':
    case 'integration.manage':
    case 'incident.view':
    case 'incident.manage':
    case 'audit.view':
      return kind === 'organization';
    case 'pass.request.self':
    case 'pass.override.request.self':
    case 'pass.depart.self':
      return kind === 'student';
    case 'pass.create.student':
    case 'pass.depart.student':
    case 'pass.override.request.student':
      return kind === 'student' || kind === 'student_in_section';
    case 'pass.approve.section':
    case 'pass.override.resolve.section':
      return kind === 'student_in_section';
    case 'pass.override.resolve.school':
      return kind === 'student';
    case 'pass.view.section_live':
      return kind === 'section';
    case 'destination.station.manage':
      return kind === 'destination';
    case 'destination.manage':
      return kind === 'organization' || kind === 'destination';
    case 'identity.manage':
    case 'system.manage':
      return kind === 'tenant';
    default:
      return false;
  }
}

interface LoadedActor {
  readonly memberships: readonly OrganizationMembershipFact[];
  readonly grants: readonly AuthorizationGrantFact[];
  readonly systemAdminGrantId: string | null;
}

function loadActor(
  memberships: readonly OrganizationMembershipFact[],
  grants: readonly AuthorizationGrantFact[],
  at: Temporal.Instant,
): LoadedActor {
  const effective = grants.filter((grant) => grantEffectiveAt(grant, at));
  const systemAdmin = effective.find(
    (grant) => grant.role === 'system_admin' && grant.scopeKind === 'tenant',
  );
  return {
    memberships,
    grants: effective,
    systemAdminGrantId: systemAdmin?.id ?? null,
  };
}

function activeAffiliations(
  actor: LoadedActor,
  organizationId: string,
  date: Temporal.PlainDate,
): readonly ('student' | 'staff' | 'other')[] {
  const affiliations = new Set<'student' | 'staff' | 'other'>();
  for (const membership of actor.memberships) {
    if (membership.organizationId !== organizationId) continue;
    if (membershipActiveOn(membership, date)) affiliations.add(membership.affiliation);
  }
  return [...affiliations].sort();
}

function isActiveStaffAt(
  actor: LoadedActor,
  organizationId: string,
  date: Temporal.PlainDate,
): boolean {
  return actor.memberships.some(
    (membership) =>
      membership.organizationId === organizationId &&
      membership.affiliation === 'staff' &&
      membershipActiveOn(membership, date),
  );
}

function hasStaffBackedGrant(
  actor: LoadedActor,
  role: ExplicitRole,
  organizationId: string,
  date: Temporal.PlainDate,
  destinationId?: string,
): AuthorizationGrantFact | null {
  for (const grant of actor.grants) {
    if (!isExplicitRole(grant.role) || grant.role !== role) continue;
    if (role === 'destination_staff') {
      if (grant.scopeKind !== 'destination' || grant.destinationId !== (destinationId ?? null))
        continue;
      // Staff membership is checked at the destination's school by the caller;
      // here we only verify the grant shape.
      return grant;
    }
    if (grant.scopeKind !== 'organization' || grant.organizationId !== organizationId) continue;
    if (!isActiveStaffAt(actor, organizationId, date)) continue;
    return grant;
  }
  return null;
}

/**
 * In-process typed evaluator backed by canonical PostgreSQL facts.
 * Deny-by-default: every path either returns an explicit allow basis or
 * falls through to deny. One tenant transaction per decision.
 */
export class RelationshipAuthorizationService {
  constructor(
    private readonly repository: AuthorizationFactsRepository,
    private readonly runner: TenantTransactionRunner,
  ) {}

  async decide<C extends Capability>(
    request: AuthorizationRequest<C>,
  ): Promise<AuthorizationDecision> {
    return this.runner.run(request.principal.tenantId, (context) =>
      this.decideWithContext(context, request),
    );
  }

  async isAllowed<C extends Capability>(request: AuthorizationRequest<C>): Promise<boolean> {
    return (await this.decide(request)).allowed;
  }

  async decideWithContext(
    context: TenantTransactionContext,
    request: AuthorizationRequest,
  ): Promise<AuthorizationDecision> {
    const { principal, capability, resource, at } = request;

    // 1. Capability/resource shape.
    if (!capabilityAllowsResourceKind(capability, resource.kind)) {
      return deny('capability_not_applicable');
    }

    // 2. Recovery-session hard restriction, evaluated before normal grants.
    if (principal.authenticationMethod === 'recovery') {
      if (!RECOVERY_ALLOWED.includes(capability)) return deny('recovery_session_restricted');
      if (capability === 'self.read') return { allowed: true, basis: { kind: 'self' } };
      // identity.manage in a recovery session still requires an effective
      // tenant system_admin grant; it never inherits operational powers.
      const grants = await this.repository.loadAccountGrants(context, principal.accountId);
      const admin = grants.find(
        (grant) =>
          grant.role === 'system_admin' &&
          grant.scopeKind === 'tenant' &&
          grantEffectiveAt(grant, at),
      );
      if (admin) return { allowed: true, basis: { kind: 'system_admin', grantId: admin.id } };
      return deny('no_applicable_grant');
    }

    // Self capabilities (OIDC): any authenticated principal may operate on
    // their own pass data; the pass command verifies exact pass ownership.
    // pass.request.self is intentionally absent here: requesting still
    // requires active student affiliation through Phase 4 below.
    // pass.progress.self is ownership-scoped the same way: finishing an
    // already-active movement never requires fresh school membership.
    if (
      capability === 'self.read' ||
      capability === 'pass.view.self' ||
      capability === 'pass.cancel.self' ||
      capability === 'pass.progress.self'
    ) {
      return { allowed: true, basis: { kind: 'self' } };
    }

    const memberships = await this.repository.listPersonMemberships(context, principal.personId);
    const grants = await this.repository.loadAccountGrants(context, principal.accountId);
    const actor = loadActor(memberships, grants, at);

    switch (resource.kind) {
      case 'tenant':
        return this.decideTenant(actor);
      case 'organization':
        return this.decideOrganization(context, actor, principal, capability, resource, at);
      case 'section':
        return this.decideSection(context, actor, principal, capability, resource, at);
      case 'student':
        return this.decideStudent(context, actor, principal, capability, resource, at);
      case 'student_in_section':
        return this.decideStudentInSection(context, actor, principal, capability, resource, at);
      case 'destination':
        return this.decideDestination(context, actor, principal, capability, resource, at);
      case 'self':
        return deny('capability_not_applicable');
      default:
        return deny('capability_not_applicable');
    }
  }

  /**
   * Snapshot for the user-context endpoints. Loads the fact set once and
   * evaluates capability mappings in memory using the same helpers as
   * enforcement, so hints and enforcement cannot drift.
   */
  async evaluateOrganizationSnapshot(
    context: TenantTransactionContext,
    principal: Principal,
    organizationId: string,
    at: Temporal.Instant,
  ): Promise<OrganizationAuthorizationSnapshot | null> {
    const organization = await this.repository.loadOrganization(context, organizationId);
    if (organization?.tenantId !== principal.tenantId) {
      return null;
    }
    if (
      organization.kind !== 'school' ||
      organization.status !== 'active' ||
      organization.timeZone === null ||
      !isUsableTimeZone(organization.timeZone)
    ) {
      return null;
    }
    const date = schoolDateFor(at, organization.timeZone);
    if (date === null) return null;

    const memberships = await this.repository.listPersonMemberships(context, principal.personId);
    const grants = await this.repository.loadAccountGrants(context, principal.accountId);
    const actor = loadActor(memberships, grants, at);
    const affiliations = activeAffiliations(actor, organizationId, date);
    const isActiveStudent = affiliations.includes('student');

    const orgCapabilities: Capability[] = [];
    const orgChecks: Capability[] = [
      'organization.context.read',
      'pass.view.school_live',
      'pass.view.school_history',
      'scheduled_authorization.manage',
      'destination.manage',
      'schedule.view',
      'schedule.manage',
      'people.view',
      'people.manage',
      'policy.manage',
      'authorization.manage',
      'integration.manage',
      'incident.view',
      'incident.manage',
      'audit.view',
    ];
    for (const capability of orgChecks) {
      const decision = await this.decideWithContext(context, {
        principal,
        capability,
        resource: { kind: 'organization', organizationId } satisfies OrganizationResource,
        at,
      });
      if (decision.allowed) orgCapabilities.push(capability);
    }
    // Org-level create is a staff-role mapping (counselor/office/school
    // admin, or tenant system_admin), not a synthetic target-student check.
    if (this.orgCreateAllowed(actor, organizationId, date)) {
      orgCapabilities.push('pass.create.student');
    }
    if (isActiveStudent) {
      // pass.request.self is evaluated for the principal themselves.
      const selfDecision = await this.decideWithContext(context, {
        principal,
        capability: 'pass.request.self',
        resource: { kind: 'student', organizationId, studentId: principal.personId },
        at,
      });
      if (selfDecision.allowed) orgCapabilities.push('pass.request.self');
      // pass.depart.self is a presentation hint only: it never implies a
      // currently ready pass, and departure reauthorizes current membership.
      const departDecision = await this.decideWithContext(context, {
        principal,
        capability: 'pass.depart.self',
        resource: { kind: 'student', organizationId, studentId: principal.personId },
        at,
      });
      if (departDecision.allowed) orgCapabilities.push('pass.depart.self');
    }

    // Candidate actual-teaching relationships (status-filtered); the local
    // date narrows to current ones so expired/inactive memberships never
    // surface as live capabilities.
    const teachingCandidates = await this.repository.listTeachingSections(
      context,
      principal.personId,
      organizationId,
    );
    const teachingWithCaps = [];
    for (const section of teachingCandidates) {
      const teacherMembership = await this.repository.checkSectionMembership(
        context,
        section.id,
        principal.personId,
        'teacher',
      );
      const current =
        teacherMembership !== null &&
        teacherMembership.status === 'active' &&
        (teacherMembership.startsOn === null ||
          Temporal.PlainDate.compare(teacherMembership.startsOn, date) <= 0) &&
        (teacherMembership.endsOn === null ||
          Temporal.PlainDate.compare(date, teacherMembership.endsOn) <= 0);
      if (current && isActiveStaffAt(actor, organizationId, date)) {
        teachingWithCaps.push({
          ...section,
          capabilities: [...SECTION_SCOPED_TEACHER_CAPS] as Capability[],
        });
      }
    }

    // Candidate explicit destination assignments; only grants effective at
    // the request instant combined with active staff membership count.
    const staffedCandidates = await this.repository.listStaffedDestinations(
      context,
      principal.accountId,
      principal.personId,
      organizationId,
    );
    const staffedWithCaps = staffedCandidates
      .filter(
        (destination) =>
          actor.grants.some(
            (grant) =>
              grant.role === 'destination_staff' &&
              grant.scopeKind === 'destination' &&
              grant.destinationId === destination.id,
          ) && isActiveStaffAt(actor, organizationId, date),
      )
      .map((destination) => ({
        ...destination,
        capabilities: ['destination.station.manage'] as Capability[],
      }));

    return {
      affiliations,
      capabilities: sortCapabilities(orgCapabilities),
      teachingSections: teachingWithCaps,
      staffedDestinations: staffedWithCaps,
      isActiveStudent,
    };
  }

  private orgCreateAllowed(
    actor: LoadedActor,
    organizationId: string,
    date: Temporal.PlainDate,
  ): boolean {
    if (actor.systemAdminGrantId !== null) return true;
    for (const role of ['counselor', 'office_staff', 'school_admin'] as const) {
      if (hasStaffBackedGrant(actor, role, organizationId, date) !== null) return true;
    }
    return false;
  }

  /**
   * Schools the principal may legitimately enter right now: current active
   * memberships (any affiliation) evaluated on each school's local date, or
   * all active schools for a tenant system_admin. Callers reject recovery
   * sessions before reaching this method.
   */
  async listAccessibleOrganizations(
    context: TenantTransactionContext,
    principal: Principal,
    at: Temporal.Instant,
  ): Promise<
    readonly {
      readonly id: string;
      readonly name: string;
      readonly slug: string;
      readonly timeZone: string;
      readonly affiliations: readonly ('student' | 'staff' | 'other')[];
    }[]
  > {
    const memberships = await this.repository.listPersonMemberships(context, principal.personId);
    const grants = await this.repository.loadAccountGrants(context, principal.accountId);
    const actor = loadActor(memberships, grants, at);
    const schools = await this.repository.listActiveSchools(context);
    const visible = [];
    for (const school of schools) {
      if (school.tenantId !== principal.tenantId) continue;
      if (school.timeZone === null || !isUsableTimeZone(school.timeZone)) continue;
      const date = schoolDateFor(at, school.timeZone);
      if (date === null) continue;
      const affiliations = activeAffiliations(actor, school.id, date);
      if (affiliations.length > 0 || actor.systemAdminGrantId !== null) {
        visible.push({
          id: school.id,
          name: school.name,
          slug: school.slug,
          timeZone: school.timeZone,
          affiliations,
        });
      }
    }
    visible.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return visible;
  }

  private decideTenant(actor: LoadedActor): AuthorizationDecision {
    if (actor.systemAdminGrantId !== null) {
      return { allowed: true, basis: { kind: 'system_admin', grantId: actor.systemAdminGrantId } };
    }
    return deny('no_applicable_grant');
  }

  private async decideOrganization(
    context: TenantTransactionContext,
    actor: LoadedActor,
    principal: Principal,
    capability: Capability,
    resource: OrganizationResource,
    at: Temporal.Instant,
  ): Promise<AuthorizationDecision> {
    const organization = await this.repository.loadOrganization(context, resource.organizationId);
    if (organization === null) return deny('resource_not_found');
    if (organization.tenantId !== principal.tenantId) return deny('tenant_mismatch');
    if (organization.kind !== 'school') return deny('organization_not_school');
    if (organization.status !== 'active') return deny('resource_inactive');
    if (organization.timeZone === null || !isUsableTimeZone(organization.timeZone)) {
      return deny('invalid_school_time_zone');
    }
    const date = schoolDateFor(at, organization.timeZone);
    if (date === null) return deny('invalid_school_time_zone');

    // Tenant system_admin operates across active schools in the tenant.
    if (
      actor.systemAdminGrantId !== null &&
      (SYSTEM_ADMIN_CAPABILITIES as readonly string[]).includes(capability)
    ) {
      return {
        allowed: true,
        basis: { kind: 'system_admin', grantId: actor.systemAdminGrantId },
      };
    }

    if (capability === 'organization.context.read') {
      const affiliations = activeAffiliations(actor, organization.id, date);
      if (affiliations.length > 0)
        return { allowed: true, basis: { kind: 'organization_membership' } };
      return deny('no_active_organization_membership');
    }

    // Org-level operational capabilities via explicit staff-backed grants.
    const roleFor = (role: ExplicitRole): AuthorizationDecision | null => {
      const grant = hasStaffBackedGrant(actor, role, organization.id, date);
      if (grant !== null && (ROLE_CAPABILITIES[role] as readonly string[]).includes(capability)) {
        const basis: AuthorizationBasis = {
          kind: 'explicit_grant',
          grantId: grant.id,
          role,
          scopeKind: 'organization',
          organizationId: organization.id,
          destinationId: null,
        };
        return { allowed: true, basis };
      }
      return null;
    };
    for (const role of ['counselor', 'office_staff', 'school_admin'] as const) {
      const decision = roleFor(role);
      if (decision !== null) return decision;
    }
    if (
      capability === 'pass.create.student' &&
      this.orgCreateAllowed(actor, organization.id, date)
    ) {
      return deny('no_applicable_grant');
    }
    return deny(
      capability === 'pass.create.student' ||
        capability === 'pass.view.school_live' ||
        capability === 'scheduled_authorization.manage'
        ? 'no_applicable_grant'
        : 'no_applicable_grant',
    );
  }

  private async decideSection(
    context: TenantTransactionContext,
    actor: LoadedActor,
    principal: Principal,
    capability: Capability,
    resource: SectionResource,
    at: Temporal.Instant,
  ): Promise<AuthorizationDecision> {
    const section = await this.repository.loadSection(context, resource.sectionId);
    if (section === null) return deny('resource_not_found');
    if (section.tenantId !== principal.tenantId) return deny('tenant_mismatch');
    const organization = await this.repository.loadOrganization(context, section.organizationId);
    if (organization === null) return deny('resource_not_found');
    if (organization.tenantId !== principal.tenantId) return deny('tenant_mismatch');
    if (organization.kind !== 'school') return deny('organization_not_school');
    if (organization.status !== 'active') return deny('resource_inactive');
    if (section.status !== 'active') return deny('resource_inactive');
    if (organization.timeZone === null || !isUsableTimeZone(organization.timeZone)) {
      return deny('invalid_school_time_zone');
    }
    const date = schoolDateFor(at, organization.timeZone);
    if (date === null) return deny('invalid_school_time_zone');

    if (
      actor.systemAdminGrantId !== null &&
      (SYSTEM_ADMIN_CAPABILITIES as readonly string[]).includes(capability)
    ) {
      return {
        allowed: true,
        basis: { kind: 'system_admin', grantId: actor.systemAdminGrantId },
      };
    }

    // School admin covers live sections at the exact school (staff-backed).
    const adminGrant = hasStaffBackedGrant(actor, 'school_admin', organization.id, date);
    if (adminGrant !== null) {
      return {
        allowed: true,
        basis: {
          kind: 'explicit_grant',
          grantId: adminGrant.id,
          role: 'school_admin',
          scopeKind: 'organization',
          organizationId: organization.id,
          destinationId: null,
        },
      };
    }

    // Teacher relationship: active staff + active teacher membership + active section.
    if (!isActiveStaffAt(actor, organization.id, date)) return deny('teacher_not_assigned');
    const teacherMembership = await this.repository.checkSectionMembership(
      context,
      section.id,
      principal.personId,
      'teacher',
    );
    if (teacherMembership === null) {
      return deny('teacher_not_assigned');
    }
    if (teacherMembership.status !== 'active') {
      return deny('teacher_not_assigned');
    }
    if (
      (teacherMembership.startsOn !== null &&
        Temporal.PlainDate.compare(teacherMembership.startsOn, date) > 0) ||
      (teacherMembership.endsOn !== null &&
        Temporal.PlainDate.compare(date, teacherMembership.endsOn) > 0)
    ) {
      return deny('teacher_not_assigned');
    }
    return { allowed: true, basis: { kind: 'teacher_section_relationship' } };
  }

  private async decideStudent(
    context: TenantTransactionContext,
    actor: LoadedActor,
    principal: Principal,
    capability: Capability,
    resource: StudentResource,
    at: Temporal.Instant,
  ): Promise<AuthorizationDecision> {
    const organization = await this.repository.loadOrganization(context, resource.organizationId);
    if (organization === null) return deny('resource_not_found');
    if (organization.tenantId !== principal.tenantId) return deny('tenant_mismatch');
    if (organization.kind !== 'school') return deny('organization_not_school');
    if (organization.status !== 'active') return deny('resource_inactive');
    if (organization.timeZone === null || !isUsableTimeZone(organization.timeZone)) {
      return deny('invalid_school_time_zone');
    }
    const date = schoolDateFor(at, organization.timeZone);
    if (date === null) return deny('invalid_school_time_zone');

    if (
      capability === 'pass.request.self' ||
      capability === 'pass.override.request.self' ||
      capability === 'pass.depart.self'
    ) {
      // Self semantics: target must be the principal; admin grants never fabricate it.
      // Override self-requests additionally require the current student
      // relationship; recovery sessions never reach here (restricted above).
      // Departure additionally requires active student membership in the
      // exact pass school at departure time.
      if (resource.studentId !== principal.personId) return deny('target_not_active_student');
      const affiliations = activeAffiliations(actor, organization.id, date);
      if (affiliations.includes('student')) {
        return { allowed: true, basis: { kind: 'student_membership' } };
      }
      return deny('target_not_active_student');
    }

    // pass.create.student on an org-level student target: the target must
    // hold an active student membership in that exact school.
    const targetMemberships = await this.repository.listPersonMemberships(
      context,
      resource.studentId,
    );
    const targetActive = targetMemberships.some(
      (membership) =>
        membership.organizationId === organization.id &&
        membership.affiliation === 'student' &&
        membershipActiveOn(membership, date),
    );
    if (!targetActive) return deny('target_not_active_student');

    if (
      actor.systemAdminGrantId !== null &&
      (SYSTEM_ADMIN_CAPABILITIES as readonly string[]).includes(capability)
    ) {
      return {
        allowed: true,
        basis: { kind: 'system_admin', grantId: actor.systemAdminGrantId },
      };
    }
    for (const role of ['counselor', 'office_staff', 'school_admin'] as const) {
      const grant = hasStaffBackedGrant(actor, role, organization.id, date);
      if (grant !== null && (ROLE_CAPABILITIES[role] as readonly string[]).includes(capability)) {
        return {
          allowed: true,
          basis: {
            kind: 'explicit_grant',
            grantId: grant.id,
            role,
            scopeKind: 'organization',
            organizationId: organization.id,
            destinationId: null,
          },
        };
      }
    }
    return deny('no_applicable_grant');
  }

  private async decideStudentInSection(
    context: TenantTransactionContext,
    actor: LoadedActor,
    principal: Principal,
    capability: Capability,
    resource: StudentInSectionResource,
    at: Temporal.Instant,
  ): Promise<AuthorizationDecision> {
    const section = await this.repository.loadSection(context, resource.sectionId);
    if (section === null) return deny('resource_not_found');
    if (section.tenantId !== principal.tenantId) return deny('tenant_mismatch');
    const organization = await this.repository.loadOrganization(context, section.organizationId);
    if (organization === null) return deny('resource_not_found');
    if (organization.tenantId !== principal.tenantId) return deny('tenant_mismatch');
    if (organization.kind !== 'school') return deny('organization_not_school');
    if (organization.status !== 'active' || section.status !== 'active') {
      return deny('resource_inactive');
    }
    if (organization.timeZone === null || !isUsableTimeZone(organization.timeZone)) {
      return deny('invalid_school_time_zone');
    }
    const date = schoolDateFor(at, organization.timeZone);
    if (date === null) return deny('invalid_school_time_zone');

    // Target must first hold an active student school membership in the
    // section's canonical school: a section relationship never resurrects
    // authority over someone no longer an active student there. Membership
    // dates stay inclusive on the school-local date; grant instants are a
    // separate half-open concept evaluated elsewhere.
    const targetSchoolMemberships = await this.repository.listPersonMemberships(
      context,
      resource.studentId,
    );
    const targetActiveStudent = targetSchoolMemberships.some(
      (targetMembership) =>
        targetMembership.organizationId === organization.id &&
        targetMembership.affiliation === 'student' &&
        membershipActiveOn(targetMembership, date),
    );
    if (!targetActiveStudent) return deny('target_not_active_student');

    // Then the target must hold an active student section membership here.
    const targetSection = await this.repository.checkSectionMembership(
      context,
      section.id,
      resource.studentId,
      'student',
    );
    const targetInSection =
      targetSection !== null &&
      targetSection.status === 'active' &&
      (targetSection.startsOn === null ||
        Temporal.PlainDate.compare(targetSection.startsOn, date) <= 0) &&
      (targetSection.endsOn === null ||
        Temporal.PlainDate.compare(date, targetSection.endsOn) <= 0);
    if (!targetInSection) return deny('target_not_in_section');

    if (
      actor.systemAdminGrantId !== null &&
      (SYSTEM_ADMIN_CAPABILITIES as readonly string[]).includes(capability)
    ) {
      return {
        allowed: true,
        basis: { kind: 'system_admin', grantId: actor.systemAdminGrantId },
      };
    }

    // School admin at the exact school covers section operations.
    const adminGrant = hasStaffBackedGrant(actor, 'school_admin', organization.id, date);
    if (
      adminGrant !== null &&
      (ROLE_CAPABILITIES.school_admin as readonly string[]).includes(capability)
    ) {
      return {
        allowed: true,
        basis: {
          kind: 'explicit_grant',
          grantId: adminGrant.id,
          role: 'school_admin',
          scopeKind: 'organization',
          organizationId: organization.id,
          destinationId: null,
        },
      };
    }

    // Counselor/office may create for students in the school (section target),
    // may depart them, and may request overrides there; override resolution
    // stays school-tier.
    if (
      capability === 'pass.create.student' ||
      capability === 'pass.depart.student' ||
      capability === 'pass.override.request.student'
    ) {
      for (const role of ['counselor', 'office_staff'] as const) {
        const grant = hasStaffBackedGrant(actor, role, organization.id, date);
        if (grant !== null) {
          return {
            allowed: true,
            basis: {
              kind: 'explicit_grant',
              grantId: grant.id,
              role,
              scopeKind: 'organization',
              organizationId: organization.id,
              destinationId: null,
            },
          };
        }
      }
    }

    // Teacher relationship in this exact section.
    if (!isActiveStaffAt(actor, organization.id, date)) return deny('teacher_not_assigned');
    const teacherMembership = await this.repository.checkSectionMembership(
      context,
      section.id,
      principal.personId,
      'teacher',
    );
    const teacherActive =
      teacherMembership !== null &&
      teacherMembership.status === 'active' &&
      (teacherMembership.startsOn === null ||
        Temporal.PlainDate.compare(teacherMembership.startsOn, date) <= 0) &&
      (teacherMembership.endsOn === null ||
        Temporal.PlainDate.compare(date, teacherMembership.endsOn) <= 0);
    if (!teacherActive) {
      return deny(
        capability === 'pass.approve.section' ||
          capability === 'pass.create.student' ||
          capability === 'pass.depart.student' ||
          capability === 'pass.override.request.student' ||
          capability === 'pass.override.resolve.section'
          ? 'teacher_not_assigned'
          : 'no_applicable_grant',
      );
    }
    return { allowed: true, basis: { kind: 'teacher_section_relationship' } };
  }

  private async decideDestination(
    context: TenantTransactionContext,
    actor: LoadedActor,
    principal: Principal,
    capability: Capability,
    resource: DestinationResource,
    at: Temporal.Instant,
  ): Promise<AuthorizationDecision> {
    const destination = await this.repository.loadDestination(context, resource.destinationId);
    if (destination === null) return deny('resource_not_found');
    if (destination.tenantId !== principal.tenantId) return deny('tenant_mismatch');
    const organization = await this.repository.loadOrganization(
      context,
      destination.organizationId,
    );
    if (organization === null) return deny('resource_not_found');
    if (organization.tenantId !== principal.tenantId) return deny('tenant_mismatch');
    if (organization.kind !== 'school') return deny('organization_not_school');
    if (organization.status !== 'active') return deny('resource_inactive');
    if (destination.status === 'archived') return deny('resource_inactive');
    if (organization.timeZone === null || !isUsableTimeZone(organization.timeZone)) {
      return deny('invalid_school_time_zone');
    }
    const date = schoolDateFor(at, organization.timeZone);
    if (date === null) return deny('invalid_school_time_zone');

    if (capability === 'destination.manage') {
      // destination.manage on a destination resource: school/system admin only.
      if (actor.systemAdminGrantId !== null) {
        return {
          allowed: true,
          basis: { kind: 'system_admin', grantId: actor.systemAdminGrantId },
        };
      }
      const adminGrant = hasStaffBackedGrant(actor, 'school_admin', organization.id, date);
      if (adminGrant !== null) {
        return {
          allowed: true,
          basis: {
            kind: 'explicit_grant',
            grantId: adminGrant.id,
            role: 'school_admin',
            scopeKind: 'organization',
            organizationId: organization.id,
            destinationId: null,
          },
        };
      }
      return deny('no_applicable_grant');
    }

    // destination.station.manage: exact destination assignment + staff membership.
    if (actor.systemAdminGrantId !== null) {
      return {
        allowed: true,
        basis: { kind: 'system_admin', grantId: actor.systemAdminGrantId },
      };
    }
    const adminGrant = hasStaffBackedGrant(actor, 'school_admin', organization.id, date);
    if (adminGrant !== null) {
      return {
        allowed: true,
        basis: {
          kind: 'explicit_grant',
          grantId: adminGrant.id,
          role: 'school_admin',
          scopeKind: 'organization',
          organizationId: organization.id,
          destinationId: null,
        },
      };
    }
    const staffGrant = actor.grants.find(
      (grant) =>
        grant.role === 'destination_staff' &&
        grant.scopeKind === 'destination' &&
        grant.destinationId === destination.id,
    );
    if (staffGrant === undefined) return deny('no_applicable_grant');
    if (!isActiveStaffAt(actor, organization.id, date)) return deny('staff_membership_required');
    return {
      allowed: true,
      basis: {
        kind: 'explicit_grant',
        grantId: staffGrant.id,
        role: 'destination_staff',
        scopeKind: 'destination',
        organizationId: null,
        destinationId: destination.id,
      },
    };
  }
}

export type { Clock };
export type { TenantTransactionRunner };
