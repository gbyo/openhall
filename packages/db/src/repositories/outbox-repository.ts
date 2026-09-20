import type { OutboxWriter } from '@openhall/application';
import type { TenantTransactionContext } from '@openhall/application';
import { connectionFor } from '../transactions.js';

/**
 * Transactional outbox writer. Rows remain pending for future
 * realtime/integration workers; Phase 5 never publishes inside the command
 * transaction, avoiding dual-write inconsistency.
 */
export class PostgresOutboxWriter implements OutboxWriter {
  async append(
    context: TenantTransactionContext,
    event: {
      readonly tenantId: string;
      readonly organizationId?: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
      readonly eventType: string;
      readonly occurredAt: string;
      readonly payload: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    const connection = connectionFor(context);
    await connection
      .insertInto('outbox_event')
      .values({
        tenant_id: event.tenantId,
        organization_id: event.organizationId ?? null,
        aggregate_kind: event.aggregateKind,
        aggregate_id: event.aggregateId,
        event_type: event.eventType,
        payload: { ...(event.payload as Record<string, never>) },
        occurred_at: event.occurredAt,
      })
      .execute();
  }
}
