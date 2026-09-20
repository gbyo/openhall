import type { OrganizationId } from '@openhall/domain';
import type { TenantContext } from '../persistence.js';

export interface RosterAdapter {
  readonly kind: string;
  synchronize(context: TenantContext, organizationId: OrganizationId): Promise<void>;
}
