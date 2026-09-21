import { createHash } from 'node:crypto';
import type { Temporal } from '@js-temporal/polyfill';
import { PassApplicationError } from '../passes/errors.js';
import {
  runIdempotentCommand,
  type IdempotencyTransactionStore,
  type IdempotentExecution,
  type IdempotentOutcome,
} from '../idempotency/coordinator.js';
import type { TenantTransactionRunner } from '../persistence.js';
import { ControlPlaneError } from './errors.js';

/**
 * Stable idempotency command namespaces for school control-plane mutations.
 * Part of the durable idempotency identity; route URLs are never command
 * names. Exact naming follows one consistent convention per area.
 */
export const CONTROL_PLANE_COMMANDS = [
  'location.create:v1',
  'location.update:v1',
  'location.archive:v1',
  'destination.create:v1',
  'destination.update:v1',
  'destination.open:v1',
  'destination.close:v1',
  'destination.archive:v1',
  'destination_category.create:v1',
  'destination_category.update:v1',
  'destination_category.archive:v1',
  'schedule.block.create:v1',
  'schedule.block.update:v1',
  'schedule.block.archive:v1',
  'schedule.template.create:v1',
  'schedule.template.update:v1',
  'schedule.template.archive:v1',
  'schedule.calendar.update:v1',
  'policy.create:v1',
  'policy.update:v1',
  'policy.activate:v1',
  'policy.deactivate:v1',
  'policy.archive:v1',
  'authorization.grant.issue:v1',
  'authorization.grant.revoke:v1',
  'identity.enrollment.issue:v1',
  'identity.enrollment.revoke:v1',
  'scheduled_authorization.create:v1',
  'scheduled_authorization.cancel:v1',
  'scheduled_authorization.start.self:v1',
] as const;

export type ControlPlaneCommand = (typeof CONTROL_PLANE_COMMANDS)[number];

const KEY_PATTERN = /^[!-~]{1,255}$/;

/**
 * OpenHall Idempotency-Key contract for control-plane mutations: opaque
 * caller-generated value, 1-255 visible ASCII characters, no silent
 * trim-and-reinterpret. UUIDv7 recommended but not required.
 */
export function requireControlPlaneIdempotencyKey(header: unknown): string {
  if (typeof header !== 'string' || header.length === 0) {
    throw new ControlPlaneError(
      'idempotency_key_required',
      'Idempotency-Key is required for control-plane mutations.',
    );
  }
  if (header.length > 255 || header !== header.trim() || !KEY_PATTERN.test(header)) {
    throw new ControlPlaneError('invalid_idempotency_key', 'Invalid Idempotency-Key.');
  }
  return header;
}

/**
 * Exactly-once envelope for control-plane commands. Translates the shared
 * coordinator's key-reuse signal into the control-plane error vocabulary so
 * routes never leak pass-domain errors.
 */
export async function runControlPlaneCommand<T>(
  runner: TenantTransactionRunner,
  store: IdempotencyTransactionStore,
  now: Temporal.Instant,
  execution: IdempotentExecution<T>,
): Promise<IdempotentOutcome<T>> {
  try {
    return await runIdempotentCommand(runner, store, now, execution);
  } catch (error) {
    if (error instanceof PassApplicationError && error.code === 'idempotency_key_reused') {
      throw new ControlPlaneError(
        'idempotency_key_reused',
        'Idempotency key was already used for a different request.',
      );
    }
    throw error;
  }
}

/** Deterministic versioned fingerprint over canonical semantic inputs only. */
export function fingerprintControlPlane(
  command: ControlPlaneCommand,
  components: readonly string[],
): string {
  return createHash('sha256')
    .update([command, ...components].join('|'))
    .digest('hex');
}

/**
 * Deterministic 64-bit advisory-lock key for (tenant, actor, command, key).
 * A collision only serializes unrelated commands; correctness never depends
 * on uniqueness.
 */
export function controlPlaneLockKey(
  tenantId: string,
  actorAccountId: string,
  command: string,
  key: string,
): bigint {
  const digest = createHash('sha256')
    .update([tenantId, actorAccountId, command, key].join('|'))
    .digest();
  return digest.readBigInt64BE(0);
}
