import type { Temporal } from '@js-temporal/polyfill';
import type { DB } from '../database.generated.js';
import type {
  EnrollmentRecord,
  EnrollmentRepository,
  NewEnrollmentGrant,
  TenantTransactionContext,
} from '@openhall/application';
import type { Kysely } from 'kysely';
import {
  connectionFor,
  fromDatabaseInstant,
  toBigInt,
  toDatabaseBytes,
  toDatabaseInstant,
} from '../transactions.js';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

interface EnrollmentRow {
  id: string;
  tenant_id: string;
  organization_id: string;
  account_id: string;
  person_id: string;
  identity_provider_id: string;
  token_hash: Buffer;
  revision: string | bigint | number;
  created_by_account_id: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  revoked_by_account_id: string | null;
}

function toRecord(row: EnrollmentRow): EnrollmentRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    accountId: row.account_id,
    personId: row.person_id,
    identityProviderId: row.identity_provider_id,
    tokenHash: new Uint8Array(row.token_hash),
    revision: toBigInt(row.revision),
    createdByAccountId: row.created_by_account_id,
    createdAt: fromDatabaseInstant(row.created_at),
    expiresAt: fromDatabaseInstant(row.expires_at),
    consumedAt: row.consumed_at === null ? null : fromDatabaseInstant(row.consumed_at),
    revokedAt: row.revoked_at === null ? null : fromDatabaseInstant(row.revoked_at),
    revokedByAccountId: row.revoked_by_account_id,
  };
}

function enrollmentSelection() {
  return [
    'identity_enrollment_grant.id',
    'identity_enrollment_grant.tenant_id',
    'identity_enrollment_grant.organization_id',
    'identity_enrollment_grant.account_id',
    'account.person_id',
    'identity_enrollment_grant.identity_provider_id',
    'identity_enrollment_grant.token_hash',
    'identity_enrollment_grant.revision',
    'identity_enrollment_grant.created_by_account_id',
    'identity_enrollment_grant.created_at',
    'identity_enrollment_grant.expires_at',
    'identity_enrollment_grant.consumed_at',
    'identity_enrollment_grant.revoked_at',
    'identity_enrollment_grant.revoked_by_account_id',
  ] as const;
}

/** PostgreSQL identity enrollment persistence (tenant-scoped + token lookup). */
export class PostgresEnrollmentRepository implements EnrollmentRepository {
  constructor(private readonly database: Kysely<DB>) {}

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

  async loadPerson(
    context: TenantTransactionContext,
    personId: string,
  ): Promise<{ readonly id: string; readonly tenantId: string; readonly status: string } | null> {
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

  async loadActiveMembership(
    context: TenantTransactionContext,
    personId: string,
    organizationId: string,
    onDate: string,
  ): Promise<{ readonly affiliation: string } | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('organization_membership')
      .select('affiliation')
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .where('affiliation', 'in', ['student', 'staff'])
      .where('status', '=', 'active')
      .where((eb) => eb.or([eb('valid_from', 'is', null), eb('valid_from', '<=', onDate)]))
      .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>=', onDate)]))
      .executeTakeFirst();
    if (row === undefined) return null;
    return { affiliation: row.affiliation };
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
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.loadAccountForPerson(context, personId);
      if (existing === null) throw error;
      return existing;
    }
  }

  async hasProviderIdentity(
    context: TenantTransactionContext,
    accountId: string,
    identityProviderId: string,
  ): Promise<boolean> {
    const connection = connectionFor(context);
    const provider = await connection
      .selectFrom('identity_provider')
      .select('issuer')
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', identityProviderId)
      .executeTakeFirst();
    if (provider === undefined) return false;
    const row = await connection
      .selectFrom('auth_identity')
      .select('id')
      .where('tenant_id', '=', context.tenantId)
      .where('account_id', '=', accountId)
      .where('issuer', '=', provider.issuer)
      .executeTakeFirst();
    return row !== undefined;
  }

  async insertGrant(
    context: TenantTransactionContext,
    input: NewEnrollmentGrant,
  ): Promise<EnrollmentRecord | null> {
    const connection = connectionFor(context);
    try {
      const inserted = await connection
        .insertInto('identity_enrollment_grant')
        .values({
          tenant_id: context.tenantId,
          organization_id: input.organizationId,
          account_id: input.accountId,
          identity_provider_id: input.identityProviderId,
          token_hash: toDatabaseBytes(input.tokenHash),
          expires_at: toDatabaseInstant(input.expiresAt),
          created_by_account_id: input.createdByAccountId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const row = await this.loadGrantById(context, inserted.id);
      if (row === null) throw new Error('Enrollment grant insert did not persist.');
      return row;
    } catch (error) {
      // The partial unique index refuses a second live invitation for the
      // same account/provider; report it instead of leaking a driver error.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async loadGrantById(
    context: TenantTransactionContext,
    enrollmentId: string,
  ): Promise<EnrollmentRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('identity_enrollment_grant')
      .innerJoin('account', (join) =>
        join
          .onRef('account.tenant_id', '=', 'identity_enrollment_grant.tenant_id')
          .onRef('account.id', '=', 'identity_enrollment_grant.account_id'),
      )
      .select(enrollmentSelection())
      .where('identity_enrollment_grant.tenant_id', '=', context.tenantId)
      .where('identity_enrollment_grant.id', '=', enrollmentId)
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async loadGrantForUpdate(
    context: TenantTransactionContext,
    enrollmentId: string,
  ): Promise<EnrollmentRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('identity_enrollment_grant')
      .innerJoin('account', (join) =>
        join
          .onRef('account.tenant_id', '=', 'identity_enrollment_grant.tenant_id')
          .onRef('account.id', '=', 'identity_enrollment_grant.account_id'),
      )
      .select(enrollmentSelection())
      .where('identity_enrollment_grant.tenant_id', '=', context.tenantId)
      .where('identity_enrollment_grant.id', '=', enrollmentId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async loadGrantByTokenDigest(tokenHash: Uint8Array): Promise<EnrollmentRecord | null> {
    const row = await this.database
      .selectFrom('identity_enrollment_grant')
      .innerJoin('account', (join) =>
        join
          .onRef('account.tenant_id', '=', 'identity_enrollment_grant.tenant_id')
          .onRef('account.id', '=', 'identity_enrollment_grant.account_id'),
      )
      .select(enrollmentSelection())
      .where('identity_enrollment_grant.token_hash', '=', toDatabaseBytes(tokenHash))
      .executeTakeFirst();
    return row === undefined ? null : toRecord(row);
  }

  async consumeGrant(
    context: TenantTransactionContext,
    enrollmentId: string,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<EnrollmentRecord | null> {
    const connection = connectionFor(context);
    const updated = await connection
      .updateTable('identity_enrollment_grant')
      .set({
        consumed_at: toDatabaseInstant(at),
        revision: String(expectedRevision + 1n),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', enrollmentId)
      .where('revision', '=', String(expectedRevision))
      .where('consumed_at', 'is', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return null;
    return this.loadGrantById(context, enrollmentId);
  }

  async revokeGrant(
    context: TenantTransactionContext,
    enrollmentId: string,
    expectedRevision: bigint,
    revokedByAccountId: string,
    at: Temporal.Instant,
  ): Promise<EnrollmentRecord | null> {
    const connection = connectionFor(context);
    const updated = await connection
      .updateTable('identity_enrollment_grant')
      .set({
        revoked_at: toDatabaseInstant(at),
        revoked_by_account_id: revokedByAccountId,
        revision: String(expectedRevision + 1n),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', enrollmentId)
      .where('revision', '=', String(expectedRevision))
      .where('consumed_at', 'is', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) return null;
    return this.loadGrantById(context, enrollmentId);
  }
}
