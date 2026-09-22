export type ControlPlaneErrorCode =
  | 'room_not_found'
  | 'room_in_use'
  | 'room_already_open'
  | 'room_already_closed'
  | 'invalid_room_state'
  | 'room_category_not_found'
  | 'room_category_in_use'
  | 'room_category_exists'
  | 'schedule_block_not_found'
  | 'schedule_block_in_use'
  | 'schedule_block_exists'
  | 'schedule_template_not_found'
  | 'schedule_template_in_use'
  | 'schedule_slots_overlap'
  | 'schedule_day_not_found'
  | 'schedule_not_found'
  | 'invalid_schedule_state'
  | 'policy_rule_not_found'
  | 'policy_rule_archived'
  | 'policy_rule_invalid'
  | 'authorization_grant_not_found'
  | 'authorization_grant_exists'
  | 'invalid_authorization_grant_state'
  | 'target_not_active_staff'
  | 'identity_enrollment_not_found'
  | 'identity_already_enrolled'
  | 'identity_enrollment_invalid'
  | 'identity_enrollment_expired'
  | 'identity_link_conflict'
  | 'scheduled_authorization_not_found'
  | 'scheduled_authorization_not_yet_valid'
  | 'scheduled_authorization_expired'
  | 'invalid_scheduled_authorization_state'
  | 'person_not_found'
  | 'section_not_found'
  | 'invalid_search_cursor'
  | 'forbidden'
  | 'recovery_session_restricted'
  | 'idempotency_key_required'
  | 'invalid_idempotency_key'
  | 'idempotency_key_reused'
  | 'precondition_required'
  | 'invalid_precondition'
  | 'stale_resource_revision';

export class ControlPlaneError extends Error {
  constructor(
    readonly code: ControlPlaneErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export function controlPlaneHttpStatus(code: ControlPlaneErrorCode): number {
  switch (code) {
    case 'room_not_found':
    case 'room_category_not_found':
    case 'schedule_block_not_found':
    case 'schedule_template_not_found':
    case 'schedule_day_not_found':
    case 'schedule_not_found':
    case 'policy_rule_not_found':
    case 'authorization_grant_not_found':
    case 'identity_enrollment_not_found':
    case 'scheduled_authorization_not_found':
    case 'person_not_found':
    case 'section_not_found':
      return 404;
    case 'forbidden':
    case 'recovery_session_restricted':
      return 403;
    case 'room_in_use':
    case 'room_already_open':
    case 'room_already_closed':
    case 'invalid_room_state':
    case 'room_category_in_use':
    case 'room_category_exists':
    case 'schedule_block_in_use':
    case 'schedule_block_exists':
    case 'schedule_template_in_use':
    case 'schedule_slots_overlap':
    case 'invalid_schedule_state':
    case 'policy_rule_archived':
    case 'policy_rule_invalid':
    case 'authorization_grant_exists':
    case 'invalid_authorization_grant_state':
    case 'target_not_active_staff':
    case 'identity_already_enrolled':
    case 'identity_enrollment_invalid':
    case 'identity_enrollment_expired':
    case 'identity_link_conflict':
    case 'scheduled_authorization_not_yet_valid':
    case 'scheduled_authorization_expired':
    case 'invalid_scheduled_authorization_state':
    case 'idempotency_key_reused':
      return 409;
    case 'stale_resource_revision':
      return 412;
    case 'precondition_required':
      return 428;
    default:
      return 400;
  }
}
