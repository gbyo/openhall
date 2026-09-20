import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/database.js';
import { migrateToLatest } from '../src/migrator.js';
import { PostgresReadinessProbe } from '../src/readiness.js';

let databaseName: string;
let databaseUrl: string;
let administrationUrl: string;
let pool: Pool;

function quotedIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('Unsafe database identifier');
  return `"${value}"`;
}

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
  const handle = createDatabase(databaseUrl, { max: 1 });
  await migrateToLatest(handle.database);
  await handle.destroy();
  pool = new Pool({ connectionString: databaseUrl, max: 4 });
});

afterAll(async () => {
  await pool.end();
  if (administrationUrl && databaseName) {
    const client = new Client({ connectionString: administrationUrl });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`);
    await client.end();
  }
});

async function seed() {
  const tenantA = (
    await pool.query<{ id: string }>("INSERT INTO tenant (name) VALUES ('A') RETURNING id")
  ).rows[0]?.id;
  const tenantB = (
    await pool.query<{ id: string }>("INSERT INTO tenant (name) VALUES ('B') RETURNING id")
  ).rows[0]?.id;
  if (!tenantA || !tenantB) throw new Error('Fixture tenant insert failed');
  const organizationA = (
    await pool.query<{ id: string }>(
      "INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'A School', $2, 'America/New_York') RETURNING id",
      [tenantA, `a-${randomUUID()}`],
    )
  ).rows[0]?.id;
  const organizationB = (
    await pool.query<{ id: string }>(
      "INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'B School', $2, 'America/Chicago') RETURNING id",
      [tenantB, `b-${randomUUID()}`],
    )
  ).rows[0]?.id;
  const student = (
    await pool.query<{ id: string }>(
      "INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'Student', 'One', 'Student One') RETURNING id",
      [tenantA],
    )
  ).rows[0]?.id;
  const staff = (
    await pool.query<{ id: string }>(
      "INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'Staff', 'One', 'Staff One') RETURNING id",
      [tenantA],
    )
  ).rows[0]?.id;
  const location = (
    await pool.query<{ id: string }>(
      "INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'classroom', '101') RETURNING id",
      [tenantA, organizationA],
    )
  ).rows[0]?.id;
  const destination = (
    await pool.query<{ id: string }>(
      "INSERT INTO destination (tenant_id, organization_id, location_id, service_type) VALUES ($1, $2, $3, 'room') RETURNING id",
      [tenantA, organizationA, location],
    )
  ).rows[0]?.id;
  if (!organizationA || !organizationB || !student || !staff || !location || !destination) {
    throw new Error('Fixture insert failed');
  }
  return { tenantA, tenantB, organizationA, organizationB, student, staff, location, destination };
}

async function insertPass(fixture: Awaited<ReturnType<typeof seed>>, state = 'requested') {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO pass (tenant_id, organization_id, student_id, destination_id, request_source, requested_by_person_id, lifecycle_state)
     VALUES ($1, $2, $3, $4, 'staff_web', $5, $6) RETURNING id`,
    [
      fixture.tenantA,
      fixture.organizationA,
      fixture.student,
      fixture.destination,
      fixture.staff,
      state,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('Pass fixture insert failed');
  return id;
}

describe('foundation migration on PostgreSQL 18', () => {
  it('migrates a blank database and uses UUIDv7 defaults', async () => {
    const version = await pool.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version",
    );
    expect(Number.parseInt(version.rows[0]?.version ?? '0', 10)).toBe(18);
    const row = await pool.query<{ id: string; version: number }>(
      "INSERT INTO tenant (name) VALUES ('UUID Test') RETURNING id, uuid_extract_version(id) AS version",
    );
    expect(row.rows[0]?.version).toBe(7);
    const tables = await pool.query<{ count: string }>(
      "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'pass'",
    );
    expect(tables.rows[0]?.count).toBe('1');
  });

  it('rejects cross-tenant references', async () => {
    const fixture = await seed();
    await expect(
      pool.query(
        "INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation) VALUES ($1, $2, $3, 'student')",
        [
          fixture.tenantA,
          fixture.organizationA,
          (
            await pool.query<{ id: string }>(
              "INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'Other', 'Tenant', 'Other Tenant') RETURNING id",
              [fixture.tenantB],
            )
          ).rows[0]?.id,
        ],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('enforces date and wall-clock ranges', async () => {
    const fixture = await seed();
    await expect(
      pool.query(
        "INSERT INTO academic_session (tenant_id, organization_id, kind, name, starts_on, ends_on) VALUES ($1, $2, 'term', 'Bad', DATE '2026-09-02', DATE '2026-09-01')",
        [fixture.tenantA, fixture.organizationA],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const block = (
      await pool.query<{ id: string }>(
        "INSERT INTO schedule_block (tenant_id, organization_id, code, display_name, kind) VALUES ($1, $2, $3, 'One', 'instructional') RETURNING id",
        [fixture.tenantA, fixture.organizationA, `b-${randomUUID()}`],
      )
    ).rows[0]?.id;
    const template = (
      await pool.query<{ id: string }>(
        "INSERT INTO schedule_template (tenant_id, organization_id, name) VALUES ($1, $2, 'Regular') RETURNING id",
        [fixture.tenantA, fixture.organizationA],
      )
    ).rows[0]?.id;
    await expect(
      pool.query(
        "INSERT INTO schedule_slot (tenant_id, schedule_template_id, schedule_block_id, starts_at, ends_at, ordinal) VALUES ($1, $2, $3, TIME '10:00', TIME '09:00', 1)",
        [fixture.tenantA, template, block],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('allows only one active pass per student', async () => {
    const fixture = await seed();
    await insertPass(fixture);
    await expect(insertPass(fixture, 'queued')).rejects.toMatchObject({ code: '23505' });
    await insertPass(fixture, 'completed');
  });

  it('enforces active reservation, active queue, and pass-event sequence uniqueness', async () => {
    const fixture = await seed();
    const passId = await insertPass(fixture);
    await pool.query(
      'INSERT INTO destination_reservation (tenant_id, destination_id, pass_id) VALUES ($1, $2, $3)',
      [fixture.tenantA, fixture.destination, passId],
    );
    await expect(
      pool.query(
        'INSERT INTO destination_reservation (tenant_id, destination_id, pass_id) VALUES ($1, $2, $3)',
        [fixture.tenantA, fixture.destination, passId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await pool.query(
      'INSERT INTO queue_entry (tenant_id, destination_id, pass_id) VALUES ($1, $2, $3)',
      [fixture.tenantA, fixture.destination, passId],
    );
    await expect(
      pool.query(
        'INSERT INTO queue_entry (tenant_id, destination_id, pass_id) VALUES ($1, $2, $3)',
        [fixture.tenantA, fixture.destination, passId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await pool.query(
      "INSERT INTO pass_event (tenant_id, pass_id, sequence, event_type, actor_kind, occurred_at) VALUES ($1, $2, 1, 'requested', 'system', statement_timestamp())",
      [fixture.tenantA, passId],
    );
    await expect(
      pool.query(
        "INSERT INTO pass_event (tenant_id, pass_id, sequence, event_type, actor_kind, occurred_at) VALUES ($1, $2, 1, 'again', 'system', statement_timestamp())",
        [fixture.tenantA, passId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('allows only one active operational incident per school', async () => {
    const fixture = await seed();
    await pool.query(
      "INSERT INTO operational_incident (tenant_id, organization_id, mode, activated_by_person_id) VALUES ($1, $2, 'lockdown', $3)",
      [fixture.tenantA, fixture.organizationA, fixture.staff],
    );
    await expect(
      pool.query(
        "INSERT INTO operational_incident (tenant_id, organization_id, mode, activated_by_person_id) VALUES ($1, $2, 'evacuation', $3)",
        [fixture.tenantA, fixture.organizationA, fixture.staff],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('prevents one external object from mapping to conflicting canonical entities', async () => {
    const fixture = await seed();
    const integration = (
      await pool.query<{ id: string }>(
        "INSERT INTO integration (tenant_id, organization_id, integration_type, name) VALUES ($1, $2, 'oneroster', 'Roster') RETURNING id",
        [fixture.tenantA, fixture.organizationA],
      )
    ).rows[0]?.id;
    await pool.query(
      "INSERT INTO external_reference (tenant_id, integration_id, entity_kind, canonical_entity_id, external_object_type, external_id) VALUES ($1, $2, 'person', $3, 'user', 'external-1')",
      [fixture.tenantA, integration, fixture.student],
    );
    await expect(
      pool.query(
        "INSERT INTO external_reference (tenant_id, integration_id, entity_kind, canonical_entity_id, external_object_type, external_id) VALUES ($1, $2, 'person', $3, 'user', 'external-1')",
        [fixture.tenantA, integration, fixture.staff],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('reports readiness only while the migrated database is reachable', async () => {
    const handle = createDatabase(databaseUrl, { max: 1 });
    const probe = new PostgresReadinessProbe(handle.database);
    await expect(probe.check()).resolves.toEqual({ migration: '001_foundation' });
    await handle.destroy();
    await expect(probe.check()).rejects.toBeDefined();
  });
});
