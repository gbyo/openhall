import type { Temporal } from '@js-temporal/polyfill';
import type {
  ActiveStudentRecord,
  NewPassRow,
  PassDestinationRecord,
  PassEventInput,
  PassRepository,
  PassRow,
} from '@openhall/application';
import type { TenantTransactionContext } from '@openhall/application';
import type { DestinationId, OrganizationId, PassId, PersonId } from '@openhall/domain';
import {
  connectionFor,
  fromDatabaseInstant,
  toBigInt,
  toDatabaseInstant,
} from '../transactions.js';

const ACTIVE_STATES = ['requested', 'queued', 'ready', 'outbound', 'at_destination', 'returning'];

function parseCheckInMode(value: string | null): 'none' | 'optional' | 'required' | null {
  if (value === null) return null;
  return value === 'optional' ? 'optional' : value === 'required' ? 'required' : 'none';
}

interface PassCore {
  id: string;
  tenant_id: string;
  organization_id: string;
  student_id: string;
  origin_location_id: string | null;
  origin_section_id: string | null;
  origin_schedule_block_id: string | null;
  destination_id: string;
  return_location_id: string | null;
  request_source: string;
  requested_by_person_id: string | null;
  requested_at: string;
  lifecycle_state: string;
  expected_return_at: string | null;
  scheduled_authorization_id: string | null;
  revision: string | bigint | number;
  departure_check_in_mode: string | null;
  departure_destination_revision: string | bigint | number | null;
}

/**
 * PostgreSQL pass persistence. Every method resolves its connection from
 * the tenant transaction context and scopes by that context's tenant; there
 * is no unscoped path in pass operations.
 */
export class PostgresPassRepository implements PassRepository {
  async loadDestination(
    context: TenantTransactionContext,
    destinationId: DestinationId,
  ): Promise<PassDestinationRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('destination')
      .select([
        'id',
        'tenant_id',
        'organization_id',
        'location_id',
        'service_type',
        'display_name',
        'status',
        'check_in_mode',
        'capacity',
        'queue_enabled',
        'ready_claim_timeout_seconds',
        'queue_timeout_seconds',
        'default_duration_seconds',
        'max_duration_seconds',
        'revision',
      ])
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', destinationId)
      .executeTakeFirst();
    if (row === undefined) return null;
    const status =
      row.status === 'active' ? 'active' : row.status === 'closed' ? 'closed' : 'archived';
    const checkInMode =
      row.check_in_mode === 'optional'
        ? 'optional'
        : row.check_in_mode === 'required'
          ? 'required'
          : 'none';
    return {
      id: row.id,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      locationId: row.location_id,
      serviceType: row.service_type,
      displayName: row.display_name ?? row.service_type,
      status,
      revision: toBigInt(row.revision),
      checkInMode,
      capacity: row.capacity,
      queueEnabled: row.queue_enabled,
      readyClaimTimeoutSeconds: row.ready_claim_timeout_seconds,
      queueTimeoutSeconds: row.queue_timeout_seconds,
      defaultDurationSeconds: row.default_duration_seconds,
      maxDurationSeconds: row.max_duration_seconds,
    };
  }

  async loadActiveStudent(
    context: TenantTransactionContext,
    organizationId: OrganizationId,
    studentId: PersonId,
    date: Temporal.PlainDate,
  ): Promise<ActiveStudentRecord | null> {
    const connection = connectionFor(context);
    const day = date.toString();
    const row = await connection
      .selectFrom('organization_membership')
      .innerJoin('person', (join) =>
        join
          .onRef('person.tenant_id', '=', 'organization_membership.tenant_id')
          .onRef('person.id', '=', 'organization_membership.person_id'),
      )
      .select(['organization_membership.person_id', 'organization_membership.organization_id'])
      .where('organization_membership.tenant_id', '=', context.tenantId)
      .where('organization_membership.organization_id', '=', organizationId)
      .where('organization_membership.person_id', '=', studentId)
      .where('organization_membership.affiliation', '=', 'student')
      .where('organization_membership.status', '=', 'active')
      .where('person.status', '=', 'active')
      .where((eb) =>
        eb.or([
          eb('organization_membership.valid_from', 'is', null),
          eb('organization_membership.valid_from', '<=', day),
        ]),
      )
      .where((eb) =>
        eb.or([
          eb('organization_membership.valid_until', 'is', null),
          eb('organization_membership.valid_until', '>=', day),
        ]),
      )
      .executeTakeFirst();
    if (row === undefined) return null;
    return { personId: row.person_id, organizationId: row.organization_id };
  }

  async findActivePassForStudent(
    context: TenantTransactionContext,
    studentId: PersonId,
  ): Promise<PassRow | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('pass')
      .selectAll('pass')
      .where('pass.tenant_id', '=', context.tenantId)
      .where('pass.student_id', '=', studentId)
      .where('pass.lifecycle_state', 'in', ACTIVE_STATES)
      .orderBy('pass.requested_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return null;
    return this.toPassRow(connectionFor(context), row);
  }

  async insertRequestedPass(
    context: TenantTransactionContext,
    input: NewPassRow,
  ): Promise<PassRow> {
    const connection = connectionFor(context);
    await connection
      .insertInto('pass')
      .values({
        id: input.id,
        tenant_id: context.tenantId,
        organization_id: input.organizationId,
        student_id: input.studentId,
        origin_location_id: input.originLocationId,
        origin_section_id: input.originSectionId,
        origin_schedule_block_id: input.originScheduleBlockId,
        destination_id: input.destinationId,
        request_source: input.requestSource,
        scheduled_authorization_id: input.scheduledAuthorizationId,
        requested_by_person_id: input.requestedByPersonId,
        requested_at: toDatabaseInstant(input.requestedAt),
        lifecycle_state: 'requested',
      })
      .execute();
    const row = await connection
      .selectFrom('pass')
      .selectAll('pass')
      .where('pass.tenant_id', '=', context.tenantId)
      .where('pass.id', '=', input.id)
      .executeTakeFirstOrThrow();
    return this.toPassRow(connection, row);
  }

  async loadPass(context: TenantTransactionContext, passId: PassId): Promise<PassRow | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('pass')
      .selectAll('pass')
      .where('pass.tenant_id', '=', context.tenantId)
      .where('pass.id', '=', passId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return this.toPassRow(connection, row);
  }

  async loadPassForUpdate(
    context: TenantTransactionContext,
    passId: PassId,
  ): Promise<PassRow | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('pass')
      .selectAll('pass')
      .where('pass.tenant_id', '=', context.tenantId)
      .where('pass.id', '=', passId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) return null;
    return this.toPassRow(connection, row);
  }

  async updatePassToCancelled(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null> {
    const connection = connectionFor(context);
    const updated = await connection
      .updateTable('pass')
      .set({
        lifecycle_state: 'cancelled',
        revision: String(expectedRevision + 1n),
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', passId)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
    if (updated === undefined) return null;
    return this.toPassRow(connection, updated);
  }

  async touchPassRevision(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null> {
    const connection = connectionFor(context);
    const updated = await connection
      .updateTable('pass')
      .set({ revision: String(expectedRevision + 1n), updated_at: toDatabaseInstant(at) })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', passId)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
    if (updated === undefined) return null;
    return this.toPassRow(connection, updated);
  }

  async updatePassToDenied(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null> {
    return this.transitionTo(context, passId, expectedRevision, at, 'denied', {});
  }

  async updatePassToRequested(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null> {
    return this.transitionTo(context, passId, expectedRevision, at, 'requested', {});
  }

  async updatePassToQueued(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null> {
    return this.transitionTo(context, passId, expectedRevision, at, 'queued', {});
  }

  async updatePassToReady(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null> {
    return this.transitionTo(context, passId, expectedRevision, at, 'ready', {});
  }

  async updatePassToOutbound(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
    expectedReturnAt: Temporal.Instant | null,
    departure: { readonly checkInMode: string; readonly destinationRevision: bigint },
  ): Promise<PassRow | null> {
    return this.transitionTo(context, passId, expectedRevision, at, 'outbound', {
      expected_return_at: expectedReturnAt === null ? null : toDatabaseInstant(expectedReturnAt),
      departure_check_in_mode: departure.checkInMode,
      departure_destination_revision: String(departure.destinationRevision),
    });
  }

  async updatePassToAtDestination(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null> {
    return this.transitionTo(context, passId, expectedRevision, at, 'at_destination', {});
  }

  async updatePassToReturning(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
    returnLocationId: string | null,
  ): Promise<PassRow | null> {
    return this.transitionTo(context, passId, expectedRevision, at, 'returning', {
      return_location_id: returnLocationId,
    });
  }

  async updatePassToCompleted(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null> {
    return this.transitionTo(context, passId, expectedRevision, at, 'completed', {});
  }

  async updatePassToExpired(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null> {
    return this.transitionTo(context, passId, expectedRevision, at, 'expired', {});
  }

  private async transitionTo(
    context: TenantTransactionContext,
    passId: PassId,
    expectedRevision: bigint,
    at: Temporal.Instant,
    lifecycleState: string,
    extra: {
      expected_return_at?: string | null;
      return_location_id?: string | null;
      departure_check_in_mode?: string;
      departure_destination_revision?: string;
    },
  ): Promise<PassRow | null> {
    const connection = connectionFor(context);
    const updated = await connection
      .updateTable('pass')
      .set({
        lifecycle_state: lifecycleState,
        revision: String(expectedRevision + 1n),
        updated_at: toDatabaseInstant(at),
        ...extra,
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', passId)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
    if (updated === undefined) return null;
    return this.toPassRow(connection, updated);
  }

  async loadLatestPassEvent(
    context: TenantTransactionContext,
    passId: PassId,
  ): Promise<{ readonly eventType: string; readonly metadata: Record<string, unknown> } | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('pass_event')
      .select(['event_type', 'metadata'])
      .where('tenant_id', '=', context.tenantId)
      .where('pass_id', '=', passId)
      .orderBy('sequence', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return null;
    return { eventType: row.event_type, metadata: row.metadata as Record<string, unknown> };
  }

  async appendPassEvent(context: TenantTransactionContext, input: PassEventInput): Promise<void> {
    const connection = connectionFor(context);
    await connection
      .insertInto('pass_event')
      .values({
        tenant_id: context.tenantId,
        pass_id: input.passId,
        sequence: input.sequence,
        event_type: input.eventType,
        actor_kind: input.actorKind,
        actor_person_id: input.actorKind === 'person' ? input.actorPersonId : null,
        occurred_at: toDatabaseInstant(input.occurredAt),
        metadata: { ...(input.metadata as Record<string, never>) },
      })
      .execute();
  }

  private async toPassRow(
    connection: ReturnType<typeof connectionFor>,
    row: PassCore,
  ): Promise<PassRow> {
    const destination = await connection
      .selectFrom('destination')
      .select(['display_name', 'service_type', 'check_in_mode'])
      .where('tenant_id', '=', row.tenant_id)
      .where('id', '=', row.destination_id)
      .executeTakeFirst();
    const block =
      row.origin_schedule_block_id === null
        ? null
        : await connection
            .selectFrom('schedule_block')
            .select(['id', 'code', 'display_name'])
            .where('tenant_id', '=', row.tenant_id)
            .where('id', '=', row.origin_schedule_block_id)
            .executeTakeFirst();
    const section =
      row.origin_section_id === null
        ? null
        : await connection
            .selectFrom('section')
            .select(['id', 'code', 'title'])
            .where('tenant_id', '=', row.tenant_id)
            .where('id', '=', row.origin_section_id)
            .executeTakeFirst();
    const location =
      row.origin_location_id === null
        ? null
        : await connection
            .selectFrom('location')
            .select(['id', 'name'])
            .where('tenant_id', '=', row.tenant_id)
            .where('id', '=', row.origin_location_id)
            .executeTakeFirst();
    return {
      id: row.id,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      studentId: row.student_id,
      originLocationId: row.origin_location_id,
      originSectionId: row.origin_section_id,
      originScheduleBlockId: row.origin_schedule_block_id,
      destinationId: row.destination_id,
      returnLocationId: row.return_location_id,
      requestSource: row.request_source,
      requestedByPersonId: row.requested_by_person_id,
      requestedAt: fromDatabaseInstant(row.requested_at),
      lifecycleState: row.lifecycle_state,
      expectedReturnAt:
        row.expected_return_at === null ? null : fromDatabaseInstant(row.expected_return_at),
      scheduledAuthorizationId: row.scheduled_authorization_id,
      revision: toBigInt(row.revision),
      departureCheckInMode: parseCheckInMode(row.departure_check_in_mode),
      departureDestinationRevision:
        row.departure_destination_revision === null
          ? null
          : toBigInt(row.departure_destination_revision),
      destinationDisplayName: destination?.display_name ?? '',
      destinationServiceType: destination?.service_type ?? '',
      destinationCheckInMode:
        destination?.check_in_mode === 'optional'
          ? 'optional'
          : destination?.check_in_mode === 'required'
            ? 'required'
            : 'none',
      originBlock:
        block === null || block === undefined
          ? null
          : { id: block.id, code: block.code, displayName: block.display_name },
      originSection:
        section === null || section === undefined
          ? null
          : { id: section.id, code: section.code, title: section.title },
      originLocation:
        location === null || location === undefined
          ? null
          : { id: location.id, name: location.name },
    };
  }
}
