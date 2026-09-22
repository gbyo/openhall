import type { Temporal } from '@js-temporal/polyfill';
import type { TenantTransactionContext } from '../persistence.js';
import type { OverrideCategory, PolicyOverrideMode } from './configurations.js';
import type {
  PolicyApprovalEvidence,
  PolicyApproverKind,
  PolicyOverrideEvidence,
  PolicyRuleInput,
} from './context.js';
import type { PolicyContribution, PolicyDecision, PolicyRuleOutcome } from './decisions.js';
import type { PolicyReasonCode } from './reason-codes.js';

export type PolicyEvaluationStage = 'request' | 'approval' | 'override' | 'reevaluation';

export interface NewPolicyEvaluation {
  readonly passId: string;
  readonly passRevision: bigint;
  readonly stage: PolicyEvaluationStage;
  readonly decision: PolicyDecision;
  readonly evaluatedAt: Temporal.Instant;
  readonly contextSnapshot: Readonly<Record<string, unknown>>;
}

export interface NewPolicyEvaluationResult {
  readonly evaluationId: string;
  readonly ruleId: string;
  readonly ruleRevision: number;
  readonly outcome: PolicyRuleOutcome;
  readonly reasonCode: PolicyReasonCode;
  readonly overrideMode: PolicyOverrideMode;
  readonly contribution: PolicyContribution;
  readonly ruleSnapshot: Readonly<Record<string, unknown>>;
}

export interface PolicyRuleSnapshotInput {
  readonly name: string;
  readonly ruleType: string;
  readonly scopeKind: string;
  readonly scopeOrganizationId: string | null;
  readonly scopeSectionId: string | null;
  readonly scopeRoomId: string | null;
  readonly configuration: unknown;
  readonly overrideMode: string;
  readonly revision: number;
}

export interface PersistedPolicyResult {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleRevision: number;
  readonly outcome: PolicyRuleOutcome;
  readonly reasonCode: PolicyReasonCode;
  readonly overrideMode: string;
  readonly contribution: PolicyContribution;
}

export interface PersistedPolicyEvaluation {
  readonly id: string;
  readonly passRevision: bigint;
  readonly stage: string;
  readonly decision: PolicyDecision;
  readonly evaluatedAt: Temporal.Instant;
  readonly results: readonly PersistedPolicyResult[];
}

export interface NewPendingApproval {
  readonly organizationId: string;
  readonly passId: string;
  readonly originEvaluationResultId: string;
  readonly ruleId: string;
  readonly ruleRevision: number;
  readonly approverKind: PolicyApproverKind;
  readonly requiredSectionId: string | null;
  readonly requiredRoomId: string | null;
}

export interface PolicyApprovalRecord extends PolicyApprovalEvidence {
  readonly id: string;
  readonly organizationId: string;
  readonly originEvaluationResultId: string;
  readonly createdAt: Temporal.Instant;
  readonly decidedAt: Temporal.Instant | null;
  readonly decisionActorKind: 'person' | 'system' | null;
  readonly decidedByPersonId: string | null;
}

export interface NewPendingOverride {
  readonly organizationId: string;
  readonly passId: string;
  readonly evaluationResultId: string;
  readonly ruleId: string;
  readonly ruleRevision: number;
  readonly overrideMode: PolicyOverrideMode;
  readonly category: string;
  readonly requestedByPersonId: string;
  readonly requestedAt: Temporal.Instant;
}

export interface PolicyOverrideRecord extends PolicyOverrideEvidence {
  readonly id: string;
  readonly organizationId: string;
  readonly evaluationResultId: string;
  readonly overrideMode: PolicyOverrideMode;
  readonly category: string;
  readonly requestedByPersonId: string;
  readonly requestedAt: Temporal.Instant;
  readonly decidedAt: Temporal.Instant | null;
  readonly decisionActorKind: 'person' | 'system' | null;
  readonly decidedByPersonId: string | null;
}

/**
 * Purpose-built policy persistence port. Methods are use-case shaped; there
 * is no generic SQL escape hatch. All operations run on the caller's tenant
 * transaction connection with pass-first lock ordering.
 */
export interface PolicyRepository {
  /** Enabled rules for one school in deterministic order (priority DESC, id ASC). */
  listEnabledRules(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly PolicyRuleInput[]>;

  createEvaluation(context: TenantTransactionContext, input: NewPolicyEvaluation): Promise<string>;

  addEvaluationResult(
    context: TenantTransactionContext,
    input: NewPolicyEvaluationResult,
  ): Promise<string>;

  /** Latest persisted evaluation with results, or null for legacy passes. */
  loadLatestEvaluation(
    context: TenantTransactionContext,
    passId: string,
  ): Promise<PersistedPolicyEvaluation | null>;

  listApprovalsForPass(
    context: TenantTransactionContext,
    passId: string,
  ): Promise<readonly PolicyApprovalRecord[]>;

  /** Reuses the live pending requirement when one already exists. */
  findPendingApproval(
    context: TenantTransactionContext,
    passId: string,
    ruleId: string,
    ruleRevision: number,
    requirement: {
      readonly approverKind: PolicyApproverKind;
      readonly requiredSectionId: string | null;
      readonly requiredRoomId: string | null;
    },
  ): Promise<PolicyApprovalRecord | null>;

  createPendingApproval(
    context: TenantTransactionContext,
    input: NewPendingApproval,
  ): Promise<PolicyApprovalRecord>;

  lockApprovalForUpdate(
    context: TenantTransactionContext,
    approvalId: string,
  ): Promise<PolicyApprovalRecord | null>;

  /**
   * Resolves a pending approval. Returns null when the row is no longer
   * pending (lost a race) so the caller reports 409, not a silent overwrite.
   */
  resolveApproval(
    context: TenantTransactionContext,
    approvalId: string,
    resolution: {
      readonly decision: 'approved' | 'denied';
      readonly actorKind: 'person';
      readonly decidedByPersonId: string;
      readonly decidedAt: Temporal.Instant;
    },
  ): Promise<PolicyApprovalRecord | null>;

  /**
   * System reconciliation: cancels pending approvals that are no longer
   * required. Never touches approved/denied history.
   */
  cancelObsoletePendingApprovals(
    context: TenantTransactionContext,
    passId: string,
    keepApprovalIds: readonly string[],
    at: Temporal.Instant,
  ): Promise<void>;

  /** System cleanup: cancels every pending approval/override on a terminal pass. */
  cancelAllPendingWorkflows(
    context: TenantTransactionContext,
    passId: string,
    at: Temporal.Instant,
  ): Promise<void>;

  listOverridesForPass(
    context: TenantTransactionContext,
    passId: string,
  ): Promise<readonly PolicyOverrideRecord[]>;

  /** Reuses the live (pending/approved) override when one already exists. */
  findLiveOverride(
    context: TenantTransactionContext,
    passId: string,
    ruleId: string,
    ruleRevision: number,
  ): Promise<PolicyOverrideRecord | null>;

  createOverride(
    context: TenantTransactionContext,
    input: NewPendingOverride & { readonly decision: 'pending' | 'approved' },
  ): Promise<PolicyOverrideRecord>;

  lockOverrideForUpdate(
    context: TenantTransactionContext,
    overrideId: string,
  ): Promise<PolicyOverrideRecord | null>;

  /** Resolves a pending override; null when no longer pending. */
  resolveOverride(
    context: TenantTransactionContext,
    overrideId: string,
    resolution: {
      readonly decision: 'approved' | 'denied';
      readonly actorKind: 'person';
      readonly decidedByPersonId: string;
      readonly decidedAt: Temporal.Instant;
    },
  ): Promise<PolicyOverrideRecord | null>;

  /** Non-locking read for fingerprinting and pending-list assembly. */
  loadApprovalById(
    context: TenantTransactionContext,
    approvalId: string,
  ): Promise<PolicyApprovalRecord | null>;

  /** Non-locking read for fingerprinting and pending-list assembly. */
  loadOverrideById(
    context: TenantTransactionContext,
    overrideId: string,
  ): Promise<PolicyOverrideRecord | null>;

  /** Every pending approval in the tenant with staff-facing display data. */
  listPendingApprovalViews(
    context: TenantTransactionContext,
  ): Promise<readonly PendingApprovalView[]>;

  /** Every pending override in the tenant with staff-facing display data. */
  listPendingOverrideViews(
    context: TenantTransactionContext,
  ): Promise<readonly PendingOverrideView[]>;
}

/** Staff-facing pending approval row; never carries rule JSON or grants. */
export interface PendingApprovalView {
  readonly approvalId: string;
  readonly passId: string;
  readonly passRevision: bigint;
  readonly organizationId: string;
  readonly studentId: string;
  readonly studentDisplayName: string;
  readonly destinationRoomId: string;
  readonly destinationRoomName: string;
  readonly approverKind: PolicyApproverKind;
  readonly requiredSectionId: string | null;
  readonly requiredRoomId: string | null;
  readonly requiredRoomName: string | null;
  readonly sectionCode: string | null;
  readonly sectionTitle: string | null;
  readonly requestedAt: Temporal.Instant;
}

/** Staff-facing pending override row; never carries rule configuration. */
export interface PendingOverrideView {
  readonly overrideId: string;
  readonly passId: string;
  readonly passRevision: bigint;
  readonly organizationId: string;
  readonly studentId: string;
  readonly studentDisplayName: string;
  readonly destinationRoomId: string;
  readonly destinationRoomName: string;
  readonly category: OverrideCategory;
  readonly overrideMode: PolicyOverrideMode;
  readonly reasonCode: PolicyReasonCode;
  readonly requestedAt: Temporal.Instant;
}
