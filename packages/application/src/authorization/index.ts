import type { AccountId, OrganizationId, PersonId } from '@openhall/domain';

export interface Principal {
  readonly tenantId: string;
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
