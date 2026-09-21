import type { PolicyReasonCode } from './reason-codes.js';

/** Phase 6 engine decisions. `queue` is reserved for Phase 7 and never emitted. */
export const POLICY_DECISIONS = [
  'allow',
  'deny',
  'approval_required',
  'override_required',
] as const;

export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

export type PolicyRuleOutcome = 'pass' | 'fail' | 'not_applicable';

export type PolicyContribution = 'none' | 'deny' | 'approval_required' | 'override_required';

export interface PolicyRuleEvaluation {
  readonly ruleId: string;
  readonly ruleRevision: number;
  readonly ruleType: string;
  readonly overrideMode: string;
  readonly outcome: PolicyRuleOutcome;
  readonly contribution: PolicyContribution;
  readonly reasonCode: PolicyReasonCode;
  /** Present when an approval requirement names an exact section. */
  readonly requiredSectionId: string | null;
}

/**
 * Deterministic safety combination. Priority orders evaluation and display
 * only; it never alters this precedence: any deny wins, then any
 * override requirement, then any approval requirement, else allow.
 */
export function combinePolicyDecision(results: readonly PolicyRuleEvaluation[]): PolicyDecision {
  let sawOverride = false;
  let sawApproval = false;
  for (const result of results) {
    switch (result.contribution) {
      case 'deny':
        return 'deny';
      case 'override_required':
        sawOverride = true;
        break;
      case 'approval_required':
        sawApproval = true;
        break;
      case 'none':
        break;
    }
  }
  if (sawOverride) return 'override_required';
  if (sawApproval) return 'approval_required';
  return 'allow';
}
