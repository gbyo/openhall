import type { AccountId, PersonId, TenantId } from '@openhall/domain';

/**
 * A trustworthy authenticated OpenHall identity. Authentication establishes a
 * Principal; authorization consumes it. This module owns the concept so the
 * authorization package can import it without owning authentication.
 */
export interface Principal {
  readonly tenantId: TenantId;
  readonly accountId: AccountId;
  readonly personId: PersonId;
  /**
   * Snapshot of account.session_revision (PostgreSQL bigint) taken when the
   * session was created. Kept as bigint end to end; never exposed in JSON.
   */
  readonly sessionRevision: bigint;
  readonly authenticationMethod: 'oidc' | 'recovery';
}
