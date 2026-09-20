export const PASS_LIFECYCLE_STATES = [
  'requested',
  'queued',
  'ready',
  'outbound',
  'at_destination',
  'returning',
  'completed',
  'denied',
  'cancelled',
  'expired',
] as const;

export type PassLifecycleState = (typeof PASS_LIFECYCLE_STATES)[number];

export const ACTIVE_PASS_STATES = [
  'requested',
  'queued',
  'ready',
  'outbound',
  'at_destination',
  'returning',
] as const satisfies readonly PassLifecycleState[];
