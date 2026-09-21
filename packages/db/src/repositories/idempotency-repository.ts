import { sql } from 'kysely';
import type { IdempotencyTransactionStore, StoredCommandRecord } from '@openhall/application';
import type { TenantTransactionContext } from '@openhall/application';
import type { Temporal } from '@js-temporal/polyfill';
import { connectionFor, fromDatabaseInstant, toDatabaseInstant } from '../transactions.js';

interface Lookup {
  readonly tenantId: string;
  readonly actorAccountId: string;
  readonly command: string;
  readonly key: string;
}

/**
 * Transaction-scoped idempotency storage. The advisory lock is
 * transaction-level and releases automatically on commit/rollback.
 */
export class PostgresIdempotencyRepository implements IdempotencyTransactionStore {
  async acquireAdvisoryLock(context: TenantTransactionContext, lockKey: bigint): Promise<void> {
    const connection = connectionFor(context);
    await sql`SELECT pg_advisory_xact_lock(${lockKey})`.execute(connection);
  }

  async find(
    context: TenantTransactionContext,
    lookup: Lookup,
  ): Promise<StoredCommandRecord | undefined> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('idempotency_record')
      .select(['request_fingerprint', 'expires_at', 'response_status', 'response_body'])
      .where('tenant_id', '=', lookup.tenantId)
      .where('actor_account_id', '=', lookup.actorAccountId)
      .where('command', '=', lookup.command)
      .where('idempotency_key', '=', lookup.key)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      fingerprint: row.request_fingerprint,
      expiresAt: fromDatabaseInstant(row.expires_at),
      responseStatus: row.response_status,
      responseBody: row.response_body as unknown,
    };
  }

  async delete(context: TenantTransactionContext, lookup: Lookup): Promise<void> {
    const connection = connectionFor(context);
    await connection
      .deleteFrom('idempotency_record')
      .where('tenant_id', '=', lookup.tenantId)
      .where('actor_account_id', '=', lookup.actorAccountId)
      .where('command', '=', lookup.command)
      .where('idempotency_key', '=', lookup.key)
      .execute();
  }

  async store(
    context: TenantTransactionContext,
    identity: Lookup & { readonly fingerprint: string },
    result: { readonly responseStatus: number; readonly responseBody: unknown },
    expiresAt: Temporal.Instant,
  ): Promise<void> {
    const connection = connectionFor(context);
    await connection
      .insertInto('idempotency_record')
      .values({
        tenant_id: identity.tenantId,
        actor_account_id: identity.actorAccountId,
        command: identity.command,
        idempotency_key: identity.key,
        request_fingerprint: identity.fingerprint,
        response_status: result.responseStatus,
        response_body: result.responseBody as never,
        expires_at: toDatabaseInstant(expiresAt),
      })
      .execute();
  }
}
