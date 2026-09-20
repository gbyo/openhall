import type { Clock } from '@openhall/domain';
import type {
  SystemTransactionContext,
  SystemTransactionRunner,
  TenantTransactionRunner,
} from '../persistence.js';
import { AuthenticationError } from './errors.js';
import { pkceChallenge } from './oidc.js';
import type {
  AuditWriter,
  BootstrapDraftInput,
  BootstrapFinalizer,
  BootstrapInstallation,
  BootstrapRepository,
  CredentialDigester,
  IdentityDirectory,
  OidcProtocolAdapter,
  OidcTransactionStore,
  OperatorGrantStore,
  RecoveryEligibilityChecker,
  SecretProtector,
  SecureRandomSource,
  SessionRecord,
  SessionRepository,
  Sha256Hasher,
  TenantDirectory,
  VerifiedExternalIdentity,
} from './ports.js';
import {
  assertIssuerShape,
  assertOidcScopes,
  assertTokenAuthMethod,
  assertValidSlug,
  fromBase64Url,
  normalizeReturnPath,
  toBase64Url,
} from './validation.js';

/** Operator grants live one hour; setup drafts share that horizon. */
export const BOOTSTRAP_GRANT_TTL_SECONDS = 60 * 60;
/** Break-glass recovery grants live thirty minutes, single use. */
export const RECOVERY_GRANT_TTL_SECONDS = 30 * 60;
export const BOOTSTRAP_TRANSACTION_TTL_SECONDS = 10 * 60;

function bootstrapSecretContext(grantId: string): string {
  return `bootstrap-provider-secret:v1:${grantId}`;
}

function bootstrapTransactionSecretContext(setupId: string): string {
  return `bootstrap-tx:v1:${setupId}`;
}

export interface OperatorTokenDependencies {
  readonly grants: OperatorGrantStore;
  readonly random: SecureRandomSource;
  readonly digester: CredentialDigester;
  readonly clock: Clock;
}

export interface IssuedOperatorGrant {
  readonly grantId: string;
  /** Raw token: printed exactly once, never logged, never stored raw. */
  readonly rawToken: string;
}

function newOperatorToken(dependencies: OperatorTokenDependencies): {
  readonly rawToken: string;
  readonly digest: Uint8Array;
} {
  const rawBytes = dependencies.random.randomBytes(32);
  return {
    rawToken: toBase64Url(rawBytes),
    digest: dependencies.digester.digest(rawBytes),
  };
}

/**
 * Issues a one-time bootstrap grant. Refuses when a canonical tenant already
 * exists, so a second installation cannot be bootstrapped over the first.
 */
export async function issueBootstrapGrant(
  context: SystemTransactionContext,
  tenants: TenantDirectory,
  dependencies: OperatorTokenDependencies,
): Promise<IssuedOperatorGrant> {
  if ((await tenants.countCanonical()) > 0) {
    throw new AuthenticationError('bootstrap_unavailable');
  }
  const token = newOperatorToken(dependencies);
  const grant = await dependencies.grants.create(context, {
    purpose: 'bootstrap',
    tenantId: null,
    accountId: null,
    tokenDigest: token.digest,
    expiresAt: dependencies.clock.now().add({ seconds: BOOTSTRAP_GRANT_TTL_SECONDS }),
  });
  return { grantId: grant.id, rawToken: token.rawToken };
}

export interface PrepareBootstrapInput {
  /** Raw operator token from the Authorization header. */
  readonly operatorToken: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
  readonly schoolName: string;
  readonly schoolSlug: string;
  readonly schoolTimeZone: string;
  readonly adminGivenName: string;
  readonly adminFamilyName: string;
  readonly adminDisplayName: string;
  readonly providerKey: string;
  readonly providerDisplayName: string;
  readonly providerIssuer: string;
  readonly providerClientId: string;
  /** Raw client secret; encrypted before persistence, never logged. */
  readonly providerClientSecret: string;
  readonly providerAuthMethod: string;
  readonly providerScopes: readonly string[];
  /** Raw browser-binding value from the binding cookie. */
  readonly browserBinding: string;
}

export interface PreparedBootstrap {
  readonly authorizationUrl: string;
  readonly state: string;
}

export interface PrepareBootstrapDependencies extends OperatorTokenDependencies {
  readonly drafts: BootstrapRepository;
  readonly transactions: OidcTransactionStore;
  readonly tenants: TenantDirectory;
  readonly adapter: OidcProtocolAdapter;
  readonly protector: SecretProtector;
  readonly hasher: Sha256Hasher;
  readonly redirectUri: string;
  readonly allowInsecureHttp: boolean;
  readonly runner: SystemTransactionRunner;
}

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new AuthenticationError('invalid_bootstrap_draft', `Invalid ${field}`);
  }
  return trimmed;
}

/**
 * Validates the bootstrap draft (including live provider discovery), stores
 * the draft with an encrypted client secret, and starts the bootstrap OIDC
 * flow. The operator grant is validated but not consumed here, so a valid
 * grant can retry the same flow until expiration; consumption happens once
 * in atomic finalization. Creates no canonical records on failure, and the
 * operator can correct the draft while the grant remains valid.
 */
export async function prepareBootstrap(
  input: PrepareBootstrapInput,
  dependencies: PrepareBootstrapDependencies,
): Promise<PreparedBootstrap> {
  // Phase 1 (short transaction): grant + field validation, no network.
  const prepared = await dependencies.runner.run(async () => {
    const now = dependencies.clock.now();
    const digest = dependencies.digester.digest(decodeOperatorToken(input.operatorToken));
    const grant = await dependencies.grants.findValidByTokenDigest(digest, now);
    if (grant?.purpose !== 'bootstrap') {
      throw new AuthenticationError('bootstrap_token_invalid');
    }
    if ((await dependencies.tenants.countCanonical()) > 0) {
      throw new AuthenticationError('bootstrap_unavailable');
    }
    let draft: BootstrapDraftInput;
    try {
      draft = {
        tenantName: nonEmpty(input.tenantName, 'tenant name'),
        tenantSlug: assertValidSlug(input.tenantSlug, 'tenant slug'),
        schoolName: nonEmpty(input.schoolName, 'school name'),
        schoolSlug: assertValidSlug(input.schoolSlug, 'school slug'),
        schoolTimeZone: nonEmpty(input.schoolTimeZone, 'school time zone'),
        adminGivenName: nonEmpty(input.adminGivenName, 'administrator given name'),
        adminFamilyName: nonEmpty(input.adminFamilyName, 'administrator family name'),
        adminDisplayName: nonEmpty(input.adminDisplayName, 'administrator display name'),
        providerKey: assertValidSlug(input.providerKey, 'provider key'),
        providerDisplayName: nonEmpty(input.providerDisplayName, 'provider display name'),
        providerIssuer: assertIssuerShape(input.providerIssuer.trim(), {
          allowInsecureHttp: dependencies.allowInsecureHttp,
        }).issuer,
        providerClientId: nonEmpty(input.providerClientId, 'provider client id'),
        providerSecret: {
          ciphertext: new Uint8Array(),
          nonce: new Uint8Array(),
          tag: new Uint8Array(),
          keyId: '',
        },
        providerAuthMethod: assertTokenAuthMethod(input.providerAuthMethod.trim()),
        providerScopes: [...assertOidcScopes(input.providerScopes)],
        expiresAt: now.add({ seconds: BOOTSTRAP_GRANT_TTL_SECONDS }),
      };
    } catch (error) {
      if (error instanceof AuthenticationError && error.code === 'auth_transaction_invalid') {
        throw new AuthenticationError('invalid_bootstrap_draft', error.message);
      }
      throw error;
    }
    if (input.providerClientSecret.length === 0 || input.providerClientSecret.length > 2000) {
      throw new AuthenticationError('invalid_bootstrap_draft', 'Invalid provider client secret');
    }
    return { grantId: grant.id, draft };
  });
  const configuration = {
    issuer: prepared.draft.providerIssuer,
    clientId: prepared.draft.providerClientId,
    clientSecret: input.providerClientSecret,
    tokenEndpointAuthMethod: prepared.draft.providerAuthMethod,
    scopes: [...prepared.draft.providerScopes],
    allowInsecureHttp: dependencies.allowInsecureHttp,
  };
  // Phase 2 (network, no transaction): live provider validation.
  try {
    await dependencies.adapter.validateProviderConfiguration(configuration);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw error;
    }
    throw new AuthenticationError('provider_configuration_unsupported');
  }
  // Phase 3 (short transaction): draft + login transaction persistence.
  const staged = await dependencies.runner.run(async (system) => {
    const now = dependencies.clock.now();
    const withSecret: BootstrapDraftInput = {
      ...prepared.draft,
      providerSecret: dependencies.protector.protect(
        input.providerClientSecret,
        bootstrapSecretContext(prepared.grantId),
      ),
    };
    const existing = await dependencies.drafts.findByGrantId(system, prepared.grantId);
    const setup =
      existing?.completedAt === null
        ? await dependencies.drafts.updateDraft(system, existing.id, withSecret)
        : await dependencies.drafts.createDraft(system, prepared.grantId, withSecret);
    const state = toBase64Url(dependencies.random.randomBytes(32));
    const nonce = toBase64Url(dependencies.random.randomBytes(32));
    const verifier = toBase64Url(dependencies.random.randomBytes(32));
    await dependencies.transactions.create(system, {
      tenantId: null,
      identityProviderId: null,
      bootstrapSetupId: setup.id,
      purpose: 'bootstrap',
      providerRevision: null,
      stateDigest: dependencies.digester.digest(new TextEncoder().encode(state)),
      browserBindingDigest: dependencies.digester.digest(decodeBinding(input.browserBinding)),
      transactionSecret: dependencies.protector.protect(
        JSON.stringify({ verifier, nonce }),
        bootstrapTransactionSecretContext(setup.id),
      ),
      returnPath: normalizeReturnPath('/'),
      expiresAt: now.add({ seconds: BOOTSTRAP_TRANSACTION_TTL_SECONDS }),
    });
    return { state, nonce, verifier };
  });
  // Phase 4 (network, no transaction): authorization redirect.
  const authorizationUrl = await dependencies.adapter.buildAuthorizationUrl({
    configuration,
    redirectUri: dependencies.redirectUri,
    state: staged.state,
    nonce: staged.nonce,
    codeChallenge: pkceChallenge(staged.verifier, dependencies.hasher),
  });
  return { authorizationUrl, state: staged.state };
}

function decodeOperatorToken(raw: string): Uint8Array {
  if (raw.length === 0) {
    throw new AuthenticationError('bootstrap_token_invalid');
  }
  try {
    return fromBase64Url(raw);
  } catch {
    throw new AuthenticationError('bootstrap_token_invalid');
  }
}

function decodeBinding(raw: string): Uint8Array {
  if (raw.length === 0) {
    throw new AuthenticationError('auth_transaction_invalid');
  }
  return fromBase64Url(raw);
}

export interface CompleteBootstrapInput {
  readonly state: string;
  readonly browserBinding: string;
  readonly callbackUrl: string;
  readonly requestId: string;
}

export interface CompleteBootstrapDependencies extends OperatorTokenDependencies {
  readonly transactions: OidcTransactionStore;
  readonly drafts: BootstrapRepository;
  readonly tenants: TenantDirectory;
  readonly adapter: OidcProtocolAdapter;
  readonly protector: SecretProtector;
  readonly redirectUri: string;
  readonly allowInsecureHttp: boolean;
  readonly finalizer: BootstrapFinalizer;
  readonly sessionRunner: SystemTransactionRunner;
}

export interface CompletedBootstrap {
  readonly installation: BootstrapInstallation;
  readonly sessionToken: string;
  readonly csrfToken: string;
}

/**
 * Completes bootstrap after the first administrator authenticates: claims
 * the bootstrap transaction once, validates the code against the draft
 * provider, then atomically creates the canonical installation and session.
 */
export async function completeBootstrap(
  input: CompleteBootstrapInput,
  dependencies: CompleteBootstrapDependencies,
): Promise<CompletedBootstrap> {
  const now = dependencies.clock.now();
  const transaction = await dependencies.transactions.claimByStateDigest(
    dependencies.digester.digest(new TextEncoder().encode(input.state)),
    now,
  );
  if (transaction?.purpose !== 'bootstrap' || transaction.bootstrapSetupId === null) {
    throw new AuthenticationError('auth_transaction_invalid');
  }
  const setupId = transaction.bootstrapSetupId;
  return dependencies.sessionRunner.run(async (system) => {
    const markFailed = async (): Promise<void> => {
      await dependencies.transactions.markFailed(transaction.id, dependencies.clock.now());
    };
    if (transaction.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
      await dependencies.transactions.markFailed(transaction.id, now);
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
    if (!bindingValid) {
      await markFailed();
      throw new AuthenticationError('auth_transaction_invalid');
    }
    const setup = await dependencies.drafts.findBySetupId(system, setupId);
    if (setup?.completedAt !== null) {
      await markFailed();
      throw new AuthenticationError('auth_transaction_invalid');
    }
    let secret: { readonly verifier: string; readonly nonce: string } | undefined;
    try {
      const revealed = JSON.parse(
        dependencies.protector.reveal(
          transaction.transactionSecret,
          bootstrapTransactionSecretContext(setup.id),
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
      setup.providerSecret,
      bootstrapSecretContext(setup.operatorGrantId),
    );
    const configuration = {
      issuer: setup.providerIssuer,
      clientId: setup.providerClientId,
      clientSecret,
      tokenEndpointAuthMethod: setup.providerAuthMethod,
      scopes: [...setup.providerScopes],
      allowInsecureHttp: dependencies.allowInsecureHttp,
    };
    let identity: VerifiedExternalIdentity;
    try {
      identity = await dependencies.adapter.exchangeCode({
        configuration,
        redirectUri: dependencies.redirectUri,
        callbackUrl: input.callbackUrl,
        codeVerifier: secret.verifier,
        expectedState: input.state,
        expectedNonce: secret.nonce,
      });
    } catch {
      await markFailed();
      throw new AuthenticationError('auth_provider_unavailable');
    }
    if (identity.issuer !== setup.providerIssuer) {
      await markFailed();
      throw new AuthenticationError('auth_transaction_invalid');
    }
    // Never email-match: the presenter of this transaction is explicitly
    // becoming the initial administrator. CSRF is derived deterministically
    // from the session credential (see oidc finalizeLogin).
    const sessionTokenBytes = dependencies.random.randomBytes(32);
    const csrfTokenBytes = dependencies.digester.deriveCsrfToken(sessionTokenBytes);
    const sessionToken = toBase64Url(sessionTokenBytes);
    const csrfToken = toBase64Url(csrfTokenBytes);
    const installation = await dependencies.finalizer.finalize(system, {
      setupId: setup.id,
      transactionId: transaction.id,
      identity,
      providerClientSecret: clientSecret,
      sessionTokenDigest: dependencies.digester.digestSessionToken(sessionTokenBytes),
      csrfTokenDigest: dependencies.digester.digest(csrfTokenBytes),
      now: dependencies.clock.now(),
      requestId: input.requestId,
    });
    return { installation, sessionToken, csrfToken };
  });
}

export interface ConsumeRecoveryInput {
  /** Raw recovery token from the Authorization header. */
  readonly recoveryToken: string;
  readonly requestId: string;
}

export interface ConsumedRecovery {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly session: SessionRecord;
}

export interface RecoveryDependencies extends OperatorTokenDependencies {
  readonly tenants: TenantDirectory;
  readonly directory: IdentityDirectory;
  readonly sessions: SessionRepository;
  readonly audit: AuditWriter;
  readonly grants: OperatorGrantStore;
  readonly tenantRunner: TenantTransactionRunner;
}

/**
 * Break-glass recovery: consumes a one-time operator grant, re-checks
 * tenant/account/person status plus a valid tenant-scoped system_admin
 * grant, and creates a short-lived recovery session.
 */
export async function consumeRecoveryGrant(
  input: ConsumeRecoveryInput,
  dependencies: RecoveryDependencies,
): Promise<ConsumedRecovery> {
  const now = dependencies.clock.now();
  let digest: Uint8Array;
  try {
    digest = dependencies.digester.digest(fromBase64Url(input.recoveryToken));
  } catch {
    throw new AuthenticationError('recovery_token_invalid');
  }
  const grant = await dependencies.grants.consumeByTokenDigest(digest, now);
  if (grant?.purpose !== 'recovery' || grant.tenantId === null) {
    throw new AuthenticationError('recovery_token_invalid');
  }
  const tenantId = grant.tenantId;
  return dependencies.tenantRunner.run(tenantId, async (context) => {
    const tenant = await dependencies.tenants.findById(tenantId);
    const account =
      grant.accountId === null
        ? undefined
        : await dependencies.directory.findAccount(context, grant.accountId);
    const person =
      account === undefined
        ? undefined
        : await dependencies.directory.findPerson(context, account.personId);
    const hasAdminGrant =
      account === undefined
        ? false
        : await dependencies.directory.hasActiveSystemAdminGrant(context, account.id, now);
    if (
      tenant?.status !== 'active' ||
      account?.status !== 'active' ||
      person?.status !== 'active' ||
      !hasAdminGrant
    ) {
      throw new AuthenticationError('recovery_token_invalid');
    }
    const authenticatedAt = dependencies.clock.now();
    const sessionTokenBytes = dependencies.random.randomBytes(32);
    const csrfTokenBytes = dependencies.digester.deriveCsrfToken(sessionTokenBytes);
    const sessionToken = toBase64Url(sessionTokenBytes);
    const csrfToken = toBase64Url(csrfTokenBytes);
    const session = await dependencies.sessions.create(context, {
      tenantId,
      accountId: account.id,
      identityProviderId: null,
      tokenDigest: dependencies.digester.digestSessionToken(sessionTokenBytes),
      csrfTokenDigest: dependencies.digester.digest(csrfTokenBytes),
      accountSessionRevision: account.sessionRevision,
      authenticationMethod: 'recovery',
      authenticatedAt,
      idleExpiresAt: authenticatedAt.add({ seconds: 15 * 60 }),
      absoluteExpiresAt: authenticatedAt.add({ seconds: 30 * 60 }),
    });
    await dependencies.audit.append(context, {
      action: 'auth.recovery_session_created',
      actorKind: 'account',
      actorId: account.id,
      targetKind: 'auth_session',
      targetId: session.id,
      outcome: 'success',
      occurredAt: authenticatedAt,
      requestId: input.requestId,
    });
    return { sessionToken, csrfToken, session };
  });
}

export interface IssueRecoveryDependencies extends OperatorTokenDependencies {
  readonly audit: AuditWriter;
  readonly tenantRunner: TenantTransactionRunner;
}

/**
 * Issues a one-time recovery grant for an existing active
 * tenant/system-admin account. Recovery issuance itself is audited
 * prominently from a tenant transaction.
 */
export async function issueRecoveryGrant(
  context: SystemTransactionContext,
  input: { readonly tenantId: string; readonly accountId: string; readonly requestId: string },
  tenants: TenantDirectory,
  checker: RecoveryEligibilityChecker,
  dependencies: IssueRecoveryDependencies,
): Promise<IssuedOperatorGrant> {
  const tenant = await tenants.findById(input.tenantId);
  if (tenant?.status !== 'active') {
    throw new AuthenticationError('recovery_token_invalid');
  }
  const eligible = await checker.checkRecoveryEligible(context, input.tenantId, input.accountId);
  if (!eligible) {
    throw new AuthenticationError('recovery_token_invalid');
  }
  const now = dependencies.clock.now();
  const token = newOperatorToken(dependencies);
  const grant = await dependencies.grants.create(context, {
    purpose: 'recovery',
    tenantId: input.tenantId,
    accountId: input.accountId,
    tokenDigest: token.digest,
    expiresAt: now.add({ seconds: RECOVERY_GRANT_TTL_SECONDS }),
  });
  await dependencies.tenantRunner.run(input.tenantId, async (tenantContext) => {
    await dependencies.audit.append(tenantContext, {
      action: 'auth.recovery_grant_issued',
      actorKind: 'system',
      targetKind: 'account',
      targetId: input.accountId,
      outcome: 'success',
      occurredAt: dependencies.clock.now(),
      requestId: input.requestId,
    });
  });
  return { grantId: grant.id, rawToken: token.rawToken };
}
