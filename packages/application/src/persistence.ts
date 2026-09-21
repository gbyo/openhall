import type { AccountId, OrganizationId, TenantId } from '@openhall/domain';

export interface TenantContext {
  readonly tenantId: TenantId;
}

export interface TenantRepository<TEntity> {
  findById(context: TenantContext, id: string): Promise<TEntity | undefined>;
}

declare const tenantTransactionBrand: unique symbol;
declare const systemTransactionBrand: unique symbol;

/**
 * Opaque tenant-scoped persistence context. Only infrastructure can create a
 * value of this type, and every value is tied to exactly one PostgreSQL
 * transaction. Application code must thread it through repositories instead of
 * inventing tenant IDs.
 */
export interface TenantTransactionContext {
  readonly tenantId: TenantId;
  readonly [tenantTransactionBrand]: 'tenant-transaction';
}

/**
 * Explicitly unscoped persistence context reserved for the bootstrap path,
 * where the tenant does not exist yet. Its use must remain obvious at every
 * call site; ordinary repositories must never silently accept it.
 */
export interface SystemTransactionContext {
  readonly system: 'system-bootstrap';
  readonly [systemTransactionBrand]: 'system-transaction';
}

/**
 * Backwards-compatible alias. Prefer {@link TenantTransactionContext} in new
 * code so the transaction binding is explicit.
 */
export type TransactionContext = TenantTransactionContext;

export interface TenantTransactionSettings {
  readonly isolationLevel?:
    | 'read uncommitted'
    | 'read committed'
    | 'repeatable read'
    | 'serializable';
  readonly accessMode?: 'read only' | 'read write';
}

/**
 * Runs a unit of work inside one tenant-scoped PostgreSQL transaction.
 * Implementations must not hold the transaction open across outbound network
 * calls (for example OIDC discovery/token requests).
 */
export interface TenantTransactionRunner {
  run<TResult>(
    tenantId: TenantId,
    operation: (context: TenantTransactionContext) => Promise<TResult>,
    settings?: TenantTransactionSettings,
  ): Promise<TResult>;
}

/**
 * Runs a unit of work inside one explicitly unscoped PostgreSQL transaction
 * for bootstrap, where no tenant exists yet.
 */
export interface SystemTransactionRunner {
  run<TResult>(
    operation: (context: SystemTransactionContext) => Promise<TResult>,
  ): Promise<TResult>;
}

/** Backwards-compatible alias. Prefer {@link TenantTransactionRunner}. */
export type TransactionRunner = TenantTransactionRunner;

export interface DomainEvent {
  readonly tenantId: TenantId;
  readonly organizationId?: OrganizationId;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OutboxWriter {
  append(context: TenantTransactionContext, event: DomainEvent): Promise<void>;
}

export interface IdempotencyLookup {
  readonly actorAccountId: AccountId;
  readonly command: string;
  readonly key: string;
  readonly requestFingerprint: string;
}

export interface StoredIdempotencyResult {
  readonly responseStatus: number;
  readonly responseBody: unknown;
}

export interface IdempotencyStore {
  find(
    context: TenantContext,
    lookup: IdempotencyLookup,
  ): Promise<StoredIdempotencyResult | undefined>;
  store(
    context: TenantTransactionContext,
    lookup: IdempotencyLookup,
    result: StoredIdempotencyResult,
    expiresAt: string,
  ): Promise<void>;
}
