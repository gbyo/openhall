import type { Temporal } from '@js-temporal/polyfill';
import type { PassPolicyProjection } from '../passes/representations.js';
import type { ExpectedPlacementResult } from '../scheduling/index.js';
import type { TenantTransactionContext } from '../persistence.js';
import { isPolicyOverrideMode } from './configurations.js';
import type { PolicyEvaluationContext, PolicyRuleInput } from './context.js';
import { evaluatePolicy, type PolicyEvaluationOutcome } from './engine.js';
import type {
  PersistedPolicyEvaluation,
  PolicyApprovalRecord,
  PolicyOverrideRecord,
  PolicyRepository,
} from './ports.js';
import type { PolicyEvaluationStage } from './ports.js';

export interface PolicyPassInput {
  readonly id: string;
  readonly revision: bigint;
  readonly organizationId: string;
  readonly studentId: string;
  readonly destinationId: string;
  readonly requestSource: string;
  readonly originBlockId: string | null;
  readonly originSectionId: string | null;
  readonly originLocationId: string | null;
}

/** Immutable versioned rule snapshot: what was actually evaluated. */
export function buildRuleSnapshot(rule: PolicyRuleInput): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    name: rule.name,
    ruleType: rule.ruleType,
    scope: {
      kind: rule.scopeKind,
      organizationId: rule.scopeOrganizationId,
      sectionId: rule.scopeSectionId,
      destinationId: rule.scopeDestinationId,
    },
    configuration: rule.configuration,
    overrideMode: rule.overrideMode,
    revision: rule.revision,
  };
}

/**
 * Minimized versioned evaluation context snapshot. Carries IDs and slot
 * boundaries only; never names, emails, OIDC subjects, grants, candidate
 * IDs, configuration messages, or private explanations.
 */
export function buildContextSnapshot(input: {
  readonly pass: PolicyPassInput;
  readonly placement: ExpectedPlacementResult;
}): Readonly<Record<string, unknown>> {
  const { pass, placement } = input;
  const currentPlacement: Record<string, unknown> = { kind: placement.kind };
  if (placement.kind === 'resolved' || placement.kind === 'block_only') {
    currentPlacement.blockId = placement.block.id;
    currentPlacement.slotBeginsAt = placement.beginsAt.toString();
    currentPlacement.slotEndsAt = placement.endsAt.toString();
  }
  if (placement.kind === 'resolved') {
    currentPlacement.sectionId = placement.section.id;
  }
  return {
    schemaVersion: 1,
    passRevision: pass.revision.toString(10),
    requestSource: pass.requestSource,
    destinationId: pass.destinationId,
    origin: {
      blockId: pass.originBlockId,
      sectionId: pass.originSectionId,
      locationId: pass.originLocationId,
    },
    currentPlacement,
  };
}

export interface PersistedPolicyDecision {
  readonly outcome: PolicyEvaluationOutcome;
  readonly evaluationId: string;
  /** Evaluation-result id per rule id, for approval/override provenance. */
  readonly resultIdsByRule: ReadonlyMap<string, string>;
}

/**
 * Loads current rules and evidence, runs the pure engine, and persists the
 * immutable evaluation plus one result per loaded rule. Exactly one
 * evaluation per command; replays never reach here.
 */
export async function evaluateAndPersistPolicy(
  context: TenantTransactionContext,
  policy: PolicyRepository,
  input: {
    readonly pass: PolicyPassInput;
    readonly placement: ExpectedPlacementResult;
    readonly at: Temporal.Instant;
    readonly stage: PolicyEvaluationStage;
  },
): Promise<PersistedPolicyDecision> {
  const rules = await policy.listEnabledRules(context, input.pass.organizationId);
  const approvals = await policy.listApprovalsForPass(context, input.pass.id);
  const overrides = await policy.listOverridesForPass(context, input.pass.id);
  const evaluationContext: PolicyEvaluationContext = {
    pass: input.pass,
    at: input.at,
    currentPlacement: input.placement,
    rules,
    approvals,
    overrides,
  };
  const outcome = evaluatePolicy(evaluationContext);
  const evaluationId = await policy.createEvaluation(context, {
    passId: input.pass.id,
    passRevision: input.pass.revision,
    stage: input.stage,
    decision: outcome.decision,
    evaluatedAt: input.at,
    contextSnapshot: buildContextSnapshot({ pass: input.pass, placement: input.placement }),
  });
  const resultIdsByRule = new Map<string, string>();
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const result = outcome.results[index];
    if (rule === undefined || result === undefined) continue;
    // The mode column honors the foundation CHECK; an unrecognized mode
    // (unreachable while the DB constraint holds) coerces to never so a
    // misconfigured rule fails closed as deny instead of erroring mid-command.
    // The rule snapshot always preserves the actual evaluated row.
    const overrideMode = isPolicyOverrideMode(result.overrideMode) ? result.overrideMode : 'never';
    const resultId = await policy.addEvaluationResult(context, {
      evaluationId,
      ruleId: rule.id,
      ruleRevision: rule.revision,
      outcome: result.outcome,
      reasonCode: result.reasonCode,
      overrideMode,
      contribution: result.contribution,
      ruleSnapshot: buildRuleSnapshot(rule),
    });
    resultIdsByRule.set(rule.id, resultId);
  }
  return { outcome, evaluationId, resultIdsByRule };
}

export interface ReconciledApprovals {
  /** Currently required pending rows, reused or newly created. */
  readonly kept: readonly PolicyApprovalRecord[];
  /** The subset of kept rows created by this reconciliation. */
  readonly created: readonly PolicyApprovalRecord[];
}

/**
 * Reconciles pending approvals with fresh requirements: reuses or creates
 * the currently required rows, cancels obsolete pending rows with system
 * provenance, and never touches approved/denied history.
 */
export async function reconcilePendingApprovals(
  context: TenantTransactionContext,
  policy: PolicyRepository,
  input: {
    readonly organizationId: string;
    readonly passId: string;
    readonly outcome: PolicyEvaluationOutcome;
    readonly resultIdsByRule: ReadonlyMap<string, string>;
    readonly at: Temporal.Instant;
  },
): Promise<ReconciledApprovals> {
  const kept: PolicyApprovalRecord[] = [];
  const created: PolicyApprovalRecord[] = [];
  for (const requirement of input.outcome.approvalRequirements) {
    const existing = await policy.findPendingApproval(
      context,
      input.passId,
      requirement.ruleId,
      requirement.ruleRevision,
      requirement.requiredSectionId,
    );
    if (existing !== null) {
      kept.push(existing);
      continue;
    }
    const originResultId = input.resultIdsByRule.get(requirement.ruleId);
    if (originResultId === undefined) continue;
    const row = await policy.createPendingApproval(context, {
      organizationId: input.organizationId,
      passId: input.passId,
      originEvaluationResultId: originResultId,
      ruleId: requirement.ruleId,
      ruleRevision: requirement.ruleRevision,
      requiredSectionId: requirement.requiredSectionId,
    });
    kept.push(row);
    if (!created.some((approval) => approval.id === row.id)) created.push(row);
  }
  await policy.cancelObsoletePendingApprovals(
    context,
    input.passId,
    kept.map((approval) => approval.id),
    input.at,
  );
  return { kept, created };
}

/** Safe client projection from the latest evaluation plus live evidence. */
export function buildPolicyProjection(
  evaluation: PersistedPolicyEvaluation,
  approvals: readonly PolicyApprovalRecord[],
  overrides: readonly PolicyOverrideRecord[],
): PassPolicyProjection {
  const reasonCodes: string[] = [];
  for (const result of evaluation.results) {
    if (!reasonCodes.includes(result.reasonCode)) reasonCodes.push(result.reasonCode);
  }
  return {
    decision: evaluation.decision,
    evaluatedAt: evaluation.evaluatedAt.toString(),
    reasonCodes,
    approvalPending: approvals.some((approval) => approval.decision === 'pending'),
    overrideAvailable: evaluation.results.some(
      (result) => result.contribution === 'override_required',
    ),
    overridePending: overrides.some((override) => override.decision === 'pending'),
  };
}
