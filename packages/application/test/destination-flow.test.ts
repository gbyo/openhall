import { Temporal } from '@js-temporal/polyfill';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildMovementProjection,
  destinationFlowLockKey,
  reasonCodeFromMetadata,
} from '../src/destination-flow/index.js';

const AT = Temporal.Instant.from('2026-09-21T14:00:00Z');

function reservation() {
  return {
    id: 'res-1',
    tenantId: 'tenant-a',
    organizationId: 'school-a',
    destinationId: 'dest-a',
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
    destinationId: 'dest-a',
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
    expect(destinationFlowLockKey('tenant-a', 'dest-a')).toBe(
      destinationFlowLockKey('tenant-a', 'dest-a'),
    );
    expect(destinationFlowLockKey('tenant-a', 'dest-a')).not.toBe(
      destinationFlowLockKey('tenant-a', 'dest-b'),
    );
    expect(destinationFlowLockKey('tenant-a', 'dest-a')).not.toBe(
      destinationFlowLockKey('tenant-b', 'dest-a'),
    );
  });

  it('uses a separate domain from the idempotency lock', () => {
    const key = destinationFlowLockKey('tenant-a', 'dest-a');
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
    });
    expect(ready).toEqual({
      readyUntil: AT.add({ seconds: 60 }).toString(),
      queueEnteredAt: null,
      queueExpiresAt: null,
      expectedReturnAt: null,
      reasonCode: null,
    });
  });

  it('exposes queue facts and the requeue reason for queued passes', () => {
    const queued = buildMovementProjection({
      lifecycleState: 'queued',
      expectedReturnAt: null,
      reservation: null,
      queueEntry: queueEntry(),
      reasonCode: 'ready_claim_expired',
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
      });
      expect(movement).toEqual({
        readyUntil: null,
        queueEnteredAt: null,
        queueExpiresAt: null,
        expectedReturnAt: AT.add({ seconds: 300 }).toString(),
        reasonCode: null,
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
