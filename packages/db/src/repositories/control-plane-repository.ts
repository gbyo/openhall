import type { Temporal } from '@js-temporal/polyfill';
import type {
  DestinationRecord,
  DestinationRepository,
  DestinationStatus,
  DestinationUpdate,
  LocationRecord,
  LocationRepository,
  LocationUpdate,
  NewDestination,
  NewLocation,
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

function locationStatus(value: string): LocationRecord['status'] {
  return value === 'archived' ? 'archived' : value === 'inactive' ? 'inactive' : 'active';
}

function destinationStatus(value: string): DestinationStatus {
  return value === 'active' ? 'active' : value === 'archived' ? 'archived' : 'closed';
}

function checkInMode(value: string): DestinationRecord['checkInMode'] {
  return value === 'optional' ? 'optional' : value === 'required' ? 'required' : 'none';
}

interface LocationRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  parent_location_id: string | null;
  kind: string;
  name: string;
  code: string | null;
  floor_label: string | null;
  status: string;
  revision: string | bigint | number;
  created_at: string;
  updated_at: string;
}

interface DestinationRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  location_id: string;
  category_id: string;
  student_self_requestable: boolean;
  service_type: string;
  display_name: string | null;
  capacity: number | null;
  queue_enabled: boolean;
  check_in_mode: string;
  default_duration_seconds: number | null;
  max_duration_seconds: number | null;
  ready_claim_timeout_seconds: number;
  queue_timeout_seconds: number;
  status: string;
  revision: string | bigint | number;
  updated_at: string;
}

function toLocationRecord(row: LocationRow): LocationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    parentLocationId: row.parent_location_id,
    kind: row.kind,
    name: row.name,
    code: row.code,
    floorLabel: row.floor_label,
    status: locationStatus(row.status),
    revision: toBigInt(row.revision),
    createdAt: fromDatabaseInstant(row.created_at),
    updatedAt: fromDatabaseInstant(row.updated_at),
  };
}

function toDestinationRecord(row: DestinationRow): DestinationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    locationId: row.location_id,
    categoryId: row.category_id,
    studentSelfRequestable: row.student_self_requestable,
    serviceType: row.service_type,
    displayName: row.display_name,
    capacity: row.capacity,
    queueEnabled: row.queue_enabled,
    checkInMode: checkInMode(row.check_in_mode),
    defaultDurationSeconds: row.default_duration_seconds,
    maxDurationSeconds: row.max_duration_seconds,
    readyClaimTimeoutSeconds: row.ready_claim_timeout_seconds,
    queueTimeoutSeconds: row.queue_timeout_seconds,
    status: destinationStatus(row.status),
    revision: toBigInt(row.revision),
    updatedAt: fromDatabaseInstant(row.updated_at),
  };
}

/** PostgreSQL location administration persistence (tenant-scoped, no unscoped path). */
export class PostgresLocationRepository implements LocationRepository {
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
  ): Promise<readonly LocationRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('location')
      .selectAll('location')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(toLocationRecord);
  }

  async loadById(
    context: TenantTransactionContext,
    locationId: string,
  ): Promise<LocationRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('location')
      .selectAll('location')
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', locationId)
      .executeTakeFirst();
    return row === undefined ? null : toLocationRecord(row);
  }

  async loadForUpdate(
    context: TenantTransactionContext,
    locationId: string,
  ): Promise<LocationRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('location')
      .selectAll('location')
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', locationId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? null : toLocationRecord(row);
  }

  async listHierarchyPairs(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly { readonly id: string; readonly parentLocationId: string | null }[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('location')
      .select(['id', 'parent_location_id'])
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .execute();
    return rows.map((row) => ({ id: row.id, parentLocationId: row.parent_location_id }));
  }

  async insert(context: TenantTransactionContext, input: NewLocation): Promise<LocationRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('location')
      .values({
        tenant_id: context.tenantId,
        organization_id: input.organizationId,
        parent_location_id: input.parentLocationId,
        kind: input.kind,
        name: input.name,
        code: input.code,
        floor_label: input.floorLabel,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toLocationRecord(row);
  }

  async updateToRevision(
    context: TenantTransactionContext,
    locationId: string,
    expectedRevision: bigint,
    update: LocationUpdate,
    at: Temporal.Instant,
  ): Promise<LocationRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('location')
      .set({
        parent_location_id: update.parentLocationId,
        kind: update.kind,
        name: update.name,
        code: update.code,
        floor_label: update.floorLabel,
        revision: String(expectedRevision + 1n),
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', locationId)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toLocationRecord(row);
  }

  async archiveToRevision(
    context: TenantTransactionContext,
    locationId: string,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<LocationRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('location')
      .set({
        status: 'archived',
        revision: String(expectedRevision + 1n),
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', locationId)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toLocationRecord(row);
  }

  async countActiveDestinationReferences(
    context: TenantTransactionContext,
    locationId: string,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('destination')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('location_id', '=', locationId)
      .where('status', '<>', 'archived')
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async countRelevantSectionMeetings(
    context: TenantTransactionContext,
    locationId: string,
    today: string,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('section_meeting')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('section_meeting.tenant_id', '=', context.tenantId)
      .where('section_meeting.location_id', '=', locationId)
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
    locationId: string,
    now: Temporal.Instant,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('scheduled_authorization')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('origin_location_id', '=', locationId)
      .where('status', '=', 'active')
      .where('valid_until', '>', toDatabaseInstant(now))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}

/** PostgreSQL destination administration persistence (tenant-scoped, no unscoped path). */
export class PostgresDestinationRepository implements DestinationRepository {
  async listByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly DestinationRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('destination')
      .selectAll('destination')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .orderBy('service_type')
      .orderBy('id')
      .execute();
    return rows.map(toDestinationRecord);
  }

  async listActiveCatalog(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly DestinationRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('destination')
      .selectAll('destination')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active')
      .orderBy('service_type')
      .orderBy('id')
      .execute();
    return rows.map(toDestinationRecord);
  }

  async loadById(
    context: TenantTransactionContext,
    destinationId: string,
  ): Promise<DestinationRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('destination')
      .selectAll('destination')
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', destinationId)
      .executeTakeFirst();
    return row === undefined ? null : toDestinationRecord(row);
  }

  async loadForUpdate(
    context: TenantTransactionContext,
    destinationId: string,
  ): Promise<DestinationRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('destination')
      .selectAll('destination')
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', destinationId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? null : toDestinationRecord(row);
  }

  async insert(
    context: TenantTransactionContext,
    input: NewDestination,
  ): Promise<DestinationRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('destination')
      .values({
        tenant_id: context.tenantId,
        organization_id: input.organizationId,
        location_id: input.locationId,
        category_id: input.categoryId,
        student_self_requestable: input.studentSelfRequestable,
        service_type: input.serviceType,
        display_name: input.displayName,
        capacity: input.capacity,
        queue_enabled: input.queueEnabled,
        check_in_mode: input.checkInMode,
        default_duration_seconds: input.defaultDurationSeconds,
        max_duration_seconds: input.maxDurationSeconds,
        ready_claim_timeout_seconds: input.readyClaimTimeoutSeconds,
        queue_timeout_seconds: input.queueTimeoutSeconds,
        status: 'closed',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toDestinationRecord(row);
  }

  async updateToRevision(
    context: TenantTransactionContext,
    destinationId: string,
    expectedRevision: bigint,
    update: DestinationUpdate,
    at: Temporal.Instant,
  ): Promise<DestinationRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('destination')
      .set({
        location_id: update.locationId,
        category_id: update.categoryId,
        student_self_requestable: update.studentSelfRequestable,
        service_type: update.serviceType,
        display_name: update.displayName,
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
      .where('id', '=', destinationId)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toDestinationRecord(row);
  }

  async transitionStatusToRevision(
    context: TenantTransactionContext,
    destinationId: string,
    expectedRevision: bigint,
    status: DestinationStatus,
    at: Temporal.Instant,
  ): Promise<DestinationRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('destination')
      .set({
        status,
        revision: String(expectedRevision + 1n),
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', destinationId)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toDestinationRecord(row);
  }

  async countLivePasses(context: TenantTransactionContext, destinationId: string): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('pass')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('destination_id', '=', destinationId)
      .where('lifecycle_state', 'in', LIVE_PASS_STATES)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async countActiveStaffGrants(
    context: TenantTransactionContext,
    destinationId: string,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('authorization_grant')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('destination_id', '=', destinationId)
      .where('role', '=', 'destination_staff')
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async countEnabledPolicyRules(
    context: TenantTransactionContext,
    destinationId: string,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('policy_rule')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('scope_kind', '=', 'destination')
      .where('scope_destination_id', '=', destinationId)
      .where('enabled', '=', true)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async countLiveScheduledAuthorizations(
    context: TenantTransactionContext,
    destinationId: string,
    now: Temporal.Instant,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('scheduled_authorization')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('destination_id', '=', destinationId)
      .where('status', '=', 'active')
      .where('valid_until', '>', toDatabaseInstant(now))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}
