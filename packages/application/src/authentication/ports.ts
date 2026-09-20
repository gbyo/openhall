import type { Temporal } from '@js-temporal/polyfill';
import type { AccountId, OrganizationId, PersonId, TenantId } from '@openhall/domain';
import type { SystemTransactionContext, TenantTransactionContext } from '../persistence.js';

/** At least 256 bits of cryptographically secure randomness per credential. */
export interface SecureRandomSource {
  randomBytes(byteLength: number): Uint8Array;
}

/**
 * One-way digests for high-entropy ephemeral Bearer [REDACTED] (session
 * tokens, CSRF comparison material, OIDC state lookups, browser bindings,
 * operator/recovery tokens): HMAC-SHA-256(APP_SECRET, credential).
 * Canonical input is always the raw credential bytes: base64url transport
 * encodings are decoded back to raw bytes before digesting, on both the
 * creation and verification sides. Rotating APP_SECRET intentionally
 * invalidates outstanding credentials.
 */
export interface CredentialDigester {
  digest(credential: Uint8Array): Uint8Array;
  matches(credential: Uint8Array, expectedDigest: Uint8Array): boolean;
}

/** Plain SHA-256 for PKCE S256 challenges (not a credential digest). */
export interface Sha256Hasher {
  hash(data: Uint8Array): Uint8Array;
}

/** AES-256-GCM sealed secret with a fresh 96-bit nonce per encryption. */
export interface ProtectedSecret {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
  readonly keyId: string;
}

/**
 * Durable encryption for long-lived provider/transaction secrets. The
 * associated-data context binds ciphertext to its intended use; sealed data
 * copied into another context must not decrypt.
 */
export interface SecretProtector {
  readonly keyId: string;
  protect(plaintext: string, context: string): ProtectedSecret;
  reveal(secret: ProtectedSecret, context: string): string;
}

export type AuthenticationMethod = 'oidc' | 'recovery';

export interface SessionRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly accountId: AccountId;
  readonly identityProviderId: string | null;
  readonly tokenDigest: Uint8Array;
  readonly csrfTokenDigest: Uint8Array;
  readonly accountSessionRevision: bigint;
  readonly authenticationMethod: AuthenticationMethod;
  readonly createdAt: Temporal.Instant;
  readonly authenticatedAt: Temporal.Instant;
  readonly lastSeenAt: Temporal.Instant;
  readonly idleExpiresAt: Temporal.Instant;
  readonly absoluteExpiresAt: Temporal.Instant;
  readonly revokedAt: Temporal.Instant | null;
  readonly revocationReason: string | null;
}

export interface NewSession {
  readonly tenantId: TenantId;
  readonly accountId: AccountId;
  readonly identityProviderId: string | null;
  readonly tokenDigest: Uint8Array;
  readonly csrfTokenDigest: Uint8Array;
  readonly accountSessionRevision: bigint;
  readonly authenticationMethod: AuthenticationMethod;
  readonly authenticatedAt: Temporal.Instant;
  readonly idleExpiresAt: Temporal.Instant;
  readonly absoluteExpiresAt: Temporal.Instant;
}

export interface SessionRepository {
  create(context: TenantTransactionContext, input: NewSession): Promise<SessionRecord>;
  /**
   * Rotates the session CSRF token digest. The session endpoint issues a
   * fresh raw CSRF value on every authenticated read, so only digests rest.
   */
  rotateCsrfToken(
    context: TenantTransactionContext,
    sessionId: string,
    csrfTokenDigest: Uint8Array,
  ): Promise<void>;
  touchLastSeen(
    context: TenantTransactionContext,
    sessionId: string,
    lastSeenAt: Temporal.Instant,
  ): Promise<void>;
  revokeSession(
    context: TenantTransactionContext,
    sessionId: string,
    reason: string,
    revokedAt: Temporal.Instant,
  ): Promise<void>;
  revokeAllForAccount(
    context: TenantTransactionContext,
    accountId: AccountId,
    reason: string,
    revokedAt: Temporal.Instant,
  ): Promise<number>;
}

/**
 * The one intentional system-level lookup before tenant context is known:
 * the opaque session Bearer [REDACTED] resolves the session row, which in
 * turn yields the tenant. Everything after this point is tenant-scoped.
 */
export interface SessionCredentialLookup {
  findByTokenDigest(tokenDigest: Uint8Array): Promise<SessionRecord | undefined>;
}

export type AccountStatus = 'active' | 'locked' | 'disabled';
export type PersonStatus = 'active' | 'inactive' | 'archived';
export type TenantStatus = 'active' | 'suspended' | 'archived';

export interface AccountRecord {
  readonly id: AccountId;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly status: AccountStatus;
  readonly sessionRevision: bigint;
}

export interface PersonRecord {
  readonly id: PersonId;
  readonly tenantId: TenantId;
  readonly givenName: string;
  readonly familyName: string;
  readonly displayName: string;
  readonly status: PersonStatus;
}

export interface TenantRecord {
  readonly id: TenantId;
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
}

export interface AuthIdentityRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly accountId: AccountId;
  readonly issuer: string;
  readonly providerSubject: string;
  readonly emailSnapshot: string | null;
}

export type IdentityProviderStatus = 'active' | 'disabled';

export interface IdentityProviderRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly key: string;
  readonly displayName: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: ProtectedSecret;
  readonly tokenEndpointAuthMethod: 'client_secret_post' | 'client_secret_basic';
  readonly scopes: readonly string[];
  readonly status: IdentityProviderStatus;
  readonly revision: number;
}

export interface IdentityDirectory {
  findIdentity(
    context: TenantTransactionContext,
    issuer: string,
    providerSubject: string,
  ): Promise<AuthIdentityRecord | undefined>;
  findAccount(
    context: TenantTransactionContext,
    accountId: AccountId,
  ): Promise<AccountRecord | undefined>;
  findPerson(
    context: TenantTransactionContext,
    personId: PersonId,
  ): Promise<PersonRecord | undefined>;
  findTenant(
    context: TenantTransactionContext,
    tenantId: TenantId,
  ): Promise<TenantRecord | undefined>;
  findProvider(
    context: TenantTransactionContext,
    providerId: string,
  ): Promise<IdentityProviderRecord | undefined>;
  findProviderByKey(
    context: TenantTransactionContext,
    providerKey: string,
  ): Promise<IdentityProviderRecord | undefined>;
  listActiveProviders(
    context: TenantTransactionContext,
  ): Promise<readonly IdentityProviderRecord[]>;
  createIdentity(
    context: TenantTransactionContext,
    input: {
      readonly accountId: AccountId;
      readonly issuer: string;
      readonly providerSubject: string;
      readonly emailSnapshot: string | null;
    },
  ): Promise<AuthIdentityRecord>;
  updateIdentityEmailSnapshot(
    context: TenantTransactionContext,
    identityId: string,
    emailSnapshot: string | null,
  ): Promise<void>;
  incrementSessionRevision(
    context: TenantTransactionContext,
    accountId: AccountId,
  ): Promise<bigint>;
  hasActiveSystemAdminGrant(
    context: TenantTransactionContext,
    accountId: AccountId,
    now: Temporal.Instant,
  ): Promise<boolean>;
}

/** Tenant lookups that are valid before authentication (discovery/status). */
export interface TenantDirectory {
  findById(tenantId: TenantId): Promise<TenantRecord | undefined>;
  findBySlug(slug: string): Promise<TenantRecord | undefined>;
  listForDiscovery(): Promise<readonly TenantRecord[]>;
  countCanonical(): Promise<number>;
}

export type OidcTransactionPurpose = 'login' | 'bootstrap';
export type OidcTransactionStatus = 'pending' | 'processing' | 'consumed' | 'failed';

export interface OidcTransactionRecord {
  readonly id: string;
  readonly tenantId: TenantId | null;
  readonly identityProviderId: string | null;
  readonly bootstrapSetupId: string | null;
  readonly purpose: OidcTransactionPurpose;
  readonly providerRevision: number | null;
  readonly stateDigest: Uint8Array;
  readonly browserBindingDigest: Uint8Array;
  readonly transactionSecret: ProtectedSecret;
  readonly returnPath: string;
  readonly status: OidcTransactionStatus;
  readonly createdAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
}

export interface OidcTransactionStore {
  create(
    context: TenantTransactionContext | SystemTransactionContext,
    input: {
      readonly tenantId: TenantId | null;
      readonly identityProviderId: string | null;
      readonly bootstrapSetupId: string | null;
      readonly purpose: OidcTransactionPurpose;
      readonly providerRevision: number | null;
      readonly stateDigest: Uint8Array;
      readonly browserBindingDigest: Uint8Array;
      readonly transactionSecret: ProtectedSecret;
      readonly returnPath: string;
      readonly expiresAt: Temporal.Instant;
    },
  ): Promise<OidcTransactionRecord>;
  /**
   * System-level lookup by state digest followed by an atomic
   * pending → processing claim. Returns null unless exactly one live
   * transaction is claimed by this call, so replays cannot double-claim.
   */
  claimByStateDigest(
    stateDigest: Uint8Array,
    now: Temporal.Instant,
  ): Promise<OidcTransactionRecord | undefined>;
  /**
   * Non-consuming lookup by state digest so the shared OIDC callback can
   * dispatch login vs bootstrap completions. Returns the latest matching
   * transaction regardless of status; the completing use case still
   * enforces the atomic pending → processing claim, so replays fail.
   */
  peekByStateDigest(stateDigest: Uint8Array): Promise<OidcTransactionRecord | undefined>;
  markFailed(transactionId: string, now: Temporal.Instant): Promise<void>;
  consume(transactionId: string, now: Temporal.Instant): Promise<void>;
}

/** External identity verified by the OIDC adapter. Email is metadata only. */
export interface VerifiedExternalIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
}

export interface OidcProviderConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenEndpointAuthMethod: 'client_secret_post' | 'client_secret_basic';
  readonly scopes: readonly string[];
  /** HTTP issuers are allowed only for explicitly local development/test. */
  readonly allowInsecureHttp: boolean;
}

/**
 * Infrastructure OIDC protocol adapter (openid-client). Application code
 * defines this port; openid-client types must not cross it.
 */
export interface OidcProtocolAdapter {
  /**
   * Runs discovery and enforces the security baseline (S256 PKCE support,
   * required endpoints, client authentication). Throws
   * provider_configuration_unsupported when the server cannot meet it.
   */
  validateProviderConfiguration(configuration: OidcProviderConfiguration): Promise<void>;
  /**
   * Discovers the exact configured provider, enforces the baseline, and
   * builds the authorization URL. Async so discovery stays in the network
   * phase and never relies on cached metadata.
   */
  buildAuthorizationUrl(input: {
    readonly configuration: OidcProviderConfiguration;
    readonly redirectUri: string;
    readonly state: string;
    readonly nonce: string;
    readonly codeChallenge: string;
    readonly maxAge?: number;
  }): Promise<string>;
  /**
   * Exchanges the authorization code and validates issuer, nonce, PKCE, and
   * the ID Token. Never determines the provider from callback parameters;
   * the caller binds the transaction to its exact configured provider first.
   */
  exchangeCode(input: {
    readonly configuration: OidcProviderConfiguration;
    readonly redirectUri: string;
    readonly callbackUrl: string;
    readonly codeVerifier: string;
    readonly expectedState: string;
    readonly expectedNonce: string;
  }): Promise<VerifiedExternalIdentity>;
}

export type AuditOutcome = 'success' | 'denied' | 'failure';

export interface AuditEventInput {
  readonly action: string;
  readonly actorKind: 'account' | 'integration' | 'system';
  readonly actorId?: string;
  readonly organizationId?: OrganizationId;
  readonly targetKind: string;
  readonly targetId?: string;
  readonly outcome: AuditOutcome;
  readonly occurredAt: Temporal.Instant;
  readonly requestId: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface AuditWriter {
  append(context: TenantTransactionContext, event: AuditEventInput): Promise<void>;
}

export type OperatorGrantPurpose = 'bootstrap' | 'recovery';

export interface OperatorGrantRecord {
  readonly id: string;
  readonly purpose: OperatorGrantPurpose;
  readonly tenantId: TenantId | null;
  readonly accountId: AccountId | null;
  readonly createdAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
  readonly consumedAt: Temporal.Instant | null;
  readonly revokedAt: Temporal.Instant | null;
}

export interface OperatorGrantStore {
  create(
    context: SystemTransactionContext,
    input: {
      readonly purpose: OperatorGrantPurpose;
      readonly tenantId: TenantId | null;
      readonly accountId: AccountId | null;
      readonly tokenDigest: Uint8Array;
      readonly expiresAt: Temporal.Instant;
    },
  ): Promise<OperatorGrantRecord>;
  /**
   * Returns the live grant matching the token digest without consuming it,
   * so a bootstrap grant can retry its setup flow until expiration.
   */
  findValidByTokenDigest(
    tokenDigest: Uint8Array,
    now: Temporal.Instant,
  ): Promise<OperatorGrantRecord | undefined>;
  /**
   * Atomically consumes one live grant matching the token digest. One-time:
   * a second call with the same token finds nothing.
   */
  consumeByTokenDigest(
    tokenDigest: Uint8Array,
    now: Temporal.Instant,
  ): Promise<OperatorGrantRecord | undefined>;
  /** Atomically consumes one live grant by id (bootstrap finalization). */
  consumeById(grantId: string, now: Temporal.Instant): Promise<OperatorGrantRecord | undefined>;
}

export interface BootstrapDraftInput {
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
  readonly providerSecret: ProtectedSecret;
  readonly providerAuthMethod: 'client_secret_post' | 'client_secret_basic';
  readonly providerScopes: readonly string[];
  readonly expiresAt: Temporal.Instant;
}

export interface BootstrapSetupRecord extends BootstrapDraftInput {
  readonly id: string;
  readonly operatorGrantId: string;
  readonly createdAt: Temporal.Instant;
  readonly completedAt: Temporal.Instant | null;
}

export interface BootstrapRepository {
  findByGrantId(
    context: SystemTransactionContext,
    grantId: string,
  ): Promise<BootstrapSetupRecord | undefined>;
  findBySetupId(
    context: SystemTransactionContext,
    setupId: string,
  ): Promise<BootstrapSetupRecord | undefined>;
  createDraft(
    context: SystemTransactionContext,
    grantId: string,
    input: BootstrapDraftInput,
  ): Promise<BootstrapSetupRecord>;
  updateDraft(
    context: SystemTransactionContext,
    setupId: string,
    input: BootstrapDraftInput,
  ): Promise<BootstrapSetupRecord>;
}

export interface BootstrapInstallation {
  readonly tenant: TenantRecord;
  readonly accountId: AccountId;
  readonly personId: PersonId;
  readonly session: SessionRecord;
}

export interface BootstrapFinalizer {
  /**
   * Atomically creates tenant, school, admin person/account, staff
   * membership, tenant-scoped system_admin grant, identity provider,
   * auth identity, session, audit events, bootstrap completion, and both
   * consumptions — or rolls back everything. Takes an advisory lock and
   * re-checks that no canonical tenant exists after acquiring it.
   */
  finalize(
    context: SystemTransactionContext,
    input: {
      readonly setupId: string;
      readonly transactionId: string;
      readonly identity: VerifiedExternalIdentity;
      /** Revealed draft client secret, re-encrypted for the provider row. */
      readonly providerClientSecret: string;
      readonly sessionTokenDigest: Uint8Array;
      readonly csrfTokenDigest: Uint8Array;
      readonly now: Temporal.Instant;
      readonly requestId: string;
    },
  ): Promise<BootstrapInstallation>;
}

/** Minimal account checks needed before a recovery grant may be issued. */
export interface RecoveryEligibilityChecker {
  checkRecoveryEligible(
    context: SystemTransactionContext,
    tenantId: string,
    accountId: string,
  ): Promise<boolean>;
}
