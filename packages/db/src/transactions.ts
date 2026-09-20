import { Temporal } from '@js-temporal/polyfill';
import type {
  SystemTransactionContext,
  SystemTransactionRunner,
  TenantTransactionContext,
  TenantTransactionRunner,
} from '@openhall/application';
import type { TenantId as DomainTenantId } from '@openhall/domain';
import type { Kysely, Transaction } from 'kysely';
import type { DB as Database } from './database.generated.js';

/**
 * Registry binding opaque application transaction contexts to the single
 * PostgreSQL transaction they were created for. Application code can only
 * thread the context; only infrastructure resolves the connection.
 */
const transactionConnections = new WeakMap<object, Kysely<Database> | Transaction<Database>>();

export function connectionFor(
  context: TenantTransactionContext | SystemTransactionContext,
): Kysely<Database> | Transaction<Database> {
  const connection = transactionConnections.get(context);
  if (connection === undefined) {
    throw new Error('Unknown transaction context: not created by a PostgreSQL runner');
  }
  return connection;
}

function tenantContext(tenantId: DomainTenantId): TenantTransactionContext {
  // The brand is intentionally unforgeable outside this module: application
  // code receives the context but cannot construct one. The double cast is
  // the single sanctioned bridge between the opaque type and its bearer.
  return { tenantId } as unknown as TenantTransactionContext;
}

function systemContext(): SystemTransactionContext {
  return { system: 'system-bootstrap' } as unknown as SystemTransactionContext;
}

/**
 * Real tenant-scoped PostgreSQL transaction runner. The transaction is
 * short-lived by construction: runners never perform outbound network calls,
 * and use cases keep provider round trips outside the operation callback.
 */
export class PostgresTenantTransactionRunner implements TenantTransactionRunner {
  constructor(private readonly database: Kysely<Database>) {}

  async run<TResult>(
    tenantId: DomainTenantId,
    operation: (context: TenantTransactionContext) => Promise<TResult>,
  ): Promise<TResult> {
    return this.database.transaction().execute(async (transaction) => {
      const context = tenantContext(tenantId);
      transactionConnections.set(context, transaction);
      try {
        return await operation(context);
      } finally {
        transactionConnections.delete(context);
      }
    });
  }
}

/**
 * Explicitly unscoped runner reserved for bootstrap, where no tenant exists
 * yet. Call sites taking a SystemTransactionContext are always obvious.
 */
export class PostgresSystemTransactionRunner implements SystemTransactionRunner {
  constructor(private readonly database: Kysely<Database>) {}

  async run<TResult>(
    operation: (context: SystemTransactionContext) => Promise<TResult>,
  ): Promise<TResult> {
    return this.database.transaction().execute(async (transaction) => {
      const context = systemContext();
      transactionConnections.set(context, transaction);
      try {
        return await operation(context);
      } finally {
        transactionConnections.delete(context);
      }
    });
  }
}

/** Formats an instant for timestamptz columns. */
export function toDatabaseInstant(instant: Temporal.Instant): string {
  return instant.toString();
}

/** Parses PostgreSQL timestamptz text output (space or T separator). */
export function fromDatabaseInstant(value: string): Temporal.Instant {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  return Temporal.Instant.from(normalized);
}

/** Converts bigint-bearing Int8 columns without narrowing through number. */
export function toBigInt(value: string | bigint | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

/** Copies credential bytes into a Buffer for bytea parameters. */
export function toDatabaseBytes(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
}
