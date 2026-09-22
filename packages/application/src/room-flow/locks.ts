import { createHash } from 'node:crypto';

/**
 * Deterministic 64-bit advisory-lock key for (tenant, room) under the
 * "room-flow:v1" domain. Derived with SHA-256 exactly like the
 * idempotency lock but with a separate domain string so the two lock spaces
 * never collide. A hash collision only serializes unrelated rooms;
 * correctness never depends on uniqueness.
 *
 * Global lock order: idempotency advisory lock, pass row FOR UPDATE,
 * room-flow advisory lock, then reservation/queue/workflow rows.
 * No code path may acquire the room lock before the pass lock.
 */
export function roomFlowLockKey(tenantId: string, roomId: string): bigint {
  const digest = createHash('sha256').update(['room-flow:v1', tenantId, roomId].join('|')).digest();
  // Signed 64-bit for pg_advisory_xact_lock(bigint).
  return digest.readBigInt64BE(0);
}
