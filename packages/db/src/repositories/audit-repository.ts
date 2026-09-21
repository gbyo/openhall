import type {
  AuditEventListInput,
  AuditEventRow,
  AuditRepository,
  TenantTransactionContext,
} from '@openhall/application';
import { connectionFor, fromDatabaseInstant } from '../transactions.js';

interface AuditRow {
  id: string;
  occurred_at: string;
  action: string;
  actor_kind: string;
  actor_id: string | null;
  target_kind: string;
  target_id: string | null;
  outcome: string;
  request_id: string;
  display_name: string | null;
}

function toAuditRow(row: AuditRow): AuditEventRow {
  return {
    id: row.id,
    occurredAt: fromDatabaseInstant(row.occurred_at),
    action: row.action,
    actorKind: row.actor_kind,
    actorAccountId: row.actor_id,
    actorDisplayName: row.display_name,
    targetKind: row.target_kind,
    targetId: row.target_id,
    outcome: row.outcome,
    requestId: row.request_id,
  };
}

/** PostgreSQL school-scoped audit feed (tenant-scoped, metadata never selected). */
export class PostgresAuditRepository implements AuditRepository {
  async listOrganizationEvents(
    context: TenantTransactionContext,
    organizationId: string,
    input: AuditEventListInput,
  ): Promise<readonly AuditEventRow[]> {
    const connection = connectionFor(context);
    const cursor = input.cursor;
    const rows = await connection
      .selectFrom('audit_event as e')
      .leftJoin('account as a', (join) =>
        join.onRef('a.tenant_id', '=', 'e.tenant_id').onRef('a.id', '=', 'e.actor_id'),
      )
      .leftJoin('person as p', (join) =>
        join.onRef('p.tenant_id', '=', 'a.tenant_id').onRef('p.id', '=', 'a.person_id'),
      )
      .select([
        'e.id',
        'e.occurred_at',
        'e.action',
        'e.actor_kind',
        'e.actor_id',
        'e.target_kind',
        'e.target_id',
        'e.outcome',
        'e.request_id',
        'p.display_name',
      ])
      .where('e.tenant_id', '=', context.tenantId)
      .where('e.organization_id', '=', organizationId)
      .$call((qb) =>
        cursor === null
          ? qb
          : qb.where((eb) =>
              eb.or([
                eb('e.occurred_at', '<', cursor.occurredAt.toString()),
                eb.and([
                  eb('e.occurred_at', '=', cursor.occurredAt.toString()),
                  eb('e.id', '<', cursor.id),
                ]),
              ]),
            ),
      )
      .orderBy('e.occurred_at', 'desc')
      .orderBy('e.id', 'desc')
      .limit(input.limit + 1)
      .execute();
    return rows.map((row) =>
      toAuditRow({
        id: row.id,
        occurred_at: row.occurred_at,
        action: row.action,
        actor_kind: row.actor_kind,
        actor_id: row.actor_id,
        target_kind: row.target_kind,
        target_id: row.target_id,
        outcome: row.outcome,
        request_id: row.request_id,
        display_name: row.display_name,
      }),
    );
  }
}
