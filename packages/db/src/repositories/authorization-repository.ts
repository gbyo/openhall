import { postgresDateToPlainDate } from '../temporal-types.js';
import { connectionFor, fromDatabaseInstant } from '../transactions.js';
import type {
  AuthorizationRoomRecord,
  AuthorizationFactsRepository,
  AuthorizationGrantFact,
  AuthorizationOrganizationRecord,
  AuthorizationSectionRecord,
  OrganizationMembershipFact,
  RoomTeacherFact,
  SectionMembershipFact,
  StaffedRoomFact,
  TeachingSectionFact,
} from '@openhall/application';
import type { RoomId, OrganizationId, PersonId, SectionId } from '@openhall/domain';
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

  async loadRoom(
    context: TenantTransactionContext,
    roomId: RoomId,
  ): Promise<AuthorizationRoomRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('room')
      .select(['id', 'tenant_id', 'organization_id', 'status', 'name'])
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', roomId)
      .executeTakeFirst();
    if (row === undefined) return null;
    const status =
      row.status === 'closed' ? 'closed' : row.status === 'archived' ? 'archived' : 'open';
    return {
      id: row.id,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      status,
      name: row.name,
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
        'room_id',
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
      roomId: row.room_id,
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

  async listStaffedRooms(
    context: TenantTransactionContext,
    accountId: string,
    personId: PersonId,
    organizationId: OrganizationId,
  ): Promise<readonly StaffedRoomFact[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('authorization_grant as grant')
      .innerJoin('room', (join) =>
        join.onRef('room.tenant_id', '=', 'grant.tenant_id').onRef('room.id', '=', 'grant.room_id'),
      )
      .innerJoin('organization_membership as staff_membership', (join) =>
        join
          .onRef('staff_membership.tenant_id', '=', 'grant.tenant_id')
          .onRef('staff_membership.organization_id', '=', 'room.organization_id'),
      )
      .select(['room.id', 'room.name'])
      .where('grant.tenant_id', '=', context.tenantId)
      .where('grant.account_id', '=', accountId)
      .where('grant.role', '=', 'room_staff')
      .where('grant.scope_kind', '=', 'room')
      .where('grant.status', '=', 'active')
      .where('staff_membership.person_id', '=', personId)
      .where('staff_membership.affiliation', '=', 'staff')
      .where('staff_membership.status', '=', 'active')
      .where('room.organization_id', '=', organizationId)
      .where('room.status', '!=', 'archived')
      .orderBy('room.name')
      .orderBy('room.id')
      .execute();
    const seen = new Map<string, StaffedRoomFact>();
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.set(row.id, { id: row.id, name: row.name });
      }
    }
    return [...seen.values()];
  }

  async listTeachingMeetingRooms(
    context: TenantTransactionContext,
    personId: PersonId,
    organizationId: OrganizationId,
  ): Promise<readonly RoomId[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('section_membership as membership')
      .innerJoin('section as section_row', (join) =>
        join
          .onRef('section_row.tenant_id', '=', 'membership.tenant_id')
          .onRef('section_row.id', '=', 'membership.section_id'),
      )
      .innerJoin('section_meeting as meeting', (join) =>
        join
          .onRef('meeting.tenant_id', '=', 'section_row.tenant_id')
          .onRef('meeting.organization_id', '=', 'section_row.organization_id')
          .onRef('meeting.section_id', '=', 'section_row.id'),
      )
      .innerJoin('organization_membership as staff_membership', (join) =>
        join
          .onRef('staff_membership.tenant_id', '=', 'membership.tenant_id')
          .onRef('staff_membership.organization_id', '=', 'section_row.organization_id')
          .onRef('staff_membership.person_id', '=', 'membership.person_id'),
      )
      .select('meeting.room_id')
      .distinct()
      .where('membership.tenant_id', '=', context.tenantId)
      .where('membership.person_id', '=', personId)
      .where('membership.role', '=', 'teacher')
      .where('membership.status', '=', 'active')
      .where('staff_membership.affiliation', '=', 'staff')
      .where('staff_membership.status', '=', 'active')
      .where('section_row.organization_id', '=', organizationId)
      .where('meeting.organization_id', '=', organizationId)
      .where('section_row.status', '=', 'active')
      .where('meeting.room_id', 'is not', null)
      .execute();
    // IS NOT NULL narrows rows at runtime; the guard below narrows the type.
    return rows.map((row) => row.room_id).filter((roomId): roomId is RoomId => roomId !== null);
  }

  async listRoomTeachers(
    context: TenantTransactionContext,
    organizationId: OrganizationId,
    roomId: RoomId,
  ): Promise<readonly RoomTeacherFact[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('section_membership as membership')
      .innerJoin('section as section_row', (join) =>
        join
          .onRef('section_row.tenant_id', '=', 'membership.tenant_id')
          .onRef('section_row.id', '=', 'membership.section_id'),
      )
      .innerJoin('section_meeting as meeting', (join) =>
        join
          .onRef('meeting.tenant_id', '=', 'section_row.tenant_id')
          .onRef('meeting.organization_id', '=', 'section_row.organization_id')
          .onRef('meeting.section_id', '=', 'section_row.id'),
      )
      .select([
        'membership.person_id',
        'membership.section_id',
        'membership.status',
        'membership.starts_on',
        'membership.ends_on',
        'meeting.effective_from',
        'meeting.effective_until',
      ])
      .where('membership.tenant_id', '=', context.tenantId)
      .where('section_row.organization_id', '=', organizationId)
      .where('meeting.organization_id', '=', organizationId)
      .where('meeting.room_id', '=', roomId)
      .where('membership.role', '=', 'teacher')
      .where('membership.status', '=', 'active')
      .where('section_row.status', '=', 'active')
      .execute();
    // One row per (teacher, section, meeting window); the caller dedupes by
    // person after applying date windows on the school local date.
    return rows.map((row) => ({
      personId: row.person_id,
      sectionId: row.section_id,
      membershipStatus: row.status === 'active' ? 'active' : 'inactive',
      startsOn: row.starts_on === null ? null : postgresDateToPlainDate(row.starts_on),
      endsOn: row.ends_on === null ? null : postgresDateToPlainDate(row.ends_on),
      meetingEffectiveFrom:
        row.effective_from === null ? null : postgresDateToPlainDate(row.effective_from),
      meetingEffectiveUntil:
        row.effective_until === null ? null : postgresDateToPlainDate(row.effective_until),
    }));
  }
}
