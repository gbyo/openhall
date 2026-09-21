import { Temporal } from '@js-temporal/polyfill';
import type { Clock } from '@openhall/domain';
import type { Principal } from '../authentication/principal.js';
import type { RelationshipAuthorizationService } from '../authorization/service.js';
import type { TenantTransactionRunner } from '../persistence.js';
import { ControlPlaneError } from './errors.js';
import type { AuditEventRow, AuditRepository } from './ports.js';
import { denialToError } from './shared.js';

export interface AuditDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly audit: AuditRepository;
}

export interface AuditEventQuery {
  readonly limit: number;
  readonly cursor: unknown;
}

export interface AuditEventEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: string;
  readonly actor: {
    readonly kind: string;
    readonly accountId: string | null;
    readonly displayName: string | null;
  };
  readonly target: {
    readonly kind: string;
    readonly id: string | null;
  };
  readonly outcome: string;
  readonly requestId: string;
}

export interface AuditEventListResult {
  readonly events: readonly AuditEventEntry[];
  readonly nextCursor: string | null;
}

export const DEFAULT_AUDIT_PAGE_LIMIT = 20;
export const MAX_AUDIT_PAGE_LIMIT = 100;

function cleanLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_AUDIT_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_AUDIT_PAGE_LIMIT) {
    throw new ControlPlaneError('invalid_search_cursor', 'Invalid page limit.');
  }
  return value;
}

function encodeCursor(occurredAt: Temporal.Instant, id: string): string {
  return Buffer.from(JSON.stringify({ occurredAt: occurredAt.toString(), id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: unknown): AuditEventCursorInput | null {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 500) {
    throw new ControlPlaneError('invalid_search_cursor', 'Invalid search cursor.');
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ControlPlaneError('invalid_search_cursor', 'Invalid search cursor.');
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.occurredAt !== 'string' || typeof record.id !== 'string') {
      throw new ControlPlaneError('invalid_search_cursor', 'Invalid search cursor.');
    }
    return {
      occurredAt: Temporal.Instant.from(record.occurredAt),
      id: record.id,
    };
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw new ControlPlaneError('invalid_search_cursor', 'Invalid search cursor.');
  }
}

interface AuditEventCursorInput {
  readonly occurredAt: Temporal.Instant;
  readonly id: string;
}

function toEntry(row: AuditEventRow): AuditEventEntry {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toString(),
    action: row.action,
    actor: {
      kind: row.actorKind,
      accountId: row.actorAccountId,
      displayName: row.actorDisplayName,
    },
    target: {
      kind: row.targetKind,
      id: row.targetId,
    },
    outcome: row.outcome,
    requestId: row.requestId,
  };
}

/** GET /organizations/:id/audit-events — audit.view keyset read over the exact school. */
export async function listAuditEvents(
  principal: Principal,
  organizationId: string,
  query: AuditEventQuery,
  dependencies: AuditDependencies,
): Promise<AuditEventListResult> {
  const limit = cleanLimit(query.limit);
  const cursor = decodeCursor(query.cursor);
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const decision = await dependencies.authorization.decideWithContext(context, {
      principal,
      capability: 'audit.view',
      resource: { kind: 'organization', organizationId },
      at: now,
    });
    if (!decision.allowed) {
      throw denialToError(decision.reason, 'person_not_found');
    }
    const rows = await dependencies.audit.listOrganizationEvents(context, organizationId, {
      limit,
      cursor,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      events: page.map(toEntry),
      nextCursor:
        rows.length > limit && last !== undefined ? encodeCursor(last.occurredAt, last.id) : null,
    };
  });
}
