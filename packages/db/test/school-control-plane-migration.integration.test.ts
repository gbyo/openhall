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

/** Tenant with one school, one district, one person/account, one provider. */
async function seedControlPlane(scratch: Pool, tag: string) {
  const tenantId = idOf(
    await scratch.query(`INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id`, [
      `T-${tag}`,
      `tcp-${tag}`,
    ]),
  );
  const school = idOf(
    await scratch.query(
      `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'School', $2, 'America/New_York') RETURNING id`,
      [tenantId, `cp-school-${tag}`],
    ),
  );
  const district = idOf(
    await scratch.query(
      `INSERT INTO organization (tenant_id, kind, name, slug) VALUES ($1, 'district', 'District', $2) RETURNING id`,
      [tenantId, `cp-district-${tag}`],
    ),
  );
  const person = idOf(
    await scratch.query(
      `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'Ada', 'Lovelace', 'Ada Lovelace') RETURNING id`,
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
      [tenantId, `test-${tag}`],
    ),
  );
  const location = idOf(
    await scratch.query(
      `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'clinic', 'Clinic') RETURNING id`,
      [tenantId, school],
    ),
  );
  const destination = idOf(
    await scratch.query(
      `INSERT INTO destination (tenant_id, organization_id, location_id, service_type) VALUES ($1, $2, $3, 'nurse') RETURNING id`,
      [tenantId, school, location],
    ),
  );
  return { tenantId, school, district, person, account, provider, location, destination };
}

describe('migration 008 school control plane', () => {
  it('migrates a blank database 001 -> 009', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const rows = await scratch.query<{ name: string }>(
        'SELECT name FROM kysely_migration ORDER BY name',
      );
      expect(rows.rows.map((row) => row.name)).toEqual([
        '001_foundation',
        '002_scheduling_expected_placement',
        '003_identity_secure_sessions',
        '004_authorization_relationships',
        '005_pass_command_core',
        '006_movement_policy_approvals_overrides',
        '007_destination_flow_and_movement',
        '008_school_control_plane',
        '009_guided_setup_authentication',
      ]);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('upgrades a real Phase 7 database 007 -> 008', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '007_destination_flow_and_movement');
      await migrateToLatest(handle.database);
      const rows = await scratch.query<{ name: string }>(
        "SELECT name FROM kysely_migration WHERE name = '008_school_control_plane'",
      );
      expect(rows.rows).toHaveLength(1);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('preserves legacy policy reason rows across the 007 -> 008 vocabulary rebuild', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '007_destination_flow_and_movement');
      const seed = await seedControlPlane(scratch, 'reason');
      const passId = idOf(
        await scratch.query(
          `INSERT INTO pass (tenant_id, organization_id, student_id, destination_id,
            request_source, lifecycle_state) VALUES ($1, $2, $3, $4, 'staff_web', 'requested') RETURNING id`,
          [seed.tenantId, seed.school, seed.person, seed.destination],
        ),
      );
      const ruleId = idOf(
        await scratch.query(
          `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind,
            scope_organization_id, configuration, override_mode)
           VALUES ($1, $2, 'Legacy', 'schedule_boundary', 'organization', $2,
             '{"schemaVersion":1,"firstMinutes":1,"lastMinutes":60,"blockKinds":["instructional"],"requestSources":["staff_web"]}',
             'never') RETURNING id`,
          [seed.tenantId, seed.school],
        ),
      );
      const evaluationId = idOf(
        await scratch.query(
          `INSERT INTO policy_evaluation (tenant_id, pass_id, pass_revision, stage, decision)
           VALUES ($1, $2, 1, 'request', 'allow') RETURNING id`,
          [seed.tenantId, passId],
        ),
      );
      await scratch.query(
        `INSERT INTO policy_evaluation_result
          (tenant_id, evaluation_id, policy_rule_id, policy_rule_revision, outcome,
           reason_code, override_mode, rule_snapshot, contribution)
         VALUES ($1, $2, $3, 1, 'pass', 'approval_satisfied', 'never', '{}', 'none')`,
        [seed.tenantId, evaluationId, ruleId],
      );

      await migrateToLatest(handle.database);

      const legacy = await scratch.query<{ reason_code: string }>(
        `SELECT reason_code FROM policy_evaluation_result WHERE evaluation_id = $1`,
        [evaluationId],
      );
      expect(legacy.rows.map((row) => row.reason_code)).toEqual(['approval_satisfied']);
      // The rebuilt CHECK carries the Phase 8 preapproval code.
      await scratch.query(
        `INSERT INTO policy_evaluation_result
          (tenant_id, evaluation_id, policy_rule_id, policy_rule_revision, outcome,
           reason_code, override_mode, rule_snapshot, contribution)
         VALUES ($1, $2, $3, 1, 'pass', 'scheduled_preapproval_satisfied', 'never', '{}', 'none')`,
        [seed.tenantId, evaluationId, ruleId],
      );
      const names = await scratch.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conname LIKE 'policy_evaluation_result_phase%_reason_code'`,
      );
      expect(names.rows.map((row) => row.conname)).toEqual([
        'policy_evaluation_result_phase8_reason_code',
      ]);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('versions locations and destinations without rewriting identity', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const seed = await seedControlPlane(scratch, randomUUID().replaceAll('-', '').slice(0, 8));
      const location = await scratch.query<{ revision: string }>(
        'SELECT revision FROM location WHERE id = $1',
        [seed.location],
      );
      expect(location.rows[0]?.revision).toBe('1');
      await expect(
        scratch.query('UPDATE location SET revision = 0 WHERE id = $1', [seed.location]),
      ).rejects.toMatchObject({ code: '23514' });
      const destination = await scratch.query<{ revision: string; updated_at: string }>(
        'SELECT revision, updated_at FROM destination WHERE id = $1',
        [seed.destination],
      );
      expect(destination.rows[0]?.revision).toBe('1');
      expect(destination.rows[0]?.updated_at).toBeDefined();
      await handle.destroy();
    } finally {
      await scratch.end();
    }
  });

  it('backfills schedule configuration for schools only', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '007_destination_flow_and_movement');
      const tenantId = idOf(
        await scratch.query(`INSERT INTO tenant (name, slug) VALUES ('T', 'tback') RETURNING id`),
      );
      const school = idOf(
        await scratch.query(
          `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'S', 'sback', 'America/New_York') RETURNING id`,
          [tenantId],
        ),
      );
      const district = idOf(
        await scratch.query(
          `INSERT INTO organization (tenant_id, kind, name, slug) VALUES ($1, 'district', 'D', 'dback') RETURNING id`,
          [tenantId],
        ),
      );
      await migrateToLatest(handle.database);
      const rows = await scratch.query<{ organization_id: string; revision: string }>(
        'SELECT organization_id, revision FROM school_schedule_configuration WHERE tenant_id = $1',
        [tenantId],
      );
      expect(rows.rows.map((row) => row.organization_id)).toEqual([school]);
      expect(rows.rows[0]?.revision).toBe('1');
      const districtRows = await scratch.query(
        'SELECT id FROM school_schedule_configuration WHERE organization_id = $1',
        [district],
      );
      expect(districtRows.rows).toHaveLength(0);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('keeps archived policy rules disabled and historical', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const seed = await seedControlPlane(scratch, randomUUID().replaceAll('-', '').slice(0, 8));
      const rule = idOf(
        await scratch.query(
          `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind, scope_organization_id,
            configuration, override_mode, enabled)
           VALUES ($1, $2, 'R', 'schedule_boundary', 'organization', $2,
            '{"schemaVersion": 1, "firstMinutes": 5, "lastMinutes": 10, "blockKinds": ["lunch"], "requestSources": ["student_web"]}',
            'never', false) RETURNING id`,
          [seed.tenantId, seed.school],
        ),
      );
      await expect(
        scratch.query(
          'UPDATE policy_rule SET archived_at = statement_timestamp(), enabled = true WHERE id = $1',
          [rule],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await scratch.query(
        'UPDATE policy_rule SET archived_at = statement_timestamp() WHERE id = $1',
        [rule],
      );
      const archived = await scratch.query<{ archived_at: string; enabled: boolean }>(
        'SELECT archived_at, enabled FROM policy_rule WHERE id = $1',
        [rule],
      );
      expect(archived.rows[0]?.archived_at).toBeDefined();
      expect(archived.rows[0]?.enabled).toBe(false);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('prevents duplicate active authorization grants without fabricating provenance', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const seed = await seedControlPlane(scratch, randomUUID().replaceAll('-', '').slice(0, 8));
      await scratch.query(
        `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id)
         VALUES ($1, $2, 'counselor', 'organization', $3)`,
        [seed.tenantId, seed.account, seed.school],
      );
      await expect(
        scratch.query(
          `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, organization_id)
           VALUES ($1, $2, 'counselor', 'organization', $3)`,
          [seed.tenantId, seed.account, seed.school],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await scratch.query(
        `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, destination_id)
         VALUES ($1, $2, 'destination_staff', 'destination', $3)`,
        [seed.tenantId, seed.account, seed.destination],
      );
      await expect(
        scratch.query(
          `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, destination_id)
           VALUES ($1, $2, 'destination_staff', 'destination', $3)`,
          [seed.tenantId, seed.account, seed.destination],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      const provenance = await scratch.query<{
        revision: string;
        created_by_account_id: string | null;
      }>(
        'SELECT revision, created_by_account_id FROM authorization_grant WHERE account_id = $1 LIMIT 1',
        [seed.account],
      );
      expect(provenance.rows[0]?.revision).toBe('1');
      expect(provenance.rows[0]?.created_by_account_id).toBeNull();
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('constrains scheduled authorizations to their own school', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const seed = await seedControlPlane(scratch, randomUUID().replaceAll('-', '').slice(0, 8));
      await scratch.query(
        `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'room', 'Other')`,
        [seed.tenantId, seed.school],
      );
      const otherSchool = idOf(
        await scratch.query(
          `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'Other', $2, 'America/New_York') RETURNING id`,
          [seed.tenantId, `other-${randomUUID().replaceAll('-', '').slice(0, 8)}`],
        ),
      );
      const otherLocationB = idOf(
        await scratch.query(
          `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'room', 'B') RETURNING id`,
          [seed.tenantId, otherSchool],
        ),
      );
      const otherDestination = idOf(
        await scratch.query(
          `INSERT INTO destination (tenant_id, organization_id, location_id, service_type) VALUES ($1, $2, $3, 'nurse') RETURNING id`,
          [seed.tenantId, otherSchool, otherLocationB],
        ),
      );
      await expect(
        scratch.query(
          `INSERT INTO scheduled_authorization (tenant_id, organization_id, student_id, destination_id,
            created_by_person_id, valid_from, valid_until, approval_mode, origin_strategy)
           VALUES ($1, $2, $3, $4, $3, statement_timestamp(), statement_timestamp() + interval '1 hour',
            'preapproved', 'expected')`,
          [seed.tenantId, seed.school, seed.person, otherDestination],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      const revision = await scratch.query<{ revision: string }>(
        `INSERT INTO scheduled_authorization (tenant_id, organization_id, student_id, destination_id,
          created_by_person_id, valid_from, valid_until, approval_mode, origin_strategy)
         VALUES ($1, $2, $3, $4, $3, statement_timestamp(), statement_timestamp() + interval '1 hour',
          'preapproved', 'expected') RETURNING revision`,
        [seed.tenantId, seed.school, seed.person, seed.destination],
      );
      expect(revision.rows[0]?.revision).toBe('1');
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('stores enrollment digests with single-live-grant protection', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const seed = await seedControlPlane(scratch, randomUUID().replaceAll('-', '').slice(0, 8));
      const grant = idOf(
        await scratch.query(
          `INSERT INTO identity_enrollment_grant (tenant_id, organization_id, account_id,
            identity_provider_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, decode('aabb', 'hex'), statement_timestamp() + interval '24 hours')
           RETURNING id`,
          [seed.tenantId, seed.school, seed.account, seed.provider],
        ),
      );
      await expect(
        scratch.query(
          `INSERT INTO identity_enrollment_grant (tenant_id, organization_id, account_id,
            identity_provider_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, decode('ccdd', 'hex'), statement_timestamp() + interval '24 hours')`,
          [seed.tenantId, seed.school, seed.account, seed.provider],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        scratch.query(
          `INSERT INTO identity_enrollment_grant (tenant_id, organization_id, account_id,
            identity_provider_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, decode('eeff', 'hex'), statement_timestamp() - interval '1 hour')`,
          [seed.tenantId, seed.school, seed.account, seed.provider],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await scratch.query(
        'UPDATE identity_enrollment_grant SET consumed_at = statement_timestamp() WHERE id = $1',
        [grant],
      );
      const second = idOf(
        await scratch.query(
          `INSERT INTO identity_enrollment_grant (tenant_id, organization_id, account_id,
            identity_provider_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, decode('ccdd', 'hex'), statement_timestamp() + interval '24 hours')
           RETURNING id`,
          [seed.tenantId, seed.school, seed.account, seed.provider],
        ),
      );
      expect(second).toBeDefined();
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('binds OIDC enrollment transactions to exactly one grant', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const seed = await seedControlPlane(scratch, randomUUID().replaceAll('-', '').slice(0, 8));
      const grant = idOf(
        await scratch.query(
          `INSERT INTO identity_enrollment_grant (tenant_id, organization_id, account_id,
            identity_provider_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, decode('aabb', 'hex'), statement_timestamp() + interval '24 hours')
           RETURNING id`,
          [seed.tenantId, seed.school, seed.account, seed.provider],
        ),
      );
      await scratch.query(
        `INSERT INTO oidc_login_transaction (tenant_id, identity_provider_id, purpose,
          identity_enrollment_grant_id, state_hash, browser_binding_hash,
          transaction_secret_ciphertext, transaction_secret_nonce, transaction_secret_tag,
          transaction_secret_key_id, expires_at)
         VALUES ($1, $2, 'enrollment', $3, decode('aa', 'hex'), decode('bb', 'hex'),
          decode('cc', 'hex'), decode('dd', 'hex'), decode('ee', 'hex'), 'key-1',
          statement_timestamp() + interval '10 minutes')`,
        [seed.tenantId, seed.provider, grant],
      );
      await expect(
        scratch.query(
          `INSERT INTO oidc_login_transaction (tenant_id, identity_provider_id, purpose,
            state_hash, browser_binding_hash,
            transaction_secret_ciphertext, transaction_secret_nonce, transaction_secret_tag,
            transaction_secret_key_id, expires_at)
           VALUES ($1, $2, 'enrollment', decode('ff', 'hex'), decode('bb', 'hex'),
            decode('cc', 'hex'), decode('dd', 'hex'), decode('ee', 'hex'), 'key-1',
            statement_timestamp() + interval '10 minutes')`,
          [seed.tenantId, seed.provider],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        scratch.query(
          `INSERT INTO oidc_login_transaction (tenant_id, identity_provider_id, purpose,
            identity_enrollment_grant_id, state_hash, browser_binding_hash,
            transaction_secret_ciphertext, transaction_secret_nonce, transaction_secret_tag,
            transaction_secret_key_id, expires_at)
           VALUES ($1, $2, 'login', $3, decode('ab', 'hex'), decode('bb', 'hex'),
            decode('cc', 'hex'), decode('dd', 'hex'), decode('ee', 'hex'), 'key-1',
            statement_timestamp() + interval '10 minutes')`,
          [seed.tenantId, seed.provider, grant],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('snapshots departure check-in mode without rewriting history', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const seed = await seedControlPlane(scratch, randomUUID().replaceAll('-', '').slice(0, 8));
      const pass = idOf(
        await scratch.query(
          `INSERT INTO pass (tenant_id, organization_id, student_id, destination_id, request_source, lifecycle_state)
           VALUES ($1, $2, $3, $4, 'student_web', 'ready') RETURNING id`,
          [seed.tenantId, seed.school, seed.person, seed.destination],
        ),
      );
      const legacy = await scratch.query<{ departure_check_in_mode: string | null }>(
        'SELECT departure_check_in_mode FROM pass WHERE id = $1',
        [pass],
      );
      expect(legacy.rows[0]?.departure_check_in_mode).toBeNull();
      await expect(
        scratch.query("UPDATE pass SET departure_check_in_mode = 'sometimes' WHERE id = $1", [
          pass,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await scratch.query(
        "UPDATE pass SET departure_check_in_mode = 'optional', departure_destination_revision = 3 WHERE id = $1",
        [pass],
      );
      const snapshotted = await scratch.query<{
        departure_check_in_mode: string;
        departure_destination_revision: string;
      }>('SELECT departure_check_in_mode, departure_destination_revision FROM pass WHERE id = $1', [
        pass,
      ]);
      expect(snapshotted.rows[0]?.departure_check_in_mode).toBe('optional');
      expect(snapshotted.rows[0]?.departure_destination_revision).toBe('3');
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });
});
