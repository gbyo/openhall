import type { Temporal } from '@js-temporal/polyfill';
import type {
  DestinationCategoryRecord,
  DestinationCategoryRepository,
  DestinationCategoryUpdate,
  NewDestinationCategory,
} from '@openhall/application';
import type { TenantTransactionContext } from '@openhall/application';
import {
  connectionFor,
  fromDatabaseInstant,
  toBigInt,
  toDatabaseInstant,
} from '../transactions.js';

function categoryStatus(value: string): DestinationCategoryRecord['status'] {
  return value === 'archived' ? 'archived' : 'active';
}

function studentSurface(value: string): DestinationCategoryRecord['studentSurface'] {
  if (value === 'primary' || value === 'hidden') return value;
  return 'secondary';
}

interface DestinationCategoryRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  name: string;
  icon_key: string;
  tone_key: string;
  student_surface: string;
  sort_order: number;
  status: string;
  revision: string | bigint | number;
  created_at: string;
  updated_at: string;
}

function toDestinationCategoryRecord(row: DestinationCategoryRow): DestinationCategoryRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    name: row.name,
    iconKey: row.icon_key,
    toneKey: row.tone_key,
    studentSurface: studentSurface(row.student_surface),
    sortOrder: row.sort_order,
    status: categoryStatus(row.status),
    revision: toBigInt(row.revision),
    createdAt: fromDatabaseInstant(row.created_at),
    updatedAt: fromDatabaseInstant(row.updated_at),
  };
}

/** PostgreSQL destination-category persistence (tenant-scoped, no unscoped path). */
export class PostgresDestinationCategoryRepository implements DestinationCategoryRepository {
  async listByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly DestinationCategoryRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('destination_category')
      .selectAll('destination_category')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .orderBy('sort_order')
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(toDestinationCategoryRecord);
  }

  async loadById(
    context: TenantTransactionContext,
    categoryId: string,
  ): Promise<DestinationCategoryRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('destination_category')
      .selectAll('destination_category')
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', categoryId)
      .executeTakeFirst();
    return row === undefined ? null : toDestinationCategoryRecord(row);
  }

  async loadForUpdate(
    context: TenantTransactionContext,
    categoryId: string,
  ): Promise<DestinationCategoryRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('destination_category')
      .selectAll('destination_category')
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', categoryId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? null : toDestinationCategoryRecord(row);
  }

  async insert(
    context: TenantTransactionContext,
    input: NewDestinationCategory,
  ): Promise<DestinationCategoryRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('destination_category')
      .values({
        tenant_id: context.tenantId,
        organization_id: input.organizationId,
        name: input.name,
        icon_key: input.iconKey,
        tone_key: input.toneKey,
        student_surface: input.studentSurface,
        sort_order: input.sortOrder,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toDestinationCategoryRecord(row);
  }

  async updateToRevision(
    context: TenantTransactionContext,
    categoryId: string,
    expectedRevision: bigint,
    update: DestinationCategoryUpdate,
    at: Temporal.Instant,
  ): Promise<DestinationCategoryRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('destination_category')
      .set({
        name: update.name,
        icon_key: update.iconKey,
        tone_key: update.toneKey,
        student_surface: update.studentSurface,
        sort_order: update.sortOrder,
        revision: String(expectedRevision + 1n),
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', categoryId)
      .where('revision', '=', String(expectedRevision))
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toDestinationCategoryRecord(row);
  }

  async archiveToRevision(
    context: TenantTransactionContext,
    categoryId: string,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<DestinationCategoryRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('destination_category')
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
    return row === undefined ? null : toDestinationCategoryRecord(row);
  }

  async countActiveDestinationReferences(
    context: TenantTransactionContext,
    categoryId: string,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('destination')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('category_id', '=', categoryId)
      .where('status', '!=', 'archived')
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}
