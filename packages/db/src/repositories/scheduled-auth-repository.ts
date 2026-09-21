import type { Temporal } from '@js-temporal/polyfill';
import type {
  NewScheduledAuth,
  ScheduledAuthRecord,
  ScheduledAuthRepository,
  TenantTransactionContext,
} from '@openhall/application';
import {
  connectionFor,
  fromDatabaseInstant,
  toBigInt,
  toDatabaseInstant,
} from '../transactions.js';

interface ScheduledAuthRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  student_id: string;
  destination_id: string;
  created_by_person_id: string;
  created_by_account_id: string | null;
  valid_from: string;
  valid_until: string;
  status: string;
  approval_mode: string;
  origin_strategy: string;
  origin_location_id: string | null;
  display_category: string | null;
  revision: string | bigint | number;
  created_at: string;
  updated_at: string;
  used_at: string | null;
  used_by_account_id: string | null;
  cancelled_at: string | null;
  cancelled_by_account_id: string | null;
  last_attempt_at: string | null;
}

function toRecord(row: ScheduledAuthRow): ScheduledAuthRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    studentId: row.student_id,
    destinationId: row.destination_id,
    createdByPersonId: row.created_by_person_id,
    createdByAccountId: row.created_by_account_id,
    validFrom: fromDatabaseInstant(row.valid_from),
    validUntil: fromDatabaseInstant(row.valid_until),
    status: row.status,
    approvalMode: row.approval_mode,
    originStrategy: row.origin_strategy,
    originLocationId: row.origin_location_id,
    displayCategory: row.display_category,
    revision: toBigInt(row.revision),
    createdAt: fromDatabaseInstant(row.created_at),
    updatedAt: fromDatabaseInstant(row.updated_at),
    usedAt: row.used_at === null ? null : fromDatabaseInstant(row.used_at),
    usedByAccountId: row.used_by_account_id,
    cancelledAt: row.cancelled_at === null ? null : fromDatabaseInstant(row.cancelled_at),
    cancelledByAccountId: row.cancelled_by_account_id,
    lastAttemptAt: row.last_attempt_at === null ? null : fromDatabaseInstant(row.last_attempt_at),
  };
}

function selection() {
  return [
    'id',
    'tenant_id',
    'organization_id',
    'student_id',
    'destination_id',
    'created_by_person_id',
    'created_by_account_id',
    'valid_from',
    'valid_until',
    'status',
    'approval_mode',
    'origin_strategy',
    'origin_location_id',
    'display_category',
    'revision',
    'created_at',
    'updated_at',
    'used_at',
    'used_by_account_id',
    'cancelled_at',
    'cancelled_by_account_id',
    'last_attempt_at',
  ] as const;
}

/** PostgreSQL scheduled authorization persistence (tenant-scoped). */
export class PostgresScheduledAuthRepository implements ScheduledAuthRepository {
  async loadSchoolTimeZone(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<string | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('organization')
      .select('time_zone')
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', organizationId)
      .executeTakeFirst();
    return row?.time_zone ?? null;
  }

  async loadStudent(
    context: TenantTransactionContext,
    studentId: string,
  ): Promise<{ readonly id: string; readonly tenantId: string; readonly status: string } | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('person')
      .select(['id', 'tenant_id', 'status'])
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', studentId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return { id: row.id, tenantId: row.tenant_id, status: row.status };
  }

  async loadActiveStudentMembership(
    context: TenantTransactionContext,
    studentId: string,
    organizationId: string,
    onDate: string,
  ): Promise<{ readonly personId: string } | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('organization_membership')
      .select('person_id')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', studentId)
      .where('affiliation', '=', 'student')
      .where('status', '=', 'active')
      .where((eb) => eb.or([eb('valid_from', 'is', null), eb('valid_from', '<=', onDate)]))
      .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>=', onDate)]))
      .executeTakeFirst();
    if (row === undefined) return null;
    return { personId: row.person_id };
  }

  async loadActiveLocation(
    context: TenantTransactionContext,
    organizationId: string,
    locationId: string,
  ): Promise<{ readonly id: string; readonly name: string } | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('location')
      .select(['id', 'name'])
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('id', '=', locationId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (row === undefined) return null;
    return { id: row.id, name: row.name };
  }

  async listByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly ScheduledAuthRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('scheduled_authorization')
      .select(selection())
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .orderBy('valid_from')
      .orderBy('id')
      .execute();
    return rows.map(toRecord);
  }

  async listByStudent(
    context: TenantTransactionContext,
    studentId: string,
  ): Promise<readonly ScheduledAuthRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('scheduled_authorization')
      .select(selection())
      .where('tenant_id', '=', context.tenantId)
      .where('student_id', '=', studentId)
      .orderBy('valid_from')
      .orderBy('id')
      .execute();
    return rows.map(toRecord);
  }

  async loadById(
    context: TenantTransactionContext,
    scheduledAuthorizationId: string,
  ): Promise<ScheduledAuthRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('scheduled_authorization')
      .select(selection())
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', scheduledAuthorizationId)
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async loadForUpdate(
    context: TenantTransactionContext,
    scheduledAuthorizationId: string,
  ): Promise<ScheduledAuthRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('scheduled_authorization')
      .select(selection())
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', scheduledAuthorizationId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async insert(
    context: TenantTransactionContext,
    input: NewScheduledAuth,
  ): Promise<ScheduledAuthRecord> {
    const connection = connectionFor(context);
    const inserted = await connection
      .insertInto('scheduled_authorization')
      .values({
        tenant_id: context.tenantId,
        organization_id: input.organizationId,
        student_id: input.studentId,
        destination_id: input.destinationId,
        created_by_person_id: input.createdByPersonId,
        created_by_account_id: input.createdByAccountId,
        valid_from: toDatabaseInstant(input.validFrom),
        valid_until: toDatabaseInstant(input.validUntil),
        status: 'active',
        approval_mode: input.approvalMode,
        origin_strategy: input.originStrategy,
        origin_location_id: input.originLocationId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const row = await this.loadById(context, inserted.id);
    if (row === null) throw new Error('Scheduled authorization insert did not persist.');
    return row;
  }

  async markUsed(
    context: TenantTransactionContext,
    scheduledAuthorizationId: string,
    expectedRevision: bigint,
    usedByAccountId: string,
    at: Temporal.Instant,
  ): Promise<ScheduledAuthRecord | null> {
    const connection = connectionFor(context);
    const updated = await connection
      .updateTable('scheduled_authorization')
      .set({
        status: 'used',
        used_at: toDatabaseInstant(at),
        used_by_account_id: usedByAccountId,
        revision: String(expectedRevision + 1n),
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', scheduledAuthorizationId)
      .where('revision', '=', String(expectedRevision))
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return null;
    return this.loadById(context, scheduledAuthorizationId);
  }

  async recordAttempt(
    context: TenantTransactionContext,
    scheduledAuthorizationId: string,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<ScheduledAuthRecord | null> {
    const connection = connectionFor(context);
    const updated = await connection
      .updateTable('scheduled_authorization')
      .set({
        last_attempt_at: toDatabaseInstant(at),
        revision: String(expectedRevision + 1n),
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', scheduledAuthorizationId)
      .where('revision', '=', String(expectedRevision))
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return null;
    return this.loadById(context, scheduledAuthorizationId);
  }

  async cancelToRevision(
    context: TenantTransactionContext,
    scheduledAuthorizationId: string,
    expectedRevision: bigint,
    cancelledByAccountId: string,
    at: Temporal.Instant,
  ): Promise<ScheduledAuthRecord | null> {
    const connection = connectionFor(context);
    const updated = await connection
      .updateTable('scheduled_authorization')
      .set({
        status: 'cancelled',
        cancelled_at: toDatabaseInstant(at),
        cancelled_by_account_id: cancelledByAccountId,
        revision: String(expectedRevision + 1n),
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', scheduledAuthorizationId)
      .where('revision', '=', String(expectedRevision))
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return null;
    return this.loadById(context, scheduledAuthorizationId);
  }
}
