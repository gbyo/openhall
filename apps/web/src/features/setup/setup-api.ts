import { api, confirmed } from '../../api/client';
import { toProblem } from '../../api/problems';
import { getCsrfToken } from '../../api/session';

export interface InitializeBody {
  tenantName: string;
  tenantSlug?: string | undefined;
  schoolName: string;
  schoolSlug?: string | undefined;
  schoolTimeZone: string;
  adminGivenName: string;
  adminFamilyName: string;
  adminDisplayName?: string | undefined;
}

export interface PrepareSignInBody {
  providerPreset: 'google' | 'generic';
  clientId: string;
  clientSecret: string;
  providerName?: string | undefined;
  issuerUrl?: string | undefined;
  providerKey?: string | undefined;
  authMethod?: 'client_secret_post' | 'client_secret_basic' | undefined;
  scopes?: string[] | undefined;
}

async function bootstrapFetch(
  path: '/api/v1/bootstrap/validate' | '/api/v1/bootstrap/initialize',
  operatorToken: string,
  body: unknown,
): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bootstrap ${operatorToken}`,
    },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  return { status: response.status, payload };
}

function throwProblem(status: number, payload: unknown): never {
  throw toProblem(status, payload);
}

/** Verifies the setup code without consuming it. Throws on failure. */
export async function validateSetupCode(operatorToken: string): Promise<void> {
  const { status, payload } = await bootstrapFetch('/api/v1/bootstrap/validate', operatorToken, {});
  if (status !== 200) throwProblem(status, payload);
}

/** Creates the installation; resolves with the setup-session deadline. */
export async function initializeInstallation(
  operatorToken: string,
  body: InitializeBody,
): Promise<{ absoluteExpiresAt: string }> {
  const { status, payload } = await bootstrapFetch(
    '/api/v1/bootstrap/initialize',
    operatorToken,
    body,
  );
  if (status !== 200) throwProblem(status, payload);
  return payload as { absoluteExpiresAt: string };
}

/** Starts the first-provider OIDC ceremony; resolves with the redirect. */
export async function prepareSchoolSignIn(body: PrepareSignInBody): Promise<string> {
  const prepared = await confirmed(
    api.POST('/api/v1/setup/identity-provider/prepare', {
      headers: { 'X-CSRF-Token': getCsrfToken() },
      body: {
        providerPreset: body.providerPreset,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        ...(body.providerName ? { providerName: body.providerName } : {}),
        ...(body.issuerUrl ? { issuerUrl: body.issuerUrl } : {}),
        ...(body.providerKey ? { providerKey: body.providerKey } : {}),
        ...(body.authMethod ? { authMethod: body.authMethod } : {}),
        ...(body.scopes ? { scopes: body.scopes } : {}),
      },
    }),
  );
  return prepared.authorizationUrl;
}

/** Consumes a recovery code; the server sets the recovery session cookie. */
export async function consumeRecoveryCode(recoveryCode: string): Promise<void> {
  const response = await fetch('/api/v1/auth/recovery', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Recovery ${recoveryCode}`,
    },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throwProblem(response.status, payload);
  }
}
