import { createHash } from 'node:crypto';
import { PassApplicationError } from './errors.js';

/**
 * Stable idempotency command namespaces. These are part of the durable
 * idempotency identity; route URLs are never used as command names.
 */
export const PASS_IDEMPOTENCY_COMMANDS = [
  'pass.request.self:v1',
  'pass.request.student:v1',
  'pass.cancel.self:v1',
  'pass.approval.approve:v1',
  'pass.approval.deny:v1',
  'pass.override.request.self:v1',
  'pass.override.request.student:v1',
  'pass.override.approve:v1',
  'pass.override.deny:v1',
  'pass.depart.self:v1',
  'pass.depart.student:v1',
  'pass.arrive.self:v1',
  'pass.return.self:v1',
  'pass.complete.self:v1',
  'pass.station.check_in:v1',
  'pass.station.begin_return:v1',
  'pass.station.complete:v1',
] as const;

export type PassIdempotencyCommand = (typeof PASS_IDEMPOTENCY_COMMANDS)[number];

const KEY_PATTERN = /^[!-~]{1,255}$/;

/**
 * OpenHall Idempotency-Key contract: opaque caller-generated value, 1-255
 * visible ASCII characters, no control characters, no silent
 * trim-and-reinterpret. UUIDv4/UUIDv7 recommended but not required.
 */
export function assertValidIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || key.length < 1 || key.length > 255) {
    throw new PassApplicationError('invalid_idempotency_key', 'Invalid Idempotency-Key.');
  }
  if (key !== key.trim() || !KEY_PATTERN.test(key)) {
    throw new PassApplicationError('invalid_idempotency_key', 'Invalid Idempotency-Key.');
  }
  return key;
}

export function requireIdempotencyKey(header: unknown): string {
  if (typeof header !== 'string' || header.length === 0) {
    throw new PassApplicationError(
      'idempotency_key_required',
      'Idempotency-Key is required for pass mutations.',
    );
  }
  return assertValidIdempotencyKey(header);
}

function hex(components: readonly string[]): string {
  return createHash('sha256').update(components.join('|')).digest('hex');
}

/** Deterministic versioned fingerprint over semantic command inputs only. */
export function fingerprintSelfRequest(destinationRoomId: string): string {
  return hex(['pass.request.self:v1', destinationRoomId]);
}

export function fingerprintStaffRequest(studentId: string, destinationRoomId: string): string {
  return hex(['pass.request.student:v1', studentId, destinationRoomId]);
}

export function fingerprintScheduledRequest(
  scheduledAuthorizationId: string,
  expectedRevision: bigint,
): string {
  // The authorization row plus the observed revision fully determines the
  // semantic input: destination, window, and mode are server-owned state.
  return hex([
    'pass.request.scheduled:v1',
    scheduledAuthorizationId,
    expectedRevision.toString(10),
  ]);
}

export function fingerprintSelfCancel(passId: string, expectedRevision: bigint): string {
  return hex(['pass.cancel.self:v1', passId, expectedRevision.toString(10)]);
}

export function fingerprintDepartSelf(passId: string, expectedRevision: bigint): string {
  return hex(['pass.depart.self:v1', passId, expectedRevision.toString(10)]);
}

export function fingerprintDepartStudent(passId: string, expectedRevision: bigint): string {
  return hex(['pass.depart.student:v1', passId, expectedRevision.toString(10)]);
}

export function fingerprintArriveSelf(passId: string, expectedRevision: bigint): string {
  return hex(['pass.arrive.self:v1', passId, expectedRevision.toString(10)]);
}

export function fingerprintReturnSelf(passId: string, expectedRevision: bigint): string {
  return hex(['pass.return.self:v1', passId, expectedRevision.toString(10)]);
}

export function fingerprintCompleteSelf(passId: string, expectedRevision: bigint): string {
  return hex(['pass.complete.self:v1', passId, expectedRevision.toString(10)]);
}

export function fingerprintStationCheckIn(
  destinationRoomId: string,
  passId: string,
  expectedRevision: bigint,
): string {
  return hex(['pass.station.check_in:v1', destinationRoomId, passId, expectedRevision.toString(10)]);
}

export function fingerprintStationBeginReturn(
  destinationRoomId: string,
  passId: string,
  expectedRevision: bigint,
): string {
  return hex([
    'pass.station.begin_return:v1',
    destinationRoomId,
    passId,
    expectedRevision.toString(10),
  ]);
}

export function fingerprintStationComplete(
  destinationRoomId: string,
  passId: string,
  expectedRevision: bigint,
): string {
  return hex(['pass.station.complete:v1', destinationRoomId, passId, expectedRevision.toString(10)]);
}

export function fingerprintApprovalResolve(
  approvalId: string,
  passId: string,
  expectedRevision: bigint,
  decision: 'approved' | 'denied',
): string {
  const command = decision === 'approved' ? 'pass.approval.approve:v1' : 'pass.approval.deny:v1';
  return hex([command, approvalId, passId, expectedRevision.toString(10), decision]);
}

export function fingerprintOverrideRequest(
  passId: string,
  category: string,
  expectedRevision: bigint,
  surface: 'self' | 'student',
): string {
  const command =
    surface === 'self' ? 'pass.override.request.self:v1' : 'pass.override.request.student:v1';
  return hex([command, passId, category, expectedRevision.toString(10), surface]);
}

export function fingerprintOverrideResolve(
  overrideId: string,
  passId: string,
  expectedRevision: bigint,
  decision: 'approved' | 'denied',
): string {
  const command = decision === 'approved' ? 'pass.override.approve:v1' : 'pass.override.deny:v1';
  return hex([command, overrideId, passId, expectedRevision.toString(10), decision]);
}

/**
 * Deterministic 64-bit advisory-lock key for (tenant, actor, command, key).
 * Collisions only serialize unrelated commands; correctness never depends
 * on uniqueness.
 */
/**
 * Identity scope note: idempotency identity is namespaced per command. The
 * same key used with a different command (approve vs deny, self vs staff
 * surface) starts an independent execution; 409 idempotency_key_reused only
 * fires when the fingerprint differs under the SAME command. Cross-command
 * intents stay safe because every execution revalidates the pass revision
 * and workflow state inside the locked transaction before mutating.
 */
export function advisoryLockKey(
  tenantId: string,
  actorAccountId: string,
  command: string,
  key: string,
): bigint {
  const digest = createHash('sha256')
    .update([tenantId, actorAccountId, command, key].join('|'))
    .digest();
  // Signed 64-bit for pg_advisory_xact_lock(bigint). A collision only
  // serializes unrelated commands; correctness never depends on uniqueness.
  return digest.readBigInt64BE(0);
}

/** Idempotency retention for new rows. */
export const IDEMPOTENCY_TTL_HOURS = 24;
