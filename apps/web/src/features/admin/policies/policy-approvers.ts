/**
 * Approval-rule approver vocabulary, mirroring the server's policy
 * configuration parser. Scope answers *where* a rule applies; the approver
 * answers *who* must approve, and the two stay independent.
 */
export const POLICY_APPROVERS = ['current_section_teacher', 'room_responsible_staff'] as const;

export type PolicyApprover = (typeof POLICY_APPROVERS)[number];

/**
 * Rules written before the room vocabulary existed carry
 * `current_section_teacher`; anything unreadable falls back to it so an
 * edit never silently reassigns who approves.
 */
export function readPolicyApprover(configuration: unknown): PolicyApprover {
  const value = (configuration as { approver?: unknown } | null | undefined)?.approver;
  return value === 'room_responsible_staff' ? 'room_responsible_staff' : 'current_section_teacher';
}

export function policyApproverLabel(approver: PolicyApprover): string {
  return approver === 'room_responsible_staff'
    ? 'Staff responsible for the destination room'
    : "The student's current class teacher";
}
