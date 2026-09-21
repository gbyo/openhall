import type { Temporal } from '@js-temporal/polyfill';
import { sql } from 'kysely';
import type { CalendarDayKind, ScheduleBlockKind } from '@openhall/domain';
import type {
  CalendarDayRecord,
  ScheduleAdminRepository,
  ScheduleBlockRecord,
  ScheduleBlockStatus,
  ScheduleConfigurationRecord,
  ScheduleSlotRecord,
  ScheduleTemplateRecord,
  TenantTransactionContext,
} from '@openhall/application';
import {
  connectionFor,
  fromDatabaseInstant,
  toBigInt,
  toDatabaseInstant,
} from '../transactions.js';
import { postgresDateToPlainDate, postgresTimeToPlainTime } from '../temporal-types.js';

function blockStatus(value: string): ScheduleBlockStatus {
  return value === 'archived' ? 'archived' : 'active';
}

function blockKind(value: string): ScheduleBlockKind {
  switch (value) {
    case 'lunch':
    case 'advisory':
    case 'transition':
    case 'other':
      return value;
    case 'instructional':
    default:
      return 'instructional';
  }
}

function dayKind(value: string): CalendarDayKind {
  return value === 'non_instructional'
    ? 'non_instructional'
    : value === 'closed'
      ? 'closed'
      : 'instructional';
}

interface BlockRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  code: string;
  display_name: string;
  kind: string;
  status: string;
}

interface TemplateRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  name: string;
  status: string;
}

function toBlockRecord(row: BlockRow): ScheduleBlockRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    code: row.code,
    displayName: row.display_name,
    kind: blockKind(row.kind),
    status: blockStatus(row.status),
  };
}

function toTemplateRecord(row: TemplateRow): ScheduleTemplateRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    name: row.name,
    status: blockStatus(row.status),
  };
}

/** PostgreSQL schedule administration persistence (tenant-scoped, aggregate-locked). */
export class PostgresScheduleAdminRepository implements ScheduleAdminRepository {
  async loadConfiguration(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<ScheduleConfigurationRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('school_schedule_configuration')
      .select(['organization_id', 'revision', 'updated_at'])
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      organizationId: row.organization_id,
      revision: toBigInt(row.revision),
      updatedAt: fromDatabaseInstant(row.updated_at),
    };
  }

  async loadConfigurationForUpdate(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<ScheduleConfigurationRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('school_schedule_configuration')
      .select(['organization_id', 'revision', 'updated_at'])
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      organizationId: row.organization_id,
      revision: toBigInt(row.revision),
      updatedAt: fromDatabaseInstant(row.updated_at),
    };
  }

  async bumpConfigurationRevision(
    context: TenantTransactionContext,
    organizationId: string,
    at: Temporal.Instant,
  ): Promise<ScheduleConfigurationRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('school_schedule_configuration')
      .set({
        revision: sql`revision + 1`,
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .returning(['organization_id', 'revision', 'updated_at'])
      .executeTakeFirstOrThrow();
    return {
      organizationId: row.organization_id,
      revision: toBigInt(row.revision),
      updatedAt: fromDatabaseInstant(row.updated_at),
    };
  }

  async listBlocks(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly ScheduleBlockRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('schedule_block')
      .selectAll('schedule_block')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .orderBy('code')
      .orderBy('id')
      .execute();
    return rows.map(toBlockRecord);
  }

  async loadBlock(
    context: TenantTransactionContext,
    organizationId: string,
    blockId: string,
  ): Promise<ScheduleBlockRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('schedule_block')
      .selectAll('schedule_block')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('id', '=', blockId)
      .executeTakeFirst();
    return row === undefined ? null : toBlockRecord(row);
  }

  async loadBlockByCode(
    context: TenantTransactionContext,
    organizationId: string,
    code: string,
  ): Promise<ScheduleBlockRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('schedule_block')
      .selectAll('schedule_block')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('code', '=', code)
      .executeTakeFirst();
    return row === undefined ? null : toBlockRecord(row);
  }

  async insertBlock(
    context: TenantTransactionContext,
    input: {
      readonly organizationId: string;
      readonly code: string;
      readonly displayName: string;
      readonly kind: ScheduleBlockKind;
    },
  ): Promise<ScheduleBlockRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('schedule_block')
      .values({
        tenant_id: context.tenantId,
        organization_id: input.organizationId,
        code: input.code,
        display_name: input.displayName,
        kind: input.kind,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toBlockRecord(row);
  }

  async updateBlock(
    context: TenantTransactionContext,
    organizationId: string,
    blockId: string,
    input: {
      readonly code: string;
      readonly displayName: string;
      readonly kind: ScheduleBlockKind;
    },
  ): Promise<ScheduleBlockRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('schedule_block')
      .set({
        code: input.code,
        display_name: input.displayName,
        kind: input.kind,
      })
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('id', '=', blockId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toBlockRecord(row);
  }

  async archiveBlock(
    context: TenantTransactionContext,
    organizationId: string,
    blockId: string,
  ): Promise<ScheduleBlockRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('schedule_block')
      .set({ status: 'archived' })
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('id', '=', blockId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toBlockRecord(row);
  }

  async countTemplateSlotsForBlock(
    context: TenantTransactionContext,
    organizationId: string,
    blockId: string,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('schedule_slot')
      .innerJoin('schedule_template', (join) =>
        join
          .onRef('schedule_template.tenant_id', '=', 'schedule_slot.tenant_id')
          .onRef('schedule_template.id', '=', 'schedule_slot.schedule_template_id'),
      )
      .select((builder) => builder.fn.countAll().as('count'))
      .where('schedule_slot.tenant_id', '=', context.tenantId)
      .where('schedule_slot.organization_id', '=', organizationId)
      .where('schedule_slot.schedule_block_id', '=', blockId)
      .where('schedule_template.status', '=', 'active')
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async listTemplates(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly ScheduleTemplateRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('schedule_template')
      .selectAll('schedule_template')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(toTemplateRecord);
  }

  async loadTemplate(
    context: TenantTransactionContext,
    organizationId: string,
    templateId: string,
  ): Promise<ScheduleTemplateRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('schedule_template')
      .selectAll('schedule_template')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('id', '=', templateId)
      .executeTakeFirst();
    return row === undefined ? null : toTemplateRecord(row);
  }

  async insertTemplate(
    context: TenantTransactionContext,
    input: { readonly organizationId: string; readonly name: string },
  ): Promise<ScheduleTemplateRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('schedule_template')
      .values({
        tenant_id: context.tenantId,
        organization_id: input.organizationId,
        name: input.name,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTemplateRecord(row);
  }

  async updateTemplateName(
    context: TenantTransactionContext,
    organizationId: string,
    templateId: string,
    name: string,
  ): Promise<ScheduleTemplateRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('schedule_template')
      .set({ name })
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('id', '=', templateId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toTemplateRecord(row);
  }

  async archiveTemplate(
    context: TenantTransactionContext,
    organizationId: string,
    templateId: string,
  ): Promise<ScheduleTemplateRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('schedule_template')
      .set({ status: 'archived' })
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('id', '=', templateId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toTemplateRecord(row);
  }

  async listSlotsByTemplate(
    context: TenantTransactionContext,
    organizationId: string,
    templateId: string,
  ): Promise<readonly ScheduleSlotRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('schedule_slot')
      .innerJoin('schedule_block', (join) =>
        join
          .onRef('schedule_block.tenant_id', '=', 'schedule_slot.tenant_id')
          .onRef('schedule_block.id', '=', 'schedule_slot.schedule_block_id'),
      )
      .select([
        'schedule_slot.id',
        'schedule_slot.tenant_id',
        'schedule_slot.organization_id',
        'schedule_slot.schedule_template_id',
        'schedule_slot.schedule_block_id',
        'schedule_slot.starts_at',
        'schedule_slot.ends_at',
        'schedule_slot.ordinal',
        'schedule_block.code as block_code',
        'schedule_block.display_name as block_display_name',
        'schedule_block.kind as block_kind',
      ])
      .where('schedule_slot.tenant_id', '=', context.tenantId)
      .where('schedule_slot.organization_id', '=', organizationId)
      .where('schedule_slot.schedule_template_id', '=', templateId)
      .orderBy('schedule_slot.ordinal')
      .orderBy('schedule_slot.id')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      templateId: row.schedule_template_id,
      blockId: row.schedule_block_id,
      startsAt: postgresTimeToPlainTime(row.starts_at),
      endsAt: postgresTimeToPlainTime(row.ends_at),
      ordinal: row.ordinal,
      blockCode: row.block_code,
      blockDisplayName: row.block_display_name,
      blockKind: blockKind(row.block_kind),
    }));
  }

  async replaceTemplateSlots(
    context: TenantTransactionContext,
    input: {
      readonly organizationId: string;
      readonly templateId: string;
      readonly slots: readonly {
        readonly blockId: string;
        readonly startsAt: string;
        readonly endsAt: string;
        readonly ordinal: number;
      }[];
    },
  ): Promise<readonly ScheduleSlotRecord[]> {
    const connection = connectionFor(context);
    await connection
      .deleteFrom('schedule_slot')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', input.organizationId)
      .where('schedule_template_id', '=', input.templateId)
      .execute();
    if (input.slots.length === 0) return [];
    await connection
      .insertInto('schedule_slot')
      .values(
        input.slots.map((slot) => ({
          tenant_id: context.tenantId,
          organization_id: input.organizationId,
          schedule_template_id: input.templateId,
          schedule_block_id: slot.blockId,
          starts_at: slot.startsAt,
          ends_at: slot.endsAt,
          ordinal: slot.ordinal,
        })),
      )
      .execute();
    return this.listSlotsByTemplate(context, input.organizationId, input.templateId);
  }

  async countCurrentOrFutureCalendarAssignmentsForTemplate(
    context: TenantTransactionContext,
    organizationId: string,
    templateId: string,
    today: string,
  ): Promise<number> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('calendar_day')
      .select((builder) => builder.fn.countAll().as('count'))
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('schedule_template_id', '=', templateId)
      .where('date', '>=', today)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async loadDayByDate(
    context: TenantTransactionContext,
    organizationId: string,
    date: string,
  ): Promise<CalendarDayRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('calendar_day')
      .leftJoin('schedule_template', (join) =>
        join
          .onRef('schedule_template.tenant_id', '=', 'calendar_day.tenant_id')
          .onRef('schedule_template.id', '=', 'calendar_day.schedule_template_id'),
      )
      .select([
        'calendar_day.id',
        'calendar_day.tenant_id',
        'calendar_day.organization_id',
        'calendar_day.date',
        'calendar_day.day_kind',
        'calendar_day.schedule_template_id',
        'calendar_day.cycle_code',
        'calendar_day.operational_note',
        'schedule_template.name as template_name',
      ])
      .where('calendar_day.tenant_id', '=', context.tenantId)
      .where('calendar_day.organization_id', '=', organizationId)
      .where('calendar_day.date', '=', date)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      date: postgresDateToPlainDate(row.date),
      dayKind: dayKind(row.day_kind),
      templateId: row.schedule_template_id,
      templateName: row.template_name,
      cycleCode: row.cycle_code,
      operationalNote: row.operational_note,
    };
  }

  async listDaysInRange(
    context: TenantTransactionContext,
    organizationId: string,
    from: string,
    through: string,
  ): Promise<readonly CalendarDayRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('calendar_day')
      .leftJoin('schedule_template', (join) =>
        join
          .onRef('schedule_template.tenant_id', '=', 'calendar_day.tenant_id')
          .onRef('schedule_template.id', '=', 'calendar_day.schedule_template_id'),
      )
      .select([
        'calendar_day.id',
        'calendar_day.tenant_id',
        'calendar_day.organization_id',
        'calendar_day.date',
        'calendar_day.day_kind',
        'calendar_day.schedule_template_id',
        'calendar_day.cycle_code',
        'calendar_day.operational_note',
        'schedule_template.name as template_name',
      ])
      .where('calendar_day.tenant_id', '=', context.tenantId)
      .where('calendar_day.organization_id', '=', organizationId)
      .where('calendar_day.date', '>=', from)
      .where('calendar_day.date', '<=', through)
      .orderBy('calendar_day.date')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      date: postgresDateToPlainDate(row.date),
      dayKind: dayKind(row.day_kind),
      templateId: row.schedule_template_id,
      templateName: row.template_name,
      cycleCode: row.cycle_code,
      operationalNote: row.operational_note,
    }));
  }

  async upsertDay(
    context: TenantTransactionContext,
    input: {
      readonly organizationId: string;
      readonly date: string;
      readonly dayKind: CalendarDayKind;
      readonly templateId: string | null;
      readonly cycleCode: string | null;
      readonly operationalNote: string | null;
    },
  ): Promise<CalendarDayRecord> {
    const connection = connectionFor(context);
    await connection
      .insertInto('calendar_day')
      .values({
        tenant_id: context.tenantId,
        organization_id: input.organizationId,
        date: input.date,
        day_kind: input.dayKind,
        schedule_template_id: input.templateId,
        cycle_code: input.cycleCode,
        operational_note: input.operationalNote,
      })
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'organization_id', 'date']).doUpdateSet({
          day_kind: input.dayKind,
          schedule_template_id: input.templateId,
          cycle_code: input.cycleCode,
          operational_note: input.operationalNote,
        }),
      )
      .execute();
    const row = await this.loadDayByDate(context, input.organizationId, input.date);
    if (row === null) throw new Error('Calendar day upsert failed.');
    return row;
  }
}
