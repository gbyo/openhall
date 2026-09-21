import type { Temporal } from '@js-temporal/polyfill';
import { isActiveState, type Clock, type PassLifecycleState } from '@openhall/domain';
import type { Principal } from '../authentication/principal.js';
import type { AuditWriter } from '../auditing/audit.js';
import type {
  AuthorizationFactsRepository,
  RelationshipAuthorizationService,
} from '../authorization/index.js';
import type { IdempotencyTransactionStore } from '../idempotency/coordinator.js';
import { runIdempotentCommand } from '../idempotency/coordinator.js';
import type {
  OutboxWriter,
  TenantTransactionContext,
  TenantTransactionRunner,
} from '../persistence.js';
import type { ExpectedPlacementResolver } from '../scheduling/index.js';
import {
  buildPolicyProjection,
  evaluateAndPersistPolicy,
  evaluatePolicy,
  isOverrideCategory,
  type OverrideCategory,
  type PolicyRepository,
} from '../policy/index.js';
import { PassApplicationError } from './errors.js';
import {
  advisoryLockKey,
  fingerprintOverrideRequest,
  fingerprintOverrideResolve,
  requireIdempotencyKey,
} from './idempotency.js';
import type { PassRepository } from './ports.js';
import type { PendingOverrideView } from '../policy/index.js';
import { etagForPass, parseAnyIfMatch, type PassRepresentation } from './representations.js';
import { reevaluatePersistAndApply } from './workflow.js';

export interface OverrideCommandDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly facts: AuthorizationFactsRepository;
  readonly placement: ExpectedPlacementResolver;
  readonly passes: PassRepository;
  readonly policy: PolicyRepository;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

export interface RequestOverrideInput {
  readonly principal: Principal;
  readonly passId: string;
  readonly category: OverrideCategory;
  readonly idempotencyKey: unknown;
  /** Raw If-Match header value; exact strong pass ETag required. */
  readonly ifMatch: unknown;
  readonly requestId: string;
  readonly surface: 'self' | 'student';
}

export interface RequestOverrideResult {
  readonly pass: PassRepresentation;
  readonly etag: string;
  readonly status: 200;
  readonly replayed: boolean;
}

export function parseOverrideCategory(value: unknown): OverrideCategory {
  if (typeof value === 'string' && isOverrideCategory(value)) return value;
  throw new PassApplicationError('invalid_override_state', 'Unknown override category.');
}

function denyToOverrideError(reason: string, surface: 'self' | 'student'): PassApplicationError {
  if (reason === 'recovery_session_restricted') {
    return new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot request overrides.',
    );
  }
  if (surface === 'self') {
    return new PassApplicationError('forbidden', 'Forbidden.');
  }
  return new PassApplicationError('override_not_found', 'Pass not found.');
}

/**
 * POST /api/v1/me/passes/:passId/overrides (self) and
 * POST /api/v1/passes/:passId/overrides (staff) — requests rule-specific
 * overrides for currently failing overrideable results. The client sends
 * only a category; blockers are server-derived from current policy.
 */
export async function requestPassOverride(
  input: RequestOverrideInput,
  dependencies: OverrideCommandDependencies,
): Promise<RequestOverrideResult> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const parsedMatch = parseAnyIfMatch(input.ifMatch);
  if (parsedMatch.passId !== input.passId) {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  if (input.principal.authenticationMethod === 'recovery') {
    throw new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot request overrides.',
    );
  }
  const now = dependencies.clock.now();
  const { authorization, passes, policy, idempotency, audit, outbox, runner } = dependencies;
  const command =
    input.surface === 'self' ? 'pass.override.request.self:v1' : 'pass.override.request.student:v1';

  const binding = await runner.run(input.principal.tenantId, async (context) => {
    const pass = await passes.loadPassForUpdate(context, input.passId);
    if (pass?.tenantId !== input.principal.tenantId) {
      throw new PassApplicationError(
        input.surface === 'self' ? 'pass_not_found' : 'override_not_found',
        'Pass not found.',
      );
    }
    if (input.surface === 'self' && pass.studentId !== input.principal.personId) {
      throw new PassApplicationError('pass_not_found', 'Pass not found.');
    }
    return { studentId: pass.studentId, schoolId: pass.organizationId };
  });
  const placement = await dependencies.placement.resolve({
    tenantId: input.principal.tenantId,
    organizationId: binding.schoolId,
    personId: binding.studentId,
    at: now,
  });
  const fingerprint = fingerprintOverrideRequest(
    input.passId,
    input.category,
    parsedMatch.revision,
    input.surface,
  );

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
        throw new PassApplicationError(
          input.surface === 'self' ? 'pass_not_found' : 'override_not_found',
          'Pass not found.',
        );
      }
      if (input.surface === 'self' && row.studentId !== input.principal.personId) {
        throw new PassApplicationError('pass_not_found', 'Pass not found.');
      }
      if (row.revision !== parsedMatch.revision) {
        throw new PassApplicationError(
          'stale_pass_revision',
          'The pass has changed since this client last read it.',
        );
      }
      if (!isActiveState(row.lifecycleState as PassLifecycleState)) {
        throw new PassApplicationError(
          'override_not_available',
          'No overrideable policy blocker exists.',
        );
      }
      if (input.surface === 'self') {
        const selfDecision = await authorization.decideWithContext(context, {
          principal: input.principal,
          capability: 'pass.override.request.self',
          resource: {
            kind: 'student',
            organizationId: row.organizationId,
            studentId: row.studentId,
          },
          at: now,
        });
        if (!selfDecision.allowed) throw denyToOverrideError(selfDecision.reason, 'self');
      } else {
        const orgDecision = await authorization.decideWithContext(context, {
          principal: input.principal,
          capability: 'pass.override.request.student',
          resource: {
            kind: 'student',
            organizationId: row.organizationId,
            studentId: row.studentId,
          },
          at: now,
        });
        if (!orgDecision.allowed) {
          if (orgDecision.reason === 'recovery_session_restricted') {
            throw denyToOverrideError(orgDecision.reason, 'student');
          }
          if (placement.kind === 'resolved') {
            const sectionDecision = await authorization.decideWithContext(context, {
              principal: input.principal,
              capability: 'pass.override.request.student',
              resource: {
                kind: 'student_in_section',
                sectionId: placement.section.id,
                studentId: row.studentId,
              },
              at: now,
            });
            if (!sectionDecision.allowed) {
              throw denyToOverrideError(sectionDecision.reason, 'student');
            }
          } else {
            throw denyToOverrideError(orgDecision.reason, 'student');
          }
        }
      }

      const passFacts = {
        id: row.id,
        revision: row.revision,
        organizationId: row.organizationId,
        studentId: row.studentId,
        destinationId: row.destinationId,
        requestSource: row.requestSource,
        originBlockId: row.originScheduleBlockId,
        originSectionId: row.originSectionId,
        originLocationId: row.originLocationId,
      };
      const rules = await policy.listEnabledRules(context, row.organizationId);
      const approvals = await policy.listApprovalsForPass(context, row.id);
      const overrides = await policy.listOverridesForPass(context, row.id);
      const current = evaluatePolicy({
        pass: passFacts,
        at: now,
        currentPlacement: placement,
        rules,
        approvals,
        overrides,
      });
      if (current.decision === 'deny') {
        throw new PassApplicationError(
          'override_not_available',
          'A nonoverrideable policy decision stands.',
        );
      }
      const blockers = current.results.filter(
        (result) =>
          (result.contribution === 'approval_required' ||
            result.contribution === 'override_required') &&
          (result.overrideMode === 'authorized' || result.overrideMode === 'approval_required'),
      );
      if (blockers.length === 0) {
        throw new PassApplicationError(
          'override_not_available',
          'No overrideable policy blocker exists.',
        );
      }

      // Provenance: each override corresponds to one exact failing result.
      // Prefer the latest persisted evaluation; persist a fresh read-only
      // view only when no persisted result matches (legacy passes, rule
      // changes since the last command).
      let latest = await policy.loadLatestEvaluation(context, row.id);
      const resultIdFor = new Map<string, string>();
      if (latest !== null) {
        for (const evaluation of latest.results) {
          const blocker = blockers.find(
            (candidate) =>
              candidate.ruleId === evaluation.ruleId &&
              candidate.ruleRevision === evaluation.ruleRevision &&
              (evaluation.contribution === 'approval_required' ||
                evaluation.contribution === 'override_required'),
          );
          if (blocker !== undefined && !resultIdFor.has(blocker.ruleId)) {
            resultIdFor.set(blocker.ruleId, evaluation.id);
          }
        }
      }
      if (blockers.some((blocker) => !resultIdFor.has(blocker.ruleId))) {
        await evaluateAndPersistPolicy(context, policy, {
          pass: passFacts,
          placement,
          at: now,
          stage: 'override',
        });
        latest = await policy.loadLatestEvaluation(context, row.id);
        resultIdFor.clear();
        if (latest !== null) {
          for (const evaluation of latest.results) {
            if (!resultIdFor.has(evaluation.ruleId)) {
              resultIdFor.set(evaluation.ruleId, evaluation.id);
            }
          }
        }
      }

      // Staff direct override: every blocker authorized-mode and resolvable
      // by this caller collapses request+approval atomically. Any
      // approval_required blocker, or lacking authority, stays pending.
      // Student self requests are always pending.
      let autoApprove = false;
      if (input.surface === 'student') {
        autoApprove = blockers.every((blocker) => blocker.overrideMode === 'authorized');
        if (autoApprove) {
          const schoolTier = await authorization.decideWithContext(context, {
            principal: input.principal,
            capability: 'pass.override.resolve.school',
            resource: {
              kind: 'student',
              organizationId: row.organizationId,
              studentId: row.studentId,
            },
            at: now,
          });
          let sectionAllowed = false;
          if (!schoolTier.allowed && placement.kind === 'resolved') {
            const sectionTier = await authorization.decideWithContext(context, {
              principal: input.principal,
              capability: 'pass.override.resolve.section',
              resource: {
                kind: 'student_in_section',
                sectionId: placement.section.id,
                studentId: row.studentId,
              },
              at: now,
            });
            sectionAllowed = sectionTier.allowed;
          }
          autoApprove = schoolTier.allowed || sectionAllowed;
        }
      }

      const createdIds: string[] = [];
      for (const blocker of blockers) {
        const live = await policy.findLiveOverride(
          context,
          row.id,
          blocker.ruleId,
          blocker.ruleRevision,
        );
        if (live !== null) continue;
        const originResultId = resultIdFor.get(blocker.ruleId);
        if (originResultId === undefined) continue;
        const created = await policy.createOverride(context, {
          organizationId: row.organizationId,
          passId: row.id,
          evaluationResultId: originResultId,
          ruleId: blocker.ruleId,
          ruleRevision: blocker.ruleRevision,
          overrideMode:
            blocker.overrideMode === 'approval_required' ? 'approval_required' : 'authorized',
          category: input.category,
          requestedByPersonId: input.principal.personId,
          requestedAt: now,
          decision: autoApprove ? 'approved' : 'pending',
        });
        createdIds.push(created.id);
      }

      const tailInputBase = {
        passId: row.id,
        schoolId: row.organizationId,
        studentId: row.studentId,
        destinationId: row.destinationId,
        placement,
        at: now,
        stage: 'override' as const,
        requestSource: row.requestSource,
      };
      if (createdIds.length === 0) {
        // Every blocker already carries a live override: no new effects, so
        // no revision bump and no event noise. Project current truth.
        const tail = await reevaluateTailOnly(context, policy, row.id);
        return {
          representation: toRepresentation(row, tail.projection),
          etag: etagForPass(row.id, row.revision),
        };
      }
      const bumped = await passes.touchPassRevision(context, row.id, row.revision, now);
      if (bumped === null) {
        throw new PassApplicationError(
          'stale_pass_revision',
          'The pass has changed since this client last read it.',
        );
      }
      await passes.appendPassEvent(context, {
        passId: row.id,
        sequence: bumped.revision,
        eventType: 'pass.override_requested',
        actorKind: 'person',
        actorPersonId: input.principal.personId,
        occurredAt: now,
        metadata: {
          schemaVersion: 1,
          revision: bumped.revision.toString(10),
          overrideIds: createdIds,
          autoApproved: autoApprove,
        },
      });
      await audit.append(context, {
        action: 'pass.override_requested',
        actorKind: 'account',
        actorId: input.principal.accountId,
        organizationId: row.organizationId,
        targetKind: 'pass',
        targetId: row.id,
        outcome: 'success',
        occurredAt: now,
        requestId: input.requestId,
        metadata: {
          passId: row.id,
          organizationId: row.organizationId,
          studentId: row.studentId,
          category: input.category,
          revision: bumped.revision.toString(10),
          requestId: input.requestId,
        },
      });
      await outbox.append(context, {
        tenantId: row.tenantId,
        organizationId: row.organizationId,
        aggregateKind: 'pass',
        aggregateId: row.id,
        eventType: 'pass.override_requested',
        occurredAt: now.toString(),
        payload: {
          schemaVersion: 1,
          overrideIds: createdIds,
          passId: row.id,
          organizationId: row.organizationId,
          studentId: row.studentId,
          category: input.category,
          passRevision: bumped.revision.toString(10),
        },
      });
      const tail = await reevaluatePersistAndApply(
        context,
        { passes, policy, outbox },
        { ...tailInputBase, workflowRow: bumped },
      );
      return {
        representation: toRepresentation(tail.row, tail.projection),
        etag: etagForPass(tail.row.id, tail.row.revision),
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

function toRepresentation(
  row: {
    id: string;
    organizationId: string;
    studentId: string;
    destinationId: string;
    destinationDisplayName: string;
    destinationServiceType: string;
    originBlock: { id: string; code: string; displayName: string } | null;
    originSection: { id: string; code: string | null; title: string } | null;
    originLocation: { id: string; name: string } | null;
    requestSource: string;
    requestedAt: Temporal.Instant;
    lifecycleState: string;
    revision: bigint;
  },
  projection: PassRepresentation['policy'],
): PassRepresentation {
  return {
    id: row.id,
    organizationId: row.organizationId,
    studentId: row.studentId,
    destination: {
      id: row.destinationId,
      displayName: row.destinationDisplayName,
      serviceType: row.destinationServiceType,
    },
    origin: {
      placementKind:
        row.originSection !== null
          ? 'resolved'
          : row.originBlock !== null
            ? 'block_only'
            : 'unresolved',
      block: row.originBlock,
      section: row.originSection,
      location: row.originLocation,
    },
    requestSource: row.requestSource,
    requestedAt: row.requestedAt.toString(),
    lifecycleState: row.lifecycleState,
    revision: row.revision.toString(10),
    policy: projection,
  };
}

/**
 * Projection-only tail for deduped override requests: reuses the latest
 * persisted evaluation without inventing history or bumping the revision.
 */
async function reevaluateTailOnly(
  context: TenantTransactionContext,
  policy: PolicyRepository,
  passId: string,
): Promise<{ projection: PassRepresentation['policy'] }> {
  const latest = await policy.loadLatestEvaluation(context, passId);
  if (latest === null) return { projection: null };
  const approvals = await policy.listApprovalsForPass(context, passId);
  const overrides = await policy.listOverridesForPass(context, passId);
  return { projection: buildPolicyProjection(latest, approvals, overrides) };
}

export interface ResolveOverrideInput {
  readonly principal: Principal;
  readonly overrideId: string;
  readonly decision: 'approved' | 'denied';
  readonly idempotencyKey: unknown;
  /** Raw If-Match header value; exact strong pass ETag required. */
  readonly ifMatch: unknown;
  readonly requestId: string;
}

export interface ResolveOverrideResult {
  readonly pass: PassRepresentation;
  readonly etag: string;
  readonly status: 200;
  readonly replayed: boolean;
}

/**
 * POST /api/v1/pass-overrides/:overrideId/approve|deny — resolves one exact
 * rule-specific override, then reevaluates current movement policy.
 */
export async function resolvePassOverride(
  input: ResolveOverrideInput,
  dependencies: OverrideCommandDependencies,
): Promise<ResolveOverrideResult> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const parsedMatch = parseAnyIfMatch(input.ifMatch);
  if (input.principal.authenticationMethod === 'recovery') {
    throw new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot resolve overrides.',
    );
  }
  const now = dependencies.clock.now();
  const { authorization, passes, policy, idempotency, audit, outbox, runner } = dependencies;
  const command =
    input.decision === 'approved' ? 'pass.override.approve:v1' : 'pass.override.deny:v1';

  const binding = await runner.run(input.principal.tenantId, async (context) => {
    const override = await policy.loadOverrideById(context, input.overrideId);
    if (override === null) {
      throw new PassApplicationError('override_not_found', 'Override not found.');
    }
    const pass = await passes.loadPassForUpdate(context, override.passId);
    if (pass?.tenantId !== input.principal.tenantId) {
      throw new PassApplicationError('override_not_found', 'Override not found.');
    }
    return { passId: pass.id, studentId: pass.studentId, schoolId: pass.organizationId };
  });
  if (parsedMatch.passId !== binding.passId) {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  const placement = await dependencies.placement.resolve({
    tenantId: input.principal.tenantId,
    organizationId: binding.schoolId,
    personId: binding.studentId,
    at: now,
  });
  const fingerprint = fingerprintOverrideResolve(
    input.overrideId,
    binding.passId,
    parsedMatch.revision,
    input.decision,
  );

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
      const row = await passes.loadPassForUpdate(context, binding.passId);
      if (row?.tenantId !== input.principal.tenantId) {
        throw new PassApplicationError('override_not_found', 'Override not found.');
      }
      const override = await policy.lockOverrideForUpdate(context, input.overrideId);
      if (override?.passId !== row.id) {
        throw new PassApplicationError('override_not_found', 'Override not found.');
      }
      if (row.revision !== parsedMatch.revision) {
        throw new PassApplicationError(
          'stale_pass_revision',
          'The pass has changed since this client last read it.',
        );
      }
      if (override.decision !== 'pending') {
        throw new PassApplicationError(
          'invalid_override_state',
          'This override is no longer pending.',
        );
      }
      if (!isActiveState(row.lifecycleState as PassLifecycleState)) {
        throw new PassApplicationError(
          'invalid_override_state',
          'This override is no longer actionable.',
        );
      }
      const schoolTier = await authorization.decideWithContext(context, {
        principal: input.principal,
        capability: 'pass.override.resolve.school',
        resource: {
          kind: 'student',
          organizationId: row.organizationId,
          studentId: row.studentId,
        },
        at: now,
      });
      if (override.overrideMode === 'authorized') {
        if (schoolTier.allowed) {
          // Section and school resolvers alike may resolve authorized mode.
        } else if (placement.kind === 'resolved') {
          const sectionTier = await authorization.decideWithContext(context, {
            principal: input.principal,
            capability: 'pass.override.resolve.section',
            resource: {
              kind: 'student_in_section',
              sectionId: placement.section.id,
              studentId: row.studentId,
            },
            at: now,
          });
          if (!sectionTier.allowed) {
            if (sectionTier.reason === 'recovery_session_restricted') {
              throw new PassApplicationError(
                'recovery_session_restricted',
                'Recovery sessions cannot resolve overrides.',
              );
            }
            throw new PassApplicationError('override_not_found', 'Override not found.');
          }
        } else if (schoolTier.reason === 'recovery_session_restricted') {
          throw new PassApplicationError(
            'recovery_session_restricted',
            'Recovery sessions cannot resolve overrides.',
          );
        } else {
          throw new PassApplicationError('override_not_found', 'Override not found.');
        }
      } else if (!schoolTier.allowed) {
        if (schoolTier.reason === 'recovery_session_restricted') {
          throw new PassApplicationError(
            'recovery_session_restricted',
            'Recovery sessions cannot resolve overrides.',
          );
        }
        throw new PassApplicationError('override_not_found', 'Override not found.');
      }
      if (
        override.overrideMode === 'approval_required' &&
        override.requestedByPersonId === input.principal.personId
      ) {
        throw new PassApplicationError(
          'override_requires_independent_approver',
          'An approval_required override needs an independent approver.',
        );
      }
      const resolved = await policy.resolveOverride(context, override.id, {
        decision: input.decision,
        actorKind: 'person',
        decidedByPersonId: input.principal.personId,
        decidedAt: now,
      });
      if (resolved === null) {
        throw new PassApplicationError(
          'invalid_override_state',
          'This override is no longer pending.',
        );
      }
      const bumped = await passes.touchPassRevision(context, row.id, row.revision, now);
      if (bumped === null) {
        throw new PassApplicationError(
          'stale_pass_revision',
          'The pass has changed since this client last read it.',
        );
      }
      const eventType =
        input.decision === 'approved' ? 'pass.override_approved' : 'pass.override_denied';
      await passes.appendPassEvent(context, {
        passId: row.id,
        sequence: bumped.revision,
        eventType,
        actorKind: 'person',
        actorPersonId: input.principal.personId,
        occurredAt: now,
        metadata: {
          schemaVersion: 1,
          overrideId: override.id,
          decision: input.decision,
          revision: bumped.revision.toString(10),
        },
      });
      await audit.append(context, {
        action: eventType,
        actorKind: 'account',
        actorId: input.principal.accountId,
        organizationId: row.organizationId,
        targetKind: 'pass',
        targetId: row.id,
        outcome: 'success',
        occurredAt: now,
        requestId: input.requestId,
        metadata: {
          passId: row.id,
          overrideId: override.id,
          organizationId: row.organizationId,
          studentId: row.studentId,
          category: override.category,
          revision: bumped.revision.toString(10),
          requestId: input.requestId,
        },
      });
      await outbox.append(context, {
        tenantId: row.tenantId,
        organizationId: row.organizationId,
        aggregateKind: 'pass',
        aggregateId: row.id,
        eventType,
        occurredAt: now.toString(),
        payload: {
          schemaVersion: 1,
          overrideId: override.id,
          passId: row.id,
          organizationId: row.organizationId,
          studentId: row.studentId,
          category: override.category,
          passRevision: bumped.revision.toString(10),
        },
      });
      const tail = await reevaluatePersistAndApply(
        context,
        { passes, policy, outbox },
        {
          passId: row.id,
          schoolId: row.organizationId,
          studentId: row.studentId,
          destinationId: row.destinationId,
          placement,
          at: now,
          stage: 'override',
          workflowRow: bumped,
          requestSource: row.requestSource,
        },
      );
      return {
        representation: toRepresentation(tail.row, tail.projection),
        etag: etagForPass(tail.row.id, tail.row.revision),
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

export interface PendingOverrideItem {
  readonly overrideId: string;
  readonly passId: string;
  readonly passRevision: string;
  readonly passEtag: string;
  readonly student: { readonly id: string; readonly displayName: string };
  readonly destination: {
    readonly id: string;
    readonly displayName: string;
    readonly serviceType: string;
  };
  readonly category: string;
  readonly overrideMode: string;
  readonly reasonCode: string;
  readonly requestedAt: string;
}

/**
 * GET /api/v1/me/pass-overrides/pending — pending overrides the principal
 * may legitimately resolve, honoring each override's escalation tier.
 */
export async function listPendingOverrides(
  principal: Principal,
  dependencies: Pick<
    OverrideCommandDependencies,
    'clock' | 'runner' | 'authorization' | 'placement' | 'policy'
  >,
): Promise<readonly PendingOverrideItem[]> {
  if (principal.authenticationMethod === 'recovery') {
    throw new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot resolve overrides.',
    );
  }
  const at: Temporal.Instant = dependencies.clock.now();
  const views = await dependencies.runner.run(principal.tenantId, (context) =>
    dependencies.policy.listPendingOverrideViews(context),
  );
  const items: PendingOverrideItem[] = [];
  for (const view of views) {
    if (await mayResolveOverride(principal, dependencies, view, at)) {
      items.push({
        overrideId: view.overrideId,
        passId: view.passId,
        passRevision: view.passRevision.toString(10),
        passEtag: etagForPass(view.passId, view.passRevision),
        student: { id: view.studentId, displayName: view.studentDisplayName },
        destination: {
          id: view.destinationId,
          displayName: view.destinationDisplayName,
          serviceType: view.destinationServiceType,
        },
        category: view.category,
        overrideMode: view.overrideMode,
        reasonCode: view.reasonCode,
        requestedAt: view.requestedAt.toString(),
      });
    }
  }
  return items;
}

async function mayResolveOverride(
  principal: Principal,
  dependencies: Pick<OverrideCommandDependencies, 'authorization' | 'placement'>,
  view: PendingOverrideView,
  at: Temporal.Instant,
): Promise<boolean> {
  const schoolTier = await dependencies.authorization.decide({
    principal,
    capability: 'pass.override.resolve.school',
    resource: {
      kind: 'student',
      organizationId: view.organizationId,
      studentId: view.studentId,
    },
    at,
  });
  if (schoolTier.allowed) return true;
  if (view.overrideMode !== 'authorized') return false;
  const placement = await dependencies.placement.resolve({
    tenantId: principal.tenantId,
    organizationId: view.organizationId,
    personId: view.studentId,
    at,
  });
  if (placement.kind !== 'resolved') return false;
  return dependencies.authorization.isAllowed({
    principal,
    capability: 'pass.override.resolve.section',
    resource: {
      kind: 'student_in_section',
      sectionId: placement.section.id,
      studentId: view.studentId,
    },
    at,
  });
}
