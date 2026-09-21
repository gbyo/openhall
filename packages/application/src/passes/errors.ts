export type PassErrorCode =
  | 'destination_not_found'
  | 'destination_unavailable'
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
  | 'recovery_session_restricted';

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
    case 'destination_not_found':
    case 'student_not_found':
    case 'pass_not_found':
      return 404;
    case 'forbidden':
    case 'recovery_session_restricted':
      return 403;
    case 'active_pass_exists':
    case 'idempotency_key_reused':
    case 'invalid_pass_transition':
    case 'destination_unavailable':
      return 409;
    case 'stale_pass_revision':
      return 412;
    case 'precondition_required':
      return 428;
    default:
      return 400;
  }
}
