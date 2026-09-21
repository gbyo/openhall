import type { Temporal } from '@js-temporal/polyfill';
import type { OrganizationId } from '@openhall/domain';
import type { TenantTransactionContext } from '../persistence.js';

export type AuditOutcome = 'success' | 'denied' | 'failure';

export interface AuditEventInput {
  readonly action: string;
  readonly actorKind: 'account' | 'integration' | 'system';
  readonly actorId?: string;
  readonly organizationId?: OrganizationId;
  readonly targetKind: string;
  readonly targetId?: string;
  readonly outcome: AuditOutcome;
  readonly occurredAt: Temporal.Instant;
  readonly requestId: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface AuditWriter {
  append(context: TenantTransactionContext, event: AuditEventInput): Promise<void>;
}
