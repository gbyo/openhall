import { Temporal } from '@js-temporal/polyfill';
import type { Clock } from '@openhall/domain';
import type { TenantTransactionContext, TenantTransactionRunner } from '../persistence.js';
import { schoolDateFor } from '../control-plane/shared.js';
import type { EnrollmentRepository } from '../control-plane/ports.js';
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
} from './ports.js';
import { assertIssuerShape, assertOidcScopes, fromBase64Url, toBase64Url } from './validation.js';
import { pkceChallenge } from './oidc.js';

export interface EnrollmentAuthDependencies {
  readonly directory: IdentityDirectory;
  readonly transactions: OidcTransactionStore;
  readonly sessions: SessionRepository;
  readonly enrollments: EnrollmentRepository;
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

export interface StartEnrollmentInput {
  /** Raw base64url enrollment token from the Authorization header. */
  readonly enrollmentToken: string;
  /** Raw browser-binding value from the (HttpOnly) binding cookie. */
  readonly browserBinding: string;
}

export interface StartedEnrollment {
  readonly authorizationUrl: string;
  /** Raw state for the provider round trip; only its digest is stored. */
  readonly state: string;
}

function transactionSecretContext(tenantId: string, providerId: string): string {
  return `oidc-tx:v1:${tenantId}:${providerId}`;
}

function providerSecretContext(tenantId: string, providerId: string): string {
  return `provider-secret:v1:${tenantId}:${providerId}`;
}

function decodeToken(raw: string): Uint8Array {
  if (raw.length === 0) {
    throw new AuthenticationError('auth_transaction_invalid');
  }
  try {
    return fromBase64Url(raw);
  } catch {
    throw new AuthenticationError('auth_transaction_invalid');
  }
}

function decodeBinding(raw: string): Uint8Array {
  if (raw.length === 0) {
    throw new AuthenticationError('auth_transaction_invalid');
  }
  try {
    return fromBase64Url(raw);
  } catch {
    throw new AuthenticationError('auth_transaction_invalid');
  }
}

/**
 * Starts an OIDC enrollment: validates the one-time invitation digest
 * without consuming it, binds the exact account/provider, and returns the
 * provider authorization URL. A valid token may retry start until the grant
 * is consumed, revoked, or expired; consumption happens only at callback.
 */
export async function startIdentityEnrollment(
  input: StartEnrollmentInput,
  dependencies: EnrollmentAuthDependencies,
): Promise<StartedEnrollment> {
  const tokenHash = dependencies.digester.digest(decodeToken(input.enrollmentToken));
  const grant = await dependencies.enrollments.loadGrantByTokenDigest(tokenHash);
  if (grant === null) {
    throw new AuthenticationError('auth_transaction_invalid');
  }
  const now = dependencies.clock.now();
  if (
    grant.consumedAt !== null ||
    grant.revokedAt !== null ||
    Temporal.Instant.compare(grant.expiresAt, now) <= 0
  ) {
    const code =
      grant.consumedAt !== null || grant.revokedAt !== null
        ? 'auth_transaction_invalid'
        : 'auth_transaction_expired';
    throw new AuthenticationError(code);
  }
  const prepared = await dependencies.runner.run(grant.tenantId, async (context) => {
    const account = await dependencies.directory.findAccount(context, grant.accountId);
    if (account?.status !== 'active') {
      throw new AuthenticationError('auth_transaction_invalid');
    }
    const provider = await dependencies.directory.findProvider(context, grant.identityProviderId);
    if (provider?.status !== 'active') {
      throw new AuthenticationError('auth_provider_unavailable');
    }
    const issuer = assertIssuerShape(provider.issuer, {
      allowInsecureHttp: dependencies.allowInsecureHttp,
    });
    const scopes = assertOidcScopes(provider.scopes);
    const state = toBase64Url(dependencies.random.randomBytes(32));
    const nonce = toBase64Url(dependencies.random.randomBytes(32));
    const verifier = toBase64Url(dependencies.random.randomBytes(32));
    const binding = decodeBinding(input.browserBinding);
    const transactionSecret = dependencies.protector.protect(
      JSON.stringify({ verifier, nonce }),
      transactionSecretContext(grant.tenantId, provider.id),
    );
    await dependencies.transactions.create(context, {
      tenantId: grant.tenantId,
      identityProviderId: provider.id,
      bootstrapSetupId: null,
      identityEnrollmentGrantId: grant.id,
      providerSetupAccountId: null,
      purpose: 'enrollment',
      providerRevision: provider.revision,
      stateDigest: dependencies.digester.digest(new TextEncoder().encode(state)),
      browserBindingDigest: dependencies.digester.digest(binding),
      transactionSecret,
      returnPath: '/',
      expiresAt: now.add({ seconds: 10 * 60 }),
    });
    return {
      tenantId: grant.tenantId,
      issuer,
      providerId: provider.id,
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      tokenEndpointAuthMethod: provider.tokenEndpointAuthMethod,
      scopes: [...scopes],
      state,
      nonce,
      verifier,
    };
  });
  const clientSecret = dependencies.protector.reveal(
    prepared.clientSecret,
    providerSecretContext(prepared.tenantId, prepared.providerId),
  );
  const authorizationUrl = await dependencies.adapter.buildAuthorizationUrl({
    configuration: {
      issuer: prepared.issuer.issuer,
      clientId: prepared.clientId,
      clientSecret,
      tokenEndpointAuthMethod: prepared.tokenEndpointAuthMethod,
      scopes: prepared.scopes,
      allowInsecureHttp: prepared.issuer.insecureHttp,
    },
    redirectUri: dependencies.redirectUri,
    state: prepared.state,
    nonce: prepared.nonce,
    codeChallenge: pkceChallenge(prepared.verifier, dependencies.hasher),
  });
  return { authorizationUrl, state: prepared.state };
}

export interface CompleteEnrollmentInput {
  /** Raw state returned by the provider. */
  readonly state: string;
  /** Raw browser-binding value from the binding cookie. */
  readonly browserBinding: string;
  /** Full callback URL as received (query included for code extraction). */
  readonly callbackUrl: string;
  readonly requestId: string;
}

export interface CompletedEnrollment {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly returnPath: string;
  readonly session: SessionRecord;
}

/**
 * Completes an OIDC enrollment. Claims the transaction atomically, then
 * atomically links the verified issuer+subject to the predetermined account
 * and consumes the invitation. A verified identity already linked to a
 * different account fails closed with identity_link_conflict; the same
 * account re-binding is accepted safely. Exactly one of two racing
 * callbacks consumes the grant.
 */
export async function completeIdentityEnrollment(
  input: CompleteEnrollmentInput,
  dependencies: EnrollmentAuthDependencies,
): Promise<CompletedEnrollment> {
  const now = dependencies.clock.now();
  const stateDigest = dependencies.digester.digest(new TextEncoder().encode(input.state));
  const transaction = await dependencies.transactions.claimByStateDigest(stateDigest, now);
  if (
    transaction?.purpose !== 'enrollment' ||
    transaction.tenantId === null ||
    transaction.identityEnrollmentGrantId === null
  ) {
    throw new AuthenticationError('auth_transaction_invalid');
  }
  const tenantId = transaction.tenantId;
  const providerId = transaction.identityProviderId;
  const enrollmentId = transaction.identityEnrollmentGrantId;
  return dependencies.runner.run(tenantId, async (context) => {
    const markFailed = async (): Promise<void> => {
      await dependencies.transactions.markFailed(transaction.id, dependencies.clock.now());
    };
    if (transaction.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
      await markFailed();
      throw new AuthenticationError('auth_transaction_expired');
    }
    let bindingValid: boolean;
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
    if (provider?.status !== 'active' || provider.revision !== transaction.providerRevision) {
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
      await denyEnrollment(tenantId, dependencies, transaction.id, input.requestId, error);
      throw new AuthenticationError('auth_provider_unavailable');
    }
    // Explicit mix-up check: the verified issuer must be the transaction's provider.
    if (identity.issuer !== provider.issuer && identity.issuer !== issuer.issuer) {
      await denyEnrollment(
        tenantId,
        dependencies,
        transaction.id,
        input.requestId,
        new AuthenticationError('auth_transaction_invalid', 'Issuer mismatch'),
      );
    }
    return finalizeEnrollment(context, dependencies, {
      transactionId: transaction.id,
      tenantId,
      providerId: provider.id,
      enrollmentId,
      issuer: provider.issuer,
      subject: identity.subject,
      email: identity.email ?? null,
      requestId: input.requestId,
    });
  });
}

async function denyEnrollment(
  tenantId: string,
  dependencies: EnrollmentAuthDependencies,
  transactionId: string,
  requestId: string,
  error: unknown,
): Promise<never> {
  await dependencies.transactions.markFailed(transactionId, dependencies.clock.now());
  const now = dependencies.clock.now();
  await dependencies.runner.run(tenantId, async (auditContext) => {
    await dependencies.audit.append(auditContext, {
      action: 'auth.enrollment_denied',
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
  });
  if (error instanceof AuthenticationError) {
    throw error;
  }
  throw new AuthenticationError('auth_provider_unavailable');
}

async function finalizeEnrollment(
  context: TenantTransactionContext,
  dependencies: EnrollmentAuthDependencies,
  input: {
    readonly transactionId: string;
    readonly tenantId: string;
    readonly providerId: string;
    readonly enrollmentId: string;
    readonly issuer: string;
    readonly subject: string;
    readonly email: string | null;
    readonly requestId: string;
  },
): Promise<CompletedEnrollment> {
  const now = dependencies.clock.now();
  // Lock the invitation first: exactly one racing callback observes it live.
  const grant = await dependencies.enrollments.loadGrantForUpdate(context, input.enrollmentId);
  if (
    grant?.tenantId !== input.tenantId ||
    grant.consumedAt !== null ||
    grant.revokedAt !== null ||
    Temporal.Instant.compare(grant.expiresAt, now) <= 0
  ) {
    await dependencies.transactions.markFailed(input.transactionId, dependencies.clock.now());
    throw new AuthenticationError('auth_transaction_invalid');
  }
  const directory = dependencies.directory;
  const account = await directory.findAccount(context, grant.accountId);
  const person =
    account === undefined ? undefined : await directory.findPerson(context, account.personId);
  if (account?.status !== 'active' || person?.status !== 'active') {
    await dependencies.transactions.markFailed(input.transactionId, dependencies.clock.now());
    throw new AuthenticationError('auth_transaction_invalid');
  }
  const timeZone = await dependencies.enrollments.loadSchoolTimeZone(context, grant.organizationId);
  const today = timeZone === null ? null : schoolDateFor(now, timeZone);
  const membership =
    today === null
      ? null
      : await dependencies.enrollments.loadActiveMembership(
          context,
          person.id,
          grant.organizationId,
          today.toString(),
        );
  if (membership === null) {
    await dependencies.transactions.markFailed(input.transactionId, dependencies.clock.now());
    throw new AuthenticationError('auth_transaction_invalid');
  }
  // Collision check on the canonical external identity: a verified
  // issuer+subject bound to a different account fails closed without
  // disclosing which person, account, or school owns it.
  const existing = await directory.findIdentity(context, input.issuer, input.subject);
  if (existing !== undefined && existing.accountId !== account.id) {
    await denyEnrollment(
      input.tenantId,
      dependencies,
      input.transactionId,
      input.requestId,
      new AuthenticationError('identity_link_conflict'),
    );
  }
  if (existing === undefined) {
    await directory.createIdentity(context, {
      accountId: account.id,
      issuer: input.issuer,
      providerSubject: input.subject,
      emailSnapshot: input.email,
    });
  } else if ((existing.emailSnapshot ?? null) !== input.email) {
    await directory.updateIdentityEmailSnapshot(context, existing.id, input.email);
  }
  const consumed = await dependencies.enrollments.consumeGrant(
    context,
    grant.id,
    grant.revision,
    now,
  );
  if (consumed === null) {
    await dependencies.transactions.markFailed(input.transactionId, dependencies.clock.now());
    throw new AuthenticationError('auth_transaction_invalid');
  }
  const sessionTokenBytes = dependencies.random.randomBytes(32);
  const csrfTokenBytes = dependencies.digester.deriveCsrfToken(sessionTokenBytes);
  const sessionToken = toBase64Url(sessionTokenBytes);
  const csrfToken = toBase64Url(csrfTokenBytes);
  const session = await dependencies.sessions.create(context, {
    tenantId: input.tenantId,
    accountId: account.id,
    identityProviderId: input.providerId,
    tokenDigest: dependencies.digester.digestSessionToken(sessionTokenBytes),
    csrfTokenDigest: dependencies.digester.digest(csrfTokenBytes),
    accountSessionRevision: account.sessionRevision,
    authenticationMethod: 'oidc',
    authenticatedAt: now,
    idleExpiresAt: now.add({ seconds: 12 * 60 * 60 }),
    absoluteExpiresAt: now.add({ seconds: 7 * 24 * 60 * 60 }),
  });
  await dependencies.audit.append(context, {
    action: 'auth.enrollment_linked',
    actorKind: 'account',
    actorId: account.id,
    targetKind: 'auth_session',
    targetId: session.id,
    outcome: 'success',
    occurredAt: now,
    requestId: input.requestId,
  });
  await dependencies.transactions.consume(input.transactionId, now);
  return { sessionToken, csrfToken, returnPath: '/', session };
}
