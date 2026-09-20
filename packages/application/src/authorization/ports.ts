import type { Temporal } from '@js-temporal/polyfill';
import type { DestinationId, OrganizationId, PersonId, SectionId } from '@openhall/domain';
import type { TenantTransactionContext } from '../persistence.js';

export interface AuthorizationOrganizationRecord {
  readonly id: OrganizationId;
  readonly tenantId: string;
  readonly kind: 'district' | 'school';
  readonly status: 'active' | 'archived';
  readonly timeZone: string | null;
  readonly name: string;
  readonly slug: string;
}

export interface AuthorizationSectionRecord {
  readonly id: SectionId;
  readonly tenantId: string;
  readonly organizationId: OrganizationId;
  readonly status: 'planned' | 'active' | 'completed' | 'archived';
  readonly code: string | null;
  readonly title: string;
}

export interface AuthorizationDestinationRecord {
  readonly id: DestinationId;
  readonly tenantId: string;
  readonly organizationId: OrganizationId;
  readonly status: 'active' | 'closed' | 'archived';
  readonly displayName: string | null;
  readonly serviceType: string;
  readonly locationName: string | null;
}

export interface OrganizationMembershipFact {
  readonly organizationId: OrganizationId;
  readonly affiliation: 'student' | 'staff' | 'other';
  readonly status: 'active' | 'inactive';
  readonly validFrom: Temporal.PlainDate | null;
  readonly validUntil: Temporal.PlainDate | null;
}

export interface SectionMembershipFact {
  readonly sectionId: SectionId;
  readonly personId: PersonId;
  readonly role: 'student' | 'teacher';
  readonly status: 'active' | 'inactive';
  readonly startsOn: Temporal.PlainDate | null;
  readonly endsOn: Temporal.PlainDate | null;
}

export interface AuthorizationGrantFact {
  readonly id: string;
  readonly role: string;
  readonly scopeKind: string;
  readonly organizationId: OrganizationId | null;
  readonly destinationId: DestinationId | null;
  readonly status: 'active' | 'revoked';
  readonly validFrom: Temporal.Instant | null;
  readonly validUntil: Temporal.Instant | null;
}

export interface TeachingSectionFact {
  readonly id: SectionId;
  readonly code: string | null;
  readonly title: string;
}

export interface StaffedDestinationFact {
  readonly id: DestinationId;
  readonly displayName: string;
  readonly serviceType: string;
}

/**
 * Purpose-built authorization fact port. Methods return typed records, never
 * generic Kysely rows. Implementations scope every query to the transaction
 * tenant; there is no generic query() escape hatch.
 */
export interface AuthorizationFactsRepository {
  loadOrganization(
    context: TenantTransactionContext,
    organizationId: OrganizationId,
  ): Promise<AuthorizationOrganizationRecord | null>;

  loadSection(
    context: TenantTransactionContext,
    sectionId: SectionId,
  ): Promise<AuthorizationSectionRecord | null>;

  loadDestination(
    context: TenantTransactionContext,
    destinationId: DestinationId,
  ): Promise<AuthorizationDestinationRecord | null>;

  /** All organization membership rows (any status) for one person. */
  listPersonMemberships(
    context: TenantTransactionContext,
    personId: PersonId,
  ): Promise<readonly OrganizationMembershipFact[]>;

  checkSectionMembership(
    context: TenantTransactionContext,
    sectionId: SectionId,
    personId: PersonId,
    role: 'student' | 'teacher',
  ): Promise<SectionMembershipFact | null>;

  /** Active-status grant rows for one account; time validity is evaluated in memory. */
  loadAccountGrants(
    context: TenantTransactionContext,
    accountId: string,
  ): Promise<readonly AuthorizationGrantFact[]>;

  /** Active schools in this tenant (for system_admin organization listing). */
  listActiveSchools(
    context: TenantTransactionContext,
  ): Promise<readonly AuthorizationOrganizationRecord[]>;

  /**
   * Candidate teaching sections in one school (active staff membership +
   * active teacher membership + active section). Date validity is applied
   * by the caller on the school local date.
   */
  listTeachingSections(
    context: TenantTransactionContext,
    personId: PersonId,
    organizationId: OrganizationId,
  ): Promise<readonly TeachingSectionFact[]>;

  /** Explicit destination assignments in one school with active staff membership. */
  listStaffedDestinations(
    context: TenantTransactionContext,
    accountId: string,
    personId: PersonId,
    organizationId: OrganizationId,
  ): Promise<readonly StaffedDestinationFact[]>;
}
