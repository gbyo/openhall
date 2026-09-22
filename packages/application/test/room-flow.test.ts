import { Temporal } from '@js-temporal/polyfill';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildMovementProjection,
  roomFlowLockKey,
  DestinationFlowReconciler,
  reasonCodeFromMetadata,
  type ReconcilerDependencies,
} from '../src/room-flow/index.js';

const AT = Temporal.Instant.from('2026-09-21T14:00:00Z');

function reservation() {
  return {
    id: 'res-1',
    tenantId: 'tenant-a',
    organizationId: 'school-a',
    roomId: 'dest-a',
    passId: 'pass-a',
    policyEvaluationId: 'eval-a',
    reservedAt: AT,
    readyExpiresAt: AT.add({ seconds: 60 }),
    claimedAt: null,
    flowExpiresAt: AT.add({ seconds: 600 }),
    releasedAt: null,
    releaseReason: null,
  };
}

function queueEntry() {
  return {
    id: 'q-1',
    tenantId: 'tenant-a',
    organizationId: 'school-a',
    roomId: 'dest-a',
    passId: 'pass-a',
    policyEvaluationId: 'eval-a',
    enteredAt: AT,
    flowExpiresAt: AT.add({ seconds: 600 }),
    releasedAt: null,
    releaseReason: null,
    priority: 0,
  };
}

describe('destination-flow advisory lock key', () => {
  it('is deterministic per tenant and destination', () => {
    expect(roomFlowLockKey('tenant-a', 'dest-a')).toBe(roomFlowLockKey('tenant-a', 'dest-a'));
    expect(roomFlowLockKey('tenant-a', 'dest-a')).not.toBe(roomFlowLockKey('tenant-a', 'dest-b'));
    expect(roomFlowLockKey('tenant-a', 'dest-a')).not.toBe(roomFlowLockKey('tenant-b', 'dest-a'));
  });

  it('uses a separate domain from the idempotency lock', () => {
    const key = roomFlowLockKey('tenant-a', 'dest-a');
    const idempotencyStyle = createHash('sha256')
      .update(['idempotency:v1', 'tenant-a', 'dest-a'].join('|'))
      .digest()
      .readBigInt64BE(0);
    expect(key).not.toBe(idempotencyStyle);
    // Signed 64-bit range for pg_advisory_xact_lock(bigint).
    expect(key >= -(2n ** 63n) && key < 2n ** 63n).toBe(true);
  });
});

describe('movement projection', () => {
  it('exposes the ready claim deadline only for ready passes', () => {
    const ready = buildMovementProjection({
      lifecycleState: 'ready',
      expectedReturnAt: null,
      reservation: reservation(),
      queueEntry: null,
      reasonCode: null,
      effectiveCheckInMode: null,
    });
    expect(ready).toEqual({
      readyUntil: AT.add({ seconds: 60 }).toString(),
      queueEnteredAt: null,
      queueExpiresAt: null,
      expectedReturnAt: null,
      reasonCode: null,
      effectiveCheckInMode: null,
    });
  });

  it('exposes queue facts and the requeue reason for queued passes', () => {
    const queued = buildMovementProjection({
      lifecycleState: 'queued',
      expectedReturnAt: null,
      reservation: null,
      queueEntry: queueEntry(),
      reasonCode: 'ready_claim_expired',
      effectiveCheckInMode: null,
    });
    expect(queued.queueEnteredAt).toBe(AT.toString());
    expect(queued.queueExpiresAt).toBe(AT.add({ seconds: 600 }).toString());
    expect(queued.reasonCode).toBe('ready_claim_expired');
    expect(queued.readyUntil).toBeNull();
  });

  it('exposes the expected return for active movement and nothing else', () => {
    for (const lifecycleState of ['outbound', 'at_destination', 'returning']) {
      const movement = buildMovementProjection({
        lifecycleState,
        expectedReturnAt: AT.add({ seconds: 300 }),
        reservation: null,
        queueEntry: null,
        reasonCode: null,
        effectiveCheckInMode: 'optional',
      });
      expect(movement).toEqual({
        readyUntil: null,
        queueEnteredAt: null,
        queueExpiresAt: null,
        expectedReturnAt: AT.add({ seconds: 300 }).toString(),
        reasonCode: null,
        effectiveCheckInMode: 'optional',
      });
    }
  });

  it('carries the operational reason for terminal flow states', () => {
    for (const [lifecycleState, reasonCode] of [
      ['denied', 'destination_unavailable'],
      ['expired', 'queue_timeout'],
      ['requested', 'policy_clearance_lost'],
    ] as const) {
      const movement = buildMovementProjection({
        lifecycleState,
        expectedReturnAt: null,
        reservation: null,
        queueEntry: null,
        reasonCode,
        effectiveCheckInMode: null,
      });
      expect(movement.reasonCode).toBe(reasonCode);
      expect(movement.readyUntil).toBeNull();
      expect(movement.queueEnteredAt).toBeNull();
    }
  });

  it('derives reason codes only from string event metadata', () => {
    expect(reasonCodeFromMetadata({ reasonCode: 'queue_timeout' })).toBe('queue_timeout');
    expect(reasonCodeFromMetadata({})).toBeNull();
    expect(reasonCodeFromMetadata(null)).toBeNull();
    expect(reasonCodeFromMetadata({ reasonCode: 42 })).toBeNull();
    expect(reasonCodeFromMetadata({ reasonCode: '' })).toBeNull();
  });
});

describe('reconciler batch fairness', () => {
  const NOW = Temporal.Instant.from('2026-09-21T14:00:00Z');

  function queuedRow(passId: string, tenantId: string) {
    return {
      id: passId,
      tenantId,
      organizationId: 'school-a',
      studentId: 'student-1',
      originLocationId: null,
      originSectionId: null,
      originScheduleBlockId: null,
      roomId: 'dest-1',
      returnLocationId: null,
      requestSource: 'student_web',
      requestedByPersonId: null,
      requestedAt: NOW,
      lifecycleState: 'queued',
      expectedReturnAt: null,
      scheduledAuthorizationId: null,
      revision: 2n,
      destinationDisplayName: 'Office',
      destinationServiceType: 'office',
      destinationCheckInMode: 'optional',
      destinationCategory: null,
      originBlock: null,
      originSection: null,
      originLocation: null,
    };
  }

  it('scans tenants once per batch and shares work fairly', async () => {
    let listCalls = 0;
    let currentTenant = '';
    const served: string[] = [];
    // t1 stays productive forever; t2 has exactly one expired queue entry.
    const remaining = new Map<string, number>([
      ['t1', 1000],
      ['t2', 1],
    ]);
    const passIdFor = (tenantId: string): string => (tenantId === 't1' ? 'p1' : 'p2');
    const flow = {
      listTenantIds: (): Promise<string[]> => {
        listCalls += 1;
        return Promise.resolve(['t1', 't2']);
      },
      findStaleReadyCandidate: () => Promise.resolve(null),
      findExpiredQueueCandidate: () => {
        const left = remaining.get(currentTenant) ?? 0;
        if (left <= 0) return Promise.resolve(null);
        remaining.set(currentTenant, left - 1);
        return Promise.resolve({ entry: { passId: passIdFor(currentTenant) } });
      },
      findUnavailableFlowCandidate: () => Promise.resolve(null),
      listQueuedRoomIds: (): Promise<string[]> => Promise.resolve([]),
      findOrphanedFlowRows: () => Promise.resolve(null),
      loadActiveQueueEntryForPass: () => Promise.resolve({ id: 'qe-1', flowExpiresAt: NOW }),
      releaseQueueEntry: () => Promise.resolve(true),
    };
    const passes = {
      loadPassForUpdate: () => Promise.resolve(queuedRow(passIdFor(currentTenant), currentTenant)),
      updatePassToExpired: () => {
        served.push(passIdFor(currentTenant));
        return Promise.resolve({ revision: 3n });
      },
      appendPassEvent: () => Promise.resolve(undefined),
    };
    const runner = {
      run: (tenantId: string, fn: (ctx: never) => Promise<unknown>) => {
        currentTenant = tenantId;
        return fn(undefined as never);
      },
    };
    const reconciler = new DestinationFlowReconciler({
      clock: { now: () => NOW },
      runner,
      passes,
      flow,
      policy: { cancelAllPendingWorkflows: () => Promise.resolve(undefined) },
      placement: {},
      outbox: { append: () => Promise.resolve(undefined) },
    } as unknown as ReconcilerDependencies);
    expect(await reconciler.runBatch(2)).toBe(2);
    // The endlessly productive first tenant must not starve the second.
    expect(served).toEqual(['p1', 'p2']);
    expect(listCalls).toBe(1);
  });
});
