import type { Temporal } from '@js-temporal/polyfill';
import { transitionPass } from '@openhall/domain';
import type { Clock } from '@openhall/domain';
import type { Principal } from '../authentication/principal.js';
import type { AuditWriter } from '../auditing/audit.js';
import type { RoomFlowRepository } from '../room-flow/ports.js';
import { roomFlowLockKey } from '../room-flow/locks.js';
import { loadMovementForRow } from '../room-flow/projections.js';
import type { IdempotencyTransactionStore } from '../idempotency/coordinator.js';
import { runIdempotentCommand } from '../idempotency/coordinator.js';
import { buildPolicyProjection, type PolicyRepository } from '../policy/index.js';
import type {
  OutboxWriter,
  TenantTransactionContext,
  TenantTransactionRunner,
} from '../persistence.js';
import { PassApplicationError } from './errors.js';
import { advisoryLockKey, fingerprintSelfCancel, requireIdempotencyKey } from './idempotency.js';
import type { PassRepository } from './ports.js';
import {
  etagForPass,
  requireIfMatch,
  toPassRepresentation,
  type PassRepresentation,
} from './representations.js';

export interface CancelPassDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly passes: PassRepository;
  readonly flow: RoomFlowRepository;
  readonly policy: PolicyRepository;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

export interface CancelPassInput {
  readonly principal: Principal;
  readonly passId: string;
  readonly idempotencyKey: unknown;
  /** Raw If-Match header value; exact OpenHall strong ETag required. */
  readonly ifMatch: unknown;
  readonly requestId: string;
}

export interface CancelPassResult {
  readonly pass: PassRepresentation;
  readonly etag: string;
  readonly status: 200;
  readonly replayed: boolean;
}

/**
 * POST /api/v1/me/passes/:passId/cancel — only the owning student's own
 * student_web pass in requested/queued/ready. Ownership is concealed as 404;
 * lifecycle violations are 409; stale revisions are 412.
 */
export async function cancelSelfPass(
  input: CancelPassInput,
  dependencies: CancelPassDependencies,
): Promise<CancelPassResult> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const expected = requireIfMatch(input.ifMatch, input.passId);
  const now = dependencies.clock.now();
  const { passes, idempotency, audit, outbox, runner } = dependencies;
  const command = 'pass.cancel.self:v1' as const;
  const fingerprint = fingerprintSelfCancel(input.passId, expected.revision);

  const outcome = await runIdempotentCommand(runner, idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command,
      key,
      fingerprint,
    },
    lockKey: advisoryLockKey(input.principal.tenantId, input.principal.accountId, command, key),
    execute: async (context: TenantTransactionContext) => {
      const row = await passes.loadPassForUpdate(context, input.passId);
      if (row?.tenantId !== input.principal.tenantId) {
        throw new PassApplicationError('pass_not_found', 'Pass not found.');
      }
      if (row.studentId !== input.principal.personId) {
        throw new PassApplicationError('pass_not_found', 'Pass not found.');
      }
      if (input.principal.authenticationMethod === 'recovery') {
        throw new PassApplicationError(
          'recovery_session_restricted',
          'Recovery sessions cannot cancel passes.',
        );
      }
      if (row.revision !== expected.revision) {
        throw new PassApplicationError(
          'stale_pass_revision',
          'The pass has changed since this client last read it.',
        );
      }
      if (row.requestSource !== 'student_web') {
        throw new PassApplicationError(
          'invalid_pass_transition',
          'This pass cannot be self-cancelled.',
        );
      }
      let nextRevision: bigint;
      try {
        const transitioned = transitionPass(
          {
            id: row.id,
            tenantId: row.tenantId,
            organizationId: row.organizationId,
            studentId: row.studentId,
            originRoomId: row.originRoomId,
            originSectionId: row.originSectionId,
            originScheduleBlockId: row.originScheduleBlockId,
            destinationRoomId: row.destinationRoomId,
            returnRoomId: row.returnRoomId,
            requestSource: 'student_web',
            requestedByPersonId: row.requestedByPersonId,
            requestedAt: row.requestedAt,
            lifecycleState: row.lifecycleState as 'requested' | 'queued' | 'ready',
            expectedReturnAt: row.expectedReturnAt,
            scheduledAuthorizationId: row.scheduledAuthorizationId,
            revision: row.revision,
          },
          'cancelled',
        );
        nextRevision = transitioned.aggregate.revision;
      } catch {
        throw new PassApplicationError(
          'invalid_pass_transition',
          'This pass cannot be self-cancelled.',
        );
      }
      const updated = await passes.updatePassToCancelled(context, row.id, row.revision, now);
      if (updated?.revision !== nextRevision) {
        throw new PassApplicationError(
          'stale_pass_revision',
          'The pass has changed since this client last read it.',
        );
      }
      // Flow-aware cancellation: no active queue or reservation row may
      // survive on a cancelled pass. Promotion of the next queued student is
      // left to the reconciler so this transaction stays small.
      if (row.lifecycleState === 'queued' || row.lifecycleState === 'ready') {
        const { flow } = dependencies;
        await flow.acquireRoomLock(context, roomFlowLockKey(row.tenantId, row.destinationRoomId));
        if (row.lifecycleState === 'queued') {
          const entry = await flow.loadActiveQueueEntryForPass(context, row.id);
          if (entry !== null) {
            await flow.releaseQueueEntry(context, entry.id, 'cancelled', now);
          }
        } else {
          const reservation = await flow.loadActiveReservationForPass(context, row.id);
          if (reservation !== null) {
            await flow.releaseReservation(context, reservation.id, 'cancelled', now);
          }
        }
      }
      const at: Temporal.Instant = now;
      // Terminal cleanup: no actionable pending approval/override may survive
      // on a cancelled pass. System provenance; no extra pass revision.
      await dependencies.policy.cancelAllPendingWorkflows(context, row.id, at);
      await passes.appendPassEvent(context, {
        passId: row.id,
        sequence: updated.revision,
        eventType: 'pass.cancelled',
        actorKind: 'person',
        actorPersonId: input.principal.personId,
        occurredAt: at,
        metadata: {
          schemaVersion: 1,
          state: 'cancelled',
          revision: updated.revision.toString(10),
        },
      });
      await audit.append(context, {
        action: 'pass.cancelled',
        actorKind: 'account',
        actorId: input.principal.accountId,
        organizationId: row.organizationId,
        targetKind: 'pass',
        targetId: row.id,
        outcome: 'success',
        occurredAt: at,
        requestId: input.requestId,
        metadata: {
          passId: row.id,
          organizationId: row.organizationId,
          studentId: row.studentId,
          requestSource: 'student_web',
          revision: updated.revision.toString(10),
          requestId: input.requestId,
        },
      });
      await outbox.append(context, {
        tenantId: row.tenantId,
        organizationId: row.organizationId,
        aggregateKind: 'pass',
        aggregateId: row.id,
        eventType: 'pass.cancelled',
        occurredAt: at.toString(),
        payload: {
          schemaVersion: 1,
          passId: row.id,
          organizationId: row.organizationId,
          studentId: row.studentId,
          lifecycleState: 'cancelled',
          revision: updated.revision.toString(10),
          destinationRoomId: row.destinationRoomId,
        },
      });
      const latest = await dependencies.policy.loadLatestEvaluation(context, row.id);
      const liveApprovals = await dependencies.policy.listApprovalsForPass(context, row.id);
      const liveOverrides = await dependencies.policy.listOverridesForPass(context, row.id);
      const representation = toPassRepresentation(
        updated,
        latest === null ? null : buildPolicyProjection(latest, liveApprovals, liveOverrides),
        await loadMovementForRow(context, passes, dependencies.flow, updated),
      );
      return {
        representation,
        etag: etagForPass(updated.id, updated.revision),
      };
    },
    toStored: (value) => ({
      responseStatus: 200,
      responseBody: { pass: value.representation },
    }),
    fromStored: (record) => {
      const body = record.responseBody as { pass: PassRepresentation };
      return {
        representation: body.pass,
        etag: etagForPass(body.pass.id, BigInt(body.pass.revision)),
      };
    },
  });
  return {
    pass: outcome.value.representation,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}
