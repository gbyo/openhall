import { Temporal } from '@js-temporal/polyfill';
import {
  isPolicyOverrideMode,
  isPolicyRuleType,
  parsePolicyRuleConfiguration,
  type PolicyOverrideMode,
} from './configurations.js';
import type {
  PolicyApprovalEvidence,
  PolicyEvaluationContext,
  PolicyOverrideEvidence,
  PolicyRuleInput,
} from './context.js';
import {
  combinePolicyDecision,
  type PolicyContribution,
  type PolicyDecision,
  type PolicyRuleEvaluation,
} from './decisions.js';
import type { PolicyReasonCode } from './reason-codes.js';

export interface ApprovalRequirement {
  readonly ruleId: string;
  readonly ruleRevision: number;
  readonly requiredSectionId: string;
}

export interface OverrideRequirement {
  readonly ruleId: string;
  readonly ruleRevision: number;
  readonly overrideMode: PolicyOverrideMode;
  readonly reasonCode: PolicyReasonCode;
}

export interface PolicyEvaluationOutcome {
  readonly decision: PolicyDecision;
  readonly results: readonly PolicyRuleEvaluation[];
  readonly approvalRequirements: readonly ApprovalRequirement[];
  readonly overrideRequirements: readonly OverrideRequirement[];
}

function inHalfOpenWindow(
  at: Temporal.Instant,
  start: Temporal.Instant,
  end: Temporal.Instant,
): boolean {
  return Temporal.Instant.compare(start, at) <= 0 && Temporal.Instant.compare(at, end) < 0;
}

/** Scope applicability without configuration: false means not_applicable. */
function scopeMatches(rule: PolicyRuleInput, context: PolicyEvaluationContext): boolean {
  switch (rule.scopeKind) {
    case 'organization':
      return rule.scopeOrganizationId === context.pass.organizationId;
    case 'destination':
      return rule.scopeDestinationId === context.pass.destinationId;
    case 'section': {
      const placement = context.currentPlacement;
      if (placement.kind !== 'resolved') return false;
      return rule.scopeSectionId === placement.section.id;
    }
    default:
      return false;
  }
}

function temporallyActive(rule: PolicyRuleInput, at: Temporal.Instant): boolean {
  if (rule.validFrom !== null && Temporal.Instant.compare(rule.validFrom, at) > 0) return false;
  if (rule.validUntil !== null && Temporal.Instant.compare(at, rule.validUntil) >= 0) return false;
  return true;
}

function notApplicable(rule: PolicyRuleInput): PolicyRuleEvaluation {
  return {
    ruleId: rule.id,
    ruleRevision: rule.revision,
    ruleType: rule.ruleType,
    overrideMode: rule.overrideMode,
    outcome: 'not_applicable',
    contribution: 'none',
    reasonCode: 'no_violation',
    requiredSectionId: null,
  };
}

/** Malformed enabled policy fails closed and is never overrideable. */
function configurationError(rule: PolicyRuleInput): PolicyRuleEvaluation {
  return {
    ruleId: rule.id,
    ruleRevision: rule.revision,
    ruleType: rule.ruleType,
    overrideMode: rule.overrideMode,
    outcome: 'fail',
    contribution: 'deny',
    reasonCode: 'policy_configuration_error',
    requiredSectionId: null,
  };
}

function failContribution(mode: string): PolicyContribution {
  // Closed modes fail toward escalation; anything unrecognized fails closed
  // as deny (unreachable when the DB CHECK holds: defense in depth).
  if (mode === 'authorized' || mode === 'approval_required') return 'override_required';
  return 'deny';
}

function isOverrideableMode(mode: string): mode is PolicyOverrideMode {
  return mode === 'authorized' || mode === 'approval_required';
}

function approvedOverrideFor(
  overrides: readonly PolicyOverrideEvidence[],
  ruleId: string,
  ruleRevision: number,
): boolean {
  return overrides.some(
    (entry) =>
      entry.policyRuleId === ruleId &&
      entry.policyRuleRevision === ruleRevision &&
      entry.decision === 'approved',
  );
}

function deniedOverrideFor(
  overrides: readonly PolicyOverrideEvidence[],
  ruleId: string,
  ruleRevision: number,
): boolean {
  return overrides.some(
    (entry) =>
      entry.policyRuleId === ruleId &&
      entry.policyRuleRevision === ruleRevision &&
      entry.decision === 'denied',
  );
}

/** Applies override evidence to a failing rule; null means no override decision. */
function applyOverrideEvidence(
  rule: PolicyRuleInput,
  context: PolicyEvaluationContext,
  requiredSectionId: string | null,
): PolicyRuleEvaluation | null {
  const base = {
    ruleId: rule.id,
    ruleRevision: rule.revision,
    ruleType: rule.ruleType,
    overrideMode: rule.overrideMode,
    requiredSectionId,
  };
  if (approvedOverrideFor(context.overrides, rule.id, rule.revision)) {
    return { ...base, outcome: 'pass', contribution: 'none', reasonCode: 'rule_overridden' };
  }
  if (deniedOverrideFor(context.overrides, rule.id, rule.revision)) {
    return { ...base, outcome: 'fail', contribution: 'deny', reasonCode: 'override_denied' };
  }
  return null;
}

function evaluateScheduleBoundary(
  rule: PolicyRuleInput,
  context: PolicyEvaluationContext,
  config: {
    readonly firstMinutes: number;
    readonly lastMinutes: number;
    readonly blockKinds: readonly string[];
    readonly requestSources: readonly string[];
  },
): PolicyRuleEvaluation {
  const base = {
    ruleId: rule.id,
    ruleRevision: rule.revision,
    ruleType: rule.ruleType,
    overrideMode: rule.overrideMode,
    requiredSectionId: null,
  };
  if (!config.requestSources.includes(context.pass.requestSource)) return notApplicable(rule);
  const placement = context.currentPlacement;
  if (placement.kind !== 'resolved' && placement.kind !== 'block_only') {
    return notApplicable(rule);
  }
  if (!config.blockKinds.includes(placement.block.kind)) return notApplicable(rule);
  const { at } = context;
  let blocked = false;
  if (config.firstMinutes > 0) {
    const end = placement.beginsAt.add({ minutes: config.firstMinutes });
    if (inHalfOpenWindow(at, placement.beginsAt, end)) blocked = true;
  }
  if (!blocked && config.lastMinutes > 0) {
    const start = placement.endsAt.subtract({ minutes: config.lastMinutes });
    if (inHalfOpenWindow(at, start, placement.endsAt)) blocked = true;
  }
  if (!blocked) {
    return { ...base, outcome: 'pass', contribution: 'none', reasonCode: 'no_violation' };
  }
  if (isOverrideableMode(rule.overrideMode)) {
    const overridden = applyOverrideEvidence(rule, context, null);
    if (overridden !== null) return overridden;
  }
  return {
    ...base,
    outcome: 'fail',
    contribution: failContribution(rule.overrideMode),
    reasonCode: 'schedule_boundary_blackout',
  };
}

function approvedApprovalFor(
  approvals: readonly PolicyApprovalEvidence[],
  ruleId: string,
  ruleRevision: number,
  requiredSectionId: string,
): boolean {
  return approvals.some(
    (entry) =>
      entry.policyRuleId === ruleId &&
      entry.policyRuleRevision === ruleRevision &&
      entry.requiredSectionId === requiredSectionId &&
      entry.decision === 'approved',
  );
}

function deniedApprovalFor(
  approvals: readonly PolicyApprovalEvidence[],
  ruleId: string,
  ruleRevision: number,
  requiredSectionId: string,
): boolean {
  return approvals.some(
    (entry) =>
      entry.policyRuleId === ruleId &&
      entry.policyRuleRevision === ruleRevision &&
      entry.requiredSectionId === requiredSectionId &&
      entry.decision === 'denied',
  );
}

function evaluateApprovalRequirement(
  rule: PolicyRuleInput,
  context: PolicyEvaluationContext,
  config: { readonly requestSources: readonly string[] },
): PolicyRuleEvaluation {
  if (!config.requestSources.includes(context.pass.requestSource)) return notApplicable(rule);
  const placement = context.currentPlacement;
  if (placement.kind !== 'resolved') {
    const base = {
      ruleId: rule.id,
      ruleRevision: rule.revision,
      ruleType: rule.ruleType,
      overrideMode: rule.overrideMode,
      requiredSectionId: null,
    };
    if (isOverrideableMode(rule.overrideMode)) {
      const overridden = applyOverrideEvidence(rule, context, null);
      if (overridden !== null) return overridden;
    }
    return {
      ...base,
      outcome: 'fail',
      contribution: failContribution(rule.overrideMode),
      reasonCode: 'approval_context_unavailable',
    };
  }
  const requiredSectionId = placement.section.id;
  const base = {
    ruleId: rule.id,
    ruleRevision: rule.revision,
    ruleType: rule.ruleType,
    overrideMode: rule.overrideMode,
    requiredSectionId,
  };
  if (approvedApprovalFor(context.approvals, rule.id, rule.revision, requiredSectionId)) {
    return { ...base, outcome: 'pass', contribution: 'none', reasonCode: 'approval_satisfied' };
  }
  if (deniedApprovalFor(context.approvals, rule.id, rule.revision, requiredSectionId)) {
    return { ...base, outcome: 'fail', contribution: 'deny', reasonCode: 'approval_denied' };
  }
  if (isOverrideableMode(rule.overrideMode)) {
    const overridden = applyOverrideEvidence(rule, context, requiredSectionId);
    if (overridden !== null) return overridden;
  }
  return {
    ...base,
    outcome: 'fail',
    contribution: 'approval_required',
    reasonCode: 'current_section_teacher_approval_required',
  };
}

function evaluateRule(
  rule: PolicyRuleInput,
  context: PolicyEvaluationContext,
): PolicyRuleEvaluation {
  if (!rule.enabled || !temporallyActive(rule, context.at)) return notApplicable(rule);
  if (!isPolicyRuleType(rule.ruleType) || !isPolicyOverrideMode(rule.overrideMode)) {
    // Unknown vocabulary on an in-scope rule fails closed; out-of-scope
    // rules stay not applicable without trusting the row.
    if (!scopeMatches(rule, context)) return notApplicable(rule);
    return configurationError(rule);
  }
  if (!scopeMatches(rule, context)) return notApplicable(rule);
  const parsed = parsePolicyRuleConfiguration(rule.ruleType, rule.configuration);
  if (!parsed.valid) return configurationError(rule);
  if (parsed.configuration.type === 'schedule_boundary') {
    return evaluateScheduleBoundary(rule, context, parsed.configuration.config);
  }
  return evaluateApprovalRequirement(rule, context, parsed.configuration.config);
}

/**
 * Pure movement-policy evaluator. No SQL, no clock, no hidden state: identical
 * inputs always produce identical outputs. Rules are evaluated in input order
 * (the repository provides priority DESC, id ASC); priority never alters the
 * safety precedence applied by {@link combinePolicyDecision}.
 */
export function evaluatePolicy(context: PolicyEvaluationContext): PolicyEvaluationOutcome {
  const results = context.rules.map((rule) => evaluateRule(rule, context));
  const approvalRequirements: ApprovalRequirement[] = [];
  const overrideRequirements: OverrideRequirement[] = [];
  for (const result of results) {
    if (result.contribution === 'approval_required' && result.requiredSectionId !== null) {
      approvalRequirements.push({
        ruleId: result.ruleId,
        ruleRevision: result.ruleRevision,
        requiredSectionId: result.requiredSectionId,
      });
    } else if (
      result.contribution === 'override_required' &&
      isPolicyOverrideMode(result.overrideMode)
    ) {
      overrideRequirements.push({
        ruleId: result.ruleId,
        ruleRevision: result.ruleRevision,
        overrideMode: result.overrideMode,
        reasonCode: result.reasonCode,
      });
    }
  }
  return {
    decision: combinePolicyDecision(results),
    results,
    approvalRequirements,
    overrideRequirements,
  };
}
