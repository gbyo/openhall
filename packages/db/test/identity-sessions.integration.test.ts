import { randomBytes, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/database.js';
import { EXPECTED_MIGRATION, migrateToLatest } from '../src/migrator.js';
import { up as up001 } from '../src/migrations/001_foundation.js';
import { up as up002 } from '../src/migrations/002_scheduling_expected_placement.js';
import {
  PostgresAuditWriter,
  PostgresBootstrapFinalizer,
  PostgresBootstrapRepository,
  PostgresIdentityDirectory,
  PostgresOidcTransactionStore,
  PostgresOperatorGrantStore,
  PostgresSessionCredentialLookup,
  PostgresSessionRepository,
  PostgresTenantDirectory,
} from '../src/repositories/auth-repository.js';
import {
  PostgresSystemTransactionRunner,
  PostgresTenantTransactionRunner,
  toDatabaseInstant,
} from '../src/transactions.js';
import type { DB as Database } from '../src/database.generated.js';
import type { Kysely } from 'kysely';
import { Kysely as KyselyCtor, PostgresDialect } from 'kysely';

let databaseName: string;
let databaseUrl: string;
let administrationUrl: string;
let pool: Pool;
let database: Kysely<Database>;
let destroyDatabase: () => Promise<void>;

function quotedIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('Unsafe database identifier');
  return `"${value}"`;
}

function bytes(length = 32): Buffer {
  return randomBytes(length);
}

function secret(prefix: string): {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
  keyId: string;
} {
  return {
    ciphertext: new Uint8Array(Buffer.from(`${prefix}-ciphertext`.padEnd(32, '.'))),
    nonce: new Uint8Array(randomBytes(12)),
    tag: new Uint8Array(randomBytes(16)),
    keyId: 'test-key-1',
  };
}

// Anchored to the live clock: expiry CHECK constraints compare against
// statement_timestamp(), so fixed historical instants would violate them.
const NOW = Temporal.Now.instant();
const LATER = NOW.add({ seconds: 3600 });

beforeAll(async () => {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
  const base = new URL(configuredUrl);
  databaseName = `openhall_test_${randomUUID().replaceAll('-', '')}`;
  const administration = new URL(base);
  administration.pathname = '/postgres';
  administrationUrl = administration.toString();
  const client = new Client({ connectionString: administrationUrl });
  await client.connect();
  await client.query(`CREATE DATABASE ${quotedIdentifier(databaseName)}`);
  await client.end();

  const target = new URL(base);
  target.pathname = `/${databaseName}`;
  databaseUrl = target.toString();
  const handle = createDatabase(databaseUrl, { max: 4 });
  database = handle.database;
  destroyDatabase = () => handle.destroy();
  await migrateToLatest(handle.database);
  pool = new Pool({ connectionString: databaseUrl, max: 4 });
});

afterAll(async () => {
  await pool.end();
  await destroyDatabase();
  const client = new Client({ connectionString: administrationUrl });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`);
  await client.end();
});

async function seedTenant(slug: string): Promise<string> {
  const row = (
    await pool.query<{ id: string }>(
      'INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id',
      [`Tenant ${slug}`, slug],
    )
  ).rows[0];
  if (!row) throw new Error('Tenant fixture failed');
  return row.id;
}

async function seedAccount(tenantId: string): Promise<{ accountId: string; personId: string }> {
  const person = (
    await pool.query<{ id: string }>(
      'INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, $2, $3, $4) RETURNING id',
      [tenantId, 'Ada', 'Admin', 'Ada Admin'],
    )
  ).rows[0];
  const account = (
    await pool.query<{ id: string }>(
      'INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id',
      [tenantId, person?.id],
    )
  ).rows[0];
  if (!person || !account) throw new Error('Account fixture failed');
  return { accountId: account.id, personId: person.id };
}

async function seedProvider(tenantId: string, key: string): Promise<string> {
  const sealed = secret(`provider-${key}`);
  const row = (
    await pool.query<{ id: string }>(
      `INSERT INTO identity_provider
        (tenant_id, key, display_name, issuer, client_id,
         client_secret_ciphertext, client_secret_nonce, client_secret_tag, client_secret_key_id,
         token_endpoint_auth_method, scopes)
       VALUES ($1, $2, 'Test Provider', 'https://provider.example.com', 'client-1', $3, $4, $5, 'test-key-1', 'client_secret_post', '{openid,email}')
       RETURNING id`,
      [
        tenantId,
        key,
        Buffer.from(sealed.ciphertext),
        Buffer.from(sealed.nonce),
        Buffer.from(sealed.tag),
      ],
    )
  ).rows[0];
  if (!row) throw new Error('Provider fixture failed');
  return row.id;
}

describe('migration 003 on PostgreSQL 18', () => {
  it('migrates a blank database through 005', async () => {
    expect(EXPECTED_MIGRATION).toBe('005_pass_command_core');
    const rows = await pool.query<{ name: string }>(
      'SELECT name FROM kysely_migration ORDER BY name',
    );
    expect(rows.rows.map((row) => row.name)).toEqual([
      '001_foundation',
      '002_scheduling_expected_placement',
      '003_identity_secure_sessions',
      '004_authorization_relationships',
      '005_pass_command_core',
    ]);
  });

  it('upgrades an existing Phase 2 database with deterministic slug backfill', async () => {
    const name = `openhall_upgrade_${randomUUID().replaceAll('-', '')}`;
    const admin = new Client({ connectionString: administrationUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quotedIdentifier(name)}`);
    await admin.end();
    const target = new URL(databaseUrl);
    target.pathname = `/${name}`;
    const url = target.toString();
    try {
      const raw = new KyselyCtor<unknown>({
        dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 1 }) }),
      });
      await up001(raw);
      await up002(raw);
      await raw.destroy();
      const setup = new Pool({ connectionString: url, max: 1 });
      await setup.query(
        'CREATE TABLE IF NOT EXISTS kysely_migration (name varchar(255) PRIMARY KEY, timestamp varchar(255) NOT NULL)',
      );
      await setup.query(
        'CREATE TABLE IF NOT EXISTS kysely_migration_lock (id varchar(255) PRIMARY KEY, is_locked integer NOT NULL DEFAULT 0)',
      );
      await setup.query(
        "INSERT INTO kysely_migration (name, timestamp) VALUES ('001_foundation', '20240101000000'), ('002_scheduling_expected_placement', '20240102000000')",
      );
      const first = '01934617-99b2-7a2c-9d01-23456789abcd';
      const second = '01934617-99b2-7a2c-9d01-23456789abce';
      await setup.query('INSERT INTO tenant (id, name) VALUES ($1, $2), ($3, $4)', [
        first,
        'Greenwood',
        second,
        'Ninety Six',
      ]);
      await setup.end();
      const handle = createDatabase(url, { max: 1 });
      await migrateToLatest(handle.database);
      await handle.destroy();
      const check = new Pool({ connectionString: url, max: 1 });
      const tenants = await check.query<{ id: string; slug: string }>(
        'SELECT id, slug FROM tenant ORDER BY slug',
      );
      expect(tenants.rows).toEqual([
        { id: first, slug: '0193461799b27a2c9d0123456789abcd' },
        { id: second, slug: '0193461799b27a2c9d0123456789abce' },
      ]);
      await check.end();
    } finally {
      const cleanup = new Client({ connectionString: administrationUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(name)} WITH (FORCE)`);
      await cleanup.end();
    }
  });

  it('enforces tenant slug uniqueness and lowercase shape', async () => {
    await seedTenant('slug-unique');
    await expect(
      pool.query("INSERT INTO tenant (name, slug) VALUES ('Dup', 'slug-unique')"),
    ).rejects.toThrow();
    await expect(
      pool.query("INSERT INTO tenant (name, slug) VALUES ('Upper', 'Not-Lower')"),
    ).rejects.toThrow();
  });

  it('enforces identity-provider constraints', async () => {
    const tenantId = await seedTenant('provider-checks');
    await seedProvider(tenantId, 'workspace');
    await expect(seedProvider(tenantId, 'workspace')).rejects.toThrow(/unique|duplicate/i);
    await expect(
      pool.query(
        `INSERT INTO identity_provider
          (tenant_id, key, display_name, issuer, client_id, client_secret_ciphertext,
           client_secret_nonce, client_secret_tag, client_secret_key_id,
           token_endpoint_auth_method, scopes)
         VALUES ($1, 'other', 'Other', 'https://provider.example.com', 'client-1', $2, $3, $4, 'k', 'client_secret_post', '{openid}')`,
        [tenantId, bytes(16), bytes(12), bytes(16)],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
    await expect(
      pool.query(
        `INSERT INTO identity_provider
          (tenant_id, key, display_name, issuer, client_id, client_secret_ciphertext,
           client_secret_nonce, client_secret_tag, client_secret_key_id,
           token_endpoint_auth_method, scopes)
         VALUES ($1, 'no-openid', 'No OpenID', 'https://other.example.com', 'client-2', $2, $3, $4, 'k', 'client_secret_post', '{email}')`,
        [tenantId, bytes(16), bytes(12), bytes(16)],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO identity_provider
          (tenant_id, key, display_name, issuer, client_id, client_secret_ciphertext,
           client_secret_nonce, client_secret_tag, client_secret_key_id,
           token_endpoint_auth_method, scopes)
         VALUES ($1, 'bad-auth', 'Bad', 'https://other.example.com', 'client-3', $2, $3, $4, 'k', 'private_key_jwt', '{openid}')`,
        [tenantId, bytes(16), bytes(12), bytes(16)],
      ),
    ).rejects.toThrow();
  });

  it('enforces session tenant/account/provider consistency', async () => {
    const tenantA = await seedTenant('session-a');
    const tenantB = await seedTenant('session-b');
    const { accountId } = await seedAccount(tenantA);
    const otherProvider = await seedProvider(tenantB, 'other');
    const digest = bytes();
    // Account from another tenant is rejected.
    await expect(
      pool.query(
        `INSERT INTO auth_session
          (tenant_id, account_id, token_hash, csrf_token_hash, account_session_revision,
           authentication_method, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, 0, 'oidc', $5, $6)`,
        [tenantB, accountId, digest, bytes(), toDatabaseInstant(LATER), toDatabaseInstant(LATER)],
      ),
    ).rejects.toThrow();
    // Provider from another tenant is rejected.
    await expect(
      pool.query(
        `INSERT INTO auth_session
          (tenant_id, account_id, identity_provider_id, token_hash, csrf_token_hash,
           account_session_revision, authentication_method, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, $5, 0, 'oidc', $6, $7)`,
        [
          tenantA,
          accountId,
          otherProvider,
          bytes(),
          bytes(),
          toDatabaseInstant(LATER),
          toDatabaseInstant(LATER),
        ],
      ),
    ).rejects.toThrow();
    // Duplicate token digests are rejected.
    await pool.query(
      `INSERT INTO auth_session
        (tenant_id, account_id, token_hash, csrf_token_hash, account_session_revision,
         authentication_method, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, 0, 'oidc', $5, $6)`,
      [tenantA, accountId, digest, bytes(), toDatabaseInstant(LATER), toDatabaseInstant(LATER)],
    );
    await expect(
      pool.query(
        `INSERT INTO auth_session
          (tenant_id, account_id, token_hash, csrf_token_hash, account_session_revision,
           authentication_method, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, 0, 'oidc', $5, $6)`,
        [tenantA, accountId, digest, bytes(), toDatabaseInstant(LATER), toDatabaseInstant(LATER)],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
    // Revocation requires a reason and vice versa.
    await expect(
      pool.query(
        `INSERT INTO auth_session
          (tenant_id, account_id, token_hash, csrf_token_hash, account_session_revision,
           authentication_method, revoked_at, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, 0, 'oidc', $5, $6, $7)`,
        [
          tenantA,
          accountId,
          bytes(),
          bytes(),
          toDatabaseInstant(NOW),
          toDatabaseInstant(LATER),
          toDatabaseInstant(LATER),
        ],
      ),
    ).rejects.toThrow();
  });

  it('enforces operator-grant and login-transaction shapes', async () => {
    const tenantId = await seedTenant('grant-shapes');
    const { accountId } = await seedAccount(tenantId);
    // Bootstrap grants must not carry a tenant.
    await expect(
      pool.query(
        "INSERT INTO local_operator_grant (purpose, tenant_id, token_hash, expires_at) VALUES ('bootstrap', $1, $2, $3)",
        [tenantId, bytes(), toDatabaseInstant(LATER)],
      ),
    ).rejects.toThrow();
    // Recovery grants require tenant and account.
    await expect(
      pool.query(
        "INSERT INTO local_operator_grant (purpose, token_hash, expires_at) VALUES ('recovery', $1, $2)",
        [bytes(), toDatabaseInstant(LATER)],
      ),
    ).rejects.toThrow();
    const recovery = (
      await pool.query<{ id: string }>(
        'INSERT INTO local_operator_grant (purpose, tenant_id, account_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        ['recovery', tenantId, accountId, bytes(), toDatabaseInstant(LATER)],
      )
    ).rows[0];
    expect(recovery?.id).toBeDefined();
    // Login transactions require tenant/provider; bootstrap ones forbid them.
    await expect(
      pool.query(
        `INSERT INTO oidc_login_transaction
          (purpose, state_hash, browser_binding_hash, transaction_secret_ciphertext,
           transaction_secret_nonce, transaction_secret_tag, transaction_secret_key_id, expires_at)
         VALUES ('login', $1, $2, $3, $4, $5, 'k', $6)`,
        [bytes(), bytes(), bytes(16), bytes(12), bytes(16), toDatabaseInstant(LATER)],
      ),
    ).rejects.toThrow();
    const providerId = await seedProvider(tenantId, 'tx-provider');
    const state = bytes();
    await pool.query(
      `INSERT INTO oidc_login_transaction
        (tenant_id, identity_provider_id, purpose, state_hash, browser_binding_hash,
         transaction_secret_ciphertext, transaction_secret_nonce, transaction_secret_tag,
         transaction_secret_key_id, expires_at)
       VALUES ($1, $2, 'login', $3, $4, $5, $6, $7, 'k', $8)`,
      [
        tenantId,
        providerId,
        state,
        bytes(),
        bytes(16),
        bytes(12),
        bytes(16),
        toDatabaseInstant(LATER),
      ],
    );
    await expect(
      pool.query(
        `INSERT INTO oidc_login_transaction
          (tenant_id, identity_provider_id, purpose, state_hash, browser_binding_hash,
           transaction_secret_ciphertext, transaction_secret_nonce, transaction_secret_tag,
           transaction_secret_key_id, expires_at)
         VALUES ($1, $2, 'login', $3, $4, $5, $6, $7, 'k', $8)`,
        [
          tenantId,
          providerId,
          state,
          bytes(),
          bytes(16),
          bytes(12),
          bytes(16),
          toDatabaseInstant(LATER),
        ],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('enforces expiry, enum, and relationship CHECKs', async () => {
    const tenantId = await seedTenant('check-shapes');
    const { accountId } = await seedAccount(tenantId);
    // Grant expiry must be strictly after creation.
    await expect(
      pool.query(
        "INSERT INTO local_operator_grant (purpose, token_hash, expires_at) VALUES ('bootstrap', $1, $2)",
        [bytes(), toDatabaseInstant(NOW)],
      ),
    ).rejects.toThrow(/check/i);
    // Unknown grant purposes are rejected.
    await expect(
      pool.query(
        "INSERT INTO local_operator_grant (purpose, token_hash, expires_at) VALUES ('bogus', $1, $2)",
        [bytes(), toDatabaseInstant(LATER)],
      ),
    ).rejects.toThrow(/check/i);
    const sealed = secret('check-provider');
    const sealedParts = [
      Buffer.from(sealed.ciphertext),
      Buffer.from(sealed.nonce),
      Buffer.from(sealed.tag),
    ];
    // Provider status, scopes, and auth method are closed enums/shapes.
    const badProviders: { key: string; authMethod: string; scopes: string; status: string }[] = [
      {
        key: 'check-status',
        authMethod: 'client_secret_post',
        scopes: '{openid,email}',
        status: 'bogus',
      },
      {
        key: 'check-scopes',
        authMethod: 'client_secret_post',
        scopes: '{email}',
        status: 'active',
      },
      { key: 'check-method', authMethod: 'none', scopes: '{openid,email}', status: 'active' },
    ];
    for (const bad of badProviders) {
      await expect(
        pool.query(
          `INSERT INTO identity_provider
            (tenant_id, key, display_name, issuer, client_id,
             client_secret_ciphertext, client_secret_nonce, client_secret_tag, client_secret_key_id,
             token_endpoint_auth_method, scopes, status)
           VALUES ($1, $2, 'Test Provider', 'https://provider.example.com',
                   'client-1', $3, $4, $5, 'test-key-1', $6, $7, $8)`,
          [tenantId, bad.key, ...sealedParts, bad.authMethod, bad.scopes, bad.status],
        ),
      ).rejects.toThrow(/check/i);
    }
    // Recovery grants must reference a real tenant: nothing forges across
    // tenant boundaries.
    await expect(
      pool.query(
        'INSERT INTO local_operator_grant (purpose, tenant_id, account_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [
          'recovery',
          '00000000-0000-0000-0000-000000000000',
          accountId,
          bytes(),
          toDatabaseInstant(LATER),
        ],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
    // A login transaction cannot pair a tenant with another tenant's provider.
    const otherTenant = await seedTenant('check-other');
    const foreignProvider = await seedProvider(otherTenant, 'check-foreign');
    await expect(
      pool.query(
        `INSERT INTO oidc_login_transaction
          (tenant_id, identity_provider_id, purpose, state_hash, browser_binding_hash,
           transaction_secret_ciphertext, transaction_secret_nonce, transaction_secret_tag,
           transaction_secret_key_id, expires_at)
         VALUES ($1, $2, 'login', $3, $4, $5, $6, $7, 'k', $8)`,
        [
          tenantId,
          foreignProvider,
          bytes(),
          bytes(),
          bytes(16),
          bytes(12),
          bytes(16),
          toDatabaseInstant(LATER),
        ],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
    // A bootstrap transaction must reference a real setup draft.
    await expect(
      pool.query(
        `INSERT INTO oidc_login_transaction
          (purpose, bootstrap_setup_id, state_hash, browser_binding_hash,
           transaction_secret_ciphertext, transaction_secret_nonce, transaction_secret_tag,
           transaction_secret_key_id, expires_at)
         VALUES ('bootstrap', $1, $2, $3, $4, $5, $6, 'k', $7)`,
        [
          '00000000-0000-0000-0000-000000000000',
          bytes(),
          bytes(),
          bytes(16),
          bytes(12),
          bytes(16),
          toDatabaseInstant(LATER),
        ],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('keeps digest uniqueness indexes in place', async () => {
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN
       ('auth_session_token_hash_key', 'oidc_login_transaction_state_hash_key', 'local_operator_grant_token_hash_key')`,
    );
    expect(indexes.rows.map((row) => row.indexname).sort()).toEqual([
      'auth_session_token_hash_key',
      'local_operator_grant_token_hash_key',
      'oidc_login_transaction_state_hash_key',
    ]);
  });
});

describe('authentication repositories', () => {
  it('creates, resolves, touches, and revokes sessions', async () => {
    const tenantId = await seedTenant('session-lifecycle');
    const { accountId } = await seedAccount(tenantId);
    const runner = new PostgresTenantTransactionRunner(database);
    const sessions = new PostgresSessionRepository();
    const lookup = new PostgresSessionCredentialLookup(database);
    const token = bytes();
    const csrf = bytes();
    const created = await runner.run(tenantId, (context) =>
      sessions.create(context, {
        tenantId,
        accountId,
        identityProviderId: null,
        tokenDigest: new Uint8Array(token),
        csrfTokenDigest: new Uint8Array(csrf),
        accountSessionRevision: 0n,
        authenticationMethod: 'oidc',
        authenticatedAt: NOW,
        idleExpiresAt: LATER,
        absoluteExpiresAt: LATER.add({ seconds: 3600 }),
      }),
    );
    expect(typeof created.accountSessionRevision === 'bigint').toBe(true);
    const found = await lookup.findByTokenDigest(new Uint8Array(token));
    expect(found?.id).toBe(created.id);
    await runner.run(tenantId, (context) =>
      sessions.touchLastSeen(context, created.id, NOW.add({ seconds: 600 })),
    );
    const touched = await lookup.findByTokenDigest(new Uint8Array(token));
    expect(touched?.lastSeenAt.epochMilliseconds).toBe(NOW.add({ seconds: 600 }).epochMilliseconds);
    await runner.run(tenantId, (context) =>
      sessions.revokeSession(context, created.id, 'logout', NOW.add({ seconds: 601 })),
    );
    const revoked = await lookup.findByTokenDigest(new Uint8Array(token));
    expect(revoked?.revokedAt).not.toBeNull();
  });

  it('revokes all sessions and bumps the revision for logout-all', async () => {
    const tenantId = await seedTenant('logout-all');
    const { accountId } = await seedAccount(tenantId);
    const runner = new PostgresTenantTransactionRunner(database);
    const sessions = new PostgresSessionRepository();
    const directory = new PostgresIdentityDirectory();
    const lookup = new PostgresSessionCredentialLookup(database);
    const tokens = [bytes(), bytes()];
    for (const token of tokens) {
      await runner.run(tenantId, (context) =>
        sessions.create(context, {
          tenantId,
          accountId,
          identityProviderId: null,
          tokenDigest: new Uint8Array(token),
          csrfTokenDigest: new Uint8Array(bytes()),
          accountSessionRevision: 0n,
          authenticationMethod: 'oidc',
          authenticatedAt: NOW,
          idleExpiresAt: LATER,
          absoluteExpiresAt: LATER,
        }),
      );
    }
    await runner.run(tenantId, async (context) => {
      await directory.incrementSessionRevision(context, accountId);
      await sessions.revokeAllForAccount(context, accountId, 'logout-all', NOW);
    });
    for (const token of tokens) {
      const row = await lookup.findByTokenDigest(new Uint8Array(token));
      expect(row?.revokedAt).not.toBeNull();
    }
    const account = await runner.run(tenantId, (context) =>
      directory.findAccount(context, accountId),
    );
    expect(account?.sessionRevision).toBe(1n);
  });

  it('claims login transactions exactly once', async () => {
    const tenantId = await seedTenant('tx-claim');
    const providerId = await seedProvider(tenantId, 'claim');
    const system = new PostgresSystemTransactionRunner(database);
    const store = new PostgresOidcTransactionStore(database);
    const sealed = secret('tx');
    const state = new Uint8Array(bytes());
    await system.run((context) =>
      store.create(context, {
        tenantId,
        identityProviderId: providerId,
        bootstrapSetupId: null,
        purpose: 'login',
        providerRevision: 1,
        stateDigest: state,
        browserBindingDigest: new Uint8Array(bytes()),
        transactionSecret: sealed,
        returnPath: '/dashboard',
        expiresAt: LATER,
      }),
    );
    const first = await store.claimByStateDigest(state, NOW);
    expect(first?.status).toBe('processing');
    const replay = await store.claimByStateDigest(state, NOW);
    expect(replay).toBeUndefined();
    if (first === undefined) throw new Error('Claim fixture failed');
    await store.consume(first.id, NOW);
    const afterConsume = await store.claimByStateDigest(state, NOW);
    expect(afterConsume).toBeUndefined();
  });

  it('consumes operator grants exactly once without reading them', async () => {
    const system = new PostgresSystemTransactionRunner(database);
    const store = new PostgresOperatorGrantStore(database);
    const digest = new Uint8Array(bytes());
    await system.run((context) =>
      store.create(context, {
        purpose: 'bootstrap',
        tenantId: null,
        accountId: null,
        tokenDigest: digest,
        expiresAt: LATER,
      }),
    );
    const visible = await store.findValidByTokenDigest(digest, NOW);
    expect(visible?.consumedAt).toBeNull();
    const consumed = await store.consumeByTokenDigest(digest, NOW);
    expect(consumed?.id).toBe(visible?.id);
    expect(await store.consumeByTokenDigest(digest, NOW)).toBeUndefined();
    expect(await store.findValidByTokenDigest(digest, NOW)).toBeUndefined();
  });

  it('detects active system_admin grants with validity windows', async () => {
    const tenantId = await seedTenant('grant-check');
    const { accountId } = await seedAccount(tenantId);
    const runner = new PostgresTenantTransactionRunner(database);
    const directory = new PostgresIdentityDirectory();
    const before = await runner.run(tenantId, (context) =>
      directory.hasActiveSystemAdminGrant(context, accountId, NOW),
    );
    expect(before).toBe(false);
    await pool.query(
      `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, status)
       VALUES ($1, $2, 'system_admin', 'tenant', 'active')`,
      [tenantId, accountId],
    );
    const after = await runner.run(tenantId, (context) =>
      directory.hasActiveSystemAdminGrant(context, accountId, NOW),
    );
    expect(after).toBe(true);
  });

  it('finalizes bootstrap atomically and refuses a second installation', async () => {
    // Bootstrap requires a blank installation: use a dedicated scratch DB.
    const blankName = `openhall_blank_${randomUUID().replaceAll('-', '')}`;
    const admin = new Client({ connectionString: administrationUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${quotedIdentifier(blankName)}`);
    await admin.end();
    const blankTarget = new URL(databaseUrl);
    blankTarget.pathname = `/${blankName}`;
    const blankUrl = blankTarget.toString();
    const blankHandle = createDatabase(blankUrl, { max: 4 });
    const blank = blankHandle.database;
    await migrateToLatest(blankHandle.database);
    const system = new PostgresSystemTransactionRunner(blank);
    const grants = new PostgresOperatorGrantStore(blank);
    const transactions = new PostgresOidcTransactionStore(blank);
    const tenants = new PostgresTenantDirectory(blank);
    const protector = {
      keyId: 'test-key-1',
      protect: (plaintext: string) => ({
        ciphertext: new Uint8Array(Buffer.from(`sealed:${plaintext}`)),
        nonce: new Uint8Array(randomBytes(12)),
        tag: new Uint8Array(randomBytes(16)),
        keyId: 'test-key-1',
      }),
      reveal: () => {
        throw new Error('not used in finalizer test');
      },
    };
    const finalizer = new PostgresBootstrapFinalizer(protector);
    const digest = new Uint8Array(bytes());
    const grant = await system.run((context) =>
      grants.create(context, {
        purpose: 'bootstrap',
        tenantId: null,
        accountId: null,
        tokenDigest: digest,
        expiresAt: LATER,
      }),
    );
    const repositories = new PostgresBootstrapRepository();
    const draft = {
      tenantName: 'Greenwood',
      tenantSlug: `greenwood-${randomUUID().slice(0, 8)}`,
      schoolName: 'Greenwood High',
      schoolSlug: `greenwood-high-${randomUUID().slice(0, 8)}`,
      schoolTimeZone: 'America/Chicago',
      adminGivenName: 'Ada',
      adminFamilyName: 'Admin',
      adminDisplayName: 'Ada Admin',
      providerKey: 'workspace',
      providerDisplayName: 'Workspace',
      providerIssuer: 'https://accounts.example.com',
      providerClientId: 'client-1',
      providerSecret: secret('draft'),
      providerAuthMethod: 'client_secret_post' as const,
      providerScopes: ['openid', 'email'] as readonly string[],
      expiresAt: LATER,
    };
    const setup = await system.run((context) => repositories.createDraft(context, grant.id, draft));
    const sealed = secret('bootstrap-tx');
    const state = new Uint8Array(bytes());
    const transaction = await system.run((context) =>
      transactions.create(context, {
        tenantId: null,
        identityProviderId: null,
        bootstrapSetupId: setup.id,
        purpose: 'bootstrap',
        providerRevision: null,
        stateDigest: state,
        browserBindingDigest: new Uint8Array(bytes()),
        transactionSecret: sealed,
        returnPath: '/',
        expiresAt: LATER,
      }),
    );
    const claimed = await transactions.claimByStateDigest(state, NOW);
    expect(claimed?.id).toBe(transaction.id);
    const installation = await system.run((context) =>
      finalizer.finalize(context, {
        setupId: setup.id,
        transactionId: transaction.id,
        identity: { issuer: 'https://accounts.example.com', subject: 'subject-1' },
        providerClientSecret: 'raw-secret',
        sessionTokenDigest: new Uint8Array(bytes()),
        csrfTokenDigest: new Uint8Array(bytes()),
        now: NOW,
        requestId: 'req-1',
      }),
    );
    expect(installation.tenant.slug).toBe(draft.tenantSlug);
    const blankPool = new Pool({ connectionString: blankUrl, max: 1 });
    try {
      const membership = await blankPool.query<{ affiliation: string }>(
        'SELECT affiliation FROM organization_membership WHERE tenant_id = $1',
        [installation.tenant.id],
      );
      expect(membership.rows[0]?.affiliation).toBe('staff');
      const grantRow = await blankPool.query(
        'SELECT role, scope_kind FROM authorization_grant WHERE tenant_id = $1',
        [installation.tenant.id],
      );
      expect(grantRow.rows[0]).toMatchObject({ role: 'system_admin', scope_kind: 'tenant' });
      const identity = await blankPool.query(
        'SELECT issuer, provider_subject FROM auth_identity WHERE tenant_id = $1',
        [installation.tenant.id],
      );
      expect(identity.rows[0]).toMatchObject({
        issuer: 'https://accounts.example.com',
        provider_subject: 'subject-1',
      });
      const audit = await blankPool.query<{ action: string }>(
        'SELECT action FROM audit_event WHERE tenant_id = $1',
        [installation.tenant.id],
      );
      expect(audit.rows.map((row) => row.action).sort()).toEqual([
        'auth.bootstrap_completed',
        'auth.sign_in_succeeded',
      ]);
      // A second finalize for the same blank-installation flow now refuses:
      // a canonical tenant exists.
      await expect(
        system.run((context) =>
          finalizer.finalize(context, {
            setupId: setup.id,
            transactionId: transaction.id,
            identity: { issuer: 'https://accounts.example.com', subject: 'subject-2' },
            providerClientSecret: 'raw-secret',
            sessionTokenDigest: new Uint8Array(bytes()),
            csrfTokenDigest: new Uint8Array(bytes()),
            now: NOW,
            requestId: 'req-2',
          }),
        ),
      ).rejects.toThrow();
      expect(await tenants.countCanonical()).toBe(1);
    } finally {
      await blankPool.end();
      await blankHandle.destroy();
      const cleanup = new Client({ connectionString: administrationUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(blankName)} WITH (FORCE)`);
      await cleanup.end();
    }
  });

  it('writes minimized audit events in tenant transactions', async () => {
    const tenantId = await seedTenant('audit-write');
    const { accountId } = await seedAccount(tenantId);
    const runner = new PostgresTenantTransactionRunner(database);
    const audit = new PostgresAuditWriter();
    await runner.run(tenantId, (context) =>
      audit.append(context, {
        action: 'auth.sign_in_succeeded',
        actorKind: 'account',
        actorId: accountId,
        targetKind: 'auth_session',
        outcome: 'success',
        occurredAt: NOW,
        requestId: 'req-audit',
        metadata: { reason: 'ok' },
      }),
    );
    const rows = await pool.query<{ action: string; metadata: unknown }>(
      'SELECT action, metadata FROM audit_event WHERE tenant_id = $1',
      [tenantId],
    );
    expect(rows.rows[0]?.action).toBe('auth.sign_in_succeeded');
    expect(rows.rows[0]?.metadata).toEqual({ reason: 'ok' });
  });
});
