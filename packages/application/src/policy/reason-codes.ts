/**
 * Closed machine-stable policy reason vocabulary. Reason codes are safe to
 * persist and project to clients; they never carry human prose, student or
 * teacher names, or configuration detail.
 */
export const POLICY_REASON_CODES = [
  'no_violation',
  'schedule_boundary_blackout',
  'current_section_teacher_approval_required',
  'approval_context_unavailable',
  'approval_satisfied',
  'approval_denied',
  'override_denied',
  'rule_overridden',
  'policy_configuration_error',
] as const;

export type PolicyReasonCode = (typeof POLICY_REASON_CODES)[number];

const REASON_SET = new Set<string>(POLICY_REASON_CODES);

export function isPolicyReasonCode(value: string): value is PolicyReasonCode {
  return REASON_SET.has(value);
}
