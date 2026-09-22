import type { Temporal } from '@js-temporal/polyfill';
import type {
  RoomRecord,
  RoomRepository,
  RoomStatus,
  RoomUpdate,
  NewRoom,
} from '@openhall/application';
import type { TenantTransactionContext } from '@openhall/application';
import {
  connectionFor,
  fromDatabaseInstant,
  toBigInt,
  toDatabaseInstant,
} from '../transactions.js';

const LIVE_PASS_STATES = [
  'requested',
  'queued',
  'ready',
  'outbound',
  'at_destination',
  'returning',
];

function roomStatus(value: string): RoomStatus {
  return value === 'closed' ? 'closed' : value === 'archived' ? 'archived' : 'open';
}

function checkInMode(value: string): RoomRecord['checkInMode'] {
  return value === 'optional' ? 'optional' : value === 'required' ? 'required' : 'none';
}

interface RoomRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  category_id: string | null;
  name: string;
  code: string | null;
  floor_label: string | null;
  status: string;
  student_self_requestable: boolean;
  origin_selectable: boolean;
  capacity: number | null;
  queue_enabled: boolean;
  check_in_mode: string;
  default_duration_seconds: number | null;
  max_duration_seconds: number | null;
  ready_claim_timeout_seconds: number;
  queue_timeout_seconds: number;
  revision: string | bigint | number;
  created_at: string;
  updated_at: string;
}

function toRoomRecord(row: RoomRow): RoomRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    categoryId: row.category_id,
    name: row.name,
    code: row.code,
    floorLabel: row.floor_label,
    status: roomStatus(row.status),
    studentSelfRequestable: row.student_self_requestable,
    originSelectable: row.origin_selectable,
    capacity: row.capacity,
    queueEnabled: row.queue_enabled,
    checkInMode: checkInMode(row.check_in_mode),
    defaultDurationSeconds: row.default_duration_seconds,
    maxDurationSeconds: row.max_duration_seconds,
    readyClaimTimeoutSeconds: row.ready_claim_timeout_seconds,
    queueTimeoutSeconds: row.queue_timeout_seconds,
    revision: toBigInt(row.revision),
    createdAt: fromDatabaseInstant(row.created_at),
    updatedAt: fromDatabaseInstant(row.updated_at),
  };
}

/** PostgreSQL room administration persistence (tenant-scoped, no unscoped path). */
export class PostgresRoomRepository implements RoomRepository {
  async loadSchoolTimeZone(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<string | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('organization')
      .select(['time_zone'])
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', organizationId)
      .executeTakeFirst();
    return row?.time_zone ?? null;
  }

  async listByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly RoomRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('room')
      .selectAll('room')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(toRoomRecord);
  }

  async listOpenCatalog(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly RoomRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('room')
      .selectAll('room')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'open')
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(toRoomRecord);
  }

  async loadById(
    context: TenantTransactionContext,
    roomId: string,
  ): Promise<RoomRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('room')
      .selectAll('room')
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', roomId)
      .executeTakeFirst();
    return row === undefined ? null : toRoomRecord(row);
  }

  async loadForUpdate(
    context: TenantTransactionContext,
    roomId: string,
  ): Promise<RoomRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('room')
      .selectAll('room')
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', roomId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? null : toRoomRecord(row);
  }

  async insert(context: TenantTransactionContext, input: NewRoom): Promise<RoomRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('room')
      .values({
        tenant_id: context.tenantId,
        organization_id: input.organizationId,
        category_id: input.categoryId,
        name: input.name,
        code: input.code,
        floor_label: input.floorLabel,
        student_self_requestable: input.studentSelfRequestable,
        origin_selectable: input.originSelectable,
        capacity: input.capacity,
        queue_enabled: input.queueEnabled,
        check_in_mode: input.checkInMode,
        default_duration_seconds: input.defaultDurationSeconds,
        max_duration_seconds: input.maxDurationSeconds,
        ready_claim_timeout_seconds: input.readyClaimTimeoutSeconds,
        queue_timeout_seconds: input.queueTimeoutSeconds,
        // Spec 24: a new room starts closed at revision 1; open is an
        // explicit later step, never implied by creation.
        status: 'closed',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRoomRecord(row);
  }

  async updateToRevision(
    context: TenantTransactionContext,
    roomId: string,
    expectedRevision: bigint,
    update: RoomUpdate,
    at: Temporal.Instant,
  ): Promise<RoomRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('room')
      .set({
        category_id: update.categoryId,
        name: update.name,
        code: update.code,
        floor_label: update.floorLabel,
        student_self_requestable: update.studentSelfRequestable,
        origin_selectable: update.originSelectable,
        capacity: update.capacity,
        queue_enabled: update.queueEnabled,
        check_in_mode: update.checkInMode,
        default_duration_seconds: update.defaultDurationSeconds,
        max_duration_seconds: update.maxDurationSeconds,
        ready_claim_timeout_seconds: update.readyClaimTimeoutSeconds,
        queue_timeout_seconds: update.queueTimeoutSeconds,
        revision: String(expectedRevision + 1n),
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', roomId)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toRoomRecord(row);
  }

  async transitionStatusToRevision(
    context: TenantTransactionContext,
    roomId: string,
    expectedRevision: bigint,
    status: RoomStatus,
    at: Temporal.Instant,
  ): Promise<RoomRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('room')
      .set({
        status,
        revision: String(expectedRevision + 1n),
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', roomId)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toRoomRecord(row);
  }

  async countLivePasses(context: TenantTransactionContext, roomId: string): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('pass')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('destination_room_id', '=', roomId)
      .where('lifecycle_state', 'in', LIVE_PASS_STATES)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async countActiveStaffGrants(
    context: TenantTransactionContext,
    roomId: string,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('authorization_grant')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('room_id', '=', roomId)
      .where('role', '=', 'room_staff')
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async countEnabledPolicyRules(
    context: TenantTransactionContext,
    roomId: string,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('policy_rule')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('scope_kind', '=', 'room')
      .where('scope_room_id', '=', roomId)
      .where('enabled', '=', true)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async countLiveScheduledAuthorizations(
    context: TenantTransactionContext,
    roomId: string,
    now: Temporal.Instant,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('scheduled_authorization')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('destination_room_id', '=', roomId)
      .where('status', '=', 'active')
      .where('valid_until', '>', toDatabaseInstant(now))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async countRelevantSectionMeetings(
    context: TenantTransactionContext,
    roomId: string,
    today: string,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('section_meeting')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('section_meeting.tenant_id', '=', context.tenantId)
      .where('section_meeting.room_id', '=', roomId)
      .where((eb) =>
        eb.or([
          eb('section_meeting.effective_until', 'is', null),
          eb('section_meeting.effective_until', '>=', today),
        ]),
      )
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async countActiveScheduledOrigins(
    context: TenantTransactionContext,
    roomId: string,
    now: Temporal.Instant,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('scheduled_authorization')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('origin_room_id', '=', roomId)
      .where('status', '=', 'active')
      .where('valid_until', '>', toDatabaseInstant(now))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async listActiveRoomStaff(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly { readonly roomId: string; readonly staffDisplayName: string }[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('authorization_grant as grant')
      .innerJoin('account', (join) =>
        join
          .onRef('account.tenant_id', '=', 'grant.tenant_id')
          .onRef('account.id', '=', 'grant.account_id'),
      )
      .innerJoin('person', (join) =>
        join
          .onRef('person.tenant_id', '=', 'grant.tenant_id')
          .onRef('person.id', '=', 'account.person_id'),
      )
      .innerJoin('room', (join) =>
        join
          .onRef('room.tenant_id', '=', 'grant.tenant_id')
          .onRef('room.id', '=', 'grant.room_id'),
      )
      .select(['grant.room_id as room_id', 'person.display_name as staff_display_name'])
      .where('grant.tenant_id', '=', context.tenantId)
      .where('room.organization_id', '=', organizationId)
      .where('grant.role', '=', 'room_staff')
      .where('grant.status', '=', 'active')
      .where('grant.room_id', 'is not', null)
      .orderBy('grant.room_id')
      .orderBy('person.display_name')
      .execute();
    return rows.flatMap((row) =>
      row.room_id === null
        ? []
        : [
            {
              roomId: row.room_id,
              staffDisplayName: row.staff_display_name,
            },
          ],
    );
  }

  async listRoomClassContexts(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<
    readonly {
      readonly roomId: string;
      readonly teacherDisplayName: string;
      readonly sectionTitle: string;
      readonly sectionCode: string | null;
    }[]
  > {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('section_meeting as meeting')
      .innerJoin('section', (join) =>
        join
          .onRef('section.tenant_id', '=', 'meeting.tenant_id')
          .onRef('section.id', '=', 'meeting.section_id'),
      )
      .innerJoin('section_membership as teacher_membership', (join) =>
        join
          .onRef('teacher_membership.tenant_id', '=', 'meeting.tenant_id')
          .onRef('teacher_membership.section_id', '=', 'meeting.section_id')
          .on('teacher_membership.role', '=', 'teacher')
          .on('teacher_membership.status', '=', 'active'),
      )
      .innerJoin('person as teacher', (join) =>
        join
          .onRef('teacher.tenant_id', '=', 'meeting.tenant_id')
          .onRef('teacher.id', '=', 'teacher_membership.person_id'),
      )
      .select([
        'meeting.room_id as room_id',
        'teacher.display_name as teacher_display_name',
        'section.title as section_title',
        'section.code as section_code',
      ])
      .where('meeting.tenant_id', '=', context.tenantId)
      .where('meeting.organization_id', '=', organizationId)
      .where('meeting.room_id', 'is not', null)
      .where('section.status', '=', 'active')
      .orderBy('meeting.room_id')
      .orderBy('teacher.display_name')
      .execute();
    return rows.flatMap((row) =>
      row.room_id === null
        ? []
        : [
            {
              roomId: row.room_id,
              teacherDisplayName: row.teacher_display_name,
              sectionTitle: row.section_title,
              sectionCode: row.section_code,
            },
          ],
    );
  }
}
