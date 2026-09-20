export type UserContextErrorCode = 'recovery_session_restricted' | 'organization_not_found';

export class UserContextError extends Error {
  readonly code: UserContextErrorCode;

  constructor(code: UserContextErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'UserContextError';
    this.code = code;
  }
}
