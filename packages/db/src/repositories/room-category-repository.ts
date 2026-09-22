import type { Temporal } from '@js-temporal/polyfill';
import type {
  RoomCategoryRecord,
  RoomCategoryRepository,
  RoomCategoryUpdate,
  NewRoomCategory,
} from '@openhall/application';
import type { TenantTransactionContext } from '@openhall/application';
import {
  connectionFor,
  fromDatabaseInstant,
  toBigInt,
  toDatabaseInstant,
} from '../transactions.js';

function categoryStatus(value: string): RoomCategoryRecord['status'] {
  return value === 'archived' ? 'archived' : 'active';
}

function studentSurface(value: string): RoomCategoryRecord['studentSurface'] {
  if (value === 'primary' || value === 'hidden') return value;
  return 'secondary';
}

function pickerMode(value: string): RoomCategoryRecord['pickerMode'] {
  if (value === 'list' || value === 'search') return value;
  return 'auto';
}

interface RoomCategoryRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  name: string;
  icon_key: string;
  tone_key: string;
  student_surface: string;
  picker_mode: string;
  sort_order: number;
  status: string;
  revision: string | bigint | number;
  created_at: string;
  updated_at: string;
}

function toRoomCategoryRecord(row: RoomCategoryRow): RoomCategoryRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    name: row.name,
    iconKey: row.icon_key,
    toneKey: row.tone_key,
    studentSurface: studentSurface(row.student_surface),
    pickerMode: pickerMode(row.picker_mode),
    sortOrder: row.sort_order,
    status: categoryStatus(row.status),
    revision: toBigInt(row.revision),
    createdAt: fromDatabaseInstant(row.created_at),
    updatedAt: fromDatabaseInstant(row.updated_at),
  };
}

/** PostgreSQL room-category persistence (tenant-scoped, no unscoped path). */
export class PostgresRoomCategoryRepository implements RoomCategoryRepository {
  async listByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly RoomCategoryRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('room_category')
      .selectAll('room_category')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .orderBy('sort_order')
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(toRoomCategoryRecord);
  }

  async loadById(
    context: TenantTransactionContext,
    categoryId: string,
  ): Promise<RoomCategoryRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('room_category')
      .selectAll('room_category')
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', categoryId)
      .executeTakeFirst();
    return row === undefined ? null : toRoomCategoryRecord(row);
  }

  async loadForUpdate(
    context: TenantTransactionContext,
    categoryId: string,
  ): Promise<RoomCategoryRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('room_category')
      .selectAll('room_category')
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', categoryId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? null : toRoomCategoryRecord(row);
  }

  async insert(
    context: TenantTransactionContext,
    input: NewRoomCategory,
  ): Promise<RoomCategoryRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('room_category')
      .values({
        tenant_id: context.tenantId,
        organization_id: input.organizationId,
        name: input.name,
        icon_key: input.iconKey,
        tone_key: input.toneKey,
        student_surface: input.studentSurface,
        picker_mode: input.pickerMode,
        sort_order: input.sortOrder,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRoomCategoryRecord(row);
  }

  async updateToRevision(
    context: TenantTransactionContext,
    categoryId: string,
    expectedRevision: bigint,
    update: RoomCategoryUpdate,
    at: Temporal.Instant,
  ): Promise<RoomCategoryRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('room_category')
      .set({
        name: update.name,
        icon_key: update.iconKey,
        tone_key: update.toneKey,
        student_surface: update.studentSurface,
        picker_mode: update.pickerMode,
        sort_order: update.sortOrder,
        revision: String(expectedRevision + 1n),
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', categoryId)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toRoomCategoryRecord(row);
  }

  async archiveToRevision(
    context: TenantTransactionContext,
    categoryId: string,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<RoomCategoryRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('room_category')
      .set({
        status: 'archived',
        revision: String(expectedRevision + 1n),
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', categoryId)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toRoomCategoryRecord(row);
  }

  async countActiveRoomReferences(
    context: TenantTransactionContext,
    categoryId: string,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('room')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('category_id', '=', categoryId)
      .where('status', '!=', 'archived')
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}
