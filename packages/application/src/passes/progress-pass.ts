import type { Temporal } from '@js-temporal/polyfill';
import { transitionPass, type PassAggregate } from '@openhall/domain';
import type { Clock } from '@openhall/domain';
import type { Principal } from '../authentication/principal.js';
import type { AuditWriter } from '../auditing/audit.js';
import type { RelationshipAuthorizationService } from '../authorization/index.js';
import type { DestinationFlowRepository } from '../destination-flow/ports.js';
import { destinationFlowLockKey } from '../destination-flow/locks.js';
import { loadMovementForRow } from '../destination-flow/projections.js';
import type { IdempotencyTransactionStore } from '../idempotency/coordinator.js';
import { runIdempotentCommand } from '../idempotency/coordinator.js';
import type {
  OutboxWriter,
  TenantTransactionContext,
  TenantTransactionRunner,
} from '../persistence.js';
import { buildPolicyProjection, type PolicyRepository } from '../policy/index.js';
import { PassApplicationError } from './errors.js';
import {
  advisoryLockKey,
  fingerprintArriveSelf,
  fingerprintCompleteSelf,
  fingerprintReturnSelf,
  fingerprintStationBeginReturn,
  fingerprintStationCheckIn,
  fingerprintStationComplete,
  requireIdempotencyKey,
} from './idempotency.js';
import type { PassRepository, PassRow } from './ports.js';
import {
  etagForPass,
  requireIfMatch,
  toPassRepresentation,
  type PassRepresentation,
} from './representations.js';

export interface ProgressPassDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly passes: PassRepository;
  readonly flow: DestinationFlowRepository;
  readonly policy: PolicyRepository;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

export interface ProgressPassInput {
  readonly principal: Principal;
  readonly passId: string;
  readonly idempotencyKey: unknown;
  /** Raw If-Match header value; exact OpenHall strong ETag required. */
  readonly ifMatch: unknown;
  readonly requestId: string;
}

export interface StationProgressInput extends ProgressPassInput {
  readonly destinationId: string;
}

export interface ProgressPassResult {
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
    originLocationId: row.originLocationId,
    originSectionId: row.originSectionId,
    originScheduleBlockId: row.originScheduleBlockId,
    destinationId: row.destinationId,
    returnLocationId: row.returnLocationId,
    requestSource: row.requestSource as PassAggregate['requestSource'],
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

interface MutationSpec {
  readonly principal: Principal;
  readonly passId: string;
  readonly command: string;
  readonly fingerprint: string;
  readonly key: string;
  readonly expectedRevision: bigint;
  readonly requestId: string;
  readonly now: Temporal.Instant;
  readonly loadAndAuthorize: (context: TenantTransactionContext) => Promise<PassRow>;
  readonly apply: (
    context: TenantTransactionContext,
    row: PassRow,
  ) => Promise<{ updated: PassRow; eventType: string; auditAction: string }>;
}

async function executeProgressMutation(
  spec: MutationSpec,
  dependencies: ProgressPassDependencies,
): Promise<ProgressPassResult> {
  const { principal, command, fingerprint, key, requestId, now } = spec;
  const { passes, policy, idempotency, audit, runner } = dependencies;

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
      const row = await spec.loadAndAuthorize(context);
      const applied = await spec.apply(context, row);
      const latest = await policy.loadLatestEvaluation(context, row.id);
      const liveApprovals = await policy.listApprovalsForPass(context, row.id);
      const liveOverrides = await policy.listOverridesForPass(context, row.id);
      const representation = toPassRepresentation(
        applied.updated,
        latest === null ? null : buildPolicyProjection(latest, liveApprovals, liveOverrides),
        await loadMovementForRow(context, passes, dependencies.flow, applied.updated),
      );
      await audit.append(context, {
        action: applied.auditAction,
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
          revision: applied.updated.revision.toString(10),
          requestId,
        },
      });
      return { representation, etag: etagForPass(applied.updated.id, applied.updated.revision) };
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

async function appendMovementEvent(
  context: TenantTransactionContext,
  passes: PassRepository,
  outbox: OutboxWriter,
  input: {
    readonly row: PassRow;
    readonly updated: PassRow;
    readonly eventType: string;
    readonly actorPersonId: string;
    readonly now: Temporal.Instant;
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await passes.appendPassEvent(context, {
    passId: input.row.id,
    sequence: input.updated.revision,
    eventType: input.eventType,
    actorKind: 'person',
    actorPersonId: input.actorPersonId,
    occurredAt: input.now,
    metadata: {
      schemaVersion: 1,
      state: input.updated.lifecycleState,
      revision: input.updated.revision.toString(10),
      ...(input.metadata ?? {}),
    },
  });
  await outbox.append(context, {
    tenantId: input.row.tenantId,
    organizationId: input.row.organizationId,
    aggregateKind: 'pass',
    aggregateId: input.row.id,
    eventType: input.eventType,
    occurredAt: input.now.toString(),
    payload: {
      schemaVersion: 1,
      passId: input.row.id,
      organizationId: input.row.organizationId,
      studentId: input.row.studentId,
      lifecycleState: input.updated.lifecycleState,
      revision: input.updated.revision.toString(10),
      destinationId: input.row.destinationId,
      expectedReturnAt: input.updated.expectedReturnAt?.toString() ?? null,
    },
  });
}

/** Ownership gate shared by self progress commands. */
async function loadOwnedPass(
  context: TenantTransactionContext,
  passes: PassRepository,
  principal: Principal,
  passId: string,
  expectedRevision: bigint,
  verb: string,
): Promise<PassRow> {
  const row = await passes.loadPassForUpdate(context, passId);
  if (row?.tenantId !== principal.tenantId) {
    throw new PassApplicationError('pass_not_found', 'Pass not found.');
  }
  if (row.studentId !== principal.personId) {
    throw new PassApplicationError('pass_not_found', 'Pass not found.');
  }
  if (principal.authenticationMethod === 'recovery') {
    throw new PassApplicationError(
      'recovery_session_restricted',
      `Recovery sessions cannot ${verb}.`,
    );
  }
  if (row.revision !== expectedRevision) {
    throw staleRevision();
  }
  return row;
}

/** Station gate: exact destination assignment plus canonical pass binding. */
async function loadStationPass(
  context: TenantTransactionContext,
  dependencies: Pick<ProgressPassDependencies, 'authorization' | 'passes'>,
  principal: Principal,
  destinationId: string,
  passId: string,
  expectedRevision: bigint,
  verb: string,
  now: Temporal.Instant,
): Promise<PassRow> {
  const { authorization, passes } = dependencies;
  if (principal.authenticationMethod === 'recovery') {
    throw new PassApplicationError(
      'recovery_session_restricted',
      `Recovery sessions cannot ${verb}.`,
    );
  }
  const decision = await authorization.decideWithContext(context, {
    principal,
    capability: 'destination.station.manage',
    resource: { kind: 'destination', destinationId },
    at: now,
  });
  if (!decision.allowed) {
    if (decision.reason === 'recovery_session_restricted') {
      throw new PassApplicationError(
        'recovery_session_restricted',
        `Recovery sessions cannot ${verb}.`,
      );
    }
    throw new PassApplicationError('pass_not_found', 'Pass not found.');
  }
  const destination = await passes.loadDestination(context, destinationId);
  if (destination?.tenantId !== principal.tenantId) {
    throw new PassApplicationError('destination_not_found', 'Destination not found.');
  }
  const row = await passes.loadPassForUpdate(context, passId);
  if (row?.tenantId !== principal.tenantId) {
    throw new PassApplicationError('pass_not_found', 'Pass not found.');
  }
  if (row.destinationId !== destinationId) {
    // A valid pass for another destination is not operable from this station.
    throw new PassApplicationError('pass_not_found', 'Pass not found.');
  }
  if (row.revision !== expectedRevision) {
    throw staleRevision();
  }
  return row;
}

async function checkInModeFor(
  passes: PassRepository,
  context: TenantTransactionContext,
  row: PassRow,
  principal: Principal,
): Promise<string> {
  // Departure-time snapshot governs active movement: later destination
  // configuration edits affect only new departures. Passes that departed
  // before Phase 8 carry no snapshot and honestly fall back to the live
  // destination setting instead of a backfilled fiction.
  if (row.departureCheckInMode !== null) {
    return row.departureCheckInMode;
  }
  const destination = await passes.loadDestination(context, row.destinationId);
  if (destination?.tenantId !== principal.tenantId) {
    throw new PassApplicationError('destination_not_found', 'Destination not found.');
  }
  return destination.checkInMode;
}

/**
 * POST /api/v1/me/passes/:passId/arrive — self arrival, only for
 * check_in_mode = optional. Required destinations need station check-in;
 * none destinations do not take arrival checkpoints.
 */
export async function arriveSelfPass(
  input: ProgressPassInput,
  dependencies: ProgressPassDependencies,
): Promise<ProgressPassResult> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const expected = requireIfMatch(input.ifMatch, input.passId);
  const now = dependencies.clock.now();
  const { passes, authorization } = dependencies;
  return executeProgressMutation(
    {
      principal: input.principal,
      passId: input.passId,
      command: 'pass.arrive.self:v1',
      fingerprint: fingerprintArriveSelf(input.passId, expected.revision),
      key,
      expectedRevision: expected.revision,
      requestId: input.requestId,
      now,
      loadAndAuthorize: async (context) => {
        const row = await loadOwnedPass(
          context,
          passes,
          input.principal,
          input.passId,
          expected.revision,
          'record arrival',
        );
        const decision = await authorization.decideWithContext(context, {
          principal: input.principal,
          capability: 'pass.progress.self',
          resource: { kind: 'self' },
          at: now,
        });
        if (!decision.allowed) {
          throw new PassApplicationError('forbidden', 'Forbidden.');
        }
        return row;
      },
      apply: async (context, row) => {
        if (row.lifecycleState !== 'outbound') {
          throw new PassApplicationError(
            'invalid_pass_transition',
            'Only an outbound pass can arrive.',
          );
        }
        const mode = await checkInModeFor(dependencies.passes, context, row, input.principal);
        if (mode === 'none') {
          throw new PassApplicationError(
            'check_in_not_supported',
            'This destination does not take arrival check-ins.',
          );
        }
        if (mode === 'required') {
          throw new PassApplicationError(
            'station_check_in_required',
            'Arrival must be recorded by the destination station.',
          );
        }
        try {
          transitionPass(toAggregate(row), 'at_destination');
        } catch {
          throw new PassApplicationError(
            'invalid_pass_transition',
            'Only an outbound pass can arrive.',
          );
        }
        const updated = await passes.updatePassToAtDestination(context, row.id, row.revision, now);
        if (updated === null) throw staleRevision();
        await appendMovementEvent(context, passes, dependencies.outbox, {
          row,
          updated,
          eventType: 'pass.arrived',
          actorPersonId: input.principal.personId,
          now,
        });
        return { updated, eventType: 'pass.arrived', auditAction: 'pass.arrived' };
      },
    },
    dependencies,
  );
}

/**
 * POST /api/v1/me/passes/:passId/return — self begin-return from
 * at_destination. Releases destination capacity: an explicit event now says
 * the student left the destination.
 */
export async function returnSelfPass(
  input: ProgressPassInput,
  dependencies: ProgressPassDependencies,
): Promise<ProgressPassResult> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const expected = requireIfMatch(input.ifMatch, input.passId);
  const now = dependencies.clock.now();
  const { passes, flow, authorization } = dependencies;
  return executeProgressMutation(
    {
      principal: input.principal,
      passId: input.passId,
      command: 'pass.return.self:v1',
      fingerprint: fingerprintReturnSelf(input.passId, expected.revision),
      key,
      expectedRevision: expected.revision,
      requestId: input.requestId,
      now,
      loadAndAuthorize: async (context) => {
        const row = await loadOwnedPass(
          context,
          passes,
          input.principal,
          input.passId,
          expected.revision,
          'begin return',
        );
        const decision = await authorization.decideWithContext(context, {
          principal: input.principal,
          capability: 'pass.progress.self',
          resource: { kind: 'self' },
          at: now,
        });
        if (!decision.allowed) {
          throw new PassApplicationError('forbidden', 'Forbidden.');
        }
        return row;
      },
      apply: async (context, row) => {
        if (row.lifecycleState !== 'at_destination') {
          throw new PassApplicationError(
            'invalid_pass_transition',
            'Only a pass at the destination can begin returning.',
          );
        }
        try {
          transitionPass(toAggregate(row), 'returning');
        } catch {
          throw new PassApplicationError(
            'invalid_pass_transition',
            'Only a pass at the destination can begin returning.',
          );
        }
        await flow.acquireDestinationLock(
          context,
          destinationFlowLockKey(input.principal.tenantId, row.destinationId),
        );
        const updated = await passes.updatePassToReturning(
          context,
          row.id,
          row.revision,
          now,
          // Return to the origin location when it is known; never invent one.
          row.originLocationId,
        );
        if (updated === null) throw staleRevision();
        const reservation = await flow.loadActiveReservationForPass(context, row.id);
        if (reservation !== null) {
          await flow.releaseReservation(context, reservation.id, 'return_started', now);
        }
        await appendMovementEvent(context, passes, dependencies.outbox, {
          row,
          updated,
          eventType: 'pass.return_started',
          actorPersonId: input.principal.personId,
          now,
        });
        return { updated, eventType: 'pass.return_started', auditAction: 'pass.return_started' };
      },
    },
    dependencies,
  );
}

/**
 * POST /api/v1/me/passes/:passId/complete — self completion. The normal
 * lightweight path is outbound -> completed with no fabricated arrival or
 * return checkpoints (Chromebook left in the room).
 */
export async function completeSelfPass(
  input: ProgressPassInput,
  dependencies: ProgressPassDependencies,
): Promise<ProgressPassResult> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const expected = requireIfMatch(input.ifMatch, input.passId);
  const now = dependencies.clock.now();
  const { passes, flow, authorization } = dependencies;
  return executeProgressMutation(
    {
      principal: input.principal,
      passId: input.passId,
      command: 'pass.complete.self:v1',
      fingerprint: fingerprintCompleteSelf(input.passId, expected.revision),
      key,
      expectedRevision: expected.revision,
      requestId: input.requestId,
      now,
      loadAndAuthorize: async (context) => {
        const row = await loadOwnedPass(
          context,
          passes,
          input.principal,
          input.passId,
          expected.revision,
          'complete movement',
        );
        const decision = await authorization.decideWithContext(context, {
          principal: input.principal,
          capability: 'pass.progress.self',
          resource: { kind: 'self' },
          at: now,
        });
        if (!decision.allowed) {
          throw new PassApplicationError('forbidden', 'Forbidden.');
        }
        return row;
      },
      apply: async (context, row) => {
        if (row.lifecycleState === 'returning') {
          // Always allowed for the pass owner; capacity was released already.
        } else if (row.lifecycleState === 'outbound') {
          const mode = await checkInModeFor(passes, context, row, input.principal);
          if (mode === 'required') {
            throw new PassApplicationError(
              'station_check_in_required',
              'Arrival must be recorded by the destination station first.',
            );
          }
        } else if (row.lifecycleState === 'at_destination') {
          const mode = await checkInModeFor(passes, context, row, input.principal);
          if (mode === 'required') {
            // A required station-managed destination ends via station
            // completion or an explicit return, never direct self-completion.
            throw new PassApplicationError(
              'invalid_pass_transition',
              'This destination completes movement at its station.',
            );
          }
        } else {
          throw new PassApplicationError(
            'invalid_pass_transition',
            'This pass cannot be completed.',
          );
        }
        try {
          transitionPass(toAggregate(row), 'completed');
        } catch {
          throw new PassApplicationError(
            'invalid_pass_transition',
            'This pass cannot be completed.',
          );
        }
        await flow.acquireDestinationLock(
          context,
          destinationFlowLockKey(input.principal.tenantId, row.destinationId),
        );
        const updated = await passes.updatePassToCompleted(context, row.id, row.revision, now);
        if (updated === null) throw staleRevision();
        const reservation = await flow.loadActiveReservationForPass(context, row.id);
        if (reservation !== null) {
          await flow.releaseReservation(context, reservation.id, 'completed', now);
        }
        await appendMovementEvent(context, passes, dependencies.outbox, {
          row,
          updated,
          eventType: 'pass.completed',
          actorPersonId: input.principal.personId,
          now,
        });
        return { updated, eventType: 'pass.completed', auditAction: 'pass.completed' };
      },
    },
    dependencies,
  );
}

/**
 * POST /api/v1/destinations/:destinationId/passes/:passId/check-in —
 * station arrival for optional/required destinations.
 */
export async function stationCheckInPass(
  input: StationProgressInput,
  dependencies: ProgressPassDependencies,
): Promise<ProgressPassResult> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const expected = requireIfMatch(input.ifMatch, input.passId);
  const now = dependencies.clock.now();
  const { passes } = dependencies;
  return executeProgressMutation(
    {
      principal: input.principal,
      passId: input.passId,
      command: 'pass.station.check_in:v1',
      fingerprint: fingerprintStationCheckIn(input.destinationId, input.passId, expected.revision),
      key,
      expectedRevision: expected.revision,
      requestId: input.requestId,
      now,
      loadAndAuthorize: (context) =>
        loadStationPass(
          context,
          dependencies,
          input.principal,
          input.destinationId,
          input.passId,
          expected.revision,
          'record station check-in',
          now,
        ),
      apply: async (context, row) => {
        if (row.lifecycleState !== 'outbound') {
          throw new PassApplicationError(
            'invalid_pass_transition',
            'Only an outbound pass can be checked in.',
          );
        }
        const mode = await checkInModeFor(passes, context, row, input.principal);
        if (mode !== 'optional' && mode !== 'required') {
          throw new PassApplicationError(
            'check_in_not_supported',
            'This destination does not take arrival check-ins.',
          );
        }
        try {
          transitionPass(toAggregate(row), 'at_destination');
        } catch {
          throw new PassApplicationError(
            'invalid_pass_transition',
            'Only an outbound pass can be checked in.',
          );
        }
        const updated = await passes.updatePassToAtDestination(context, row.id, row.revision, now);
        if (updated === null) throw staleRevision();
        await appendMovementEvent(context, passes, dependencies.outbox, {
          row,
          updated,
          eventType: 'pass.arrived',
          actorPersonId: input.principal.personId,
          now,
        });
        return { updated, eventType: 'pass.arrived', auditAction: 'pass.arrived' };
      },
    },
    dependencies,
  );
}

/**
 * POST /api/v1/destinations/:destinationId/passes/:passId/begin-return —
 * station records that the student left the destination. Releases capacity.
 */
export async function stationBeginReturnPass(
  input: StationProgressInput,
  dependencies: ProgressPassDependencies,
): Promise<ProgressPassResult> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const expected = requireIfMatch(input.ifMatch, input.passId);
  const now = dependencies.clock.now();
  const { passes, flow } = dependencies;
  return executeProgressMutation(
    {
      principal: input.principal,
      passId: input.passId,
      command: 'pass.station.begin_return:v1',
      fingerprint: fingerprintStationBeginReturn(
        input.destinationId,
        input.passId,
        expected.revision,
      ),
      key,
      expectedRevision: expected.revision,
      requestId: input.requestId,
      now,
      loadAndAuthorize: (context) =>
        loadStationPass(
          context,
          dependencies,
          input.principal,
          input.destinationId,
          input.passId,
          expected.revision,
          'begin station return',
          now,
        ),
      apply: async (context, row) => {
        if (row.lifecycleState !== 'at_destination') {
          throw new PassApplicationError(
            'invalid_pass_transition',
            'Only a pass at the destination can begin returning.',
          );
        }
        try {
          transitionPass(toAggregate(row), 'returning');
        } catch {
          throw new PassApplicationError(
            'invalid_pass_transition',
            'Only a pass at the destination can begin returning.',
          );
        }
        await flow.acquireDestinationLock(
          context,
          destinationFlowLockKey(input.principal.tenantId, row.destinationId),
        );
        const updated = await passes.updatePassToReturning(
          context,
          row.id,
          row.revision,
          now,
          row.originLocationId,
        );
        if (updated === null) throw staleRevision();
        const reservation = await flow.loadActiveReservationForPass(context, row.id);
        if (reservation !== null) {
          await flow.releaseReservation(context, reservation.id, 'return_started', now);
        }
        await appendMovementEvent(context, passes, dependencies.outbox, {
          row,
          updated,
          eventType: 'pass.return_started',
          actorPersonId: input.principal.personId,
          now,
        });
        return { updated, eventType: 'pass.return_started', auditAction: 'pass.return_started' };
      },
    },
    dependencies,
  );
}

/**
 * POST /api/v1/destinations/:destinationId/passes/:passId/complete —
 * destination staff explicitly ends a movement at the destination (one-way
 * workflows: nurse stays, office supervision transfers). Never from
 * outbound: arrival stays an explicit fact.
 */
export async function stationCompletePass(
  input: StationProgressInput,
  dependencies: ProgressPassDependencies,
): Promise<ProgressPassResult> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const expected = requireIfMatch(input.ifMatch, input.passId);
  const now = dependencies.clock.now();
  const { passes, flow } = dependencies;
  return executeProgressMutation(
    {
      principal: input.principal,
      passId: input.passId,
      command: 'pass.station.complete:v1',
      fingerprint: fingerprintStationComplete(input.destinationId, input.passId, expected.revision),
      key,
      expectedRevision: expected.revision,
      requestId: input.requestId,
      now,
      loadAndAuthorize: (context) =>
        loadStationPass(
          context,
          dependencies,
          input.principal,
          input.destinationId,
          input.passId,
          expected.revision,
          'complete station movement',
          now,
        ),
      apply: async (context, row) => {
        if (row.lifecycleState !== 'at_destination') {
          throw new PassApplicationError(
            'invalid_pass_transition',
            'Station completion requires an explicit arrival first.',
          );
        }
        const mode = await checkInModeFor(passes, context, row, input.principal);
        if (mode !== 'optional' && mode !== 'required') {
          throw new PassApplicationError(
            'check_in_not_supported',
            'This destination does not complete movement at a station.',
          );
        }
        try {
          transitionPass(toAggregate(row), 'completed');
        } catch {
          throw new PassApplicationError(
            'invalid_pass_transition',
            'This pass cannot be completed.',
          );
        }
        await flow.acquireDestinationLock(
          context,
          destinationFlowLockKey(input.principal.tenantId, row.destinationId),
        );
        const updated = await passes.updatePassToCompleted(context, row.id, row.revision, now);
        if (updated === null) throw staleRevision();
        const reservation = await flow.loadActiveReservationForPass(context, row.id);
        if (reservation !== null) {
          await flow.releaseReservation(context, reservation.id, 'completed', now);
        }
        await appendMovementEvent(context, passes, dependencies.outbox, {
          row,
          updated,
          eventType: 'pass.completed',
          actorPersonId: input.principal.personId,
          now,
        });
        return { updated, eventType: 'pass.completed', auditAction: 'pass.completed' };
      },
    },
    dependencies,
  );
}
