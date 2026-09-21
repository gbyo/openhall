import type {
  OperationalLivePassRow,
  OperationalReadRepository,
  OperationalSectionRecord,
  OperationalStudentRow,
  TenantTransactionContext,
} from '@openhall/application';
import { connectionFor, fromDatabaseInstant, toBigInt } from '../transactions.js';

const LIVE_STATES = [
  'requested',
  'queued',
  'ready',
  'outbound',
  'at_destination',
  'returning',
] as const;

/** PostgreSQL implementation of minimized live movement and roster reads. */
export class PostgresOperationalReadRepository implements OperationalReadRepository {
  async loadSection(
    context: TenantTransactionContext,
    sectionId: string,
  ): Promise<OperationalSectionRecord | null> {
    const row = await connectionFor(context)
      .selectFrom('section')
      .innerJoin('organization', (join) =>
        join
          .onRef('organization.tenant_id', '=', 'section.tenant_id')
          .onRef('organization.id', '=', 'section.organization_id'),
      )
      .select(['section.id', 'section.organization_id', 'organization.time_zone'])
      .where('section.tenant_id', '=', context.tenantId)
      .where('section.id', '=', sectionId)
      .where('section.status', '=', 'active')
      .executeTakeFirst();
    if (!row?.time_zone) return null;
    return { id: row.id, organizationId: row.organization_id, timeZone: row.time_zone };
  }

  async listActiveSectionStudents(
    context: TenantTransactionContext,
    sectionId: string,
    onDate: string,
  ): Promise<readonly OperationalStudentRow[]> {
    const rows = await connectionFor(context)
      .selectFrom('section_membership')
      .innerJoin('person', (join) =>
        join
          .onRef('person.tenant_id', '=', 'section_membership.tenant_id')
          .onRef('person.id', '=', 'section_membership.person_id'),
      )
      .select(['person.id', 'person.display_name'])
      .where('section_membership.tenant_id', '=', context.tenantId)
      .where('section_membership.section_id', '=', sectionId)
      .where('section_membership.role', '=', 'student')
      .where('section_membership.status', '=', 'active')
      .where('person.status', '=', 'active')
      .where((eb) =>
        eb.or([
          eb('section_membership.starts_on', 'is', null),
          eb('section_membership.starts_on', '<=', onDate),
        ]),
      )
      .where((eb) =>
        eb.or([
          eb('section_membership.ends_on', 'is', null),
          eb('section_membership.ends_on', '>=', onDate),
        ]),
      )
      .orderBy('person.display_name')
      .orderBy('person.id')
      .execute();
    return rows.map((row) => ({ id: row.id, displayName: row.display_name }));
  }

  async listLiveBySection(
    context: TenantTransactionContext,
    sectionId: string,
  ): Promise<readonly OperationalLivePassRow[]> {
    return this.listLive(context, { sectionId });
  }

  async listLiveByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly OperationalLivePassRow[]> {
    return this.listLive(context, { organizationId });
  }

  private async listLive(
    context: TenantTransactionContext,
    scope: { readonly sectionId: string } | { readonly organizationId: string },
  ): Promise<readonly OperationalLivePassRow[]> {
    let query = connectionFor(context)
      .selectFrom('pass')
      .innerJoin('person', (join) =>
        join
          .onRef('person.tenant_id', '=', 'pass.tenant_id')
          .onRef('person.id', '=', 'pass.student_id'),
      )
      .innerJoin('destination', (join) =>
        join
          .onRef('destination.tenant_id', '=', 'pass.tenant_id')
          .onRef('destination.id', '=', 'pass.destination_id'),
      )
      .leftJoin('destination_reservation', (join) =>
        join
          .onRef('destination_reservation.tenant_id', '=', 'pass.tenant_id')
          .onRef('destination_reservation.pass_id', '=', 'pass.id')
          .on('destination_reservation.released_at', 'is', null),
      )
      .select([
        'pass.id as pass_id',
        'pass.revision as pass_revision',
        'pass.student_id as student_id',
        'person.display_name as student_display_name',
        'pass.destination_id as destination_id',
        'destination.display_name as destination_display_name',
        'destination.service_type as destination_service_type',
        'pass.lifecycle_state as lifecycle_state',
        'pass.requested_at as requested_at',
        'destination_reservation.ready_expires_at as ready_until',
        'pass.expected_return_at as expected_return_at',
        'pass.origin_section_id as origin_section_id',
      ])
      .where('pass.tenant_id', '=', context.tenantId)
      .where('pass.lifecycle_state', 'in', [...LIVE_STATES]);
    query =
      'sectionId' in scope
        ? query.where('pass.origin_section_id', '=', scope.sectionId)
        : query.where('pass.organization_id', '=', scope.organizationId);
    const rows = await query.orderBy('pass.requested_at').orderBy('pass.id').execute();
    return rows.map((row) => ({
      passId: row.pass_id,
      passRevision: toBigInt(row.pass_revision),
      studentId: row.student_id,
      studentDisplayName: row.student_display_name,
      destinationId: row.destination_id,
      destinationDisplayName: row.destination_display_name ?? row.destination_service_type,
      destinationServiceType: row.destination_service_type,
      lifecycleState: row.lifecycle_state as OperationalLivePassRow['lifecycleState'],
      requestedAt: fromDatabaseInstant(row.requested_at),
      readyUntil: row.ready_until === null ? null : fromDatabaseInstant(row.ready_until),
      expectedReturnAt:
        row.expected_return_at === null ? null : fromDatabaseInstant(row.expected_return_at),
      originSectionId: row.origin_section_id,
    }));
  }
}
