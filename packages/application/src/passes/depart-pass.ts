import { Temporal } from '@js-temporal/polyfill';
import { transitionPass, type PassAggregate } from '@openhall/domain';
import type { Clock } from '@openhall/domain';
import type { Principal } from '../authentication/principal.js';
import type { AuditWriter } from '../auditing/audit.js';
import type { RelationshipAuthorizationService } from '../authorization/index.js';
import type { RoomFlowRepository } from '../room-flow/ports.js';
import { roomFlowLockKey } from '../room-flow/locks.js';
import { loadMovementForRow } from '../room-flow/projections.js';
import type { IdempotencyTransactionStore } from '../idempotency/coordinator.js';
import { runIdempotentCommand } from '../idempotency/coordinator.js';
import type {
  OutboxWriter,
  TenantTransactionContext,
  TenantTransactionRunner,
} from '../persistence.js';
import type { ExpectedPlacementResolver } from '../scheduling/index.js';
import { buildPolicyProjection, type PolicyRepository } from '../policy/index.js';
import { PassApplicationError } from './errors.js';
import {
  advisoryLockKey,
  fingerprintDepartSelf,
  fingerprintDepartStudent,
  requireIdempotencyKey,
} from './idempotency.js';
import type { PassRepository, PassRow } from './ports.js';
import {
  etagForPass,
  requireIfMatch,
  toPassRepresentation,
  type PassRepresentation,
} from './representations.js';

export interface DepartPassDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly placement: ExpectedPlacementResolver;
  readonly passes: PassRepository;
  readonly flow: RoomFlowRepository;
  readonly policy: PolicyRepository;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

export interface DepartPassInput {
  readonly principal: Principal;
  readonly passId: string;
  readonly idempotencyKey: unknown;
  /** Raw If-Match header value; exact OpenHall strong ETag required. */
  readonly ifMatch: unknown;
  readonly requestId: string;
}

export interface DepartPassResult {
  readonly pass: PassRepresentation;
  readonly etag: string;
  readonly status: 200;
  readonly replayed: boolean;
}

function toAggregate(row: PassRow): PassAggregate {
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
    requestSource: row.requestSource as PassAggregate['requestSource'],
    requestedByPersonId: row.requestedByPersonId,
    requestedAt: row.requestedAt,
    lifecycleState: row.lifecycleState as PassAggregate['lifecycleState'],
    expectedReturnAt: row.expectedReturnAt,
    scheduledAuthorizationId: row.scheduledAuthorizationId,
    revision: row.revision,
  };
}

interface DepartureMutation {
  readonly principal: Principal;
  readonly passId: string;
  readonly command: 'pass.depart.self:v1' | 'pass.depart.student:v1';
  readonly fingerprint: string;
  readonly key: string;
  readonly expectedRevision: bigint;
  readonly requestId: string;
  readonly now: Temporal.Instant;
  readonly authorize: (context: TenantTransactionContext, row: PassRow) => Promise<void>;
}

/**
 * Shared departure transaction: authenticate, one Clock instant,
 * idempotency replay, pass FOR UPDATE, If-Match, authorize, destination
 * lock, valid reservation, usable destination, claim, ready -> outbound,
 * pass.departed, audit, outbox, idempotency result, commit. Only an explicit
 * departure command establishes that the student left.
 */
async function executeDeparture(
  mutation: DepartureMutation,
  dependencies: DepartPassDependencies,
): Promise<DepartPassResult> {
  const { principal, passId, command, fingerprint, key, expectedRevision, requestId, now } =
    mutation;
  const { passes, flow, idempotency, audit, outbox, runner, policy } = dependencies;

  const outcome = await runIdempotentCommand(runner, idempotency, now, {
    identity: {
      tenantId: principal.tenantId,
      actorAccountId: principal.accountId,
      command,
      key,
      fingerprint,
    },
    lockKey: advisoryLockKey(principal.tenantId, principal.accountId, command, key),
    execute: async (context: TenantTransactionContext) => {
      const row = await passes.loadPassForUpdate(context, passId);
      if (row?.tenantId !== principal.tenantId) {
        throw new PassApplicationError('pass_not_found', 'Pass not found.');
      }
      if (principal.authenticationMethod === 'recovery') {
        throw new PassApplicationError(
          'recovery_session_restricted',
          'Recovery sessions cannot record departures.',
        );
      }
      await mutation.authorize(context, row);
      if (row.revision !== expectedRevision) {
        throw new PassApplicationError(
          'stale_pass_revision',
          'The pass has changed since this client last read it.',
        );
      }
      if (row.lifecycleState !== 'ready') {
        throw new PassApplicationError('invalid_pass_transition', 'Only a ready pass can depart.');
      }
      await flow.acquireRoomLock(
        context,
        roomFlowLockKey(principal.tenantId, row.destinationRoomId),
      );
      const reservation = await flow.loadActiveReservationForPass(context, row.id);
      if (
        reservation?.releasedAt !== null ||
        reservation.claimedAt !== null ||
        Temporal.Instant.compare(now, reservation.readyExpiresAt) >= 0 ||
        Temporal.Instant.compare(now, reservation.flowExpiresAt) >= 0
      ) {
        throw new PassApplicationError('ready_offer_expired', 'The ready offer has expired.');
      }
      const destination = await passes.loadRoom(context, row.destinationRoomId);
      if (destination?.tenantId !== principal.tenantId) {
        throw new PassApplicationError('room_not_found', 'Room not found.');
      }
      if (destination.status !== 'open') {
        // No physical state is mutated as part of this error response; the
        // reconciler terminalizes the stale pre-departure flow afterwards.
        throw new PassApplicationError(
          'room_unavailable',
          'The destination is no longer usable.',
        );
      }
      try {
        transitionPass(toAggregate(row), 'outbound');
      } catch {
        throw new PassApplicationError('invalid_pass_transition', 'Only a ready pass can depart.');
      }
      const expectedReturnAt =
        destination.defaultDurationSeconds === null
          ? null
          : now.add({ seconds: destination.defaultDurationSeconds });
      const updated = await passes.updatePassToOutbound(
        context,
        row.id,
        row.revision,
        now,
        expectedReturnAt,
        {
          checkInMode: destination.checkInMode,
          destinationRevision: destination.revision,
        },
      );
      if (updated === null) {
        throw new PassApplicationError(
          'stale_pass_revision',
          'The pass has changed since this client last read it.',
        );
      }
      const claimed = await flow.claimReservation(context, reservation.id, now);
      if (!claimed) {
        throw new PassApplicationError('ready_offer_expired', 'The ready offer has expired.');
      }
      await passes.appendPassEvent(context, {
        passId: row.id,
        sequence: updated.revision,
        eventType: 'pass.departed',
        actorKind: 'person',
        actorPersonId: principal.personId,
        occurredAt: now,
        metadata: {
          schemaVersion: 1,
          state: 'outbound',
          revision: updated.revision.toString(10),
          defaultDurationSeconds: destination.defaultDurationSeconds,
          maxDurationSeconds: destination.maxDurationSeconds,
          expectedReturnAt: expectedReturnAt?.toString() ?? null,
          checkInMode: destination.checkInMode,
          destinationRevision: destination.revision.toString(10),
        },
      });
      await audit.append(context, {
        action: 'pass.departed',
        actorKind: 'account',
        actorId: principal.accountId,
        organizationId: row.organizationId,
        targetKind: 'pass',
        targetId: row.id,
        outcome: 'success',
        occurredAt: now,
        requestId,
        metadata: {
          passId: row.id,
          organizationId: row.organizationId,
          studentId: row.studentId,
          revision: updated.revision.toString(10),
          requestId,
        },
      });
      await outbox.append(context, {
        tenantId: row.tenantId,
        organizationId: row.organizationId,
        aggregateKind: 'pass',
        aggregateId: row.id,
        eventType: 'pass.departed',
        occurredAt: now.toString(),
        payload: {
          schemaVersion: 1,
          passId: row.id,
          organizationId: row.organizationId,
          studentId: row.studentId,
          lifecycleState: 'outbound',
          revision: updated.revision.toString(10),
          destinationRoomId: row.destinationRoomId,
          expectedReturnAt: expectedReturnAt?.toString() ?? null,
        },
      });
      const latest = await policy.loadLatestEvaluation(context, row.id);
      const liveApprovals = await policy.listApprovalsForPass(context, row.id);
      const liveOverrides = await policy.listOverridesForPass(context, row.id);
      const representation = toPassRepresentation(
        updated,
        latest === null ? null : buildPolicyProjection(latest, liveApprovals, liveOverrides),
        await loadMovementForRow(context, passes, flow, updated),
      );
      return { representation, etag: etagForPass(updated.id, updated.revision) };
    },
    toStored: (value) => ({ responseStatus: 200, responseBody: { pass: value.representation } }),
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

/**
 * POST /api/v1/me/passes/:passId/depart — the owning student starts their
 * own ready pass. Requires active student membership in the exact pass
 * school; system/admin grants never fabricate self semantics.
 */
export async function departSelfPass(
  input: DepartPassInput,
  dependencies: DepartPassDependencies,
): Promise<DepartPassResult> {
  if (input.principal.authenticationMethod === 'recovery') {
    throw new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot record departures.',
    );
  }
  const key = requireIdempotencyKey(input.idempotencyKey);
  const expected = requireIfMatch(input.ifMatch, input.passId);
  const now = dependencies.clock.now();
  const { authorization } = dependencies;
  return executeDeparture(
    {
      principal: input.principal,
      passId: input.passId,
      command: 'pass.depart.self:v1',
      fingerprint: fingerprintDepartSelf(input.passId, expected.revision),
      key,
      expectedRevision: expected.revision,
      requestId: input.requestId,
      now,
      authorize: async (context, row) => {
        if (row.studentId !== input.principal.personId) {
          throw new PassApplicationError('pass_not_found', 'Pass not found.');
        }
        const decision = await authorization.decideWithContext(context, {
          principal: input.principal,
          capability: 'pass.depart.self',
          resource: {
            kind: 'student',
            organizationId: row.organizationId,
            studentId: row.studentId,
          },
          at: now,
        });
        if (!decision.allowed) {
          throw new PassApplicationError('forbidden', 'Forbidden.');
        }
      },
    },
    dependencies,
  );
}

/**
 * POST /api/v1/passes/:passId/depart — staff starts a student's ready pass
 * (for example when the student carries no device). Organization-level staff
 * authority first, teacher fallback against the student's current section.
 */
export async function departStudentPass(
  input: DepartPassInput,
  dependencies: DepartPassDependencies,
): Promise<DepartPassResult> {
  if (input.principal.authenticationMethod === 'recovery') {
    throw new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot record departures.',
    );
  }
  const key = requireIdempotencyKey(input.idempotencyKey);
  const expected = requireIfMatch(input.ifMatch, input.passId);
  const now = dependencies.clock.now();
  const { authorization, placement, runner, passes } = dependencies;
  // Resolve the student's current placement before the mutation transaction
  // using the same command instant; the transaction revalidates authority.
  const binding = await runner.run(input.principal.tenantId, async (context) => {
    const pass = await passes.loadPassForUpdate(context, input.passId);
    if (pass?.tenantId !== input.principal.tenantId) {
      throw new PassApplicationError('pass_not_found', 'Pass not found.');
    }
    return { studentId: pass.studentId, schoolId: pass.organizationId };
  });
  const current = await placement.resolve({
    tenantId: input.principal.tenantId,
    organizationId: binding.schoolId,
    personId: binding.studentId,
    at: now,
  });
  return executeDeparture(
    {
      principal: input.principal,
      passId: input.passId,
      command: 'pass.depart.student:v1',
      fingerprint: fingerprintDepartStudent(input.passId, expected.revision),
      key,
      expectedRevision: expected.revision,
      requestId: input.requestId,
      now,
      authorize: async (context, row) => {
        const orgDecision = await authorization.decideWithContext(context, {
          principal: input.principal,
          capability: 'pass.depart.student',
          resource: {
            kind: 'student',
            organizationId: row.organizationId,
            studentId: row.studentId,
          },
          at: now,
        });
        if (orgDecision.allowed) return;
        if (current.kind === 'resolved') {
          const sectionDecision = await authorization.decideWithContext(context, {
            principal: input.principal,
            capability: 'pass.depart.student',
            resource: {
              kind: 'student_in_section',
              sectionId: current.section.id,
              studentId: row.studentId,
            },
            at: now,
          });
          if (sectionDecision.allowed) return;
        }
        // Conceal staff-unauthorized passes; recovery never reaches here.
        throw new PassApplicationError('pass_not_found', 'Pass not found.');
      },
    },
    dependencies,
  );
}
