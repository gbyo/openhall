import { Temporal } from '@js-temporal/polyfill';
import {
  AuthenticationError,
  type AccountRecord,
  type AuditEventInput,
  type AuditWriter,
  type AuthIdentityRecord,
  type BootstrapDraftInput,
  type BootstrapFinalizer,
  type BootstrapInstallation,
  type BootstrapRepository,
  type BootstrapSetupRecord,
  type IdentityDirectory,
  type IdentityProviderRecord,
  type NewSession,
  type OidcTransactionRecord,
  type OidcTransactionStore,
  type OperatorGrantRecord,
  type OperatorGrantStore,
  type PersonRecord,
  type ProtectedSecret,
  type RecoveryEligibilityChecker,
  type SecretProtector,
  type SessionCredentialLookup,
  type SessionRecord,
  type SessionRepository,
  type TenantDirectory,
  type TenantRecord,
  type TenantTransactionContext,
  type SystemTransactionContext,
} from '@openhall/application';
import type { AccountId } from '@openhall/domain';
import { sql, type Kysely } from 'kysely';
import type { DB as Database } from '../database.generated.js';
import {
  connectionFor,
  fromDatabaseInstant,
  toBigInt,
  toDatabaseBytes,
  toDatabaseInstant,
} from '../transactions.js';

function bytes(value: Buffer): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function secretFrom(
  ciphertext: Buffer,
  nonce: Buffer,
  tag: Buffer,
  keyId: string,
): ProtectedSecret {
  return { ciphertext: bytes(ciphertext), nonce: bytes(nonce), tag: bytes(tag), keyId };
}

function mapSession(row: {
  id: string;
  tenant_id: string;
  account_id: string;
  identity_provider_id: string | null;
  token_hash: Buffer;
  csrf_token_hash: Buffer;
  account_session_revision: string | bigint | number;
  authentication_method: string;
  created_at: string;
  authenticated_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
}): SessionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    identityProviderId: row.identity_provider_id,
    tokenDigest: bytes(row.token_hash),
    csrfTokenDigest: bytes(row.csrf_token_hash),
    accountSessionRevision: toBigInt(row.account_session_revision),
    authenticationMethod: row.authentication_method === 'recovery' ? 'recovery' : 'oidc',
    createdAt: fromDatabaseInstant(row.created_at),
    authenticatedAt: fromDatabaseInstant(row.authenticated_at),
    lastSeenAt: fromDatabaseInstant(row.last_seen_at),
    idleExpiresAt: fromDatabaseInstant(row.idle_expires_at),
    absoluteExpiresAt: fromDatabaseInstant(row.absolute_expires_at),
    revokedAt: row.revoked_at === null ? null : fromDatabaseInstant(row.revoked_at),
    revocationReason: row.revocation_reason,
  };
}

function mapProvider(row: {
  id: string;
  tenant_id: string;
  key: string;
  display_name: string;
  issuer: string;
  client_id: string;
  client_secret_ciphertext: Buffer;
  client_secret_nonce: Buffer;
  client_secret_tag: Buffer;
  client_secret_key_id: string;
  token_endpoint_auth_method: string;
  scopes: string[];
  status: string;
  revision: number;
}): IdentityProviderRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    key: row.key,
    displayName: row.display_name,
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecret: secretFrom(
      row.client_secret_ciphertext,
      row.client_secret_nonce,
      row.client_secret_tag,
      row.client_secret_key_id,
    ),
    tokenEndpointAuthMethod:
      row.token_endpoint_auth_method === 'client_secret_basic'
        ? 'client_secret_basic'
        : 'client_secret_post',
    scopes: row.scopes,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    revision: row.revision,
  };
}

function mapTransaction(row: {
  id: string;
  tenant_id: string | null;
  identity_provider_id: string | null;
  bootstrap_setup_id: string | null;
  purpose: string;
  provider_revision: number | null;
  state_hash: Buffer;
  browser_binding_hash: Buffer;
  transaction_secret_ciphertext: Buffer;
  transaction_secret_nonce: Buffer;
  transaction_secret_tag: Buffer;
  transaction_secret_key_id: string;
  return_path: string;
  status: string;
  created_at: string;
  expires_at: string;
}): OidcTransactionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    identityProviderId: row.identity_provider_id,
    bootstrapSetupId: row.bootstrap_setup_id,
    purpose: row.purpose === 'bootstrap' ? 'bootstrap' : 'login',
    providerRevision: row.provider_revision,
    stateDigest: bytes(row.state_hash),
    browserBindingDigest: bytes(row.browser_binding_hash),
    transactionSecret: secretFrom(
      row.transaction_secret_ciphertext,
      row.transaction_secret_nonce,
      row.transaction_secret_tag,
      row.transaction_secret_key_id,
    ),
    returnPath: row.return_path,
    status:
      row.status === 'processing'
        ? 'processing'
        : row.status === 'consumed'
          ? 'consumed'
          : row.status === 'failed'
            ? 'failed'
            : 'pending',
    createdAt: fromDatabaseInstant(row.created_at),
    expiresAt: fromDatabaseInstant(row.expires_at),
  };
}

function mapGrant(row: {
  id: string;
  purpose: string;
  tenant_id: string | null;
  account_id: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}): OperatorGrantRecord {
  return {
    id: row.id,
    purpose: row.purpose === 'recovery' ? 'recovery' : 'bootstrap',
    tenantId: row.tenant_id,
    accountId: row.account_id,
    createdAt: fromDatabaseInstant(row.created_at),
    expiresAt: fromDatabaseInstant(row.expires_at),
    consumedAt: row.consumed_at === null ? null : fromDatabaseInstant(row.consumed_at),
    revokedAt: row.revoked_at === null ? null : fromDatabaseInstant(row.revoked_at),
  };
}

function mapSetup(row: {
  id: string;
  operator_grant_id: string;
  tenant_name: string;
  tenant_slug: string;
  school_name: string;
  school_slug: string;
  school_time_zone: string;
  admin_given_name: string;
  admin_family_name: string;
  admin_display_name: string;
  provider_key: string;
  provider_display_name: string;
  provider_issuer: string;
  provider_client_id: string;
  provider_secret_ciphertext: Buffer;
  provider_secret_nonce: Buffer;
  provider_secret_tag: Buffer;
  provider_secret_key_id: string;
  provider_auth_method: string;
  provider_scopes: string[];
  created_at: string;
  expires_at: string;
  completed_at: string | null;
}): BootstrapSetupRecord {
  return {
    id: row.id,
    operatorGrantId: row.operator_grant_id,
    tenantName: row.tenant_name,
    tenantSlug: row.tenant_slug,
    schoolName: row.school_name,
    schoolSlug: row.school_slug,
    schoolTimeZone: row.school_time_zone,
    adminGivenName: row.admin_given_name,
    adminFamilyName: row.admin_family_name,
    adminDisplayName: row.admin_display_name,
    providerKey: row.provider_key,
    providerDisplayName: row.provider_display_name,
    providerIssuer: row.provider_issuer,
    providerClientId: row.provider_client_id,
    providerSecret: secretFrom(
      row.provider_secret_ciphertext,
      row.provider_secret_nonce,
      row.provider_secret_tag,
      row.provider_secret_key_id,
    ),
    providerAuthMethod:
      row.provider_auth_method === 'client_secret_basic'
        ? 'client_secret_basic'
        : 'client_secret_post',
    providerScopes: row.provider_scopes,
    expiresAt: fromDatabaseInstant(row.expires_at),
    createdAt: fromDatabaseInstant(row.created_at),
    completedAt: row.completed_at === null ? null : fromDatabaseInstant(row.completed_at),
  };
}

function mapTenant(row: { id: string; slug: string; name: string; status: string }): TenantRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status:
      row.status === 'suspended' ? 'suspended' : row.status === 'archived' ? 'archived' : 'active',
  };
}

export class PostgresSessionRepository implements SessionRepository {
  async create(context: TenantTransactionContext, input: NewSession): Promise<SessionRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('auth_session')
      .values({
        tenant_id: input.tenantId,
        account_id: input.accountId,
        identity_provider_id: input.identityProviderId,
        token_hash: toDatabaseBytes(input.tokenDigest),
        csrf_token_hash: toDatabaseBytes(input.csrfTokenDigest),
        account_session_revision: input.accountSessionRevision,
        authentication_method: input.authenticationMethod,
        authenticated_at: toDatabaseInstant(input.authenticatedAt),
        idle_expires_at: toDatabaseInstant(input.idleExpiresAt),
        absolute_expires_at: toDatabaseInstant(input.absoluteExpiresAt),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapSession(row);
  }

  async touchLastSeen(
    context: TenantTransactionContext,
    sessionId: string,
    lastSeenAt: Temporal.Instant,
  ): Promise<void> {
    const connection = connectionFor(context);
    await connection
      .updateTable('auth_session')
      .set({ last_seen_at: toDatabaseInstant(lastSeenAt) })
      .where('id', '=', sessionId)
      .where('tenant_id', '=', context.tenantId)
      .execute();
  }

  async revokeSession(
    context: TenantTransactionContext,
    sessionId: string,
    reason: string,
    revokedAt: Temporal.Instant,
  ): Promise<void> {
    const connection = connectionFor(context);
    await connection
      .updateTable('auth_session')
      .set({ revoked_at: toDatabaseInstant(revokedAt), revocation_reason: reason })
      .where('id', '=', sessionId)
      .where('tenant_id', '=', context.tenantId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  async revokeAllForAccount(
    context: TenantTransactionContext,
    accountId: AccountId,
    reason: string,
    revokedAt: Temporal.Instant,
  ): Promise<number> {
    const connection = connectionFor(context);
    const result = await connection
      .updateTable('auth_session')
      .set({ revoked_at: toDatabaseInstant(revokedAt), revocation_reason: reason })
      .where('tenant_id', '=', context.tenantId)
      .where('account_id', '=', accountId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }
}

/**
 * Intentional system-level lookup: the opaque Bearer [REDACTED] is resolved
 * before tenant context is known. The row yields the tenant; everything
 * downstream is tenant-scoped.
 */
export class PostgresSessionCredentialLookup implements SessionCredentialLookup {
  constructor(private readonly database: Kysely<Database>) {}

  async findByTokenDigest(tokenDigest: Uint8Array): Promise<SessionRecord | undefined> {
    const row = await this.database
      .selectFrom('auth_session')
      .selectAll()
      .where('token_hash', '=', toDatabaseBytes(tokenDigest))
      .executeTakeFirst();
    return row === undefined ? undefined : mapSession(row);
  }
}

export class PostgresIdentityDirectory implements IdentityDirectory {
  async findIdentity(
    context: TenantTransactionContext,
    issuer: string,
    providerSubject: string,
  ): Promise<AuthIdentityRecord | undefined> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('auth_identity')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('issuer', '=', issuer)
      .where('provider_subject', '=', providerSubject)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          id: row.id,
          tenantId: row.tenant_id,
          accountId: row.account_id,
          issuer: row.issuer,
          providerSubject: row.provider_subject,
          emailSnapshot: row.email_snapshot,
        };
  }

  async findAccount(
    context: TenantTransactionContext,
    accountId: AccountId,
  ): Promise<AccountRecord | undefined> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('account')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', accountId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          id: row.id,
          tenantId: row.tenant_id,
          personId: row.person_id,
          status:
            row.status === 'locked' ? 'locked' : row.status === 'disabled' ? 'disabled' : 'active',
          sessionRevision: toBigInt(row.session_revision),
        };
  }

  async findPerson(
    context: TenantTransactionContext,
    personId: string,
  ): Promise<PersonRecord | undefined> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('person')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', personId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          id: row.id,
          tenantId: row.tenant_id,
          givenName: row.given_name,
          familyName: row.family_name,
          displayName: row.display_name,
          status:
            row.status === 'inactive'
              ? 'inactive'
              : row.status === 'archived'
                ? 'archived'
                : 'active',
        };
  }

  async findTenant(
    context: TenantTransactionContext,
    tenantId: string,
  ): Promise<TenantRecord | undefined> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('tenant')
      .selectAll()
      .where('id', '=', tenantId)
      .executeTakeFirst();
    return row === undefined ? undefined : mapTenant(row);
  }

  async findProvider(
    context: TenantTransactionContext,
    providerId: string,
  ): Promise<IdentityProviderRecord | undefined> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('identity_provider')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', providerId)
      .executeTakeFirst();
    return row === undefined ? undefined : mapProvider(row);
  }

  async findProviderByKey(
    context: TenantTransactionContext,
    providerKey: string,
  ): Promise<IdentityProviderRecord | undefined> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('identity_provider')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('key', '=', providerKey)
      .executeTakeFirst();
    return row === undefined ? undefined : mapProvider(row);
  }

  async listActiveProviders(
    context: TenantTransactionContext,
  ): Promise<readonly IdentityProviderRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('identity_provider')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('status', '=', 'active')
      .orderBy('key')
      .execute();
    return rows.map(mapProvider);
  }

  async createIdentity(
    context: TenantTransactionContext,
    input: {
      readonly accountId: AccountId;
      readonly issuer: string;
      readonly providerSubject: string;
      readonly emailSnapshot: string | null;
    },
  ): Promise<AuthIdentityRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('auth_identity')
      .values({
        tenant_id: context.tenantId,
        account_id: input.accountId,
        issuer: input.issuer,
        provider_subject: input.providerSubject,
        email_snapshot: input.emailSnapshot,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      tenantId: row.tenant_id,
      accountId: row.account_id,
      issuer: row.issuer,
      providerSubject: row.provider_subject,
      emailSnapshot: row.email_snapshot,
    };
  }

  async updateIdentityEmailSnapshot(
    context: TenantTransactionContext,
    identityId: string,
    emailSnapshot: string | null,
  ): Promise<void> {
    const connection = connectionFor(context);
    await connection
      .updateTable('auth_identity')
      .set({ email_snapshot: emailSnapshot })
      .where('id', '=', identityId)
      .where('tenant_id', '=', context.tenantId)
      .execute();
  }

  async incrementSessionRevision(
    context: TenantTransactionContext,
    accountId: AccountId,
  ): Promise<bigint> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('account')
      .set({ session_revision: sql`session_revision + 1` })
      .where('id', '=', accountId)
      .where('tenant_id', '=', context.tenantId)
      .returning('session_revision')
      .executeTakeFirstOrThrow();
    return toBigInt(row.session_revision);
  }

  async hasActiveSystemAdminGrant(
    context: TenantTransactionContext,
    accountId: AccountId,
    now: Temporal.Instant,
  ): Promise<boolean> {
    const connection = connectionFor(context);
    const instant = toDatabaseInstant(now);
    const row = await connection
      .selectFrom('authorization_grant')
      .select('id')
      .where('tenant_id', '=', context.tenantId)
      .where('account_id', '=', accountId)
      .where('role', '=', 'system_admin')
      .where('scope_kind', '=', 'tenant')
      .where('status', '=', 'active')
      .where((builder) =>
        builder.or([builder('valid_from', 'is', null), builder('valid_from', '<=', instant)]),
      )
      .where((builder) =>
        builder.or([builder('valid_until', 'is', null), builder('valid_until', '>', instant)]),
      )
      .executeTakeFirst();
    return row !== undefined;
  }
}

export class PostgresTenantDirectory implements TenantDirectory {
  constructor(private readonly database: Kysely<Database>) {}

  async findById(tenantId: string): Promise<TenantRecord | undefined> {
    const row = await this.database
      .selectFrom('tenant')
      .selectAll()
      .where('id', '=', tenantId)
      .executeTakeFirst();
    return row === undefined ? undefined : mapTenant(row);
  }

  async findBySlug(slug: string): Promise<TenantRecord | undefined> {
    const row = await this.database
      .selectFrom('tenant')
      .selectAll()
      .where('slug', '=', slug)
      .executeTakeFirst();
    return row === undefined ? undefined : mapTenant(row);
  }

  async listForDiscovery(): Promise<readonly TenantRecord[]> {
    const rows = await this.database
      .selectFrom('tenant')
      .selectAll()
      .where('status', '=', 'active')
      .orderBy('name')
      .execute();
    return rows.map(mapTenant);
  }

  async countCanonical(): Promise<number> {
    const row = await this.database
      .selectFrom('tenant')
      .select((builder) => builder.fn.countAll().as('count'))
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }
}

export class PostgresOidcTransactionStore implements OidcTransactionStore {
  constructor(private readonly database: Kysely<Database>) {}

  async create(
    context: TenantTransactionContext | SystemTransactionContext,
    input: {
      readonly tenantId: string | null;
      readonly identityProviderId: string | null;
      readonly bootstrapSetupId: string | null;
      readonly purpose: 'login' | 'bootstrap';
      readonly providerRevision: number | null;
      readonly stateDigest: Uint8Array;
      readonly browserBindingDigest: Uint8Array;
      readonly transactionSecret: ProtectedSecret;
      readonly returnPath: string;
      readonly expiresAt: Temporal.Instant;
    },
  ): Promise<OidcTransactionRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('oidc_login_transaction')
      .values({
        tenant_id: input.tenantId,
        identity_provider_id: input.identityProviderId,
        bootstrap_setup_id: input.bootstrapSetupId,
        purpose: input.purpose,
        provider_revision: input.providerRevision,
        state_hash: toDatabaseBytes(input.stateDigest),
        browser_binding_hash: toDatabaseBytes(input.browserBindingDigest),
        transaction_secret_ciphertext: toDatabaseBytes(input.transactionSecret.ciphertext),
        transaction_secret_nonce: toDatabaseBytes(input.transactionSecret.nonce),
        transaction_secret_tag: toDatabaseBytes(input.transactionSecret.tag),
        transaction_secret_key_id: input.transactionSecret.keyId,
        return_path: input.returnPath,
        expires_at: toDatabaseInstant(input.expiresAt),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapTransaction(row);
  }

  async claimByStateDigest(
    stateDigest: Uint8Array,
    // Reserved for OidcTransactionStore conformance: expiry is enforced by
    // the completing use case so expired transactions stay distinguishable.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _now: Temporal.Instant,
  ): Promise<OidcTransactionRecord | undefined> {
    const result = await sql`
      UPDATE oidc_login_transaction
      SET status = 'processing', processing_started_at = statement_timestamp()
      WHERE id = (
        SELECT id FROM oidc_login_transaction
        WHERE state_hash = ${toDatabaseBytes(stateDigest)} AND status = 'pending'
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        id, tenant_id, identity_provider_id, bootstrap_setup_id, purpose,
        provider_revision, state_hash, browser_binding_hash,
        transaction_secret_ciphertext, transaction_secret_nonce,
        transaction_secret_tag, transaction_secret_key_id,
        return_path, status, created_at, expires_at
    `.execute(this.database);
    const row = result.rows[0] as OidcTransactionStoreRow | undefined;
    return row === undefined ? undefined : mapTransaction(row);
  }

  async peekByStateDigest(stateDigest: Uint8Array): Promise<OidcTransactionRecord | undefined> {
    const row = await this.database
      .selectFrom('oidc_login_transaction')
      .selectAll()
      .where('state_hash', '=', toDatabaseBytes(stateDigest))
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    return row === undefined ? undefined : mapTransaction(row);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async markFailed(transactionId: string, _now: Temporal.Instant): Promise<void> {
    await this.database
      .updateTable('oidc_login_transaction')
      .set({ status: 'failed' })
      .where('id', '=', transactionId)
      .where('status', 'in', ['pending', 'processing'])
      .execute();
  }

  async consume(transactionId: string, now: Temporal.Instant): Promise<void> {
    await this.database
      .updateTable('oidc_login_transaction')
      .set({ status: 'consumed', consumed_at: toDatabaseInstant(now) })
      .where('id', '=', transactionId)
      .where('status', '=', 'processing')
      .execute();
  }
}

interface OidcTransactionStoreRow {
  id: string;
  tenant_id: string | null;
  identity_provider_id: string | null;
  bootstrap_setup_id: string | null;
  purpose: string;
  provider_revision: number | null;
  state_hash: Buffer;
  browser_binding_hash: Buffer;
  transaction_secret_ciphertext: Buffer;
  transaction_secret_nonce: Buffer;
  transaction_secret_tag: Buffer;
  transaction_secret_key_id: string;
  return_path: string;
  status: string;
  created_at: string;
  expires_at: string;
}

export class PostgresOperatorGrantStore implements OperatorGrantStore {
  constructor(private readonly database: Kysely<Database>) {}

  async create(
    context: SystemTransactionContext,
    input: {
      readonly purpose: 'bootstrap' | 'recovery';
      readonly tenantId: string | null;
      readonly accountId: string | null;
      readonly tokenDigest: Uint8Array;
      readonly expiresAt: Temporal.Instant;
    },
  ): Promise<OperatorGrantRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('local_operator_grant')
      .values({
        purpose: input.purpose,
        tenant_id: input.tenantId,
        account_id: input.accountId,
        token_hash: toDatabaseBytes(input.tokenDigest),
        expires_at: toDatabaseInstant(input.expiresAt),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapGrant(row);
  }

  async findValidByTokenDigest(
    tokenDigest: Uint8Array,
    now: Temporal.Instant,
  ): Promise<OperatorGrantRecord | undefined> {
    const row = await this.database
      .selectFrom('local_operator_grant')
      .selectAll()
      .where('token_hash', '=', toDatabaseBytes(tokenDigest))
      .where('consumed_at', 'is', null)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', toDatabaseInstant(now))
      .executeTakeFirst();
    return row === undefined ? undefined : mapGrant(row);
  }

  async consumeByTokenDigest(
    tokenDigest: Uint8Array,
    now: Temporal.Instant,
  ): Promise<OperatorGrantRecord | undefined> {
    const result = await sql`
      UPDATE local_operator_grant
      SET consumed_at = statement_timestamp()
      WHERE token_hash = ${toDatabaseBytes(tokenDigest)}
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ${toDatabaseInstant(now)}
      RETURNING id, purpose, tenant_id, account_id, created_at, expires_at, consumed_at, revoked_at
    `.execute(this.database);
    const row = result.rows[0] as OperatorGrantRow | undefined;
    return row === undefined ? undefined : mapGrant(row);
  }

  async consumeById(
    grantId: string,
    now: Temporal.Instant,
  ): Promise<OperatorGrantRecord | undefined> {
    const result = await sql`
      UPDATE local_operator_grant
      SET consumed_at = statement_timestamp()
      WHERE id = ${grantId}::uuid
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ${toDatabaseInstant(now)}
      RETURNING id, purpose, tenant_id, account_id, created_at, expires_at, consumed_at, revoked_at
    `.execute(this.database);
    const row = result.rows[0] as OperatorGrantRow | undefined;
    return row === undefined ? undefined : mapGrant(row);
  }
}

interface OperatorGrantRow {
  id: string;
  purpose: string;
  tenant_id: string | null;
  account_id: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

export class PostgresBootstrapRepository implements BootstrapRepository {
  async findByGrantId(
    context: SystemTransactionContext,
    grantId: string,
  ): Promise<BootstrapSetupRecord | undefined> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('bootstrap_setup')
      .selectAll()
      .where('operator_grant_id', '=', grantId)
      .executeTakeFirst();
    return row === undefined ? undefined : mapSetup(row);
  }

  async findBySetupId(
    context: SystemTransactionContext,
    setupId: string,
  ): Promise<BootstrapSetupRecord | undefined> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('bootstrap_setup')
      .selectAll()
      .where('id', '=', setupId)
      .executeTakeFirst();
    return row === undefined ? undefined : mapSetup(row);
  }

  async createDraft(
    context: SystemTransactionContext,
    grantId: string,
    input: BootstrapDraftInput,
  ): Promise<BootstrapSetupRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('bootstrap_setup')
      .values({ operator_grant_id: grantId, ...draftValues(input) })
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapSetup(row);
  }

  async updateDraft(
    context: SystemTransactionContext,
    setupId: string,
    input: BootstrapDraftInput,
  ): Promise<BootstrapSetupRecord> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('bootstrap_setup')
      .set(draftValues(input))
      .where('id', '=', setupId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapSetup(row);
  }
}

function draftValues(input: BootstrapDraftInput): {
  tenant_name: string;
  tenant_slug: string;
  school_name: string;
  school_slug: string;
  school_time_zone: string;
  admin_given_name: string;
  admin_family_name: string;
  admin_display_name: string;
  provider_key: string;
  provider_display_name: string;
  provider_issuer: string;
  provider_client_id: string;
  provider_secret_ciphertext: Buffer;
  provider_secret_nonce: Buffer;
  provider_secret_tag: Buffer;
  provider_secret_key_id: string;
  provider_auth_method: string;
  provider_scopes: string[];
  expires_at: string;
} {
  return {
    tenant_name: input.tenantName,
    tenant_slug: input.tenantSlug,
    school_name: input.schoolName,
    school_slug: input.schoolSlug,
    school_time_zone: input.schoolTimeZone,
    admin_given_name: input.adminGivenName,
    admin_family_name: input.adminFamilyName,
    admin_display_name: input.adminDisplayName,
    provider_key: input.providerKey,
    provider_display_name: input.providerDisplayName,
    provider_issuer: input.providerIssuer,
    provider_client_id: input.providerClientId,
    provider_secret_ciphertext: toDatabaseBytes(input.providerSecret.ciphertext),
    provider_secret_nonce: toDatabaseBytes(input.providerSecret.nonce),
    provider_secret_tag: toDatabaseBytes(input.providerSecret.tag),
    provider_secret_key_id: input.providerSecret.keyId,
    provider_auth_method: input.providerAuthMethod,
    provider_scopes: [...input.providerScopes],
    expires_at: toDatabaseInstant(input.expiresAt),
  };
}

export class PostgresAuditWriter implements AuditWriter {
  async append(context: TenantTransactionContext, event: AuditEventInput): Promise<void> {
    const connection = connectionFor(context);
    await connection
      .insertInto('audit_event')
      .values({
        tenant_id: context.tenantId,
        organization_id: event.organizationId ?? null,
        actor_kind: event.actorKind,
        actor_id: event.actorId ?? null,
        action: event.action,
        target_kind: event.targetKind,
        target_id: event.targetId ?? null,
        outcome: event.outcome,
        occurred_at: toDatabaseInstant(event.occurredAt),
        request_id: event.requestId,
        metadata: { ...(event.metadata ?? {}) },
      })
      .execute();
  }
}

export class PostgresRecoveryEligibilityChecker implements RecoveryEligibilityChecker {
  async checkRecoveryEligible(
    context: SystemTransactionContext,
    tenantId: string,
    accountId: string,
  ): Promise<boolean> {
    const connection = connectionFor(context);
    const instant = toDatabaseInstant(Temporal.Now.instant());
    const tenant = await connection
      .selectFrom('tenant')
      .select(['id', 'status'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (tenant?.status !== 'active') {
      return false;
    }
    const account = await connection
      .selectFrom('account')
      .select(['id', 'person_id', 'status'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (account?.status !== 'active') {
      return false;
    }
    const person = await connection
      .selectFrom('person')
      .select(['id', 'status'])
      .where('tenant_id', '=', tenantId)
      .where('id', '=', account.person_id)
      .executeTakeFirst();
    if (person?.status !== 'active') {
      return false;
    }
    const grant = await connection
      .selectFrom('authorization_grant')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('account_id', '=', accountId)
      .where('role', '=', 'system_admin')
      .where('scope_kind', '=', 'tenant')
      .where('status', '=', 'active')
      .where((builder) =>
        builder.or([builder('valid_from', 'is', null), builder('valid_from', '<=', instant)]),
      )
      .where((builder) =>
        builder.or([builder('valid_until', 'is', null), builder('valid_until', '>', instant)]),
      )
      .executeTakeFirst();
    return grant !== undefined;
  }
}

export class PostgresBootstrapFinalizer implements BootstrapFinalizer {
  constructor(private readonly protector: SecretProtector) {}

  async finalize(
    context: SystemTransactionContext,
    input: {
      readonly setupId: string;
      readonly transactionId: string;
      readonly identity: {
        readonly issuer: string;
        readonly subject: string;
        readonly email?: string;
      };
      readonly providerClientSecret: string;
      readonly sessionTokenDigest: Uint8Array;
      readonly csrfTokenDigest: Uint8Array;
      readonly now: Temporal.Instant;
      readonly requestId: string;
    },
  ): Promise<BootstrapInstallation> {
    const connection = connectionFor(context);
    const nowText = toDatabaseInstant(input.now);
    try {
      await sql`SELECT pg_advisory_xact_lock(hashtext('openhall:bootstrap-finalize'))`.execute(
        connection,
      );
      const existing = await connection
        .selectFrom('tenant')
        .select((builder) => builder.fn.countAll().as('count'))
        .executeTakeFirstOrThrow();
      if (Number(existing.count) > 0) {
        throw new AuthenticationError('bootstrap_unavailable');
      }
      const setup = await connection
        .selectFrom('bootstrap_setup')
        .selectAll()
        .where('id', '=', input.setupId)
        .executeTakeFirst();
      if (
        setup?.completed_at !== null ||
        fromDatabaseInstant(setup.expires_at).epochMilliseconds <= input.now.epochMilliseconds
      ) {
        throw new AuthenticationError('auth_transaction_invalid');
      }
      const consumed = await sql`
        UPDATE local_operator_grant
        SET consumed_at = statement_timestamp()
        WHERE id = ${setup.operator_grant_id}::uuid
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > ${nowText}
        RETURNING id
      `.execute(connection);
      if (consumed.rows.length === 0) {
        throw new AuthenticationError('bootstrap_token_invalid');
      }
      const transaction = await connection
        .selectFrom('oidc_login_transaction')
        .selectAll()
        .where('id', '=', input.transactionId)
        .executeTakeFirst();
      if (
        transaction?.status !== 'processing' ||
        transaction.purpose !== 'bootstrap' ||
        transaction.bootstrap_setup_id !== input.setupId
      ) {
        throw new AuthenticationError('auth_transaction_invalid');
      }
      const tenant = await connection
        .insertInto('tenant')
        .values({ name: setup.tenant_name, slug: setup.tenant_slug, status: 'active' })
        .returningAll()
        .executeTakeFirstOrThrow();
      const school = await connection
        .insertInto('organization')
        .values({
          tenant_id: tenant.id,
          kind: 'school',
          name: setup.school_name,
          slug: setup.school_slug,
          time_zone: setup.school_time_zone,
          status: 'active',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const person = await connection
        .insertInto('person')
        .values({
          tenant_id: tenant.id,
          given_name: setup.admin_given_name,
          family_name: setup.admin_family_name,
          display_name: setup.admin_display_name,
          status: 'active',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const account = await connection
        .insertInto('account')
        .values({ tenant_id: tenant.id, person_id: person.id, status: 'active' })
        .returningAll()
        .executeTakeFirstOrThrow();
      await connection
        .insertInto('organization_membership')
        .values({
          tenant_id: tenant.id,
          organization_id: school.id,
          person_id: person.id,
          affiliation: 'staff',
          status: 'active',
        })
        .execute();
      await connection
        .insertInto('authorization_grant')
        .values({
          tenant_id: tenant.id,
          account_id: account.id,
          role: 'system_admin',
          scope_kind: 'tenant',
          status: 'active',
        })
        .execute();
      const provider = await connection
        .insertInto('identity_provider')
        .values({
          tenant_id: tenant.id,
          key: setup.provider_key,
          display_name: setup.provider_display_name,
          issuer: setup.provider_issuer,
          client_id: setup.provider_client_id,
          client_secret_ciphertext: toDatabaseBytes(new Uint8Array()),
          client_secret_nonce: toDatabaseBytes(new Uint8Array()),
          client_secret_tag: toDatabaseBytes(new Uint8Array()),
          client_secret_key_id: this.protector.keyId,
          token_endpoint_auth_method: setup.provider_auth_method,
          scopes: setup.provider_scopes,
          status: 'active',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const sealed = this.protector.protect(
        input.providerClientSecret,
        `provider-secret:v1:${tenant.id}:${provider.id}`,
      );
      await connection
        .updateTable('identity_provider')
        .set({
          client_secret_ciphertext: toDatabaseBytes(sealed.ciphertext),
          client_secret_nonce: toDatabaseBytes(sealed.nonce),
          client_secret_tag: toDatabaseBytes(sealed.tag),
          client_secret_key_id: sealed.keyId,
        })
        .where('tenant_id', '=', tenant.id)
        .where('id', '=', provider.id)
        .execute();
      await connection
        .insertInto('auth_identity')
        .values({
          tenant_id: tenant.id,
          account_id: account.id,
          issuer: input.identity.issuer,
          provider_subject: input.identity.subject,
          email_snapshot: input.identity.email ?? null,
        })
        .execute();
      const idleExpires = toDatabaseInstant(input.now.add({ seconds: 12 * 60 * 60 }));
      const absoluteExpires = toDatabaseInstant(input.now.add({ seconds: 7 * 24 * 60 * 60 }));
      const session = await connection
        .insertInto('auth_session')
        .values({
          tenant_id: tenant.id,
          account_id: account.id,
          identity_provider_id: provider.id,
          token_hash: toDatabaseBytes(input.sessionTokenDigest),
          csrf_token_hash: toDatabaseBytes(input.csrfTokenDigest),
          account_session_revision: toBigInt(account.session_revision),
          authentication_method: 'oidc',
          authenticated_at: nowText,
          idle_expires_at: idleExpires,
          absolute_expires_at: absoluteExpires,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await connection
        .insertInto('audit_event')
        .values({
          tenant_id: tenant.id,
          actor_kind: 'account',
          actor_id: account.id,
          action: 'auth.bootstrap_completed',
          target_kind: 'tenant',
          target_id: tenant.id,
          outcome: 'success',
          occurred_at: nowText,
          request_id: input.requestId,
          metadata: {},
        })
        .execute();
      await connection
        .insertInto('audit_event')
        .values({
          tenant_id: tenant.id,
          actor_kind: 'account',
          actor_id: account.id,
          action: 'auth.sign_in_succeeded',
          target_kind: 'auth_session',
          target_id: session.id,
          outcome: 'success',
          occurred_at: nowText,
          request_id: input.requestId,
          metadata: {},
        })
        .execute();
      await connection
        .updateTable('bootstrap_setup')
        .set({ completed_at: nowText })
        .where('id', '=', input.setupId)
        .where('completed_at', 'is', null)
        .execute();
      await connection
        .updateTable('oidc_login_transaction')
        .set({ status: 'consumed', consumed_at: nowText })
        .where('id', '=', input.transactionId)
        .where('status', '=', 'processing')
        .execute();
      return {
        tenant: mapTenant(tenant),
        accountId: account.id,
        personId: person.id,
        session: mapSession(session),
      };
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = error.code;
        if (code === '23505') {
          throw new AuthenticationError(
            'invalid_bootstrap_draft',
            'Bootstrap details conflict with an existing installation',
          );
        }
      }
      throw error;
    }
  }
}
