import type { Temporal } from '@js-temporal/polyfill';
import type { ExpectedPlacementResult } from '../scheduling/index.js';
import type { PolicyOverrideMode, PolicyRuleType } from './configurations.js';

/** Typed rule as loaded for evaluation (configuration validated by the engine). */
export interface PolicyRuleInput {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly ruleType: string;
  readonly scopeKind: 'organization' | 'section' | 'destination';
  readonly scopeOrganizationId: string | null;
  readonly scopeSectionId: string | null;
  readonly scopeDestinationId: string | null;
  readonly priority: number;
  readonly configuration: unknown;
  readonly overrideMode: string;
  readonly enabled: boolean;
  readonly validFrom: Temporal.Instant | null;
  readonly validUntil: Temporal.Instant | null;
  readonly revision: number;
}

/** Approval evidence visible to the evaluator (any decision state). */
export interface PolicyApprovalEvidence {
  readonly passId: string;
  readonly policyRuleId: string;
  readonly policyRuleRevision: number;
  readonly requiredSectionId: string;
  readonly decision: 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';
}

/** Override evidence visible to the evaluator (any decision state). */
export interface PolicyOverrideEvidence {
  readonly passId: string;
  readonly policyRuleId: string;
  readonly policyRuleRevision: number;
  readonly decision: 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';
}

/**
 * Typed scheduled-preapproval evidence. A preapproved scheduled
 * authorization may satisfy only an approval_requirement that would
 * otherwise require a classroom approval for the exact scheduled movement.
 * It never bypasses deny contributions, overrides, capacity, or status.
 */
export interface ScheduledPreapprovalEvidence {
  readonly scheduledAuthorizationId: string;
  readonly studentId: string;
  readonly destinationId: string;
}

export interface PolicyPassFacts {
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

/**
 * Pure policy evaluation context. The caller injects exactly one command
 * instant; the engine performs no I/O, clock reads, or hidden state access.
 */
export interface PolicyEvaluationContext {
  readonly pass: PolicyPassFacts;
  /** The single injected command instant shared by the whole command. */
  readonly at: Temporal.Instant;
  readonly currentPlacement: ExpectedPlacementResult;
  /** Active typed rules in deterministic order (priority DESC, id ASC). */
  readonly rules: readonly PolicyRuleInput[];
  readonly approvals: readonly PolicyApprovalEvidence[];
  readonly overrides: readonly PolicyOverrideEvidence[];
  /** Scheduled preapprovals bound to this exact pass command, if any. */
  readonly scheduledPreapprovals: readonly ScheduledPreapprovalEvidence[];
}

export type { PolicyOverrideMode, PolicyRuleType };
