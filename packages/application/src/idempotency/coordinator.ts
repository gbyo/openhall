import { Temporal } from '@js-temporal/polyfill';
import type { AccountId, TenantId } from '@openhall/domain';
import type { TenantTransactionContext, TenantTransactionRunner } from '../persistence.js';
import { PassApplicationError } from '../passes/errors.js';
import { IDEMPOTENCY_TTL_HOURS } from '../passes/idempotency.js';

export interface IdempotentIdentity {
  readonly tenantId: TenantId;
  readonly actorAccountId: AccountId;
  readonly command: string;
  readonly key: string;
  readonly fingerprint: string;
}

export interface StoredCommandRecord {
  readonly fingerprint: string;
  readonly expiresAt: Temporal.Instant;
  readonly responseStatus: number;
  readonly responseBody: unknown;
}

/**
 * Transaction-scoped idempotency storage. Implementations must run every
 * method on the given tenant transaction connection; the advisory lock is
 * transaction-level (pg_advisory_xact_lock) and releases on commit/rollback.
 * Generic across future policy/destination/admin/incident commands; command
 * fingerprints stay domain-owned by each use case.
 */
export interface IdempotencyTransactionStore {
  acquireAdvisoryLock(context: TenantTransactionContext, lockKey: bigint): Promise<void>;
  find(
    context: TenantTransactionContext,
    lookup: Omit<IdempotentIdentity, 'fingerprint'>,
  ): Promise<StoredCommandRecord | undefined>;
  delete(
    context: TenantTransactionContext,
    lookup: Omit<IdempotentIdentity, 'fingerprint'>,
  ): Promise<void>;
  store(
    context: TenantTransactionContext,
    identity: IdempotentIdentity,
    result: { readonly responseStatus: number; readonly responseBody: unknown },
    expiresAt: Temporal.Instant,
  ): Promise<void>;
}

export interface IdempotentExecution<T> {
  readonly identity: IdempotentIdentity;
  readonly lockKey: bigint;
  readonly execute: (context: TenantTransactionContext) => Promise<T>;
  readonly toStored: (value: T) => {
    readonly responseStatus: number;
    readonly responseBody: unknown;
  };
  readonly fromStored: (record: StoredCommandRecord) => T;
}

export interface IdempotentOutcome<T> {
  readonly value: T;
  /** True when returning a previously committed result without new effects. */
  readonly replayed: boolean;
}

/**
 * Exactly-once command envelope. The mutation and its idempotency result
 * commit atomically; a pre-commit crash rolls everything back so a retry
 * safely executes again. Only successful mutations are stored — auth,
 * validation, stale-revision, conflict, and 500 failures are re-evaluated.
 */
export async function runIdempotentCommand<T>(
  runner: TenantTransactionRunner,
  store: IdempotencyTransactionStore,
  now: Temporal.Instant,
  execution: IdempotentExecution<T>,
): Promise<IdempotentOutcome<T>> {
  return runner.run(execution.identity.tenantId, async (context) => {
    await store.acquireAdvisoryLock(context, execution.lockKey);
    const lookup = {
      tenantId: execution.identity.tenantId,
      actorAccountId: execution.identity.actorAccountId,
      command: execution.identity.command,
      key: execution.identity.key,
    };
    const existing = await store.find(context, lookup);
    if (existing !== undefined) {
      if (Temporal.Instant.compare(existing.expiresAt, now) <= 0) {
        await store.delete(context, lookup);
      } else if (existing.fingerprint === execution.identity.fingerprint) {
        return { value: execution.fromStored(existing), replayed: true };
      } else {
        throw new PassApplicationError(
          'idempotency_key_reused',
          'Idempotency key was already used for a different request.',
        );
      }
    }
    const value = await execution.execute(context);
    const stored = execution.toStored(value);
    const expiresAt = now.add({ hours: IDEMPOTENCY_TTL_HOURS });
    await store.store(context, execution.identity, stored, expiresAt);
    return { value, replayed: false };
  });
}
