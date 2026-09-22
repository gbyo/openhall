import { sql } from 'kysely';
import type { Temporal } from '@js-temporal/polyfill';
import type {
  RoomFlowConfig,
  RoomFlowRepository,
  ExpiredQueueCandidate,
  FlowQueueEntryRow,
  FlowReservationRow,
  NewFlowQueueEntry,
  NewFlowReservation,
  OrphanedFlowRows,
  QueueHeadCandidate,
  StaleReadyCandidate,
  StationAggregates,
  UnavailableFlowCandidate,
} from '@openhall/application';
import type { TenantTransactionContext } from '@openhall/application';
import type { Kysely } from 'kysely';
import type { DB as Database } from '../database.generated.js';
import {
  connectionFor,
  fromDatabaseInstant,
  toBigInt,
  toDatabaseInstant,
} from '../transactions.js';

interface ReservationCore {
  id: string;
  tenant_id: string;
  organization_id: string;
  room_id: string;
  pass_id: string;
  policy_evaluation_id: string;
  reserved_at: string;
  ready_expires_at: string;
  claimed_at: string | null;
  flow_expires_at: string;
  released_at: string | null;
  release_reason: string | null;
}

interface QueueCore {
  id: string;
  tenant_id: string;
  organization_id: string;
  room_id: string;
  pass_id: string;
  policy_evaluation_id: string;
  entered_at: string;
  flow_expires_at: string;
  released_at: string | null;
  release_reason: string | null;
  priority: number;
}

function toReservation(row: ReservationCore): FlowReservationRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    roomId: row.room_id,
    passId: row.pass_id,
    policyEvaluationId: row.policy_evaluation_id,
    reservedAt: fromDatabaseInstant(row.reserved_at),
    readyExpiresAt: fromDatabaseInstant(row.ready_expires_at),
    claimedAt: row.claimed_at === null ? null : fromDatabaseInstant(row.claimed_at),
    flowExpiresAt: fromDatabaseInstant(row.flow_expires_at),
    releasedAt: row.released_at === null ? null : fromDatabaseInstant(row.released_at),
    releaseReason: row.release_reason,
  };
}

function toQueueEntry(row: QueueCore): FlowQueueEntryRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    roomId: row.room_id,
    passId: row.pass_id,
    policyEvaluationId: row.policy_evaluation_id,
    enteredAt: fromDatabaseInstant(row.entered_at),
    flowExpiresAt: fromDatabaseInstant(row.flow_expires_at),
    releasedAt: row.released_at === null ? null : fromDatabaseInstant(row.released_at),
    releaseReason: row.release_reason,
    priority: row.priority,
  };
}

/**
 * PostgreSQL room-flow persistence. Capacity decisions are serialized
 * by the room-flow advisory lock held by the caller; every method
 * resolves its connection from the tenant transaction context and scopes by
 * that context's tenant.
 */
export class PostgresRoomFlowRepository implements RoomFlowRepository {
  constructor(private readonly database: Kysely<Database>) {}

  async listTenantIds(): Promise<string[]> {
    const rows = await this.database.selectFrom('tenant').select('id').execute();
    return rows.map((row) => row.id);
  }

  async acquireRoomLock(context: TenantTransactionContext, lockKey: bigint): Promise<void> {
    const connection = connectionFor(context);
    await sql`SELECT pg_advisory_xact_lock(${lockKey})`.execute(connection);
  }

  async loadRoomConfig(
    context: TenantTransactionContext,
    roomId: string,
  ): Promise<RoomFlowConfig | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('room')
      .select([
        'id',
        'tenant_id',
        'organization_id',
        'status',
        'check_in_mode',
        'capacity',
        'queue_enabled',
        'ready_claim_timeout_seconds',
        'queue_timeout_seconds',
        'default_duration_seconds',
        'max_duration_seconds',
      ])
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', roomId)
      .executeTakeFirst();
    if (row === undefined) return null;
    const status =
      row.status === 'closed' ? 'closed' : row.status === 'archived' ? 'archived' : 'open';
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
      status,
      checkInMode,
      capacity: row.capacity,
      queueEnabled: row.queue_enabled,
      readyClaimTimeoutSeconds: row.ready_claim_timeout_seconds,
      queueTimeoutSeconds: row.queue_timeout_seconds,
      defaultDurationSeconds: row.default_duration_seconds,
      maxDurationSeconds: row.max_duration_seconds,
    };
  }

  async countConsumingReservations(
    context: TenantTransactionContext,
    roomId: string,
    at: Temporal.Instant,
  ): Promise<number> {
    const connection = connectionFor(context);
    const stamp = toDatabaseInstant(at);
    const row = await connection
      .selectFrom('room_reservation')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('room_id', '=', roomId)
      .where('released_at', 'is', null)
      .where((eb) => eb.or([eb('claimed_at', 'is not', null), eb('ready_expires_at', '>', stamp)]))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async createReservation(
    context: TenantTransactionContext,
    input: NewFlowReservation,
  ): Promise<FlowReservationRow> {
    const connection = connectionFor(context);
    const created = await connection
      .insertInto('room_reservation')
      .values({
        tenant_id: context.tenantId,
        organization_id: input.organizationId,
        room_id: input.roomId,
        pass_id: input.passId,
        policy_evaluation_id: input.policyEvaluationId,
        reserved_at: toDatabaseInstant(input.reservedAt),
        ready_expires_at: toDatabaseInstant(input.readyExpiresAt),
        flow_expires_at: toDatabaseInstant(input.flowExpiresAt),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toReservation(created);
  }

  async loadActiveReservationForPass(
    context: TenantTransactionContext,
    passId: string,
  ): Promise<FlowReservationRow | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('room_reservation')
      .selectAll('room_reservation')
      .where('tenant_id', '=', context.tenantId)
      .where('pass_id', '=', passId)
      .where('released_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) return null;
    return toReservation(row);
  }

  async claimReservation(
    context: TenantTransactionContext,
    reservationId: string,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const connection = connectionFor(context);
    const result = await connection
      .updateTable('room_reservation')
      .set({ claimed_at: toDatabaseInstant(at) })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', reservationId)
      .where('released_at', 'is', null)
      .where('claimed_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async releaseReservation(
    context: TenantTransactionContext,
    reservationId: string,
    reason: string,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const connection = connectionFor(context);
    const result = await connection
      .updateTable('room_reservation')
      .set({ released_at: toDatabaseInstant(at), release_reason: reason })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', reservationId)
      .where('released_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async createQueueEntry(
    context: TenantTransactionContext,
    input: NewFlowQueueEntry,
  ): Promise<FlowQueueEntryRow> {
    const connection = connectionFor(context);
    const created = await connection
      .insertInto('queue_entry')
      .values({
        tenant_id: context.tenantId,
        organization_id: input.organizationId,
        room_id: input.roomId,
        pass_id: input.passId,
        policy_evaluation_id: input.policyEvaluationId,
        entered_at: toDatabaseInstant(input.enteredAt),
        flow_expires_at: toDatabaseInstant(input.flowExpiresAt),
        priority: 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toQueueEntry(created);
  }

  async loadActiveQueueEntryForPass(
    context: TenantTransactionContext,
    passId: string,
  ): Promise<FlowQueueEntryRow | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('queue_entry')
      .selectAll('queue_entry')
      .where('tenant_id', '=', context.tenantId)
      .where('pass_id', '=', passId)
      .where('released_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) return null;
    return toQueueEntry(row);
  }

  async releaseQueueEntry(
    context: TenantTransactionContext,
    entryId: string,
    reason: string,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const connection = connectionFor(context);
    const result = await connection
      .updateTable('queue_entry')
      .set({ released_at: toDatabaseInstant(at), release_reason: reason })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', entryId)
      .where('released_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async loadQueueHead(
    context: TenantTransactionContext,
    roomId: string,
  ): Promise<QueueHeadCandidate | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('queue_entry')
      .innerJoin('pass', (join) =>
        join
          .onRef('pass.tenant_id', '=', 'queue_entry.tenant_id')
          .onRef('pass.id', '=', 'queue_entry.pass_id'),
      )
      .select([
        'queue_entry.id as entry_id',
        'queue_entry.organization_id as entry_organization_id',
        'queue_entry.pass_id as entry_pass_id',
        'queue_entry.policy_evaluation_id as entry_policy_evaluation_id',
        'queue_entry.entered_at as entry_entered_at',
        'queue_entry.flow_expires_at as entry_flow_expires_at',
        'queue_entry.priority as entry_priority',
        'pass.organization_id as pass_organization_id',
        'pass.student_id as pass_student_id',
        'pass.lifecycle_state as pass_lifecycle_state',
      ])
      .where('queue_entry.tenant_id', '=', context.tenantId)
      .where('queue_entry.room_id', '=', roomId)
      .where('queue_entry.released_at', 'is', null)
      .orderBy('queue_entry.priority', 'desc')
      .orderBy('queue_entry.entered_at', 'asc')
      .orderBy('queue_entry.id', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      entry: {
        id: row.entry_id,
        tenantId: context.tenantId,
        organizationId: row.entry_organization_id,
        roomId,
        passId: row.entry_pass_id,
        policyEvaluationId: row.entry_policy_evaluation_id,
        enteredAt: fromDatabaseInstant(row.entry_entered_at),
        flowExpiresAt: fromDatabaseInstant(row.entry_flow_expires_at),
        releasedAt: null,
        releaseReason: null,
        priority: row.entry_priority,
      },
      passId: row.entry_pass_id,
      organizationId: row.pass_organization_id,
      studentId: row.pass_student_id,
      passLifecycleState: row.pass_lifecycle_state,
    };
  }

  async countActiveQueueEntries(
    context: TenantTransactionContext,
    roomId: string,
    excludePassId?: string,
  ): Promise<number> {
    const connection = connectionFor(context);
    let query = connection
      .selectFrom('queue_entry')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('room_id', '=', roomId)
      .where('released_at', 'is', null);
    if (excludePassId !== undefined) {
      query = query.where('pass_id', '!=', excludePassId);
    }
    const row = await query.executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async queuePosition(
    context: TenantTransactionContext,
    roomId: string,
    entryId: string,
  ): Promise<{ readonly position: number; readonly ahead: number }> {
    const connection = connectionFor(context);
    const entry = await connection
      .selectFrom('queue_entry')
      .select(['priority', 'entered_at'])
      .where('tenant_id', '=', context.tenantId)
      .where('room_id', '=', roomId)
      .where('id', '=', entryId)
      .where('released_at', 'is', null)
      .executeTakeFirst();
    if (entry === undefined) {
      throw new Error('Queue entry is not active.');
    }
    const ahead = await connection
      .selectFrom('queue_entry')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('room_id', '=', roomId)
      .where('released_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('priority', '>', entry.priority),
          eb.and([eb('priority', '=', entry.priority), eb('entered_at', '<', entry.entered_at)]),
          eb.and([
            eb('priority', '=', entry.priority),
            eb('entered_at', '=', entry.entered_at),
            eb('id', '<', entryId),
          ]),
        ]),
      )
      .executeTakeFirstOrThrow();
    const aheadCount = Number(ahead.count);
    return { position: aheadCount + 1, ahead: aheadCount };
  }

  async listQueuedRoomIds(context: TenantTransactionContext, limit: number): Promise<string[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('queue_entry')
      .select('room_id')
      .distinct()
      .where('tenant_id', '=', context.tenantId)
      .where('released_at', 'is', null)
      .orderBy('room_id', 'asc')
      .limit(limit)
      .execute();
    return rows.map((row) => row.room_id);
  }

  async findStaleReadyCandidate(
    context: TenantTransactionContext,
    at: Temporal.Instant,
  ): Promise<StaleReadyCandidate | null> {
    const connection = connectionFor(context);
    const stamp = toDatabaseInstant(at);
    const row = await connection
      .selectFrom('room_reservation')
      .innerJoin('pass', (join) =>
        join
          .onRef('pass.tenant_id', '=', 'room_reservation.tenant_id')
          .onRef('pass.id', '=', 'room_reservation.pass_id'),
      )
      .selectAll('room_reservation')
      .select('pass.lifecycle_state as pass_lifecycle_state')
      .where('room_reservation.tenant_id', '=', context.tenantId)
      .where('room_reservation.released_at', 'is', null)
      .where('room_reservation.claimed_at', 'is', null)
      .where('room_reservation.ready_expires_at', '<=', stamp)
      .where('pass.lifecycle_state', '=', 'ready')
      .orderBy('room_reservation.ready_expires_at', 'asc')
      .orderBy('room_reservation.id', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return null;
    return { reservation: toReservation(row), passLifecycleState: row.pass_lifecycle_state };
  }

  async findExpiredQueueCandidate(
    context: TenantTransactionContext,
    at: Temporal.Instant,
  ): Promise<ExpiredQueueCandidate | null> {
    const connection = connectionFor(context);
    const stamp = toDatabaseInstant(at);
    const row = await connection
      .selectFrom('queue_entry')
      .innerJoin('pass', (join) =>
        join
          .onRef('pass.tenant_id', '=', 'queue_entry.tenant_id')
          .onRef('pass.id', '=', 'queue_entry.pass_id'),
      )
      .selectAll('queue_entry')
      .where('queue_entry.tenant_id', '=', context.tenantId)
      .where('queue_entry.released_at', 'is', null)
      .where('queue_entry.flow_expires_at', '<=', stamp)
      .where('pass.lifecycle_state', '=', 'queued')
      .orderBy('queue_entry.flow_expires_at', 'asc')
      .orderBy('queue_entry.id', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return null;
    return { entry: toQueueEntry(row) };
  }

  async findUnavailableFlowCandidate(
    context: TenantTransactionContext,
  ): Promise<UnavailableFlowCandidate | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('pass')
      .innerJoin('room', (join) =>
        join
          .onRef('room.tenant_id', '=', 'pass.tenant_id')
          .onRef('room.id', '=', 'pass.destination_room_id'),
      )
      .select(['pass.id as pass_id', 'pass.lifecycle_state', 'pass.destination_room_id'])
      .where('pass.tenant_id', '=', context.tenantId)
      .where('pass.lifecycle_state', 'in', ['queued', 'ready'])
      .where('room.status', 'in', ['closed', 'archived'])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('queue_entry')
            .select('queue_entry.id')
            .whereRef('queue_entry.tenant_id', '=', 'pass.tenant_id')
            .whereRef('queue_entry.pass_id', '=', 'pass.id')
            .where('queue_entry.released_at', 'is', null),
        ),
      )
      .orderBy('pass.requested_at', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (row !== undefined) {
      return {
        passId: row.pass_id,
        lifecycleState: row.lifecycle_state,
        roomId: row.destination_room_id,
      };
    }
    const claimed = await connection
      .selectFrom('pass')
      .innerJoin('room', (join) =>
        join
          .onRef('room.tenant_id', '=', 'pass.tenant_id')
          .onRef('room.id', '=', 'pass.destination_room_id'),
      )
      .select(['pass.id as pass_id', 'pass.lifecycle_state', 'pass.destination_room_id'])
      .where('pass.tenant_id', '=', context.tenantId)
      .where('pass.lifecycle_state', '=', 'ready')
      .where('room.status', 'in', ['closed', 'archived'])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('room_reservation')
            .select('room_reservation.id')
            .whereRef('room_reservation.tenant_id', '=', 'pass.tenant_id')
            .whereRef('room_reservation.pass_id', '=', 'pass.id')
            .where('room_reservation.released_at', 'is', null)
            .where('room_reservation.claimed_at', 'is', null),
        ),
      )
      .orderBy('pass.requested_at', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (claimed === undefined) return null;
    return {
      passId: claimed.pass_id,
      lifecycleState: claimed.lifecycle_state,
      roomId: claimed.destination_room_id,
    };
  }

  async findOrphanedFlowRows(context: TenantTransactionContext): Promise<OrphanedFlowRows | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('pass')
      .leftJoin('room_reservation', (join) =>
        join
          .onRef('room_reservation.tenant_id', '=', 'pass.tenant_id')
          .onRef('room_reservation.pass_id', '=', 'pass.id')
          .on('room_reservation.released_at', 'is', null),
      )
      .leftJoin('queue_entry', (join) =>
        join
          .onRef('queue_entry.tenant_id', '=', 'pass.tenant_id')
          .onRef('queue_entry.pass_id', '=', 'pass.id')
          .on('queue_entry.released_at', 'is', null),
      )
      .select([
        'pass.id as pass_id',
        'room_reservation.id as reservation_id',
        'queue_entry.id as queue_entry_id',
      ])
      .where('pass.tenant_id', '=', context.tenantId)
      .where('pass.lifecycle_state', 'in', ['completed', 'denied', 'cancelled', 'expired'])
      .where((eb) =>
        eb.or([eb('room_reservation.id', 'is not', null), eb('queue_entry.id', 'is not', null)]),
      )
      .orderBy('pass.requested_at', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      passId: row.pass_id,
      reservationId: row.reservation_id,
      queueEntryId: row.queue_entry_id,
    };
  }

  async loadStationAggregates(
    context: TenantTransactionContext,
    roomId: string,
    at: Temporal.Instant,
  ): Promise<StationAggregates> {
    const connection = connectionFor(context);
    const config = await this.loadRoomConfig(context, roomId);
    if (config === null) {
      throw new Error('Room not found.');
    }
    const roomMeta = await connection
      .selectFrom('room')
      .select(['name'])
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', roomId)
      .executeTakeFirstOrThrow();
    const stamp = toDatabaseInstant(at);
    const consumingRow = await connection
      .selectFrom('room_reservation')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('room_id', '=', roomId)
      .where('released_at', 'is', null)
      .where((eb) => eb.or([eb('claimed_at', 'is not', null), eb('ready_expires_at', '>', stamp)]))
      .executeTakeFirstOrThrow();
    const queueRow = await connection
      .selectFrom('queue_entry')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('room_id', '=', roomId)
      .where('released_at', 'is', null)
      .executeTakeFirstOrThrow();

    const readyRows = await connection
      .selectFrom('pass')
      .innerJoin('room_reservation', (join) =>
        join
          .onRef('room_reservation.tenant_id', '=', 'pass.tenant_id')
          .onRef('room_reservation.pass_id', '=', 'pass.id')
          .on('room_reservation.released_at', 'is', null)
          .on('room_reservation.claimed_at', 'is', null),
      )
      .innerJoin('person', (join) =>
        join
          .onRef('person.tenant_id', '=', 'pass.tenant_id')
          .onRef('person.id', '=', 'pass.student_id'),
      )
      .select([
        'pass.id as pass_id',
        'pass.revision as pass_revision',
        'pass.student_id as student_id',
        'person.display_name as student_display_name',
        'pass.expected_return_at as expected_return_at',
        'room_reservation.ready_expires_at as ready_until',
      ])
      .where('pass.tenant_id', '=', context.tenantId)
      .where('pass.destination_room_id', '=', roomId)
      .where('pass.lifecycle_state', '=', 'ready')
      .orderBy('room_reservation.ready_expires_at', 'asc')
      .execute();

    const outboundRows = await connection
      .selectFrom('pass')
      .innerJoin('room_reservation', (join) =>
        join
          .onRef('room_reservation.tenant_id', '=', 'pass.tenant_id')
          .onRef('room_reservation.pass_id', '=', 'pass.id')
          .on('room_reservation.released_at', 'is', null)
          .on('room_reservation.claimed_at', 'is not', null),
      )
      .innerJoin('person', (join) =>
        join
          .onRef('person.tenant_id', '=', 'pass.tenant_id')
          .onRef('person.id', '=', 'pass.student_id'),
      )
      .select([
        'pass.id as pass_id',
        'pass.revision as pass_revision',
        'pass.student_id as student_id',
        'person.display_name as student_display_name',
        'pass.expected_return_at as expected_return_at',
        'room_reservation.claimed_at as departed_at',
      ])
      .where('pass.tenant_id', '=', context.tenantId)
      .where('pass.destination_room_id', '=', roomId)
      .where('pass.lifecycle_state', '=', 'outbound')
      .orderBy('room_reservation.claimed_at', 'asc')
      .execute();

    const atDestinationRows = await connection
      .selectFrom('pass')
      .innerJoin('person', (join) =>
        join
          .onRef('person.tenant_id', '=', 'pass.tenant_id')
          .onRef('person.id', '=', 'pass.student_id'),
      )
      .select([
        'pass.id as pass_id',
        'pass.revision as pass_revision',
        'pass.student_id as student_id',
        'person.display_name as student_display_name',
        'pass.expected_return_at as expected_return_at',
      ])
      .where('pass.tenant_id', '=', context.tenantId)
      .where('pass.destination_room_id', '=', roomId)
      .where('pass.lifecycle_state', '=', 'at_destination')
      .orderBy('pass.requested_at', 'asc')
      .execute();

    const queuedRows = await connection
      .selectFrom('pass')
      .innerJoin('queue_entry', (join) =>
        join
          .onRef('queue_entry.tenant_id', '=', 'pass.tenant_id')
          .onRef('queue_entry.pass_id', '=', 'pass.id')
          .on('queue_entry.released_at', 'is', null),
      )
      .innerJoin('person', (join) =>
        join
          .onRef('person.tenant_id', '=', 'pass.tenant_id')
          .onRef('person.id', '=', 'pass.student_id'),
      )
      .select([
        'pass.id as pass_id',
        'pass.revision as pass_revision',
        'pass.student_id as student_id',
        'person.display_name as student_display_name',
        'pass.expected_return_at as expected_return_at',
        'queue_entry.entered_at as entered_at',
      ])
      .where('pass.tenant_id', '=', context.tenantId)
      .where('pass.destination_room_id', '=', roomId)
      .where('pass.lifecycle_state', '=', 'queued')
      .orderBy('queue_entry.priority', 'desc')
      .orderBy('queue_entry.entered_at', 'asc')
      .orderBy('queue_entry.id', 'asc')
      .execute();

    return {
      config,
      roomName: roomMeta.name,
      consumingReservations: Number(consumingRow.count),
      queueCount: Number(queueRow.count),
      ready: readyRows.map((entry) => ({
        passId: entry.pass_id,
        passRevision: toBigInt(entry.pass_revision),
        studentId: entry.student_id,
        studentDisplayName: entry.student_display_name,
        expectedReturnAt: null,
        readyUntil: fromDatabaseInstant(entry.ready_until),
      })),
      outbound: outboundRows.map((entry) => {
        if (entry.departed_at === null) {
          throw new Error('Station view outbound row is missing departed_at');
        }
        return {
          passId: entry.pass_id,
          passRevision: toBigInt(entry.pass_revision),
          studentId: entry.student_id,
          studentDisplayName: entry.student_display_name,
          expectedReturnAt:
            entry.expected_return_at === null
              ? null
              : fromDatabaseInstant(entry.expected_return_at),
          departedAt: fromDatabaseInstant(entry.departed_at),
        };
      }),
      atDestination: atDestinationRows.map((entry) => ({
        passId: entry.pass_id,
        passRevision: toBigInt(entry.pass_revision),
        studentId: entry.student_id,
        studentDisplayName: entry.student_display_name,
        expectedReturnAt:
          entry.expected_return_at === null ? null : fromDatabaseInstant(entry.expected_return_at),
      })),
      queued: queuedRows.map((entry) => ({
        passId: entry.pass_id,
        passRevision: toBigInt(entry.pass_revision),
        studentId: entry.student_id,
        studentDisplayName: entry.student_display_name,
        expectedReturnAt: null,
        enteredAt: fromDatabaseInstant(entry.entered_at),
      })),
    };
  }
}
