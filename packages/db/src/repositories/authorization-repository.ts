import { postgresDateToPlainDate } from '../temporal-types.js';
import { connectionFor, fromDatabaseInstant } from '../transactions.js';
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
} from '@openhall/application';
import type { DestinationId, OrganizationId, PersonId, SectionId } from '@openhall/domain';
import type { TenantTransactionContext } from '@openhall/application';

/**
 * PostgreSQL authorization facts. Every query resolves its connection from
 * the tenant transaction context and scopes by that context's tenant; there
 * is no SystemDatabaseAccess or unscoped use here.
 */
export class PostgresAuthorizationRepository implements AuthorizationFactsRepository {
  async loadOrganization(
    context: TenantTransactionContext,
    organizationId: OrganizationId,
  ): Promise<AuthorizationOrganizationRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('organization')
      .select(['id', 'tenant_id', 'kind', 'status', 'time_zone', 'name', 'slug'])
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', organizationId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      kind: row.kind === 'school' ? 'school' : 'district',
      status: row.status === 'archived' ? 'archived' : 'active',
      timeZone: row.time_zone,
      name: row.name,
      slug: row.slug,
    };
  }

  async loadSection(
    context: TenantTransactionContext,
    sectionId: SectionId,
  ): Promise<AuthorizationSectionRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('section')
      .select(['id', 'tenant_id', 'organization_id', 'status', 'code', 'title'])
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', sectionId)
      .executeTakeFirst();
    if (row === undefined) return null;
    const status =
      row.status === 'active'
        ? 'active'
        : row.status === 'planned'
          ? 'planned'
          : row.status === 'completed'
            ? 'completed'
            : 'archived';
    return {
      id: row.id,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      status,
      code: row.code,
      title: row.title,
    };
  }

  async loadDestination(
    context: TenantTransactionContext,
    destinationId: DestinationId,
  ): Promise<AuthorizationDestinationRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('destination')
      .leftJoin('location', (join) =>
        join
          .onRef('location.tenant_id', '=', 'destination.tenant_id')
          .onRef('location.organization_id', '=', 'destination.organization_id')
          .onRef('location.id', '=', 'destination.location_id'),
      )
      .select([
        'destination.id',
        'destination.tenant_id',
        'destination.organization_id',
        'destination.status',
        'destination.display_name',
        'destination.service_type',
        'location.name as location_name',
      ])
      .where('destination.tenant_id', '=', context.tenantId)
      .where('destination.id', '=', destinationId)
      .executeTakeFirst();
    if (row === undefined) return null;
    const status =
      row.status === 'closed' ? 'closed' : row.status === 'archived' ? 'archived' : 'active';
    return {
      id: row.id,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      status,
      displayName: row.display_name,
      serviceType: row.service_type,
      locationName: row.location_name,
    };
  }

  async listPersonMemberships(
    context: TenantTransactionContext,
    personId: PersonId,
  ): Promise<readonly OrganizationMembershipFact[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('organization_membership')
      .select(['organization_id', 'affiliation', 'status', 'valid_from', 'valid_until'])
      .where('tenant_id', '=', context.tenantId)
      .where('person_id', '=', personId)
      .execute();
    return rows.map((row) => ({
      organizationId: row.organization_id,
      affiliation:
        row.affiliation === 'staff' ? 'staff' : row.affiliation === 'other' ? 'other' : 'student',
      status: row.status === 'inactive' ? 'inactive' : 'active',
      validFrom: row.valid_from === null ? null : postgresDateToPlainDate(row.valid_from),
      validUntil: row.valid_until === null ? null : postgresDateToPlainDate(row.valid_until),
    }));
  }

  async checkSectionMembership(
    context: TenantTransactionContext,
    sectionId: SectionId,
    personId: PersonId,
    role: 'student' | 'teacher',
  ): Promise<SectionMembershipFact | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('section_membership')
      .select(['section_id', 'person_id', 'role', 'status', 'starts_on', 'ends_on'])
      .where('tenant_id', '=', context.tenantId)
      .where('section_id', '=', sectionId)
      .where('person_id', '=', personId)
      .where('role', '=', role)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      sectionId: row.section_id,
      personId: row.person_id,
      role: row.role === 'teacher' ? 'teacher' : 'student',
      status: row.status === 'inactive' ? 'inactive' : 'active',
      startsOn: row.starts_on === null ? null : postgresDateToPlainDate(row.starts_on),
      endsOn: row.ends_on === null ? null : postgresDateToPlainDate(row.ends_on),
    };
  }

  async loadAccountGrants(
    context: TenantTransactionContext,
    accountId: string,
  ): Promise<readonly AuthorizationGrantFact[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('authorization_grant')
      .select([
        'id',
        'role',
        'scope_kind',
        'organization_id',
        'destination_id',
        'status',
        'valid_from',
        'valid_until',
      ])
      .where('tenant_id', '=', context.tenantId)
      .where('account_id', '=', accountId)
      .where('status', '=', 'active')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      scopeKind: row.scope_kind,
      organizationId: row.organization_id,
      destinationId: row.destination_id,
      status: 'active' as const,
      validFrom: row.valid_from === null ? null : fromDatabaseInstant(row.valid_from),
      validUntil: row.valid_until === null ? null : fromDatabaseInstant(row.valid_until),
    }));
  }

  async listActiveSchools(
    context: TenantTransactionContext,
  ): Promise<readonly AuthorizationOrganizationRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('organization')
      .select(['id', 'tenant_id', 'kind', 'status', 'time_zone', 'name', 'slug'])
      .where('tenant_id', '=', context.tenantId)
      .where('kind', '=', 'school')
      .where('status', '=', 'active')
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      kind: 'school' as const,
      status: 'active' as const,
      timeZone: row.time_zone,
      name: row.name,
      slug: row.slug,
    }));
  }

  async listTeachingSections(
    context: TenantTransactionContext,
    personId: PersonId,
    organizationId: OrganizationId,
  ): Promise<readonly TeachingSectionFact[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('section_membership as teacher_membership')
      .innerJoin('section', (join) =>
        join
          .onRef('section.tenant_id', '=', 'teacher_membership.tenant_id')
          .onRef('section.id', '=', 'teacher_membership.section_id'),
      )
      .innerJoin('organization_membership as staff_membership', (join) =>
        join
          .onRef('staff_membership.tenant_id', '=', 'teacher_membership.tenant_id')
          .onRef('staff_membership.organization_id', '=', 'section.organization_id')
          .onRef('staff_membership.person_id', '=', 'teacher_membership.person_id'),
      )
      .select(['section.id', 'section.code', 'section.title'])
      .where('teacher_membership.tenant_id', '=', context.tenantId)
      .where('teacher_membership.person_id', '=', personId)
      .where('teacher_membership.role', '=', 'teacher')
      .where('teacher_membership.status', '=', 'active')
      .where('staff_membership.affiliation', '=', 'staff')
      .where('staff_membership.status', '=', 'active')
      .where('section.organization_id', '=', organizationId)
      .where('section.status', '=', 'active')
      .orderBy('section.title')
      .orderBy('section.id')
      .execute();
    return rows.map((row) => ({ id: row.id, code: row.code, title: row.title }));
  }

  async listStaffedDestinations(
    context: TenantTransactionContext,
    accountId: string,
    personId: PersonId,
    organizationId: OrganizationId,
  ): Promise<readonly StaffedDestinationFact[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('authorization_grant as grant')
      .innerJoin('destination', (join) =>
        join
          .onRef('destination.tenant_id', '=', 'grant.tenant_id')
          .onRef('destination.id', '=', 'grant.destination_id'),
      )
      .leftJoin('location', (join) =>
        join
          .onRef('location.tenant_id', '=', 'destination.tenant_id')
          .onRef('location.organization_id', '=', 'destination.organization_id')
          .onRef('location.id', '=', 'destination.location_id'),
      )
      .innerJoin('organization_membership as staff_membership', (join) =>
        join
          .onRef('staff_membership.tenant_id', '=', 'grant.tenant_id')
          .onRef('staff_membership.organization_id', '=', 'destination.organization_id'),
      )
      .select([
        'destination.id',
        'destination.display_name',
        'destination.service_type',
        'location.name as location_name',
      ])
      .where('grant.tenant_id', '=', context.tenantId)
      .where('grant.account_id', '=', accountId)
      .where('grant.role', '=', 'destination_staff')
      .where('grant.scope_kind', '=', 'destination')
      .where('grant.status', '=', 'active')
      .where('staff_membership.person_id', '=', personId)
      .where('staff_membership.affiliation', '=', 'staff')
      .where('staff_membership.status', '=', 'active')
      .where('destination.organization_id', '=', organizationId)
      .where('destination.status', '!=', 'archived')
      .orderBy('destination.service_type')
      .orderBy('destination.id')
      .execute();
    const seen = new Map<string, StaffedDestinationFact>();
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.set(row.id, {
          id: row.id,
          displayName: row.display_name ?? row.location_name ?? row.service_type,
          serviceType: row.service_type,
        });
      }
    }
    return [...seen.values()];
  }
}
