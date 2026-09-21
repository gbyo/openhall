import type { Clock } from '@openhall/domain';
import type { TenantTransactionRunner } from '../persistence.js';
import { AuthenticationError } from './errors.js';
import { pkceChallenge } from './oidc.js';
import type {
  AuditWriter,
  CredentialDigester,
  IdentityDirectory,
  OidcProtocolAdapter,
  OidcTransactionStore,
  ProviderSetupFinalizer,
  ResolvedProviderSetupConfig,
  SecretProtector,
  SecureRandomSource,
  SessionRecord,
  Sha256Hasher,
} from './ports.js';
import type { Principal } from './principal.js';
import {
  assertIssuerShape,
  assertOidcScopes,
  assertTokenAuthMethod,
  assertValidSlug,
  CANONICAL_GOOGLE_PROVIDER,
  deriveSlug,
  fromBase64Url,
  toBase64Url,
} from './validation.js';

export const PROVIDER_SETUP_TRANSACTION_TTL_SECONDS = 10 * 60;

function providerSetupSecretContext(tenantId: string, accountId: string, state: string): string {
  return `provider-setup-tx:v1:${tenantId}:${accountId}:${state}`;
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

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 500) {
    throw new AuthenticationError('auth_transaction_invalid', `Invalid ${field}`);
  }
  return trimmed;
}

export interface PrepareProviderSetupInput {
  readonly principal: Principal;
  readonly providerPreset: 'google' | 'generic';
  /** Google: the only provider fields the browser may submit. */
  readonly clientId: string;
  readonly clientSecret: string;
  /** Generic only. */
  readonly providerName?: string | undefined;
  readonly issuerUrl?: string | undefined;
  readonly providerKey?: string | undefined;
  readonly authMethod?: string | undefined;
  readonly scopes?: readonly string[] | undefined;
  /** Raw browser-binding value from the (HttpOnly) binding cookie. */
  readonly browserBinding: string;
}

export interface PreparedProviderSetup {
  readonly authorizationUrl: string;
  readonly state: string;
}

export interface ProviderSetupDependencies {
  readonly directory: IdentityDirectory;
  readonly transactions: OidcTransactionStore;
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

interface StagedProviderSetup {
  readonly config: ResolvedProviderSetupConfig;
  readonly clientSecret: string;
  readonly verifier: string;
  readonly nonce: string;
}

function resolveGoogleConfig(clientId: string, secret: string): StagedProviderSetup | never {
  const trimmedId = clientId.trim();
  if (trimmedId.length === 0 || trimmedId.length > 500) {
    throw new AuthenticationError('auth_transaction_invalid', 'Invalid client ID');
  }
  if (secret.length === 0 || secret.length > 2000) {
    throw new AuthenticationError('auth_transaction_invalid', 'Invalid client secret');
  }
  return {
    config: {
      providerKey: CANONICAL_GOOGLE_PROVIDER.key,
      providerDisplayName: CANONICAL_GOOGLE_PROVIDER.displayName,
      providerIssuer: CANONICAL_GOOGLE_PROVIDER.issuer,
      providerClientId: trimmedId,
      providerAuthMethod: CANONICAL_GOOGLE_PROVIDER.tokenEndpointAuthMethod,
      providerScopes: [...CANONICAL_GOOGLE_PROVIDER.scopes],
    },
    clientSecret: secret,
    verifier: '',
    nonce: '',
  };
}

function resolveGenericConfig(
  input: PrepareProviderSetupInput,
  allowInsecureHttp: boolean,
): Omit<StagedProviderSetup, 'verifier' | 'nonce'> {
  const displayName = nonEmpty(input.providerName ?? '', 'provider name');
  const issuerChecked = assertIssuerShape((input.issuerUrl ?? '').trim(), {
    allowInsecureHttp,
  });
  const clientId = nonEmpty(input.clientId, 'client ID');
  const secret = input.clientSecret;
  if (secret.length === 0 || secret.length > 2000) {
    throw new AuthenticationError('auth_transaction_invalid', 'Invalid client secret');
  }
  const authMethodRaw = (input.authMethod ?? 'client_secret_post').trim();
  const authMethod = assertTokenAuthMethod(
    authMethodRaw === '' ? 'client_secret_post' : authMethodRaw,
  );
  const scopes = [...assertOidcScopes(input.scopes ?? ['openid'])];
  const keyRaw = (input.providerKey ?? '').trim();
  let providerKey: string;
  if (keyRaw.length > 0) {
    providerKey = assertValidSlug(keyRaw, 'provider key');
  } else {
    const derived = deriveSlug(displayName);
    if (derived === undefined) {
      throw new AuthenticationError(
        'auth_transaction_invalid',
        'Cannot derive a provider key; provide an explicit provider key',
      );
    }
    providerKey = derived;
  }
  return {
    config: {
      providerKey,
      providerDisplayName: displayName,
      providerIssuer: issuerChecked.issuer,
      providerClientId: clientId,
      providerAuthMethod: authMethod,
      providerScopes: scopes,
    },
    clientSecret: secret,
  };
}

/**
 * Starts first-provider setup for an initialized school: binds the exact
 * authenticated administrator account, validates the proposed provider
 * (including live discovery outside any DB transaction), stages the
 * configuration in a protected transaction secret, and returns the provider
 * authorization URL. Never creates a canonical provider row before OIDC
 * succeeds. Setup and authorized recovery sessions may prepare; anything
 * else, an ineligible account, or an already-connected provider fails
 * closed.
 */
export async function prepareProviderSetup(
  input: PrepareProviderSetupInput,
  dependencies: ProviderSetupDependencies,
): Promise<PreparedProviderSetup> {
  const tenantId = input.principal.tenantId;
  const accountId = input.principal.accountId;
  // Phase 1 (short transaction): eligibility + field validation, no network.
  const staged = await dependencies.runner.run(tenantId, async (context) => {
    const account = await dependencies.directory.findAccount(context, accountId);
    const person =
      account === undefined
        ? undefined
        : await dependencies.directory.findPerson(context, account.personId);
    if (account?.status !== 'active' || person?.status !== 'active') {
      throw new AuthenticationError('unauthenticated');
    }
    if (
      input.principal.authenticationMethod !== 'setup' &&
      input.principal.authenticationMethod !== 'recovery'
    ) {
      throw new AuthenticationError('unauthenticated');
    }
    if (
      !(await dependencies.directory.hasActiveSystemAdminGrant(
        context,
        account.id,
        dependencies.clock.now(),
      ))
    ) {
      throw new AuthenticationError('unauthenticated');
    }
    const active = await dependencies.directory.listActiveProviders(context);
    if (active.length > 0) {
      throw new AuthenticationError('provider_setup_conflict');
    }
    const resolved =
      input.providerPreset === 'google'
        ? resolveGoogleConfig(input.clientId, input.clientSecret)
        : resolveGenericConfig(input, dependencies.allowInsecureHttp);
    // Browser binding is decoded here so a missing binding fails before any
    // network call; the digest is persisted with the transaction below.
    decodeBinding(input.browserBinding);
    return resolved;
  });
  const configuration = {
    issuer: staged.config.providerIssuer,
    clientId: staged.config.providerClientId,
    clientSecret: staged.clientSecret,
    tokenEndpointAuthMethod: staged.config.providerAuthMethod,
    scopes: [...staged.config.providerScopes],
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
  // Phase 3 (short transaction): re-check eligibility, stage transaction.
  const created = await dependencies.runner.run(tenantId, async (context) => {
    const account = await dependencies.directory.findAccount(context, accountId);
    if (account?.status !== 'active') {
      throw new AuthenticationError('unauthenticated');
    }
    if (
      !(await dependencies.directory.hasActiveSystemAdminGrant(
        context,
        account.id,
        dependencies.clock.now(),
      ))
    ) {
      throw new AuthenticationError('unauthenticated');
    }
    const active = await dependencies.directory.listActiveProviders(context);
    if (active.length > 0) {
      throw new AuthenticationError('provider_setup_conflict');
    }
    const now = dependencies.clock.now();
    const state = toBase64Url(dependencies.random.randomBytes(32));
    const nonce = toBase64Url(dependencies.random.randomBytes(32));
    const verifier = toBase64Url(dependencies.random.randomBytes(32));
    const payload: StagedProviderSetup = { ...staged, verifier, nonce };
    await dependencies.transactions.create(context, {
      tenantId,
      identityProviderId: null,
      bootstrapSetupId: null,
      identityEnrollmentGrantId: null,
      providerSetupAccountId: accountId,
      purpose: 'provider_setup',
      providerRevision: null,
      stateDigest: dependencies.digester.digest(new TextEncoder().encode(state)),
      browserBindingDigest: dependencies.digester.digest(decodeBinding(input.browserBinding)),
      transactionSecret: dependencies.protector.protect(
        JSON.stringify(payload),
        providerSetupSecretContext(tenantId, accountId, state),
      ),
      returnPath: '/',
      expiresAt: now.add({ seconds: PROVIDER_SETUP_TRANSACTION_TTL_SECONDS }),
    });
    return { state, nonce, verifier };
  });
  // Phase 4 (network, no transaction): authorization redirect.
  const authorizationUrl = await dependencies.adapter.buildAuthorizationUrl({
    configuration,
    redirectUri: dependencies.redirectUri,
    state: created.state,
    nonce: created.nonce,
    codeChallenge: pkceChallenge(created.verifier, dependencies.hasher),
  });
  return { authorizationUrl, state: created.state };
}

export interface CompleteProviderSetupInput {
  /** Raw state returned by the provider. */
  readonly state: string;
  /** Raw browser-binding value from the binding cookie. */
  readonly browserBinding: string;
  /** Full callback URL as received (query included for code extraction). */
  readonly callbackUrl: string;
  readonly requestId: string;
}

export interface CompletedProviderSetup {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly session: SessionRecord;
}

export interface CompleteProviderSetupDependencies extends ProviderSetupDependencies {
  readonly finalizer: ProviderSetupFinalizer;
}

function revealStaged(
  transactionSecret: {
    readonly ciphertext: Uint8Array;
    readonly nonce: Uint8Array;
    readonly tag: Uint8Array;
    readonly keyId: string;
  },
  context: string,
  dependencies: ProviderSetupDependencies,
): StagedProviderSetup {
  let revealed: unknown;
  try {
    revealed = JSON.parse(dependencies.protector.reveal(transactionSecret, context));
  } catch {
    throw new AuthenticationError('auth_transaction_invalid');
  }
  const staged = revealed as Partial<StagedProviderSetup>;
  const config = staged.config as Partial<ResolvedProviderSetupConfig> | undefined;
  if (
    typeof staged.clientSecret !== 'string' ||
    typeof staged.verifier !== 'string' ||
    typeof staged.nonce !== 'string' ||
    config === undefined ||
    typeof config.providerKey !== 'string' ||
    typeof config.providerDisplayName !== 'string' ||
    typeof config.providerIssuer !== 'string' ||
    typeof config.providerClientId !== 'string' ||
    (config.providerAuthMethod !== 'client_secret_post' &&
      config.providerAuthMethod !== 'client_secret_basic') ||
    !Array.isArray(config.providerScopes) ||
    !config.providerScopes.every((scope): scope is string => typeof scope === 'string')
  ) {
    throw new AuthenticationError('auth_transaction_invalid');
  }
  return {
    config: {
      providerKey: config.providerKey,
      providerDisplayName: config.providerDisplayName,
      providerIssuer: config.providerIssuer,
      providerClientId: config.providerClientId,
      providerAuthMethod: config.providerAuthMethod,
      providerScopes: [...config.providerScopes],
    },
    clientSecret: staged.clientSecret,
    verifier: staged.verifier,
    nonce: staged.nonce,
  };
}

/**
 * Completes first-provider setup after external OIDC verification: the
 * verified identity becomes an identity for the predetermined administrator
 * account (never email-matched), the canonical provider is created, and
 * temporary setup/recovery sessions are atomically replaced by a normal
 * OIDC session.
 */
export async function completeProviderSetup(
  input: CompleteProviderSetupInput,
  dependencies: CompleteProviderSetupDependencies,
): Promise<CompletedProviderSetup> {
  const now = dependencies.clock.now();
  const transaction = await dependencies.transactions.claimByStateDigest(
    dependencies.digester.digest(new TextEncoder().encode(input.state)),
    now,
  );
  if (
    transaction?.purpose !== 'provider_setup' ||
    transaction.tenantId === null ||
    transaction.providerSetupAccountId === null
  ) {
    throw new AuthenticationError('auth_transaction_invalid');
  }
  const tenantId = transaction.tenantId;
  const accountId = transaction.providerSetupAccountId;
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
    if (!bindingValid) {
      await markFailed();
      throw new AuthenticationError('auth_transaction_invalid');
    }
    const staged = revealStaged(
      transaction.transactionSecret,
      providerSetupSecretContext(tenantId, accountId, input.state),
      dependencies,
    );
    const configuration = {
      issuer: staged.config.providerIssuer,
      clientId: staged.config.providerClientId,
      clientSecret: staged.clientSecret,
      tokenEndpointAuthMethod: staged.config.providerAuthMethod,
      scopes: [...staged.config.providerScopes],
      allowInsecureHttp: dependencies.allowInsecureHttp,
    };
    let identity: { readonly issuer: string; readonly subject: string; readonly email?: string };
    try {
      identity = await dependencies.adapter.exchangeCode({
        configuration,
        redirectUri: dependencies.redirectUri,
        callbackUrl: input.callbackUrl,
        codeVerifier: staged.verifier,
        expectedState: input.state,
        expectedNonce: staged.nonce,
      });
    } catch {
      await markFailed();
      throw new AuthenticationError('auth_provider_unavailable');
    }
    if (identity.issuer !== staged.config.providerIssuer) {
      await markFailed();
      throw new AuthenticationError('auth_transaction_invalid');
    }
    const sessionTokenBytes = dependencies.random.randomBytes(32);
    const csrfTokenBytes = dependencies.digester.deriveCsrfToken(sessionTokenBytes);
    const completed = await dependencies.finalizer.completeProviderSetup(context, {
      transactionId: transaction.id,
      accountId,
      config: staged.config,
      providerClientSecret: staged.clientSecret,
      identitySubject: identity.subject,
      identityEmail: identity.email ?? null,
      sessionTokenDigest: dependencies.digester.digestSessionToken(sessionTokenBytes),
      csrfTokenDigest: dependencies.digester.digest(csrfTokenBytes),
      now: dependencies.clock.now(),
      requestId: input.requestId,
    });
    return {
      sessionToken: toBase64Url(sessionTokenBytes),
      csrfToken: toBase64Url(csrfTokenBytes),
      session: completed.session,
    };
  });
}
