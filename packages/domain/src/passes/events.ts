import type { PassLifecycleState } from './lifecycle.js';

export const PASS_DOMAIN_EVENTS = [
  'pass.requested',
  'pass.queued',
  'pass.ready',
  'pass.denied',
  'pass.cancelled',
  'pass.expired',
  'pass.departed',
  'pass.arrived',
  'pass.return_started',
  'pass.completed',
] as const;

export type PassDomainEvent = (typeof PASS_DOMAIN_EVENTS)[number];

/** Lifecycle state reached by each semantic domain event. */
export const EVENT_STATE: Record<PassDomainEvent, PassLifecycleState> = {
  'pass.requested': 'requested',
  'pass.queued': 'queued',
  'pass.ready': 'ready',
  'pass.denied': 'denied',
  'pass.cancelled': 'cancelled',
  'pass.expired': 'expired',
  'pass.departed': 'outbound',
  'pass.arrived': 'at_destination',
  'pass.return_started': 'returning',
  'pass.completed': 'completed',
};

/** Semantic event emitted when entering a lifecycle state. */
export const STATE_EVENT: Record<PassLifecycleState, PassDomainEvent> = {
  requested: 'pass.requested',
  queued: 'pass.queued',
  ready: 'pass.ready',
  outbound: 'pass.departed',
  at_destination: 'pass.arrived',
  returning: 'pass.return_started',
  completed: 'pass.completed',
  denied: 'pass.denied',
  cancelled: 'pass.cancelled',
  expired: 'pass.expired',
};

export type RequestedOriginKind =
  | 'resolved'
  | 'block_only'
  | 'outside_schedule'
  | 'non_instructional_day'
  | 'calendar_not_configured'
  | 'not_member'
  | 'ambiguous'
  | 'configuration_error';

/**
 * Minimized versioned origin snapshot carried by the immutable initial
 * pass.requested event. Never carries teacher names, grant rows, student
 * display names, OIDC identity, email, tokens, or the full placement object.
 */
export interface RequestedEventOrigin {
  readonly kind: RequestedOriginKind;
  readonly blockId?: string;
  readonly sectionId?: string;
  readonly locationId?: string;
  readonly slotBeginsAt?: string;
  readonly slotEndsAt?: string;
  /** Ambiguous placement reason; candidate IDs are never included. */
  readonly reason?: string;
  /** Configuration error code; internal messages are never included. */
  readonly code?: string;
}

export interface RequestedEventMetadata {
  readonly schemaVersion: 1;
  readonly state: 'requested';
  readonly revision: string;
  readonly origin: RequestedEventOrigin;
  readonly destinationId: string;
}
