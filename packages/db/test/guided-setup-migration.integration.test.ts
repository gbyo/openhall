import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/database.js';
import { createMigrator, migrateToLatest } from '../src/migrator.js';

function quotedIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('Unsafe database identifier');
  return `"${value}"`;
}

function idOf(result: { rows: { id?: string }[] }): string {
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('Fixture insert failed');
  return id;
}

const createdDatabases: string[] = [];

async function freshDatabase(): Promise<{ url: string; pool: Pool }> {
  const base = new URL(process.env.DATABASE_URL ?? '');
  const name = `openhall_test_${randomUUID().replaceAll('-', '')}`;
  const administration = new URL(base);
  administration.pathname = '/postgres';
  const client = new Client({ connectionString: administration.toString() });
  await client.connect();
  await client.query(`CREATE DATABASE ${quotedIdentifier(name)}`);
  await client.end();
  createdDatabases.push(name);
  const target = new URL(base);
  target.pathname = `/${name}`;
  const url = target.toString();
  return { url, pool: new Pool({ connectionString: url, max: 4 }) };
}

async function migrateTo(handle: ReturnType<typeof createDatabase>, target: string): Promise<void> {
  const result = await createMigrator(handle.database).migrateTo(target);
  if (result.error) {
    throw result.error instanceof Error ? result.error : new Error(`Migration to ${target} failed`);
  }
}

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
});

afterAll(async () => {
  const base = new URL(process.env.DATABASE_URL ?? '');
  const administration = new URL(base);
  administration.pathname = '/postgres';
  const client = new Client({ connectionString: administration.toString() });
  await client.connect();
  try {
    for (const name of createdDatabases) {
      await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(name)} WITH (FORCE)`);
    }
  } finally {
    await client.end();
  }
});

/** Seeds one tenant with an admin account, a provider, and representative auth rows. */
async function seedPhase8(scratch: Pool, tag: string) {
  const tenantId = idOf(
    await scratch.query(`INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id`, [
      `T-${tag}`,
      `g9-${tag}`,
    ]),
  );
  const school = idOf(
    await scratch.query(
      `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'School', $2, 'America/New_York') RETURNING id`,
      [tenantId, `g9-school-${tag}`],
    ),
  );
  const person = idOf(
    await scratch.query(
      `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'Gibson', 'Bell', 'Gibson Bell') RETURNING id`,
      [tenantId],
    ),
  );
  const account = idOf(
    await scratch.query(`INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id`, [
      tenantId,
      person,
    ]),
  );
  const provider = idOf(
    await scratch.query(
      `INSERT INTO identity_provider (tenant_id, key, display_name, issuer, client_id,
        client_secret_ciphertext, client_secret_nonce, client_secret_tag, client_secret_key_id,
        token_endpoint_auth_method, scopes)
       VALUES ($1, $2, 'Test', 'https://issuer.example', 'client',
        decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), 'key-1',
        'client_secret_post', '{openid}') RETURNING id`,
      [tenantId, `gtest-${tag}`],
    ),
  );
  const oidcSession = idOf(
    await scratch.query(
      `INSERT INTO auth_session (tenant_id, account_id, identity_provider_id, token_hash,
        csrf_token_hash, account_session_revision, authentication_method,
        idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, decode('01', 'hex'), decode('02', 'hex'), 0, 'oidc',
        statement_timestamp() + interval '1 hour', statement_timestamp() + interval '1 day')
       RETURNING id`,
      [tenantId, account, provider],
    ),
  );
  const recoverySession = idOf(
    await scratch.query(
      `INSERT INTO auth_session (tenant_id, account_id, identity_provider_id, token_hash,
        csrf_token_hash, account_session_revision, authentication_method,
        idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, NULL, decode('03', 'hex'), decode('04', 'hex'), 0, 'recovery',
        statement_timestamp() + interval '15 minutes', statement_timestamp() + interval '30 minutes')
       RETURNING id`,
      [tenantId, account],
    ),
  );
  const loginTransaction = idOf(
    await scratch.query(
      `INSERT INTO oidc_login_transaction (tenant_id, identity_provider_id, purpose,
        state_hash, browser_binding_hash, transaction_secret_ciphertext,
        transaction_secret_nonce, transaction_secret_tag, transaction_secret_key_id,
        expires_at)
       VALUES ($1, $2, 'login', decode('05', 'hex'), decode('06', 'hex'),
        decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), 'key-1',
        statement_timestamp() + interval '10 minutes') RETURNING id`,
      [tenantId, provider],
    ),
  );
  const grant = idOf(
    await scratch.query(
      `INSERT INTO local_operator_grant (purpose, token_hash, expires_at)
       VALUES ('bootstrap', decode('07', 'hex'), statement_timestamp() + interval '1 hour')
       RETURNING id`,
      [],
    ),
  );
  const setup = idOf(
    await scratch.query(
      `INSERT INTO bootstrap_setup (operator_grant_id, tenant_name, tenant_slug, school_name,
        school_slug, school_time_zone, admin_given_name, admin_family_name, admin_display_name,
        provider_key, provider_display_name, provider_issuer, provider_client_id,
        provider_secret_ciphertext, provider_secret_nonce, provider_secret_tag,
        provider_secret_key_id, provider_auth_method, provider_scopes, expires_at)
       VALUES ($1, 'T', 't', 'S', 's', 'America/New_York', 'G', 'B', 'GB',
        'workspace', 'Workspace', 'https://issuer.example', 'client',
        decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), 'key-1',
        'client_secret_post', '{openid}', statement_timestamp() + interval '1 hour')
       RETURNING id`,
      [grant],
    ),
  );
  const bootstrapTransaction = idOf(
    await scratch.query(
      `INSERT INTO oidc_login_transaction (bootstrap_setup_id, purpose,
        state_hash, browser_binding_hash, transaction_secret_ciphertext,
        transaction_secret_nonce, transaction_secret_tag, transaction_secret_key_id,
        expires_at)
       VALUES ($1, 'bootstrap', decode('08', 'hex'), decode('09', 'hex'),
        decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), 'key-1',
        statement_timestamp() + interval '10 minutes') RETURNING id`,
      [setup],
    ),
  );
  const enrollmentGrant = idOf(
    await scratch.query(
      `INSERT INTO identity_enrollment_grant (tenant_id, organization_id, account_id,
        identity_provider_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, decode('0a', 'hex'), statement_timestamp() + interval '1 hour')
       RETURNING id`,
      [tenantId, school, account, provider],
    ),
  );
  const enrollmentTransaction = idOf(
    await scratch.query(
      `INSERT INTO oidc_login_transaction (tenant_id, identity_provider_id,
        identity_enrollment_grant_id, purpose, state_hash, browser_binding_hash,
        transaction_secret_ciphertext, transaction_secret_nonce, transaction_secret_tag,
        transaction_secret_key_id, expires_at)
       VALUES ($1, $2, $3, 'enrollment', decode('0b', 'hex'), decode('0c', 'hex'),
        decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), 'key-1',
        statement_timestamp() + interval '10 minutes') RETURNING id`,
      [tenantId, provider, enrollmentGrant],
    ),
  );
  return {
    tenantId,
    account,
    provider,
    oidcSession,
    recoverySession,
    loginTransaction,
    bootstrapTransaction,
    enrollmentTransaction,
  };
}

describe('migration 009 guided setup authentication', () => {
  it('upgrades a real Phase 8 database 008 -> 009', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '008_school_control_plane');
      await migrateToLatest(handle.database);
      const rows = await scratch.query<{ name: string }>(
        "SELECT name FROM kysely_migration WHERE name = '009_guided_setup_authentication'",
      );
      expect(rows.rows).toHaveLength(1);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('preserves existing sessions and transactions across 008 -> 009', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '008_school_control_plane');
      const seed = await seedPhase8(scratch, randomUUID().replaceAll('-', '').slice(0, 8));
      await migrateToLatest(handle.database);

      const sessions = await scratch.query<{ id: string; authentication_method: string }>(
        'SELECT id, authentication_method FROM auth_session ORDER BY created_at',
      );
      expect(sessions.rows.map((row) => row.authentication_method).sort()).toEqual([
        'oidc',
        'recovery',
      ]);
      expect(sessions.rows.map((row) => row.id).sort()).toEqual(
        [seed.oidcSession, seed.recoverySession].sort(),
      );
      const transactions = await scratch.query<{ id: string; purpose: string }>(
        'SELECT id, purpose FROM oidc_login_transaction ORDER BY created_at',
      );
      expect(transactions.rows.map((row) => row.purpose).sort()).toEqual([
        'bootstrap',
        'enrollment',
        'login',
      ]);
      expect(transactions.rows.map((row) => row.id).sort()).toEqual(
        [seed.loginTransaction, seed.bootstrapTransaction, seed.enrollmentTransaction].sort(),
      );

      // New setup sessions are accepted.
      const setupSession = idOf(
        await scratch.query(
          `INSERT INTO auth_session (tenant_id, account_id, token_hash, csrf_token_hash,
            account_session_revision, authentication_method, idle_expires_at, absolute_expires_at)
           VALUES ($1, $2, decode('0d', 'hex'), decode('0e', 'hex'), 0, 'setup',
            statement_timestamp() + interval '12 hours', statement_timestamp() + interval '24 hours')
           RETURNING id`,
          [seed.tenantId, seed.account],
        ),
      );
      expect(setupSession.length).toBeGreaterThan(0);

      // New provider_setup transactions bind the predetermined account.
      const setupTransaction = idOf(
        await scratch.query(
          `INSERT INTO oidc_login_transaction (tenant_id, provider_setup_account_id, purpose,
            state_hash, browser_binding_hash, transaction_secret_ciphertext,
            transaction_secret_nonce, transaction_secret_tag, transaction_secret_key_id,
            expires_at)
           VALUES ($1, $2, 'provider_setup', decode('0f', 'hex'), decode('10', 'hex'),
            decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), 'key-1',
            statement_timestamp() + interval '10 minutes') RETURNING id`,
          [seed.tenantId, seed.account],
        ),
      );
      expect(setupTransaction.length).toBeGreaterThan(0);

      // Invalid combinations are rejected: provider_setup without an
      // account, login carrying a setup account, and unknown methods.
      await expect(
        scratch.query(
          `INSERT INTO oidc_login_transaction (tenant_id, purpose, state_hash,
            browser_binding_hash, transaction_secret_ciphertext, transaction_secret_nonce,
            transaction_secret_tag, transaction_secret_key_id, expires_at)
           VALUES ($1, 'provider_setup', decode('11', 'hex'), decode('12', 'hex'),
            decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), 'key-1',
            statement_timestamp() + interval '10 minutes')`,
          [seed.tenantId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        scratch.query(
          `INSERT INTO auth_session (tenant_id, account_id, token_hash, csrf_token_hash,
            account_session_revision, authentication_method, idle_expires_at, absolute_expires_at)
           VALUES ($1, $2, decode('13', 'hex'), decode('14', 'hex'), 0, 'sso',
            statement_timestamp() + interval '1 hour', statement_timestamp() + interval '1 day')`,
          [seed.tenantId, seed.account],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });
});
