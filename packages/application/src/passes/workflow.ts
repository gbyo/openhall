import type { Temporal } from '@js-temporal/polyfill';
import { transitionPass } from '@openhall/domain';
import type { OutboxWriter, TenantTransactionContext } from '../persistence.js';
import type { ExpectedPlacementResult } from '../scheduling/index.js';
import {
  buildPolicyProjection,
  evaluateAndPersistPolicy,
  reconcilePendingApprovals,
  type PolicyRepository,
} from '../policy/index.js';
import type { PolicyEvaluationStage } from '../policy/index.js';
import { PassApplicationError } from './errors.js';
import type { PassRepository, PassRow } from './ports.js';
import type { PassPolicyProjection } from './representations.js';

export interface WorkflowTailDependencies {
  readonly passes: PassRepository;
  readonly policy: PolicyRepository;
  readonly outbox: OutboxWriter;
}

export interface WorkflowTailInput {
  readonly passId: string;
  readonly schoolId: string;
  readonly studentId: string;
  readonly destinationId: string;
  readonly placement: ExpectedPlacementResult;
  readonly at: Temporal.Instant;
  readonly stage: Extract<PolicyEvaluationStage, 'approval' | 'override'>;
  /** Locked pass row at the workflow revision (after the workflow bump). */
  readonly workflowRow: PassRow;
  readonly requestSource: string;
}

export interface WorkflowTailResult {
  readonly row: PassRow;
  readonly projection: PassPolicyProjection;
}

/**
 * Shared tail for approval/override commands: reevaluates current movement
 * policy at the workflow revision, persists the immutable evaluation,
 * reconciles pending approvals, applies denial transitions, and builds the
 * safe projection. Never emits queued/ready: allow, approval_required, and
 * override_required all leave the lifecycle at requested.
 */
export async function reevaluatePersistAndApply(
  context: TenantTransactionContext,
  dependencies: WorkflowTailDependencies,
  input: WorkflowTailInput,
): Promise<WorkflowTailResult> {
  const { passes, policy, outbox } = dependencies;
  const { workflowRow, placement, at, stage } = input;
  const decided = await evaluateAndPersistPolicy(context, policy, {
    pass: {
      id: workflowRow.id,
      revision: workflowRow.revision,
      organizationId: workflowRow.organizationId,
      studentId: workflowRow.studentId,
      destinationId: workflowRow.destinationId,
      requestSource: input.requestSource,
      originBlockId: workflowRow.originScheduleBlockId,
      originSectionId: workflowRow.originSectionId,
      originLocationId: workflowRow.originLocationId,
    },
    placement,
    at,
    stage,
  });
  const reconciled = await reconcilePendingApprovals(context, policy, {
    organizationId: workflowRow.organizationId,
    passId: workflowRow.id,
    outcome: decided.outcome,
    resultIdsByRule: decided.resultIdsByRule,
    at,
  });
  const reasonCodes: string[] = [];
  for (const result of decided.outcome.results) {
    if (!reasonCodes.includes(result.reasonCode)) reasonCodes.push(result.reasonCode);
  }
  const revisionText = workflowRow.revision.toString(10);
  await outbox.append(context, {
    tenantId: workflowRow.tenantId,
    organizationId: input.schoolId,
    aggregateKind: 'pass',
    aggregateId: workflowRow.id,
    eventType: 'pass.policy_evaluated',
    occurredAt: at.toString(),
    payload: {
      schemaVersion: 1,
      passId: workflowRow.id,
      organizationId: input.schoolId,
      studentId: input.studentId,
      passRevision: revisionText,
      decision: decided.outcome.decision,
      reasonCodes,
      approvalPending: reconciled.kept.length > 0,
      overrideAvailable: decided.outcome.results.some(
        (result) => result.contribution === 'override_required',
      ),
    },
  });
  for (const approval of reconciled.created) {
    await outbox.append(context, {
      tenantId: workflowRow.tenantId,
      organizationId: input.schoolId,
      aggregateKind: 'pass',
      aggregateId: workflowRow.id,
      eventType: 'pass.approval_required',
      occurredAt: at.toString(),
      payload: {
        schemaVersion: 1,
        approvalId: approval.id,
        passId: workflowRow.id,
        organizationId: input.schoolId,
        studentId: input.studentId,
        requiredSectionId: approval.requiredSectionId,
        passRevision: revisionText,
      },
    });
  }
  let finalRow = workflowRow;
  let liveApprovals = [...reconciled.kept];
  if (decided.outcome.decision === 'deny') {
    try {
      transitionPass(
        {
          id: workflowRow.id,
          tenantId: workflowRow.tenantId,
          organizationId: workflowRow.organizationId,
          studentId: workflowRow.studentId,
          originLocationId: workflowRow.originLocationId,
          originSectionId: workflowRow.originSectionId,
          originScheduleBlockId: workflowRow.originScheduleBlockId,
          destinationId: workflowRow.destinationId,
          returnLocationId: workflowRow.returnLocationId,
          requestSource: input.requestSource as 'student_web' | 'staff_web',
          requestedByPersonId: workflowRow.requestedByPersonId,
          requestedAt: workflowRow.requestedAt,
          lifecycleState: workflowRow.lifecycleState as 'requested',
          expectedReturnAt: workflowRow.expectedReturnAt,
          scheduledAuthorizationId: workflowRow.scheduledAuthorizationId,
          revision: workflowRow.revision,
        },
        'denied',
      );
    } catch {
      throw new PassApplicationError('invalid_pass_transition', 'This pass cannot be denied.');
    }
    const denied = await passes.updatePassToDenied(
      context,
      workflowRow.id,
      workflowRow.revision,
      at,
    );
    if (denied === null) {
      throw new PassApplicationError(
        'stale_pass_revision',
        'The pass has changed since this client last read it.',
      );
    }
    await passes.appendPassEvent(context, {
      passId: workflowRow.id,
      sequence: denied.revision,
      eventType: 'pass.denied',
      actorKind: 'system',
      actorPersonId: null,
      occurredAt: at,
      metadata: {
        schemaVersion: 1,
        state: 'denied',
        revision: denied.revision.toString(10),
      },
    });
    await outbox.append(context, {
      tenantId: workflowRow.tenantId,
      organizationId: input.schoolId,
      aggregateKind: 'pass',
      aggregateId: workflowRow.id,
      eventType: 'pass.denied',
      occurredAt: at.toString(),
      payload: {
        schemaVersion: 1,
        passId: workflowRow.id,
        organizationId: input.schoolId,
        studentId: input.studentId,
        lifecycleState: 'denied',
        revision: denied.revision.toString(10),
        destinationId: input.destinationId,
      },
    });
    await policy.cancelAllPendingWorkflows(context, workflowRow.id, at);
    finalRow = denied;
    liveApprovals = [];
  }
  const liveOverrides = await policy.listOverridesForPass(context, workflowRow.id);
  const projection = buildPolicyProjection(
    {
      id: decided.evaluationId,
      passRevision: finalRow.revision,
      stage,
      decision: decided.outcome.decision,
      evaluatedAt: at,
      results: decided.outcome.results.map((result) => ({
        id: decided.resultIdsByRule.get(result.ruleId) ?? '',
        ruleId: result.ruleId,
        ruleRevision: result.ruleRevision,
        outcome: result.outcome,
        reasonCode: result.reasonCode,
        overrideMode: result.overrideMode,
        contribution: result.contribution,
      })),
    },
    liveApprovals,
    liveOverrides,
  );
  return { row: finalRow, projection };
}
