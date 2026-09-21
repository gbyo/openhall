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

export type ActivePassState = (typeof ACTIVE_PASS_STATES)[number];

/** Terminal states: no ordinary command may transition out of these. */
export const TERMINAL_PASS_STATES = [
  'completed',
  'denied',
  'cancelled',
  'expired',
] as const satisfies readonly PassLifecycleState[];

export type TerminalPassState = (typeof TERMINAL_PASS_STATES)[number];

/**
 * Self-cancellable pre-departure states. Phase 5 normally only produces
 * `requested`, but the wider definition keeps Phase 6/7 from breaking
 * self-cancellation semantics later.
 */
export const CANCELLABLE_PASS_STATES = [
  'requested',
  'queued',
  'ready',
] as const satisfies readonly PassLifecycleState[];

/**
 * Central normal lifecycle matrix. Future policy phases may extend
 * deliberately; application code must never scatter ad-hoc state checks.
 */
const NORMAL_TRANSITIONS: Record<PassLifecycleState, readonly PassLifecycleState[]> = {
  requested: ['queued', 'ready', 'denied', 'cancelled', 'expired'],
  queued: ['ready', 'denied', 'cancelled', 'expired'],
  ready: ['outbound', 'cancelled', 'expired'],
  outbound: ['at_destination'],
  at_destination: ['returning', 'completed'],
  returning: ['completed'],
  completed: [],
  denied: [],
  cancelled: [],
  expired: [],
};

export function allowedTransitions(from: PassLifecycleState): readonly PassLifecycleState[] {
  return NORMAL_TRANSITIONS[from];
}

export function canTransition(from: PassLifecycleState, to: PassLifecycleState): boolean {
  return NORMAL_TRANSITIONS[from].includes(to);
}

export function isTerminalState(state: PassLifecycleState): boolean {
  return (TERMINAL_PASS_STATES as readonly string[]).includes(state);
}

export function isCancellableState(state: PassLifecycleState): boolean {
  return (CANCELLABLE_PASS_STATES as readonly string[]).includes(state);
}

export function isActiveState(state: PassLifecycleState): boolean {
  return (ACTIVE_PASS_STATES as readonly string[]).includes(state);
}
