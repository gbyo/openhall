import type { Pass } from '../../api/types.js';

export type StudentPassPresentation =
  | { kind: 'waiting-approval'; title: string; action: null }
  | { kind: 'staff-review-available'; title: string; action: 'request-review' }
  | { kind: 'staff-review-pending'; title: string; action: null }
  | { kind: 'queued'; title: string; action: null }
  | { kind: 'ready'; title: string; action: 'depart' }
  | { kind: 'outbound-lightweight'; title: string; action: 'complete' }
  | { kind: 'outbound-optional'; title: string; action: 'arrive' | 'complete' }
  | { kind: 'outbound-station-required'; title: string; action: null }
  | { kind: 'at-destination'; title: string; action: 'return' }
  | { kind: 'returning'; title: string; action: 'complete' }
  | { kind: 'terminal'; title: string; action: null };

/** Presentation only: wall-clock time never advances the lifecycle. */
export function presentStudentPass(pass: Pass): StudentPassPresentation {
  if (pass.lifecycleState === 'requested') {
    if (pass.policy?.approvalPending)
      return { kind: 'waiting-approval', title: 'Waiting for approval', action: null };
    if (pass.policy?.overridePending)
      return { kind: 'staff-review-pending', title: 'Waiting for staff review', action: null };
    if (pass.policy?.overrideAvailable)
      return {
        kind: 'staff-review-available',
        title: 'This pass needs staff review.',
        action: 'request-review',
      };
    return { kind: 'waiting-approval', title: 'Request received', action: null };
  }
  if (pass.lifecycleState === 'queued')
    return { kind: 'queued', title: "You're in line.", action: null };
  if (pass.lifecycleState === 'ready')
    return { kind: 'ready', title: "You're ready.", action: 'depart' };
  if (pass.lifecycleState === 'outbound') {
    if (pass.movement.effectiveCheckInMode === 'required')
      return {
        kind: 'outbound-station-required',
        title: `On the way to ${pass.destination.name}`,
        action: null,
      };
    if (pass.movement.effectiveCheckInMode === 'optional')
      return { kind: 'outbound-optional', title: 'Pass active', action: 'arrive' };
    return { kind: 'outbound-lightweight', title: 'Pass active', action: 'complete' };
  }
  if (pass.lifecycleState === 'at_destination')
    return {
      kind: 'at-destination',
      title: `At ${pass.destination.name}`,
      action: 'return',
    };
  if (pass.lifecycleState === 'returning')
    return {
      kind: 'returning',
      title: `Returning${pass.origin.room ? ` to ${pass.origin.room.name}` : ''}`,
      action: 'complete',
    };
  return {
    kind: 'terminal',
    title: pass.lifecycleState === 'completed' ? 'Welcome back.' : 'This pass is finished.',
    action: null,
  };
}
