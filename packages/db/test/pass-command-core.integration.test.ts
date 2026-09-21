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

function idOf(result: { rows: { id?: string }[] }): string {
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('Fixture insert failed');
  return id;
}

function nonce(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12);
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

interface SchoolFixture {
  tenantId: string;
  schoolA: string;
  schoolB: string;
  studentA: string;
  locationA: string;
  locationB: string;
  destinationA: string;
  destinationB: string;
}

async function seedTwoSchools(target: Pool, tag: string): Promise<SchoolFixture> {
  const tenantId = idOf(
    await target.query<{ id: string }>(
      `INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id`,
      [`T-${tag}`, `t-${tag}-${nonce()}`],
    ),
  );
  const schoolA = idOf(
    await target.query<{ id: string }>(
      `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', $2, $3, 'America/New_York') RETURNING id`,
      [tenantId, `A-${tag}`, `a-${tag}-${nonce()}`],
    ),
  );
  const schoolB = idOf(
    await target.query<{ id: string }>(
      `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', $2, $3, 'America/Chicago') RETURNING id`,
      [tenantId, `B-${tag}`, `b-${tag}-${nonce()}`],
    ),
  );
  const studentA = idOf(
    await target.query<{ id: string }>(
      `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'Stu', 'Dent', 'Stu Dent') RETURNING id`,
      [tenantId],
    ),
  );
  await target.query(
    `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation) VALUES ($1, $2, $3, 'student')`,
    [tenantId, schoolA, studentA],
  );
  const locationA = idOf(
    await target.query<{ id: string }>(
      `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'classroom', 'Room A') RETURNING id`,
      [tenantId, schoolA],
    ),
  );
  const locationB = idOf(
    await target.query<{ id: string }>(
      `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'clinic', 'Clinic B') RETURNING id`,
      [tenantId, schoolB],
    ),
  );
  const destinationB = idOf(
    await target.query<{ id: string }>(
      `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name) VALUES ($1, $2, $3, 'nurse', 'Nurse B') RETURNING id`,
      [tenantId, schoolB, locationB],
    ),
  );
  const destinationA = idOf(
    await target.query<{ id: string }>(
      `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name) VALUES ($1, $2, $3, 'restroom', 'Restroom A') RETURNING id`,
      [tenantId, schoolA, locationA],
    ),
  );
  return {
    tenantId,
    schoolA,
    schoolB,
    studentA,
    locationA,
    locationB,
    destinationA,
    destinationB,
  };
}

describe('migration 005 pass command core', () => {
  it('advances the expected migration marker to 008', () => {
    expect(EXPECTED_MIGRATION).toBe('008_school_control_plane');
  });

  it('migrates a blank database 001 -> 005 with same-school hardening', async () => {
    const { url, pool: scratch } = await freshDatabase();
    try {
      const handle = createDatabase(url, { max: 1 });
      try {
        await migrateToLatest(handle.database);
      } finally {
        await handle.destroy();
      }
      const column = await scratch.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'pass' AND column_name = 'origin_schedule_block_id'`,
      );
      expect(column.rows).toHaveLength(1);
      const constraints = (
        await scratch.query<{ name: string }>(
          `SELECT conname AS name FROM pg_constraint WHERE conname LIKE 'pass_phase5%' ORDER BY 1`,
        )
      ).rows.map((row) => row.name);
      expect(constraints).toEqual([
        'pass_phase5_destination_same_school',
        'pass_phase5_organization_tenant_fk',
        'pass_phase5_origin_block_same_school',
        'pass_phase5_origin_location_same_school',
        'pass_phase5_origin_section_same_school',
        'pass_phase5_requested_by_tenant_fk',
        'pass_phase5_return_location_same_school',
        'pass_phase5_scheduled_auth_tenant_fk',
        'pass_phase5_student_tenant_fk',
      ]);
      const destinationKey = await scratch.query(
        `SELECT conname FROM pg_constraint WHERE conname = 'destination_phase5_tenant_school_key'`,
      );
      expect(destinationKey.rows).toHaveLength(1);
    } finally {
      await scratch.end();
    }
  });

  it('upgrades a real Phase 4 schema 004 -> 005, backfilling origin block as NULL', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '004_authorization_relationships');
      const tag = `up${nonce()}`;
      const tenantId = idOf(
        await scratch.query<{ id: string }>(
          `INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id`,
          [`T-${tag}`, `t-${tag}`],
        ),
      );
      const school = idOf(
        await scratch.query<{ id: string }>(
          `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'S', $2, 'America/New_York') RETURNING id`,
          [tenantId, `s-${tag}`],
        ),
      );
      const student = idOf(
        await scratch.query<{ id: string }>(
          `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'A', 'B', 'A B') RETURNING id`,
          [tenantId],
        ),
      );
      const location = idOf(
        await scratch.query<{ id: string }>(
          `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'clinic', 'C') RETURNING id`,
          [tenantId, school],
        ),
      );
      const destination = idOf(
        await scratch.query<{ id: string }>(
          `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name) VALUES ($1, $2, $3, 'nurse', 'N') RETURNING id`,
          [tenantId, school, location],
        ),
      );
      await scratch.query(
        `INSERT INTO pass (tenant_id, organization_id, student_id, destination_id, request_source, lifecycle_state) VALUES ($1, $2, $3, $4, 'student_web', 'requested')`,
        [tenantId, school, student, destination],
      );
      await migrateToLatest(handle.database);
      const upgraded = await scratch.query<{ origin_schedule_block_id: string | null }>(
        `SELECT origin_schedule_block_id FROM pass`,
      );
      expect(upgraded.rows).toHaveLength(1);
      expect(upgraded.rows[0]?.origin_schedule_block_id).toBeNull();
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('refuses a 004 -> 005 upgrade when a pass references another school', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '004_authorization_relationships');
      const fixture = await seedTwoSchools(scratch, `x${nonce()}`);
      await scratch.query(
        `INSERT INTO pass (tenant_id, organization_id, student_id, destination_id, request_source, lifecycle_state) VALUES ($1, $2, $3, $4, 'student_web', 'requested')`,
        [fixture.tenantId, fixture.schoolA, fixture.studentA, fixture.destinationB],
      );
      await expect(migrateToLatest(handle.database)).rejects.toThrow(/another school/);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('rejects cross-school pass references at the database boundary', async () => {
    const { url, pool: scratch } = await freshDatabase();
    try {
      const handle = createDatabase(url, { max: 1 });
      try {
        await migrateToLatest(handle.database);
      } finally {
        await handle.destroy();
      }
      const fixture = await seedTwoSchools(scratch, `f${nonce()}`);
      await expect(
        scratch.query(
          `INSERT INTO pass (tenant_id, organization_id, student_id, destination_id, request_source, lifecycle_state) VALUES ($1, $2, $3, $4, 'student_web', 'requested')`,
          [fixture.tenantId, fixture.schoolA, fixture.studentA, fixture.destinationB],
        ),
      ).rejects.toThrow(/pass_phase5_destination_same_school/);
      await expect(
        scratch.query(
          `INSERT INTO pass (tenant_id, organization_id, student_id, destination_id, origin_location_id, request_source, lifecycle_state) VALUES ($1, $2, $3, $4, $5, 'student_web', 'requested') RETURNING id`,
          [
            fixture.tenantId,
            fixture.schoolB,
            fixture.studentA,
            fixture.destinationB,
            fixture.locationA,
          ],
        ),
      ).rejects.toThrow(/pass_phase5_origin_location_same_school/);
      const blockB = idOf(
        await scratch.query<{ id: string }>(
          `INSERT INTO schedule_block (tenant_id, organization_id, code, display_name, kind) VALUES ($1, $2, 'P1', 'P1', 'instructional') RETURNING id`,
          [fixture.tenantId, fixture.schoolB],
        ),
      );
      await expect(
        scratch.query(
          `INSERT INTO pass (tenant_id, organization_id, student_id, destination_id, origin_schedule_block_id, request_source, lifecycle_state) VALUES ($1, $2, $3, $4, $5, 'student_web', 'requested')`,
          [fixture.tenantId, fixture.schoolA, fixture.studentA, fixture.destinationA, blockB],
        ),
      ).rejects.toThrow(/pass_phase5_origin_block_same_school/);
    } finally {
      await scratch.end();
    }
  });

  it('enforces idempotency key scope per tenant, actor, command, and key', async () => {
    const { url, pool: scratch } = await freshDatabase();
    try {
      const handle = createDatabase(url, { max: 1 });
      try {
        await migrateToLatest(handle.database);
      } finally {
        await handle.destroy();
      }
      const tag = `i${nonce()}`;
      const tenantId = idOf(
        await scratch.query<{ id: string }>(
          `INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id`,
          [`T-${tag}`, `t-${tag}`],
        ),
      );
      const person = idOf(
        await scratch.query<{ id: string }>(
          `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'A', 'B', 'A B') RETURNING id`,
          [tenantId],
        ),
      );
      const account = idOf(
        await scratch.query<{ id: string }>(
          `INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id`,
          [tenantId, person],
        ),
      );
      const insertRecord = (actor: string, command: string, key: string) =>
        scratch.query(
          `INSERT INTO idempotency_record (tenant_id, actor_account_id, command, idempotency_key, request_fingerprint, response_status, response_body, expires_at)
           VALUES ($1, $2, $3, $4, 'fp', 201, '{}', now() + interval '24 hours')`,
          [tenantId, actor, command, key],
        );
      await insertRecord(account, 'pass.request.self:v1', 'key-1');
      await expect(insertRecord(account, 'pass.request.self:v1', 'key-1')).rejects.toThrow();
      await insertRecord(account, 'pass.request.student:v1', 'key-1');
      await insertRecord(account, 'pass.request.self:v1', 'key-2');
      const person2 = idOf(
        await scratch.query<{ id: string }>(
          `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'C', 'D', 'C D') RETURNING id`,
          [tenantId],
        ),
      );
      const account2 = idOf(
        await scratch.query<{ id: string }>(
          `INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id`,
          [tenantId, person2],
        ),
      );
      await insertRecord(account2, 'pass.request.self:v1', 'key-1');
      // The coordinator reuses a key only after removing its exact expired
      // row (CHECK expires_at > created_at forbids writing already-expired
      // rows, so expiry happens through time, not through writes).
      const retired = await scratch.query<{ id: string }>(
        `INSERT INTO idempotency_record (tenant_id, actor_account_id, command, idempotency_key, request_fingerprint, response_status, response_body, expires_at)
         VALUES ($1, $2, $3, 'old-key', 'fp', 201, '{}', now() + interval '24 hours') RETURNING id`,
        [tenantId, account, 'pass.request.self:v1'],
      );
      expect(retired.rows).toHaveLength(1);
      await scratch.query(`DELETE FROM idempotency_record WHERE id = $1`, [retired.rows[0]?.id]);
      await insertRecord(account, 'pass.request.self:v1', 'old-key');
    } finally {
      await scratch.end();
    }
  });
});
