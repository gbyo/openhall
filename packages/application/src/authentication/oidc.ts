import type { Clock } from '@openhall/domain';
import type {
  TenantTransactionContext,
  TenantTransactionRunner,
} from '../persistence.js';
import { AuthenticationError } from './errors.js';
import type {
  AuditWriter,
  CredentialDigester,
  IdentityDirectory,
  OidcProtocolAdapter,
  OidcTransactionStore,
  SecretProtector,
  SecureRandomSource,
  SessionRecord,
  SessionRepository,
  Sha256Hasher,
  TenantDirectory,
} from './ports.js';
import {
  assertIssuerShape,
  assertOidcScopes,
  fromBase64Url,
  normalizeReturnPath,
  toBase64Url,
} from './validation.js';

/** Login transactions expire after ten minutes. */
export const OIDC_TRANSACTION_TTL_SECONDS = 10 * 60;

export interface BeginLoginInput {
  readonly tenantSlug: string;
  readonly providerKey: string;
  readonly returnPath: unknown;
  /** Raw browser-binding value from the (HttpOnly) binding cookie. */
  readonly browserBinding: string;
}

export interface BegunLogin {
  readonly authorizationUrl: string;
  /** Raw state for the provider round trip; only its digest is stored. */
  readonly state: string;
}

export interface OidcUseCaseDependencies {
  readonly tenants: TenantDirectory;
  readonly directory: IdentityDirectory;
  readonly transactions: OidcTransactionStore;
  readonly sessions: SessionRepository;
  readonly audit: AuditWriter;
  readonly adapter: OidcProtocolAdapter;
  readonly random: SecureRandomSource;
  readonly digester: CredentialDigester;
  readonly hasher: Sha256Hasher;
  readonly protector: SecretProtector;
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly redirectUri: string;
  readonly allowInsecureHttp: boolean;
}

/** PKCE S256 code challenge for a verifier. */
export function pkceChallenge(verifier: string, hasher: Sha256Hasher): string {
  return toBase64Url(hasher.hash(new TextEncoder().encode(verifier)));
}

function transactionSecretContext(tenantId: string, providerId: string): string {
  return `oidc-tx:v1:${tenantId}:${providerId}`;
}

function providerSecretContext(tenantId: string, providerId: string): string {
  return `provider-secret:v1:${tenantId}:${providerId}`;
}

/**
 * Starts a normal OIDC login: validates tenant/provider, persists a durable
 * login transaction holding only digests plus an encrypted PKCE
 * verifier/nonce bundle, and returns the provider authorization URL.
 */
export async function beginOidcLogin(
  input: BeginLoginInput,
  dependencies: OidcUseCaseDependencies,
): Promise<BegunLogin> {
  const tenant = await dependencies.tenants.findBySlug(input.tenantSlug.trim().toLowerCase());
  if (tenant === undefined || tenant.status !== 'active') {
    throw new AuthenticationError('auth_provider_unavailable');
  }
  return dependencies.runner.run(tenant.id, async (context) => {
    const provider = await dependencies.directory.findProviderByKey(
      context,
      input.providerKey.trim().toLowerCase(),
    );
    if (provider === undefined || provider.status !== 'active') {
      throw new AuthenticationError('auth_provider_unavailable');
    }
    const issuer = assertIssuerShape(provider.issuer, {
      allowInsecureHttp: dependencies.allowInsecureHttp,
    });
    const scopes = assertOidcScopes(provider.scopes);
    const now = dependencies.clock.now();
    const state = toBase64Url(dependencies.random.randomBytes(32));
    const nonce = toBase64Url(dependencies.random.randomBytes(32));
    const verifier = toBase64Url(dependencies.random.randomBytes(32));
    const binding = decodeBinding(input.browserBinding);
    const transactionSecret = dependencies.protector.protect(
      JSON.stringify({ verifier, nonce }),
      transactionSecretContext(tenant.id, provider.id),
    );
    await dependencies.transactions.create(context, {
      tenantId: tenant.id,
      identityProviderId: provider.id,
      bootstrapSetupId: null,
      purpose: 'login',
      providerRevision: provider.revision,
      stateDigest: dependencies.digester.digest(new TextEncoder().encode(state)),
      browserBindingDigest: dependencies.digester.digest(binding),
      transactionSecret,
      returnPath: normalizeReturnPath(input.returnPath),
      expiresAt: now.add({ seconds: OIDC_TRANSACTION_TTL_SECONDS }),
    });
    const clientSecret = dependencies.protector.reveal(
      provider.clientSecret,
      providerSecretContext(tenant.id, provider.id),
    );
    const authorizationUrl = await dependencies.adapter.buildAuthorizationUrl({
      configuration: {
        issuer: issuer.issuer,
        clientId: provider.clientId,
        clientSecret,
        tokenEndpointAuthMethod: provider.tokenEndpointAuthMethod,
        scopes: [...scopes],
        allowInsecureHttp: issuer.insecureHttp,
      },
      redirectUri: dependencies.redirectUri,
      state,
      nonce,
      codeChallenge: pkceChallenge(verifier, dependencies.hasher),
    });
    return { authorizationUrl, state };
  });
}

function decodeBinding(raw: string): Uint8Array {
  if (raw.length === 0) {
    throw new AuthenticationError('auth_transaction_invalid');
  }
  return fromBase64Url(raw);
}

export interface CompleteLoginInput {
  /** Raw state returned by the provider. */
  readonly state: string;
  /** Raw browser-binding value from the binding cookie. */
  readonly browserBinding: string;
  /** Full callback URL as received (query included for code extraction). */
  readonly callbackUrl: string;
  readonly requestId: string;
  /** Previously valid session presenting this browser, if any. */
  readonly supersededSession?: SessionRecord;
}

export interface CompletedLogin {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly returnPath: string;
  readonly session: SessionRecord;
}

/**
 * Completes a normal OIDC login. Claims the transaction atomically before
 * any network call; the database transaction is never held open across the
 * provider exchange. Mix-up protection comes from binding the transaction to
 * its exact provider and validating against that provider's configuration.
 */
export async function completeOidcLogin(
  input: CompleteLoginInput,
  dependencies: OidcUseCaseDependencies,
): Promise<CompletedLogin> {
  const now = dependencies.clock.now();
  const stateDigest = dependencies.digester.digest(new TextEncoder().encode(input.state));
  const transaction = await dependencies.transactions.claimByStateDigest(stateDigest, now);
  if (transaction === undefined || transaction.purpose !== 'login' || transaction.tenantId === null) {
    throw new AuthenticationError('auth_transaction_invalid');
  }
  const tenantId = transaction.tenantId;
  const providerId = transaction.identityProviderId;
  return dependencies.runner.run(tenantId, async (context) => {
    const markFailed = async (): Promise<void> => {
      await dependencies.transactions.markFailed(transaction.id, dependencies.clock.now());
    };
    if (transaction.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
      await markFailed();
      throw new AuthenticationError('auth_transaction_expired');
    }
    let bindingValid = false;
    try {
      bindingValid = dependencies.digester.matches(
        decodeBinding(input.browserBinding),
        transaction.browserBindingDigest,
      );
    } catch {
      bindingValid = false;
    }
    if (!bindingValid || providerId === null) {
      await markFailed();
      throw new AuthenticationError('auth_transaction_invalid');
    }
    const provider = await dependencies.directory.findProvider(context, providerId);
    if (
      provider === undefined ||
      provider.status !== 'active' ||
      provider.revision !== transaction.providerRevision
    ) {
      await markFailed();
      throw new AuthenticationError('auth_provider_unavailable');
    }
    const issuer = assertIssuerShape(provider.issuer, {
      allowInsecureHttp: dependencies.allowInsecureHttp,
    });
    let secret: { readonly verifier: string; readonly nonce: string } | undefined;
    try {
      const revealed = JSON.parse(
        dependencies.protector.reveal(
          transaction.transactionSecret,
          transactionSecretContext(tenantId, provider.id),
        ),
      ) as { readonly verifier: string; readonly nonce: string };
      if (typeof revealed.verifier === 'string' && typeof revealed.nonce === 'string') {
        secret = revealed;
      }
    } catch {
      secret = undefined;
    }
    if (secret === undefined) {
      await markFailed();
      throw new AuthenticationError('auth_transaction_invalid');
    }
    const clientSecret = dependencies.protector.reveal(
      provider.clientSecret,
      providerSecretContext(tenantId, provider.id),
    );
    const configuration = {
      issuer: issuer.issuer,
      clientId: provider.clientId,
      clientSecret,
      tokenEndpointAuthMethod: provider.tokenEndpointAuthMethod,
      scopes: [...assertOidcScopes(provider.scopes)],
      allowInsecureHttp: issuer.insecureHttp,
    };
    let identity: { readonly issuer: string; readonly subject: string; readonly email?: string };
    try {
      identity = await dependencies.adapter.exchangeCode({
        configuration,
        redirectUri: dependencies.redirectUri,
        callbackUrl: input.callbackUrl,
        codeVerifier: secret.verifier,
        expectedState: input.state,
        expectedNonce: secret.nonce,
      });
    } catch (error) {
      await denyAndThrow(context, dependencies, transaction.id, input.requestId, error);
      throw new AuthenticationError('auth_provider_unavailable');
    }
    // Explicit mix-up check: the verified issuer must be the transaction's provider.
    if (identity.issuer !== provider.issuer && identity.issuer !== issuer.issuer) {
      await denyAndThrow(
        context,
        dependencies,
        transaction.id,
        input.requestId,
        new AuthenticationError('auth_transaction_invalid', 'Issuer mismatch'),
      );
    }
    return finalizeLogin(context, dependencies, {
      transactionId: transaction.id,
      tenantId,
      providerId: provider.id,
      issuer: provider.issuer,
      subject: identity.subject,
      email: identity.email ?? null,
      returnPath: transaction.returnPath,
      requestId: input.requestId,
      supersededSession: input.supersededSession,
    });
  });
}

async function denyAndThrow(
  context: TenantTransactionContext,
  dependencies: OidcUseCaseDependencies,
  transactionId: string,
  requestId: string,
  error: unknown,
): Promise<never> {
  await dependencies.transactions.markFailed(transactionId, dependencies.clock.now());
  const now = dependencies.clock.now();
  await dependencies.audit.append(context, {
    action: 'auth.sign_in_denied',
    actorKind: 'system',
    targetKind: 'oidc_login_transaction',
    targetId: transactionId,
    outcome: 'denied',
    occurredAt: now,
    requestId,
    metadata: {
      reason: error instanceof AuthenticationError ? error.code : 'auth_provider_unavailable',
    },
  });
  if (error instanceof AuthenticationError) {
    throw error;
  }
  throw new AuthenticationError('auth_provider_unavailable');
}

async function finalizeLogin(
  context: TenantTransactionContext,
  dependencies: OidcUseCaseDependencies,
  input: {
    readonly transactionId: string;
    readonly tenantId: string;
    readonly providerId: string;
    readonly issuer: string;
    readonly subject: string;
    readonly email: string | null;
    readonly returnPath: string;
    readonly requestId: string;
    readonly supersededSession: SessionRecord | undefined;
  },
): Promise<CompletedLogin> {
  const directory = dependencies.directory;
  const tenant = await directory.findTenant(context, input.tenantId);
  // Every resolution failure maps to the same generic code so login never
  // reveals whether an identity, account, or person exists or is disabled.
  const identity = await directory.findIdentity(context, input.issuer, input.subject);
  const account =
    identity === undefined ? undefined : await directory.findAccount(context, identity.accountId);
  const person =
    account === undefined ? undefined : await directory.findPerson(context, account.personId);
  if (
    tenant === undefined ||
    tenant.status !== 'active' ||
    identity === undefined ||
    account === undefined ||
    account.status !== 'active' ||
    person === undefined ||
    person.status !== 'active'
  ) {
    await dependencies.transactions.consume(input.transactionId, dependencies.clock.now());
    const now = dependencies.clock.now();
    await dependencies.audit.append(context, {
      action: 'auth.sign_in_denied',
      actorKind: 'system',
      targetKind: 'oidc_login_transaction',
      targetId: input.transactionId,
      outcome: 'denied',
      occurredAt: now,
      requestId: input.requestId,
      metadata: { reason: 'identity_not_linked' },
    });
    throw new AuthenticationError('identity_not_linked');
  }
  if ((identity.emailSnapshot ?? null) !== input.email) {
    await directory.updateIdentityEmailSnapshot(context, identity.id, input.email);
  }
  const now = dependencies.clock.now();
  const sessionToken = toBase64Url(dependencies.random.randomBytes(32));
  const csrfToken = toBase64Url(dependencies.random.randomBytes(32));
  const session = await dependencies.sessions.create(context, {
    tenantId: input.tenantId,
    accountId: account.id,
    identityProviderId: input.providerId,
    tokenDigest: dependencies.digester.digest(new TextEncoder().encode(sessionToken)),
    csrfTokenDigest: dependencies.digester.digest(new TextEncoder().encode(csrfToken)),
    accountSessionRevision: account.sessionRevision,
    authenticationMethod: 'oidc',
    authenticatedAt: now,
    idleExpiresAt: now.add({ seconds: 12 * 60 * 60 }),
    absoluteExpiresAt: now.add({ seconds: 7 * 24 * 60 * 60 }),
  });
  if (
    input.supersededSession !== undefined &&
    input.supersededSession.id !== session.id &&
    input.supersededSession.tenantId === input.tenantId
  ) {
    await dependencies.sessions.revokeSession(
      context,
      input.supersededSession.id,
      'superseded',
      now,
    );
  }
  await dependencies.audit.append(context, {
    action: 'auth.sign_in_succeeded',
    actorKind: 'account',
    actorId: account.id,
    targetKind: 'auth_session',
    targetId: session.id,
    outcome: 'success',
    occurredAt: now,
    requestId: input.requestId,
  });
  await dependencies.transactions.consume(input.transactionId, now);
  return { sessionToken, csrfToken, returnPath: input.returnPath, session };
}
