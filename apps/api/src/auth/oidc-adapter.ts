import {
  AuthenticationError,
  type OidcProtocolAdapter,
  type OidcProviderConfiguration,
} from '@openhall/application';
import * as client from 'openid-client';

/**
 * Finite timeout (seconds) for provider discovery and token calls. A broken
 * provider must never hang an OpenHall request indefinitely.
 */
const PROVIDER_TIMEOUT_SECONDS = 10;

function clientAuth(configuration: OidcProviderConfiguration): client.ClientAuth {
  if (configuration.tokenEndpointAuthMethod === 'client_secret_basic') {
    return client.ClientSecretBasic(configuration.clientSecret);
  }
  return client.ClientSecretPost(configuration.clientSecret);
}

async function discover(
  configuration: OidcProviderConfiguration,
): Promise<client.Configuration> {
  let issuer: URL;
  try {
    issuer = new URL(configuration.issuer);
  } catch {
    throw new AuthenticationError('provider_configuration_unsupported');
  }
  if (issuer.protocol === 'http:' && configuration.allowInsecureHttp !== true) {
    throw new AuthenticationError('provider_configuration_unsupported');
  }
  try {
    const discovered = await client.discovery(
      issuer,
      configuration.clientId,
      configuration.clientSecret,
      clientAuth(configuration),
      { timeout: PROVIDER_TIMEOUT_SECONDS },
    );
    if (issuer.protocol === 'http:') {
      client.allowInsecureRequests(discovered);
    }
    return discovered;
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw error;
    }
    throw new AuthenticationError('auth_provider_unavailable');
  }
}

/**
 * Enforces the OpenHall OIDC security baseline against discovered metadata:
 * authorization + token endpoints, S256 PKCE support, and the configured
 * client authentication method. Never silently downgrades.
 */
function enforceBaseline(
  metadata: ReturnType<client.Configuration['serverMetadata']>,
  configuration: OidcProviderConfiguration,
): void {
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new AuthenticationError(
      'provider_configuration_unsupported',
      'Provider lacks required endpoints',
    );
  }
  const methods = metadata.code_challenge_methods_supported;
  if (methods !== undefined && !methods.includes('S256')) {
    throw new AuthenticationError(
      'provider_configuration_unsupported',
      'Provider does not support PKCE S256',
    );
  }
  const authMethods = metadata.token_endpoint_auth_methods_supported;
  if (authMethods !== undefined && !authMethods.includes(configuration.tokenEndpointAuthMethod)) {
    throw new AuthenticationError(
      'provider_configuration_unsupported',
      'Provider does not support the configured client authentication method',
    );
  }
}

/**
 * Generic OIDC adapter built on openid-client. No OAuth cryptography is
 * implemented here: discovery, authorization URL creation, code exchange,
 * PKCE, nonce, issuer, and ID Token validation all run through the library.
 * Each call performs its own short-lived discovery so metadata is never
 * stale; nothing provider-specific (Google, Microsoft, ...) lives here.
 */
export class OpenIdClientAdapter implements OidcProtocolAdapter {
  async validateProviderConfiguration(
    configuration: OidcProviderConfiguration,
  ): Promise<void> {
    const discovered = await discover(configuration);
    enforceBaseline(discovered.serverMetadata(), configuration);
  }

  async buildAuthorizationUrl(input: {
    readonly configuration: OidcProviderConfiguration;
    readonly redirectUri: string;
    readonly state: string;
    readonly nonce: string;
    readonly codeChallenge: string;
    readonly maxAge?: number;
  }): Promise<string> {
    const discovered = await discover(input.configuration);
    enforceBaseline(discovered.serverMetadata(), input.configuration);
    const parameters: Record<string, string> = {
      response_type: 'code',
      redirect_uri: input.redirectUri,
      scope: input.configuration.scopes.join(' '),
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    };
    if (input.maxAge !== undefined) {
      parameters.maxAge = String(input.maxAge);
    }
    return client.buildAuthorizationUrl(discovered, parameters).toString();
  }

  async exchangeCode(input: {
    readonly configuration: OidcProviderConfiguration;
    readonly redirectUri: string;
    readonly callbackUrl: string;
    readonly codeVerifier: string;
    readonly expectedState: string;
    readonly expectedNonce: string;
  }): Promise<{ readonly issuer: string; readonly subject: string; readonly email?: string }> {
    let callback: URL;
    try {
      callback = new URL(input.callbackUrl);
    } catch {
      throw new AuthenticationError('auth_transaction_invalid');
    }
    const discovered = await discover(input.configuration);
    enforceBaseline(discovered.serverMetadata(), input.configuration);
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(discovered, callback, {
        pkceCodeVerifier: input.codeVerifier,
        expectedState: input.expectedState,
        expectedNonce: input.expectedNonce,
        idTokenExpected: true,
      });
    } catch {
      // Never propagate raw provider/OAuth errors: normalize to a safe code.
      throw new AuthenticationError('auth_provider_unavailable');
    }
    const claims = tokens.claims();
    if (claims === undefined || typeof claims.sub !== 'string' || claims.sub.length === 0) {
      throw new AuthenticationError('auth_provider_unavailable');
    }
    const email = typeof claims.email === 'string' ? claims.email : undefined;
    return { issuer: claims.iss, subject: claims.sub, email };
  }
}
