import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../src/database.js';
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

function nonce(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12);
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

async function migrateTo(handle: DatabaseHandle, target: string) {
  const result = await createMigrator(handle.database).migrateTo(target);
  if (result.error) {
    throw result.error instanceof Error ? result.error : new Error(`Migration to ${target} failed`);
  }
}

async function migrationNames(scratch: Pool): Promise<string[]> {
  const rows = await scratch.query<{ name: string }>(
    'SELECT name FROM kysely_migration ORDER BY name',
  );
  return rows.rows.map((row) => row.name);
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

/** Minimal school graph: tenant, school, student, destination, requested pass. */
async function seedSchool(scratch: Pool, tag: string) {
  const tenantId = idOf(
    await scratch.query(`INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id`, [
      `T-${tag}`,
      `t-${tag}`,
    ]),
  );
  const school = idOf(
    await scratch.query(
      `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'S', $2, 'America/New_York') RETURNING id`,
      [tenantId, `s-${tag}`],
    ),
  );
  const otherSchool = idOf(
    await scratch.query(
      `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'O', $2, 'America/New_York') RETURNING id`,
      [tenantId, `o-${tag}`],
    ),
  );
  const student = idOf(
    await scratch.query(
      `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'A', 'B', 'A B') RETURNING id`,
      [tenantId],
    ),
  );
  const location = idOf(
    await scratch.query(
      `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'clinic', 'C') RETURNING id`,
      [tenantId, school],
    ),
  );
  // destination_category exists only from migration 010 on; pinned-version
  // fixtures must not reference it while latest-level fixtures must.
  const hasCategories =
    (
      await scratch.query<{ reg: string | null }>(
        `SELECT to_regclass('destination_category') AS reg`,
      )
    ).rows[0]?.reg !== null;
  const category = hasCategories
    ? idOf(
        await scratch.query(
          `INSERT INTO destination_category (tenant_id, organization_id, name) VALUES ($1, $2, 'Nurse') RETURNING id`,
          [tenantId, school],
        ),
      )
    : null;
  const destination = idOf(
    await scratch.query(
      hasCategories
        ? `INSERT INTO destination (tenant_id, organization_id, location_id, category_id, service_type, display_name) VALUES ($1, $2, $3, $4, 'nurse', 'N') RETURNING id`
        : `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name) VALUES ($1, $2, $3, 'nurse', 'N') RETURNING id`,
      hasCategories && category !== null
        ? [tenantId, school, location, category]
        : [tenantId, school, location],
    ),
  );
  const pass = idOf(
    await scratch.query(
      `INSERT INTO pass (tenant_id, organization_id, student_id, destination_id, request_source, lifecycle_state) VALUES ($1, $2, $3, $4, 'student_web', 'requested') RETURNING id`,
      [tenantId, school, student, destination],
    ),
  );
  return { tenantId, school, otherSchool, student, destination, pass };
}

async function seedEvaluation(scratch: Pool, school: { tenantId: string; pass: string }) {
  return idOf(
    await scratch.query(
      `INSERT INTO policy_evaluation (tenant_id, pass_id, pass_revision, stage, decision) VALUES ($1, $2, 1, 'request', 'allow') RETURNING id`,
      [school.tenantId, school.pass],
    ),
  );
}

describe('migration 007 destination flow and movement', () => {
  it('migrates a blank database 001 -> 010 with flow hardening', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      expect(await migrationNames(scratch)).toEqual([
        '001_foundation',
        '002_scheduling_expected_placement',
        '003_identity_secure_sessions',
        '004_authorization_relationships',
        '005_pass_command_core',
        '006_movement_policy_approvals_overrides',
        '007_destination_flow_and_movement',
        '008_school_control_plane',
        '009_guided_setup_authentication',
        '010_destination_categories',
      ]);
      const constraints = await scratch.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conname LIKE '%phase7%' ORDER BY 1`,
      );
      expect(constraints.rows.length).toBeGreaterThan(15);
      const columns = await scratch.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'destination' AND column_name IN ('ready_claim_timeout_seconds', 'queue_timeout_seconds')`,
      );
      expect(columns.rows).toHaveLength(2);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('upgrades a real Phase 6 database 006 -> 007 with flow defaults', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '006_movement_policy_approvals_overrides');
      const school = await seedSchool(scratch, nonce());
      await migrateTo(handle, '007_destination_flow_and_movement');
      const destination = (
        await scratch.query<{
          ready_claim_timeout_seconds: number;
          queue_timeout_seconds: number;
          capacity: number | null;
          queue_enabled: boolean;
          check_in_mode: string;
        }>(
          `SELECT ready_claim_timeout_seconds, queue_timeout_seconds, capacity, queue_enabled, check_in_mode
           FROM destination WHERE id = $1`,
          [school.destination],
        )
      ).rows[0];
      expect(destination?.ready_claim_timeout_seconds).toBe(60);
      expect(destination?.queue_timeout_seconds).toBe(600);
      expect(destination?.capacity).toBeNull();
      // Foundation defaults are preserved: queueing stays opt-in per
      // destination, unlimited capacity stays the default.
      expect(destination?.queue_enabled).toBe(false);
      expect(destination?.check_in_mode).toBe('none');
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('refuses the 006 -> 007 upgrade when dormant flow tables hold legacy rows', async () => {
    for (const table of ['destination_reservation', 'queue_entry'] as const) {
      const { url, pool: scratch } = await freshDatabase();
      const handle = createDatabase(url, { max: 1 });
      try {
        await migrateTo(handle, '006_movement_policy_approvals_overrides');
        const school = await seedSchool(scratch, nonce());
        await scratch.query(
          `INSERT INTO ${table} (tenant_id, destination_id, pass_id) VALUES ($1, $2, $3)`,
          [school.tenantId, school.destination, school.pass],
        );
        await expect(migrateTo(handle, '007_destination_flow_and_movement')).rejects.toThrow(
          /predate operational/,
        );
      } finally {
        await handle.destroy();
        await scratch.end();
      }
    }
  });

  it('bounds destination flow timeouts at the database boundary', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const school = await seedSchool(scratch, nonce());
      await expect(
        scratch.query(`UPDATE destination SET ready_claim_timeout_seconds = 4 WHERE id = $1`, [
          school.destination,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        scratch.query(`UPDATE destination SET ready_claim_timeout_seconds = 601 WHERE id = $1`, [
          school.destination,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        scratch.query(`UPDATE destination SET queue_timeout_seconds = 59 WHERE id = $1`, [
          school.destination,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        scratch.query(`UPDATE destination SET queue_timeout_seconds = 14401 WHERE id = $1`, [
          school.destination,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await scratch.query(
        `UPDATE destination SET ready_claim_timeout_seconds = 5, queue_timeout_seconds = 14400 WHERE id = $1`,
        [school.destination],
      );
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('rejects cross-school flow references at the database boundary', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const school = await seedSchool(scratch, nonce());
      const evaluationId = await seedEvaluation(scratch, school);
      // A reservation for another school's destination cannot bind this pass.
      const foreignLocation = idOf(
        await scratch.query(
          `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'clinic', 'F') RETURNING id`,
          [school.tenantId, school.otherSchool],
        ),
      );
      const foreignCategory = idOf(
        await scratch.query(
          `INSERT INTO destination_category (tenant_id, organization_id, name) VALUES ($1, $2, 'Foreign Nurse') RETURNING id`,
          [school.tenantId, school.otherSchool],
        ),
      );
      const foreignDestination = idOf(
        await scratch.query(
          `INSERT INTO destination (tenant_id, organization_id, location_id, category_id, service_type) VALUES ($1, $2, $3, $4, 'nurse') RETURNING id`,
          [school.tenantId, school.otherSchool, foreignLocation, foreignCategory],
        ),
      );
      await expect(
        scratch.query(
          `INSERT INTO destination_reservation
             (tenant_id, organization_id, destination_id, pass_id, policy_evaluation_id, ready_expires_at, flow_expires_at)
           VALUES ($1, $2, $3, $4, $5, statement_timestamp() + interval '1 minute', statement_timestamp() + interval '10 minutes')`,
          [school.tenantId, school.school, foreignDestination, school.pass, evaluationId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await expect(
        scratch.query(
          `INSERT INTO queue_entry
             (tenant_id, organization_id, destination_id, pass_id, policy_evaluation_id, flow_expires_at)
           VALUES ($1, $2, $3, $4, $5, statement_timestamp() + interval '10 minutes')`,
          [school.tenantId, school.school, foreignDestination, school.pass, evaluationId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('binds flow rows to an evaluation of the same pass', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const school = await seedSchool(scratch, nonce());
      const otherStudent = idOf(
        await scratch.query(
          `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'C', 'D', 'C D') RETURNING id`,
          [school.tenantId],
        ),
      );
      const otherPass = idOf(
        await scratch.query(
          `INSERT INTO pass (tenant_id, organization_id, student_id, destination_id, request_source, lifecycle_state)
           VALUES ($1, $2, $3, $4, 'student_web', 'requested') RETURNING id`,
          [school.tenantId, school.school, otherStudent, school.destination],
        ),
      );
      const foreignEvaluation = idOf(
        await scratch.query(
          `INSERT INTO policy_evaluation (tenant_id, pass_id, pass_revision, stage, decision)
           VALUES ($1, $2, 1, 'request', 'allow') RETURNING id`,
          [school.tenantId, otherPass],
        ),
      );
      await expect(
        scratch.query(
          `INSERT INTO destination_reservation
             (tenant_id, organization_id, destination_id, pass_id, policy_evaluation_id, ready_expires_at, flow_expires_at)
           VALUES ($1, $2, $3, $4, $5, statement_timestamp() + interval '1 minute', statement_timestamp() + interval '10 minutes')`,
          [school.tenantId, school.school, school.destination, school.pass, foreignEvaluation],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('closes the release-reason vocabularies and coherence checks', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const school = await seedSchool(scratch, nonce());
      const evaluationId = await seedEvaluation(scratch, school);
      // Unknown release reason.
      await expect(
        scratch.query(
          `INSERT INTO destination_reservation
             (tenant_id, organization_id, destination_id, pass_id, policy_evaluation_id, ready_expires_at, flow_expires_at, released_at, release_reason)
           VALUES ($1, $2, $3, $4, $5, statement_timestamp() + interval '1 minute', statement_timestamp() + interval '10 minutes', statement_timestamp(), 'mystery')`,
          [school.tenantId, school.school, school.destination, school.pass, evaluationId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      // Released without a reason and vice versa.
      await expect(
        scratch.query(
          `INSERT INTO queue_entry
             (tenant_id, organization_id, destination_id, pass_id, policy_evaluation_id, flow_expires_at, released_at)
           VALUES ($1, $2, $3, $4, $5, statement_timestamp() + interval '10 minutes', statement_timestamp())`,
          [school.tenantId, school.school, school.destination, school.pass, evaluationId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        scratch.query(
          `INSERT INTO queue_entry
             (tenant_id, organization_id, destination_id, pass_id, policy_evaluation_id, flow_expires_at, release_reason)
           VALUES ($1, $2, $3, $4, $5, statement_timestamp() + interval '10 minutes', 'cancelled')`,
          [school.tenantId, school.school, school.destination, school.pass, evaluationId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      // Ready offer must end no later than the overall flow.
      await expect(
        scratch.query(
          `INSERT INTO destination_reservation
             (tenant_id, organization_id, destination_id, pass_id, policy_evaluation_id, ready_expires_at, flow_expires_at)
           VALUES ($1, $2, $3, $4, $5, statement_timestamp() + interval '10 minutes', statement_timestamp() + interval '1 minute')`,
          [school.tenantId, school.school, school.destination, school.pass, evaluationId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      // A coherent reservation round-trips.
      const reservation = idOf(
        await scratch.query(
          `INSERT INTO destination_reservation
             (tenant_id, organization_id, destination_id, pass_id, policy_evaluation_id, ready_expires_at, flow_expires_at)
           VALUES ($1, $2, $3, $4, $5, statement_timestamp() + interval '1 minute', statement_timestamp() + interval '10 minutes')
           RETURNING id`,
          [school.tenantId, school.school, school.destination, school.pass, evaluationId],
        ),
      );
      expect(reservation).toBeDefined();
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });
});
