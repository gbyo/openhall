import type { Temporal } from '@js-temporal/polyfill';
import type {
  GrantAdminRepository,
  GrantRecord,
  GrantTargetPerson,
  NewGrant,
  TenantTransactionContext,
} from '@openhall/application';
import {
  connectionFor,
  fromDatabaseInstant,
  toBigInt,
  toDatabaseInstant,
} from '../transactions.js';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

interface GrantRow {
  id: string;
  tenant_id: string;
  account_id: string;
  person_id: string;
  person_display_name: string;
  role: string;
  scope_kind: string;
  organization_id: string | null;
  destination_id: string | null;
  destination_display_name: string | null;
  status: string;
  valid_from: string | null;
  valid_until: string | null;
  revision: string | bigint | number;
  created_by_account_id: string | null;
  revoked_at: string | null;
  revoked_by_account_id: string | null;
  created_at: string;
}

function toRecord(row: GrantRow): GrantRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    personId: row.person_id,
    personDisplayName: row.person_display_name,
    role: row.role,
    scopeKind: row.scope_kind,
    organizationId: row.organization_id,
    destinationId: row.destination_id,
    destinationDisplayName: row.destination_display_name,
    status: row.status,
    validFrom: row.valid_from === null ? null : fromDatabaseInstant(row.valid_from),
    validUntil: row.valid_until === null ? null : fromDatabaseInstant(row.valid_until),
    revision: toBigInt(row.revision),
    createdByAccountId: row.created_by_account_id,
    revokedAt: row.revoked_at === null ? null : fromDatabaseInstant(row.revoked_at),
    revokedByAccountId: row.revoked_by_account_id,
    createdAt: fromDatabaseInstant(row.created_at),
  };
}

/** Columns for the grant row joined to its account for the person handle. */
function grantSelection() {
  return [
    'authorization_grant.id',
    'authorization_grant.tenant_id',
    'authorization_grant.account_id',
    'account.person_id',
    'person.display_name as person_display_name',
    'authorization_grant.role',
    'authorization_grant.scope_kind',
    'authorization_grant.organization_id',
    'authorization_grant.destination_id',
    'destination.display_name as destination_display_name',
    'authorization_grant.status',
    'authorization_grant.valid_from',
    'authorization_grant.valid_until',
    'authorization_grant.revision',
    'authorization_grant.created_by_account_id',
    'authorization_grant.revoked_at',
    'authorization_grant.revoked_by_account_id',
    'authorization_grant.created_at',
  ] as const;
}

/** PostgreSQL authorization grant administration persistence (tenant-scoped). */
export class PostgresGrantAdminRepository implements GrantAdminRepository {
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

  async listByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly GrantRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('authorization_grant')
      .innerJoin('account', (join) =>
        join
          .onRef('account.tenant_id', '=', 'authorization_grant.tenant_id')
          .onRef('account.id', '=', 'authorization_grant.account_id'),
      )
      .innerJoin('person', (join) =>
        join
          .onRef('person.tenant_id', '=', 'account.tenant_id')
          .onRef('person.id', '=', 'account.person_id'),
      )
      .leftJoin('destination', (join) =>
        join
          .onRef('destination.tenant_id', '=', 'authorization_grant.tenant_id')
          .onRef('destination.id', '=', 'authorization_grant.destination_id'),
      )
      .select(grantSelection())
      .where('authorization_grant.tenant_id', '=', context.tenantId)
      .where((eb) =>
        eb.or([
          eb('authorization_grant.organization_id', '=', organizationId),
          eb('destination.organization_id', '=', organizationId),
        ]),
      )
      .orderBy('authorization_grant.created_at', 'desc')
      .orderBy('authorization_grant.id', 'desc')
      .execute();
    return rows.map((row) => toRecord(row));
  }

  async loadById(context: TenantTransactionContext, grantId: string): Promise<GrantRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('authorization_grant')
      .innerJoin('account', (join) =>
        join
          .onRef('account.tenant_id', '=', 'authorization_grant.tenant_id')
          .onRef('account.id', '=', 'authorization_grant.account_id'),
      )
      .innerJoin('person', (join) =>
        join
          .onRef('person.tenant_id', '=', 'account.tenant_id')
          .onRef('person.id', '=', 'account.person_id'),
      )
      .leftJoin('destination', (join) =>
        join
          .onRef('destination.tenant_id', '=', 'authorization_grant.tenant_id')
          .onRef('destination.id', '=', 'authorization_grant.destination_id'),
      )
      .select(grantSelection())
      .where('authorization_grant.tenant_id', '=', context.tenantId)
      .where('authorization_grant.id', '=', grantId)
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async loadForUpdate(
    context: TenantTransactionContext,
    grantId: string,
  ): Promise<GrantRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('authorization_grant')
      .innerJoin('account', (join) =>
        join
          .onRef('account.tenant_id', '=', 'authorization_grant.tenant_id')
          .onRef('account.id', '=', 'authorization_grant.account_id'),
      )
      .innerJoin('person', (join) =>
        join
          .onRef('person.tenant_id', '=', 'account.tenant_id')
          .onRef('person.id', '=', 'account.person_id'),
      )
      .leftJoin('destination', (join) =>
        join
          .onRef('destination.tenant_id', '=', 'authorization_grant.tenant_id')
          .onRef('destination.id', '=', 'authorization_grant.destination_id'),
      )
      .select(grantSelection())
      .where('authorization_grant.tenant_id', '=', context.tenantId)
      .where('authorization_grant.id', '=', grantId)
      .forUpdate('authorization_grant')
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async loadPerson(
    context: TenantTransactionContext,
    personId: string,
  ): Promise<GrantTargetPerson | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('person')
      .select(['id', 'tenant_id', 'status'])
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', personId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return { id: row.id, tenantId: row.tenant_id, status: row.status };
  }

  async loadActiveStaffMembership(
    context: TenantTransactionContext,
    personId: string,
    organizationId: string,
    onDate: string,
  ): Promise<{ readonly personId: string } | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('organization_membership')
      .select('person_id')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .where('affiliation', '=', 'staff')
      .where('status', '=', 'active')
      .where((eb) => eb.or([eb('valid_from', 'is', null), eb('valid_from', '<=', onDate)]))
      .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>=', onDate)]))
      .executeTakeFirst();
    if (row === undefined) return null;
    return { personId: row.person_id };
  }

  async loadAccountForPerson(
    context: TenantTransactionContext,
    personId: string,
  ): Promise<{ readonly id: string } | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('account')
      .select('id')
      .where('tenant_id', '=', context.tenantId)
      .where('person_id', '=', personId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return { id: row.id };
  }

  async insertAccount(
    context: TenantTransactionContext,
    personId: string,
  ): Promise<{ readonly id: string }> {
    const connection = connectionFor(context);
    try {
      const row = await connection
        .insertInto('account')
        .values({ tenant_id: context.tenantId, person_id: personId })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { id: row.id };
    } catch (error) {
      // A concurrent issue created the account first; reuse it instead of
      // failing the duty that both administrators intended.
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.loadAccountForPerson(context, personId);
      if (existing === null) throw error;
      return existing;
    }
  }

  async insertActive(
    context: TenantTransactionContext,
    input: NewGrant,
  ): Promise<GrantRecord | null> {
    const connection = connectionFor(context);
    try {
      await connection
        .insertInto('authorization_grant')
        .values({
          tenant_id: context.tenantId,
          account_id: input.accountId,
          role: input.role,
          scope_kind: input.scopeKind,
          organization_id: input.organizationId,
          destination_id: input.destinationId,
          status: 'active',
          valid_from: input.validFrom === null ? null : toDatabaseInstant(input.validFrom),
          valid_until: input.validUntil === null ? null : toDatabaseInstant(input.validUntil),
          created_by_account_id: input.createdByAccountId,
        })
        .execute();
    } catch (error) {
      // The partial unique indexes reject a second live copy of the same
      // duty; report it as a duplicate instead of a driver error.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
    // The partial unique indexes guarantee at most one live copy of this
    // exact duty, so re-selecting it is deterministic.
    const row = await connection
      .selectFrom('authorization_grant')
      .innerJoin('account', (join) =>
        join
          .onRef('account.tenant_id', '=', 'authorization_grant.tenant_id')
          .onRef('account.id', '=', 'authorization_grant.account_id'),
      )
      .innerJoin('person', (join) =>
        join
          .onRef('person.tenant_id', '=', 'account.tenant_id')
          .onRef('person.id', '=', 'account.person_id'),
      )
      .leftJoin('destination', (join) =>
        join
          .onRef('destination.tenant_id', '=', 'authorization_grant.tenant_id')
          .onRef('destination.id', '=', 'authorization_grant.destination_id'),
      )
      .select(grantSelection())
      .where('authorization_grant.tenant_id', '=', context.tenantId)
      .where('authorization_grant.account_id', '=', input.accountId)
      .where('authorization_grant.role', '=', input.role)
      .where('authorization_grant.status', '=', 'active')
      .where((eb) =>
        input.organizationId === null
          ? eb('authorization_grant.organization_id', 'is', null)
          : eb('authorization_grant.organization_id', '=', input.organizationId),
      )
      .where((eb) =>
        input.destinationId === null
          ? eb('authorization_grant.destination_id', 'is', null)
          : eb('authorization_grant.destination_id', '=', input.destinationId),
      )
      .executeTakeFirst();
    if (row === undefined) throw new Error('Grant insert did not persist.');
    return toRecord(row);
  }

  async revokeToRevision(
    context: TenantTransactionContext,
    grantId: string,
    expectedRevision: bigint,
    revokedByAccountId: string,
    at: Temporal.Instant,
  ): Promise<GrantRecord | null> {
    const connection = connectionFor(context);
    const updated = await connection
      .updateTable('authorization_grant')
      .set({
        status: 'revoked',
        revision: String(expectedRevision + 1n),
        revoked_at: toDatabaseInstant(at),
        revoked_by_account_id: revokedByAccountId,
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', grantId)
      .where('revision', '=', String(expectedRevision))
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return null;
    return this.loadById(context, grantId);
  }
}
