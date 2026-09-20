import type { AuthErrorCode, AuthenticationError } from '@openhall/application';
import type { FastifyRequest } from 'fastify';
import { safeRequestPath } from '../http-privacy.js';

const STATUS_BY_CODE: Record<AuthErrorCode, number> = {
  unauthenticated: 401,
  invalid_csrf_token: 403,
  invalid_request_origin: 403,
  auth_provider_unavailable: 502,
  auth_transaction_invalid: 400,
  auth_transaction_expired: 400,
  identity_not_linked: 403,
  bootstrap_unavailable: 409,
  bootstrap_token_invalid: 401,
  invalid_bootstrap_draft: 400,
  recovery_token_invalid: 401,
  provider_configuration_unsupported: 400,
};

const TITLE_BY_CODE: Record<AuthErrorCode, string> = {
  unauthenticated: 'Unauthenticated',
  invalid_csrf_token: 'Invalid CSRF token',
  invalid_request_origin: 'Invalid request origin',
  auth_provider_unavailable: 'Identity provider unavailable',
  auth_transaction_invalid: 'Invalid login transaction',
  auth_transaction_expired: 'Expired login transaction',
  identity_not_linked: 'Account not linked',
  bootstrap_unavailable: 'Bootstrap unavailable',
  bootstrap_token_invalid: 'Invalid bootstrap token',
  invalid_bootstrap_draft: 'Invalid setup details',
  recovery_token_invalid: 'Invalid recovery token',
  provider_configuration_unsupported: 'Unsupported provider configuration',
};

export function statusFor(code: AuthErrorCode): number {
  return STATUS_BY_CODE[code];
}

export function problemFor(error: AuthenticationError, request: FastifyRequest): {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance: string;
  readonly code: AuthErrorCode;
  readonly requestId: string;
} {
  const status = STATUS_BY_CODE[error.code];
  return {
    type: `https://openhall.dev/problems/${error.code}`,
    title: TITLE_BY_CODE[error.code],
    status,
    ...(error.code === 'identity_not_linked'
      ? {
          detail:
            'Your account is not linked to this OpenHall installation. Contact your school administrator.',
        }
      : {}),
    instance: safeRequestPath(request.url),
    code: error.code,
    requestId: request.id,
  };
}
