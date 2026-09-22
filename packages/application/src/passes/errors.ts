export type PassErrorCode =
  | 'room_not_found'
  | 'room_unavailable'
  | 'room_capacity_full'
  | 'student_not_found'
  | 'active_pass_exists'
  | 'pass_not_found'
  | 'invalid_pass_transition'
  | 'idempotency_key_required'
  | 'invalid_idempotency_key'
  | 'idempotency_key_reused'
  | 'precondition_required'
  | 'invalid_precondition'
  | 'stale_pass_revision'
  | 'forbidden'
  | 'recovery_session_restricted'
  | 'approval_not_found'
  | 'invalid_approval_state'
  | 'override_not_found'
  | 'override_not_available'
  | 'invalid_override_state'
  | 'override_requires_independent_approver'
  | 'policy_configuration_error'
  | 'queue_status_unavailable'
  | 'ready_offer_expired'
  | 'check_in_not_supported'
  | 'station_check_in_required';

export class PassApplicationError extends Error {
  constructor(
    readonly code: PassErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PassApplicationError';
  }
}

export function passHttpStatus(code: PassErrorCode): number {
  switch (code) {
    case 'room_not_found':
    case 'student_not_found':
    case 'pass_not_found':
    case 'approval_not_found':
    case 'override_not_found':
      return 404;
    case 'forbidden':
    case 'recovery_session_restricted':
      return 403;
    case 'active_pass_exists':
    case 'idempotency_key_reused':
    case 'invalid_pass_transition':
    case 'room_unavailable':
    case 'room_capacity_full':
    case 'invalid_approval_state':
    case 'override_not_available':
    case 'invalid_override_state':
    case 'override_requires_independent_approver':
    case 'queue_status_unavailable':
    case 'ready_offer_expired':
    case 'check_in_not_supported':
    case 'station_check_in_required':
      return 409;
    case 'stale_pass_revision':
      return 412;
    case 'precondition_required':
      return 428;
    default:
      return 400;
  }
}
