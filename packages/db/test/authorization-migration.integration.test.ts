import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../src/database.js';
import { EXPECTED_MIGRATION, createMigrator, migrateToLatest } from '../src/migrator.js';

let databaseName: string;
let administrationUrl: string;
let databaseUrl: string;
let pool: Pool;

function quotedIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('Unsafe database identifier');
  return `"${value}"`;
}

async function freshDatabase(): Promise<{ url: string; pool: Pool }> {
  const base = new URL(process.env.DATABASE_URL ?? '');
  const name = `openhall_test_${randomUUID().replaceAll('-', '')}`;
  const administration = new URL(base);
  administration.pathname = '/postgres';
  const client = new Client({ connectionString: administration.toString() });
  await client.connect();
  await client.query(`CREATE DATABASE ${quotedIdentifier(name)}`);
  await client.end();
  const target = new URL(base);
  target.pathname = `/${name}`;
  const url = target.toString();
  return { url, pool: new Pool({ connectionString: url, max: 4 }) };
}

async function migrateTo(handle: DatabaseHandle, target: string) {
  const result = await createMigrator(handle.database).migrateTo(target);
  if (result.error) {
    throw result.error instanceof Error ? result.error : new Error(`Migration to ${target} failed`);
  }
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const base = new URL(process.env.DATABASE_URL);
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
  pool = new Pool({ connectionString: databaseUrl, max: 4 });
});

afterAll(async () => {
  await pool.end();
  const client = new Client({ connectionString: administrationUrl });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`);
  await client.end();
});

describe('migration 004 authorization relationships', () => {
  it('advances the expected migration marker', () => {
    expect(EXPECTED_MIGRATION).toBe('006_movement_policy_approvals_overrides');
  });

  it('migrates a blank database 001 -> 004', async () => {
    const { url, pool: scratch } = await freshDatabase();
    try {
      const handle = createDatabase(url, { max: 1 });
      try {
        await migrateToLatest(handle.database);
      } finally {
        await handle.destroy();
      }
      const constraints = (
        await scratch.query<{ name: string }>(
          `SELECT conname AS name FROM pg_constraint WHERE conname LIKE 'authorization_grant_phase4%' ORDER BY 1`,
        )
      ).rows.map((row) => row.name);
      expect(constraints).toEqual([
        'authorization_grant_phase4_role_check',
        'authorization_grant_phase4_role_scope_check',
      ]);
      const indexes = (
        await scratch.query<{ name: string }>(
          `SELECT indexname AS name FROM pg_indexes WHERE indexname LIKE '%phase4%' ORDER BY 1`,
        )
      ).rows.map((row) => row.name);
      expect(indexes).toEqual([
        'authorization_grant_phase4_account_active_idx',
        'organization_membership_phase4_person_active_idx',
      ]);
    } finally {
      await scratch.end();
    }
  });

  it('upgrades a real Phase 3 schema 003 -> 004', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '003_identity_secure_sessions');
      const tenant = (
        await scratch.query<{ id: string }>(
          `INSERT INTO tenant (name, slug) VALUES ('T', 't-upgrade') RETURNING id`,
        )
      ).rows[0]?.id;
      const person = (
        await scratch.query<{ id: string }>(
          `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'A', 'B', 'A B') RETURNING id`,
          [tenant],
        )
      ).rows[0]?.id;
      const account = (
        await scratch.query<{ id: string }>(
          `INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id`,
          [tenant, person],
        )
      ).rows[0]?.id;
      const organization = (
        await scratch.query<{ id: string }>(
          `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'S', 's-upgrade', 'America/New_York') RETURNING id`,
          [tenant],
        )
      ).rows[0]?.id;
      // A valid Phase 3 explicit grant survives the upgrade.
      await scratch.query(
        `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, 'counselor', 'organization', $3)`,
        [tenant, account, organization],
      );
      await migrateToLatest(handle.database);
      const surviving = await scratch.query<{ role: string }>(
        `SELECT role FROM authorization_grant WHERE tenant_id = $1`,
        [tenant],
      );
      expect(surviving.rows.map((row) => row.role)).toEqual(['counselor']);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('refuses legacy student/teacher grants instead of reinterpreting them', async () => {
    for (const role of ['student', 'teacher']) {
      const { url, pool: scratch } = await freshDatabase();
      const handle = createDatabase(url, { max: 1 });
      try {
        await migrateTo(handle, '003_identity_secure_sessions');
        const tenant = (
          await scratch.query<{ id: string }>(
            `INSERT INTO tenant (name, slug) VALUES ('T', 't-${role}') RETURNING id`,
          )
        ).rows[0]?.id;
        const person = (
          await scratch.query<{ id: string }>(
            `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'A', 'B', 'A B') RETURNING id`,
            [tenant],
          )
        ).rows[0]?.id;
        const account = (
          await scratch.query<{ id: string }>(
            `INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id`,
            [tenant, person],
          )
        ).rows[0]?.id;
        // Scope columns must satisfy the foundation shape check; section
        // scope needs a real section, so use tenant scope (valid in Phase 3).
        await scratch.query(
          `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind) VALUES ($1, $2, $3, 'tenant')`,
          [tenant, account, role],
        );
        await expect(migrateToLatest(handle.database)).rejects.toThrow(
          /legacy.*authorization_grant/i,
        );
      } finally {
        await handle.destroy();
        await scratch.end();
      }
    }
  });

  it('enforces the role vocabulary and role/scope combinations', async () => {
    const handle = createDatabase(databaseUrl, { max: 1 });
    try {
      await migrateToLatest(handle.database);
    } finally {
      await handle.destroy();
    }
    const nonce = randomUUID().replaceAll('-', '');
    const tenant = (
      await pool.query<{ id: string }>(
        `INSERT INTO tenant (name, slug) VALUES ('T', 't-${nonce}') RETURNING id`,
      )
    ).rows[0]?.id;
    const person = (
      await pool.query<{ id: string }>(
        `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'A', 'B', 'A B') RETURNING id`,
        [tenant],
      )
    ).rows[0]?.id;
    const account = (
      await pool.query<{ id: string }>(
        `INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id`,
        [tenant, person],
      )
    ).rows[0]?.id;
    const organization = (
      await pool.query<{ id: string }>(
        `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'S', 's-${nonce}', 'America/New_York') RETURNING id`,
        [tenant],
      )
    ).rows[0]?.id;

    // student/teacher roles are no longer accepted.
    await expect(
      pool.query(
        `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind) VALUES ($1, $2, 'student', 'tenant')`,
        [tenant, account],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind) VALUES ($1, $2, 'teacher', 'tenant')`,
        [tenant, account],
      ),
    ).rejects.toThrow();

    // system_admin requires tenant scope; school_admin requires organization scope.
    await expect(
      pool.query(
        `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, 'system_admin', 'organization', $3)`,
        [tenant, account, organization],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind) VALUES ($1, $2, 'school_admin', 'tenant')`,
        [tenant, account],
      ),
    ).rejects.toThrow();

    // Valid combinations succeed.
    await pool.query(
      `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind) VALUES ($1, $2, 'system_admin', 'tenant')`,
      [tenant, account],
    );
    await pool.query(
      `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id) VALUES ($1, $2, 'school_admin', 'organization', $3)`,
      [tenant, account, organization],
    );
  });
});
