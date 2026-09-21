import type { Temporal } from '@js-temporal/polyfill';
import type { MovementProjection } from '../passes/representations.js';
import { EMPTY_MOVEMENT } from '../passes/representations.js';
import type { TenantTransactionContext } from '../persistence.js';
import type { FlowQueueEntryRow, FlowReservationRow } from './ports.js';

interface LatestEventReader {
  loadLatestPassEvent(
    context: TenantTransactionContext,
    passId: string,
  ): Promise<{ readonly eventType: string; readonly metadata: Record<string, unknown> } | null>;
}

interface ActiveFlowReader {
  loadActiveReservationForPass(
    context: TenantTransactionContext,
    passId: string,
  ): Promise<FlowReservationRow | null>;
  loadActiveQueueEntryForPass(
    context: TenantTransactionContext,
    passId: string,
  ): Promise<FlowQueueEntryRow | null>;
}

interface MovementRow {
  readonly id: string;
  readonly lifecycleState: string;
  readonly expectedReturnAt: Temporal.Instant | null;
}

export interface MovementFacts {
  readonly lifecycleState: string;
  readonly expectedReturnAt: Temporal.Instant | null;
  readonly reservation: FlowReservationRow | null;
  readonly queueEntry: FlowQueueEntryRow | null;
  /** Current operational reason from the latest immutable pass event. */
  readonly reasonCode: string | null;
}

/**
 * Builds the non-dynamic movement projection. Values only change when the
 * pass revision changes: every reservation claim/release and every queue
 * entry release is paired with a pass transition in the same transaction,
 * while live queue position stays out of this representation by design.
 */
export function buildMovementProjection(facts: MovementFacts): MovementProjection {
  switch (facts.lifecycleState) {
    case 'ready':
      return {
        ...EMPTY_MOVEMENT,
        readyUntil: facts.reservation?.readyExpiresAt.toString() ?? null,
      };
    case 'queued':
      return {
        ...EMPTY_MOVEMENT,
        queueEnteredAt: facts.queueEntry?.enteredAt.toString() ?? null,
        queueExpiresAt: facts.queueEntry?.flowExpiresAt.toString() ?? null,
        reasonCode: facts.reasonCode,
      };
    case 'outbound':
    case 'at_destination':
    case 'returning':
      return {
        ...EMPTY_MOVEMENT,
        expectedReturnAt: facts.expectedReturnAt?.toString() ?? null,
      };
    case 'denied':
    case 'expired':
      return { ...EMPTY_MOVEMENT, reasonCode: facts.reasonCode };
    default:
      return { ...EMPTY_MOVEMENT, reasonCode: facts.reasonCode };
  }
}

/** Extracts a string reasonCode from immutable event metadata, if present. */
export function reasonCodeFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const reasonCode = metadata?.reasonCode;
  return typeof reasonCode === 'string' && reasonCode.length > 0 ? reasonCode : null;
}

/**
 * Derives the revision-tied movement projection for a pass row by loading
 * its active flow rows and latest event reason. Callers must hold the pass
 * row lock (mutations) or accept a read snapshot (reads); flow rows only
 * ever change alongside a pass revision bump, so the result stays inside
 * the strong ETag.
 */
export async function loadMovementForRow(
  context: TenantTransactionContext,
  passes: LatestEventReader,
  flow: ActiveFlowReader,
  row: MovementRow,
): Promise<MovementProjection> {
  const [reservation, queueEntry, latest] = await Promise.all([
    row.lifecycleState === 'ready'
      ? flow.loadActiveReservationForPass(context, row.id)
      : Promise.resolve(null),
    row.lifecycleState === 'queued'
      ? flow.loadActiveQueueEntryForPass(context, row.id)
      : Promise.resolve(null),
    row.lifecycleState === 'queued' ||
    row.lifecycleState === 'denied' ||
    row.lifecycleState === 'expired' ||
    row.lifecycleState === 'requested'
      ? passes.loadLatestPassEvent(context, row.id)
      : Promise.resolve(null),
  ]);
  return buildMovementProjection({
    lifecycleState: row.lifecycleState,
    expectedReturnAt: row.expectedReturnAt,
    reservation,
    queueEntry,
    reasonCode: reasonCodeFromMetadata(latest?.metadata),
  });
}
