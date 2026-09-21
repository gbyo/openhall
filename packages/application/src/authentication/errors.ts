/**
 * Stable machine-readable authentication error codes. Raw provider/OAuth
 * errors are never returned to the browser; they are normalized to one of
 * these codes before logging or responding, and must not reveal whether an
 * account, person, or email exists.
 */
export type AuthErrorCode =
  | 'unauthenticated'
  | 'invalid_csrf_token'
  | 'invalid_request_origin'
  | 'auth_provider_unavailable'
  | 'auth_transaction_invalid'
  | 'auth_transaction_expired'
  | 'identity_not_linked'
  | 'identity_link_conflict'
  | 'bootstrap_unavailable'
  | 'bootstrap_token_invalid'
  | 'invalid_bootstrap_draft'
  | 'recovery_token_invalid'
  | 'provider_configuration_unsupported'
  | 'provider_setup_conflict';

export class AuthenticationError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AuthenticationError';
    this.code = code;
  }
}
