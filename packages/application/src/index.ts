import type { AccountId, OrganizationId, PersonId, TenantId } from '@openhall/domain';

export interface Principal {
  readonly tenantId: TenantId;
  readonly accountId: AccountId;
  readonly personId: PersonId;
  readonly sessionRevision: number;
}

export type AuthorizationScope =
  | { readonly kind: 'tenant' }
  | { readonly kind: 'organization'; readonly organizationId: OrganizationId }
  | { readonly kind: 'section'; readonly sectionId: string }
  | { readonly kind: 'destination'; readonly destinationId: string };

export interface AuthorizationRequest {
  readonly principal: Principal;
  readonly permission: string;
  readonly scope: AuthorizationScope;
}

export interface AuthorizationService {
  isAllowed(request: AuthorizationRequest): Promise<boolean>;
}

export class DenyAllAuthorizationService implements AuthorizationService {
  isAllowed(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

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

export interface RosterAdapter {
  readonly kind: string;
  synchronize(context: TenantContext, organizationId: OrganizationId): Promise<void>;
}
