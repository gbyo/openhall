import { Temporal } from '@js-temporal/polyfill';
import { transitionPass, type PassAggregate } from '@openhall/domain';
import { PassApplicationError } from '../passes/errors.js';
import type { PassRow } from '../passes/ports.js';
import type { OutboxWriter, TenantTransactionContext } from '../persistence.js';
import type { ExpectedPlacementResult } from '../scheduling/index.js';
import type { PolicyRepository } from '../policy/index.js';
import { roomFlowLockKey } from './locks.js';
import type { RoomFlowRepository } from './ports.js';

export interface AllocatorDependencies {
  readonly passes: PassRepositorySlice;
  readonly flow: RoomFlowRepository;
  readonly policy: PolicyRepository;
  readonly outbox: OutboxWriter;
}

interface PassRepositorySlice {
  updatePassToReady(
    context: TenantTransactionContext,
    passId: string,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null>;
  updatePassToQueued(
    context: TenantTransactionContext,
    passId: string,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null>;
  updatePassToDenied(
    context: TenantTransactionContext,
    passId: string,
    expectedRevision: bigint,
    at: Temporal.Instant,
  ): Promise<PassRow | null>;
  appendPassEvent(
    context: TenantTransactionContext,
    input: {
      readonly passId: string;
      readonly sequence: bigint;
      readonly eventType: string;
      readonly actorKind: 'person' | 'system';
      readonly actorPersonId: string | null;
      readonly occurredAt: Temporal.Instant;
      readonly metadata: Readonly<Record<string, unknown>>;
    },
  ): Promise<void>;
}

export interface AllocateDestinationFlowInput {
  /** Locked pass row in `requested` state. */
  readonly pass: PassRow;
  /** Exact allow evaluation that cleared this operational step. */
  readonly evaluationId: string;
  /** Callers narrow the fresh decision to allow before invoking. */
  readonly decision: 'allow';
  readonly placement: ExpectedPlacementResult;
  /** Single command instant shared by the whole allocation. */
  readonly at: Temporal.Instant;
  readonly requestSource: string;
}

export type AllocationOutcome = 'ready' | 'queued' | 'denied';

export interface AllocationResult {
  readonly outcome: AllocationOutcome;
  readonly row: PassRow;
  /** Operational reason code for denied outcomes; null otherwise. */
  readonly reasonCode: 'room_unavailable' | 'room_capacity_full' | null;
}

function toAggregate(row: PassRow, requestSource: string): PassAggregate {
  return {
    id: row.id,
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    studentId: row.studentId,
    originRoomId: row.originRoomId,
    originSectionId: row.originSectionId,
    originScheduleBlockId: row.originScheduleBlockId,
    destinationRoomId: row.destinationRoomId,
    returnRoomId: row.returnRoomId,
    requestSource: requestSource as PassAggregate['requestSource'],
    requestedByPersonId: row.requestedByPersonId,
    requestedAt: row.requestedAt,
    lifecycleState: row.lifecycleState as PassAggregate['lifecycleState'],
    expectedReturnAt: row.expectedReturnAt,
    scheduledAuthorizationId: row.scheduledAuthorizationId,
    revision: row.revision,
  };
}

function staleRevision(): PassApplicationError {
  return new PassApplicationError(
    'stale_pass_revision',
    'The pass has changed since this client last read it.',
  );
}

/**
 * Reusable room-flow allocator. Runs inside the caller's existing
 * tenant transaction (request, approval, override, or reconciler) and never
 * starts its own. The caller persists a fresh allow evaluation first and
 * passes its id, so the created reservation or queue entry is bound to the
 * exact decision that authorized readiness. Only invoked for allow: policy
 * and physical capacity stay separate questions.
 */
export async function allocateRoomFlow(
  context: TenantTransactionContext,
  dependencies: AllocatorDependencies,
  input: AllocateDestinationFlowInput,
): Promise<AllocationResult> {
  const { passes, flow, policy, outbox } = dependencies;
  const { pass, evaluationId, placement, at, requestSource } = input;
  if (pass.lifecycleState !== 'requested') {
    throw new PassApplicationError(
      'invalid_pass_transition',
      'Destination flow can only be allocated for a requested pass.',
    );
  }

  const config = await flow.loadRoomConfig(context, pass.destinationRoomId);
  if (config?.tenantId !== pass.tenantId) {
    throw new PassApplicationError('room_not_found', 'Destination not found.');
  }
  if (config.organizationId !== pass.organizationId) {
    throw new PassApplicationError('room_not_found', 'Destination not found.');
  }

  // Serialize the capacity decision per destination. The caller already
  // holds the pass row lock (or created the pass in this transaction), so
  // global order (pass before destination) is preserved.
  await flow.acquireRoomLock(context, roomFlowLockKey(pass.tenantId, pass.destinationRoomId));

  const denyWithReason = async (
    reasonCode: 'room_unavailable' | 'room_capacity_full',
  ): Promise<AllocationResult> => {
    try {
      transitionPass(toAggregate(pass, requestSource), 'denied');
    } catch {
      throw new PassApplicationError('invalid_pass_transition', 'This pass cannot be denied.');
    }
    const denied = await passes.updatePassToDenied(context, pass.id, pass.revision, at);
    if (denied === null) throw staleRevision();
    await passes.appendPassEvent(context, {
      passId: pass.id,
      sequence: denied.revision,
      eventType: 'pass.denied',
      actorKind: 'system',
      actorPersonId: null,
      occurredAt: at,
      metadata: {
        schemaVersion: 1,
        state: 'denied',
        revision: denied.revision.toString(10),
        reasonCode,
      },
    });
    await outbox.append(context, {
      tenantId: pass.tenantId,
      organizationId: pass.organizationId,
      aggregateKind: 'pass',
      aggregateId: pass.id,
      eventType: 'pass.denied',
      occurredAt: at.toString(),
      payload: {
        schemaVersion: 1,
        passId: pass.id,
        organizationId: pass.organizationId,
        studentId: pass.studentId,
        lifecycleState: 'denied',
        revision: denied.revision.toString(10),
        destinationRoomId: pass.destinationRoomId,
        reasonCode,
      },
    });
    await policy.cancelAllPendingWorkflows(context, pass.id, at);
    return { outcome: 'denied', row: denied, reasonCode };
  };

  if (config.status === 'closed' || config.status === 'archived') {
    return denyWithReason('room_unavailable');
  }

  // Overall pre-departure deadline: queue timeout bounded by the current
  // slot end when one is known. A slot that already ended is treated as no
  // usable slot rather than fabricating an instantly-dead flow.
  const queueDeadline = at.add({ seconds: config.queueTimeoutSeconds });
  const slotEnd =
    placement.kind === 'resolved' || placement.kind === 'block_only' ? placement.endsAt : null;
  const flowExpiresAt =
    slotEnd !== null &&
    Temporal.Instant.compare(slotEnd, at) > 0 &&
    Temporal.Instant.compare(slotEnd, queueDeadline) < 0
      ? slotEnd
      : queueDeadline;

  const consuming = await flow.countConsumingReservations(context, pass.destinationRoomId, at);
  // Fairness: a freed slot belongs to the queue first. A newcomer waits
  // behind active entries (excluding this pass) instead of leapfrogging them.
  const waiting = config.queueEnabled
    ? await flow.countActiveQueueEntries(context, pass.destinationRoomId, pass.id)
    : 0;
  if ((config.capacity === null || consuming < config.capacity) && waiting === 0) {
    const claimDeadline = at.add({ seconds: config.readyClaimTimeoutSeconds });
    const readyExpiresAt =
      Temporal.Instant.compare(claimDeadline, flowExpiresAt) < 0 ? claimDeadline : flowExpiresAt;
    try {
      transitionPass(toAggregate(pass, requestSource), 'ready');
    } catch {
      throw new PassApplicationError('invalid_pass_transition', 'This pass cannot become ready.');
    }
    const reservation = await flow.createReservation(context, {
      organizationId: pass.organizationId,
      roomId: pass.destinationRoomId,
      passId: pass.id,
      policyEvaluationId: evaluationId,
      reservedAt: at,
      readyExpiresAt,
      flowExpiresAt,
    });
    const ready = await passes.updatePassToReady(context, pass.id, pass.revision, at);
    if (ready === null) throw staleRevision();
    await passes.appendPassEvent(context, {
      passId: pass.id,
      sequence: ready.revision,
      eventType: 'pass.ready',
      actorKind: 'system',
      actorPersonId: null,
      occurredAt: at,
      metadata: {
        schemaVersion: 1,
        state: 'ready',
        revision: ready.revision.toString(10),
        readyUntil: reservation.readyExpiresAt.toString(),
        flowExpiresAt: reservation.flowExpiresAt.toString(),
      },
    });
    await outbox.append(context, {
      tenantId: pass.tenantId,
      organizationId: pass.organizationId,
      aggregateKind: 'pass',
      aggregateId: pass.id,
      eventType: 'pass.ready',
      occurredAt: at.toString(),
      payload: {
        schemaVersion: 1,
        passId: pass.id,
        organizationId: pass.organizationId,
        studentId: pass.studentId,
        lifecycleState: 'ready',
        revision: ready.revision.toString(10),
        destinationRoomId: pass.destinationRoomId,
        readyUntil: reservation.readyExpiresAt.toString(),
      },
    });
    return { outcome: 'ready', row: ready, reasonCode: null };
  }

  if (config.queueEnabled) {
    try {
      transitionPass(toAggregate(pass, requestSource), 'queued');
    } catch {
      throw new PassApplicationError('invalid_pass_transition', 'This pass cannot be queued.');
    }
    const entry = await flow.createQueueEntry(context, {
      organizationId: pass.organizationId,
      roomId: pass.destinationRoomId,
      passId: pass.id,
      policyEvaluationId: evaluationId,
      enteredAt: at,
      flowExpiresAt,
    });
    const queued = await passes.updatePassToQueued(context, pass.id, pass.revision, at);
    if (queued === null) throw staleRevision();
    await passes.appendPassEvent(context, {
      passId: pass.id,
      sequence: queued.revision,
      eventType: 'pass.queued',
      actorKind: 'system',
      actorPersonId: null,
      occurredAt: at,
      metadata: {
        schemaVersion: 1,
        state: 'queued',
        revision: queued.revision.toString(10),
        queueExpiresAt: entry.flowExpiresAt.toString(),
      },
    });
    await outbox.append(context, {
      tenantId: pass.tenantId,
      organizationId: pass.organizationId,
      aggregateKind: 'pass',
      aggregateId: pass.id,
      eventType: 'pass.queued',
      occurredAt: at.toString(),
      payload: {
        schemaVersion: 1,
        passId: pass.id,
        organizationId: pass.organizationId,
        studentId: pass.studentId,
        lifecycleState: 'queued',
        revision: queued.revision.toString(10),
        destinationRoomId: pass.destinationRoomId,
      },
    });
    return { outcome: 'queued', row: queued, reasonCode: null };
  }

  return denyWithReason('room_capacity_full');
}
