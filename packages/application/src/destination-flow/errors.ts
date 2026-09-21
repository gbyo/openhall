/**
 * Closed Phase 7 operational vocabularies. Reservation and queue release
 * reasons are persisted verbatim behind database CHECK constraints; reason
 * codes travel in pass-event metadata and the movement projection. No
 * arbitrary text is ever stored in these columns.
 */

export const RESERVATION_RELEASE_REASONS = [
  'ready_claim_expired',
  'cancelled',
  'return_started',
  'completed',
  'destination_unavailable',
  'pass_terminal',
] as const;

export type ReservationReleaseReason = (typeof RESERVATION_RELEASE_REASONS)[number];

export const QUEUE_RELEASE_REASONS = [
  'promoted',
  'cancelled',
  'expired',
  'policy_changed',
  'destination_unavailable',
  'pass_terminal',
  'ready_requeue_replaced',
] as const;

export type QueueReleaseReason = (typeof QUEUE_RELEASE_REASONS)[number];

/** Stable machine reason codes surfaced to clients for flow outcomes. */
export const OPERATIONAL_REASON_CODES = [
  'destination_capacity_full',
  'destination_unavailable',
  'queue_timeout',
  'ready_claim_expired',
  'policy_clearance_lost',
  'check_in_not_supported',
  'station_check_in_required',
] as const;

export type OperationalReasonCode = (typeof OPERATIONAL_REASON_CODES)[number];
