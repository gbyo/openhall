import type { AccountId, OrganizationId, TenantId } from '@openhall/domain';

export interface TenantContext {
  readonly tenantId: TenantId;
}

export interface TenantRepository<TEntity> {
  findById(context: TenantContext, id: string): Promise<TEntity | undefined>;
}

export interface TransactionContext {
  readonly tenantId: TenantId;
}

export interface TransactionRunner {
  run<TResult>(
    tenantId: TenantId,
    operation: (context: TransactionContext) => Promise<TResult>,
  ): Promise<TResult>;
}

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
  append(context: TransactionContext, event: DomainEvent): Promise<void>;
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
    context: TransactionContext,
    lookup: IdempotencyLookup,
    result: StoredIdempotencyResult,
    expiresAt: string,
  ): Promise<void>;
}
