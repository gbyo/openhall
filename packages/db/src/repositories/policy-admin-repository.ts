import type { Temporal } from '@js-temporal/polyfill';
import type {
  PolicyAdminRepository,
  PolicyRuleRecord,
  PolicyRuleWrite,
  PolicyScopeKind,
  TenantTransactionContext,
} from '@openhall/application';
import { connectionFor, fromDatabaseInstant, toDatabaseInstant } from '../transactions.js';
import type { JsonObject } from '../database.generated.js';

/** Normalizes validated configuration to plain JSON for the jsonb column. */
function toJsonb(value: unknown): JsonObject {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) {
    throw new Error('Policy configuration must be a JSON object.');
  }
  return normalized as JsonObject;
}

function scopeKind(value: string): PolicyScopeKind {
  if (value === 'section') return 'section';
  if (value === 'room') return 'room';
  if (value === 'room_category') return 'room_category';
  return 'organization';
}

interface PolicyRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  name: string;
  rule_type: string;
  scope_kind: string;
  scope_organization_id: string | null;
  scope_section_id: string | null;
  scope_room_id: string | null;
  scope_room_category_id: string | null;
  priority: number;
  configuration: unknown;
  override_mode: string;
  enabled: boolean;
  valid_from: string | null;
  valid_until: string | null;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: PolicyRow): PolicyRuleRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    name: row.name,
    ruleType: row.rule_type,
    scopeKind: scopeKind(row.scope_kind),
    scopeOrganizationId: row.scope_organization_id,
    scopeSectionId: row.scope_section_id,
    scopeRoomId: row.scope_room_id,
    scopeRoomCategoryId: row.scope_room_category_id,
    priority: row.priority,
    configuration: row.configuration,
    overrideMode: row.override_mode,
    enabled: row.enabled,
    validFrom: row.valid_from === null ? null : fromDatabaseInstant(row.valid_from),
    validUntil: row.valid_until === null ? null : fromDatabaseInstant(row.valid_until),
    revision: row.revision,
    archivedAt: row.archived_at === null ? null : fromDatabaseInstant(row.archived_at),
    createdAt: fromDatabaseInstant(row.created_at),
    updatedAt: fromDatabaseInstant(row.updated_at),
  };
}

/** PostgreSQL policy rule administration persistence (tenant-scoped). */
export class PostgresPolicyAdminRepository implements PolicyAdminRepository {
  async listByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly PolicyRuleRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('policy_rule')
      .selectAll('policy_rule')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .orderBy('priority', 'desc')
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(toRecord);
  }

  async loadById(
    context: TenantTransactionContext,
    ruleId: string,
  ): Promise<PolicyRuleRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('policy_rule')
      .selectAll('policy_rule')
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', ruleId)
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async loadForUpdate(
    context: TenantTransactionContext,
    ruleId: string,
  ): Promise<PolicyRuleRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('policy_rule')
      .selectAll('policy_rule')
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', ruleId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async insert(
    context: TenantTransactionContext,
    input: PolicyRuleWrite & { readonly organizationId: string },
  ): Promise<PolicyRuleRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('policy_rule')
      .values({
        tenant_id: context.tenantId,
        organization_id: input.organizationId,
        name: input.name,
        rule_type: input.ruleType,
        scope_kind: input.scopeKind,
        scope_organization_id: input.scopeOrganizationId,
        scope_section_id: input.scopeSectionId,
        scope_room_category_id: input.scopeRoomCategoryId,
        scope_room_id: input.scopeRoomId,
        priority: input.priority,
        configuration: toJsonb(input.configuration),
        override_mode: input.overrideMode,
        enabled: false,
        valid_from: input.validFrom === null ? null : toDatabaseInstant(input.validFrom),
        valid_until: input.validUntil === null ? null : toDatabaseInstant(input.validUntil),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }

  async updateToRevision(
    context: TenantTransactionContext,
    ruleId: string,
    expectedRevision: number,
    input: PolicyRuleWrite,
    at: Temporal.Instant,
  ): Promise<PolicyRuleRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('policy_rule')
      .set({
        name: input.name,
        rule_type: input.ruleType,
        scope_kind: input.scopeKind,
        scope_organization_id: input.scopeOrganizationId,
        scope_section_id: input.scopeSectionId,
        scope_room_category_id: input.scopeRoomCategoryId,
        scope_room_id: input.scopeRoomId,
        priority: input.priority,
        configuration: toJsonb(input.configuration),
        override_mode: input.overrideMode,
        valid_from: input.validFrom === null ? null : toDatabaseInstant(input.validFrom),
        valid_until: input.validUntil === null ? null : toDatabaseInstant(input.validUntil),
        revision: expectedRevision + 1,
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', ruleId)
      .where('revision', '=', expectedRevision)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async setEnabledToRevision(
    context: TenantTransactionContext,
    ruleId: string,
    expectedRevision: number,
    enabled: boolean,
    at: Temporal.Instant,
  ): Promise<PolicyRuleRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('policy_rule')
      .set({
        enabled,
        revision: expectedRevision + 1,
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', ruleId)
      .where('revision', '=', expectedRevision)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async archiveToRevision(
    context: TenantTransactionContext,
    ruleId: string,
    expectedRevision: number,
    at: Temporal.Instant,
  ): Promise<PolicyRuleRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('policy_rule')
      .set({
        enabled: false,
        archived_at: toDatabaseInstant(at),
        revision: expectedRevision + 1,
        updated_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', ruleId)
      .where('revision', '=', expectedRevision)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async loadSectionSchool(
    context: TenantTransactionContext,
    sectionId: string,
  ): Promise<{ readonly organizationId: string; readonly status: string } | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('section')
      .select(['organization_id', 'status'])
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', sectionId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return { organizationId: row.organization_id, status: row.status };
  }
}
