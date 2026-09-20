import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { ExpectedPlacementResolver } from '@openhall/application';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../src/database.js';
import { migrateToLatest } from '../src/migrator.js';
import { PostgresExpectedPlacementRepository } from '../src/repositories/schedule-repository.js';

let databaseName: string;
let databaseUrl: string;
let administrationUrl: string;
let handle: DatabaseHandle;

function quotedIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error('Unsafe database identifier');
  return `"${value}"`;
}

beforeAll(async () => {
  const configuredUrl = process.env.DATABASE_URL;
  if (!configuredUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
  const base = new URL(configuredUrl);
  databaseName = `openhall_schedule_${randomUUID().replaceAll('-', '')}`;
  const administration = new URL(base);
  administration.pathname = '/postgres';
  administrationUrl = administration.toString();
  const client = new Client({ connectionString: administrationUrl });
  await client.connect();
  await client.query(`CREATE DATABASE ${quotedIdentifier(databaseName)}`);
  await client.end();
  base.pathname = `/${databaseName}`;
  databaseUrl = base.toString();
  handle = createDatabase(databaseUrl, { max: 4 });
  await migrateToLatest(handle.database);
});

afterAll(async () => {
  await handle.destroy();
  if (administrationUrl && databaseName) {
    const client = new Client({ connectionString: administrationUrl });
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(databaseName)} WITH (FORCE)`);
    await client.end();
  }
});

async function seedSchedule() {
  const tenant = (
    await handle.pool.query<{ id: string }>(
      "INSERT INTO tenant (name) VALUES ('Resolver') RETURNING id",
    )
  ).rows[0]?.id;
  if (!tenant) throw new Error('Tenant fixture failed');
  const school = (
    await handle.pool.query<{ id: string }>(
      `INSERT INTO organization (tenant_id, kind, name, slug, time_zone)
       VALUES ($1, 'school', 'Resolver School', $2, 'America/New_York') RETURNING id`,
      [tenant, `resolver-${randomUUID()}`],
    )
  ).rows[0]?.id;
  const student = (
    await handle.pool.query<{ id: string }>(
      `INSERT INTO person (tenant_id, given_name, family_name, display_name)
       VALUES ($1, 'Student', 'Resolver', 'Student Resolver') RETURNING id`,
      [tenant],
    )
  ).rows[0]?.id;
  const teacherIds: string[] = [];
  for (const displayName of ['Ada Teacher', 'Grace Teacher']) {
    const [givenName, familyName] = displayName.split(' ');
    const id = (
      await handle.pool.query<{ id: string }>(
        `INSERT INTO person (tenant_id, given_name, family_name, display_name)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenant, givenName, familyName, displayName],
      )
    ).rows[0]?.id;
    if (id) teacherIds.push(id);
  }
  if (!school || !student || teacherIds.length !== 2) throw new Error('Person fixture failed');
  await handle.pool.query(
    `INSERT INTO organization_membership
       (tenant_id, organization_id, person_id, affiliation, valid_from, valid_until)
     VALUES ($1, $2, $3, 'student', '2026-09-01', '2027-06-30')`,
    [tenant, school, student],
  );
  const session = (
    await handle.pool.query<{ id: string }>(
      `INSERT INTO academic_session
         (tenant_id, organization_id, kind, name, starts_on, ends_on)
       VALUES ($1, $2, 'school_year', '2026-27', '2026-09-01', '2027-06-30') RETURNING id`,
      [tenant, school],
    )
  ).rows[0]?.id;
  const section = (
    await handle.pool.query<{ id: string }>(
      `INSERT INTO section
         (tenant_id, organization_id, academic_session_id, code, title)
       VALUES ($1, $2, $3, 'MATH-3', 'Mathematics') RETURNING id`,
      [tenant, school, session],
    )
  ).rows[0]?.id;
  if (!section) throw new Error('Section fixture failed');
  await handle.pool.query(
    `INSERT INTO section_membership
       (tenant_id, section_id, person_id, role, starts_on, ends_on)
     VALUES ($1, $2, $3, 'student', '2026-09-01', '2027-06-30')`,
    [tenant, section, student],
  );
  for (const teacherId of teacherIds) {
    await handle.pool.query(
      `INSERT INTO section_membership
         (tenant_id, section_id, person_id, role, starts_on, ends_on)
       VALUES ($1, $2, $3, 'teacher', '2026-09-01', '2027-06-30')`,
      [tenant, section, teacherId],
    );
  }
  const location = (
    await handle.pool.query<{ id: string }>(
      `INSERT INTO location (tenant_id, organization_id, kind, name, code)
       VALUES ($1, $2, 'classroom', 'Room 303', '303') RETURNING id`,
      [tenant, school],
    )
  ).rows[0]?.id;
  const block = (
    await handle.pool.query<{ id: string }>(
      `INSERT INTO schedule_block (tenant_id, organization_id, code, display_name, kind)
       VALUES ($1, $2, 'P3', 'Period 3', 'instructional') RETURNING id`,
      [tenant, school],
    )
  ).rows[0]?.id;
  const template = (
    await handle.pool.query<{ id: string }>(
      `INSERT INTO schedule_template (tenant_id, organization_id, name)
       VALUES ($1, $2, 'Regular') RETURNING id`,
      [tenant, school],
    )
  ).rows[0]?.id;
  if (!location || !block || !template) throw new Error('Schedule fixture failed');
  await handle.pool.query(
    `INSERT INTO section_meeting
       (tenant_id, organization_id, section_id, schedule_block_id, location_id, cycle_code,
        effective_from, effective_until)
     VALUES ($1, $2, $3, $4, $5, NULL, '2026-09-01', '2027-06-30')`,
    [tenant, school, section, block, location],
  );
  await handle.pool.query(
    `INSERT INTO schedule_slot
       (tenant_id, organization_id, schedule_template_id, schedule_block_id,
        starts_at, ends_at, ordinal)
     VALUES ($1, $2, $3, $4, '10:00', '11:00', 3)`,
    [tenant, school, template, block],
  );
  await handle.pool.query(
    `INSERT INTO calendar_day
       (tenant_id, organization_id, date, day_kind, schedule_template_id, cycle_code)
     VALUES ($1, $2, '2026-09-21', 'instructional', $3, 'A')`,
    [tenant, school, template],
  );
  return { tenant, school, student, section };
}

describe('PostgreSQL expected-placement repository', () => {
  it('resolves a school-scoped placement through the real adapter', async () => {
    const fixture = await seedSchedule();
    const resolver = new ExpectedPlacementResolver(
      new PostgresExpectedPlacementRepository(handle.database),
    );
    const result = await resolver.resolve({
      tenantId: fixture.tenant,
      organizationId: fixture.school,
      personId: fixture.student,
      at: Temporal.Instant.from('2026-09-21T14:30:00Z'),
    });
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.section.id).toBe(fixture.section);
    expect(result.expectedLocation?.code).toBe('303');
    expect(result.teachers.map((teacher) => teacher.displayName)).toEqual([
      'Ada Teacher',
      'Grace Teacher',
    ]);
    expect(result.elapsedSeconds).toBe(1800);
  });

  it('scopes every lookup by tenant and never leaks a placement across tenants', async () => {
    const fixture = await seedSchedule();
    const otherTenant = (
      await handle.pool.query<{ id: string }>(
        "INSERT INTO tenant (name) VALUES ('Other') RETURNING id",
      )
    ).rows[0]?.id;
    const resolver = new ExpectedPlacementResolver(
      new PostgresExpectedPlacementRepository(handle.database),
    );
    const result = await resolver.resolve({
      tenantId: otherTenant ?? 'missing',
      organizationId: fixture.school,
      personId: fixture.student,
      at: Temporal.Instant.from('2026-09-21T14:30:00Z'),
    });
    expect(result).toMatchObject({ kind: 'configuration_error', code: 'school_not_found' });
  });

  it('returns PostgreSQL dates and timestamps as text, independent of process timezone', async () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Honolulu';
      const hawaii = await handle.pool.query<{
        date: unknown;
        timestamp: unknown;
        timestamptz: unknown;
      }>(
        `SELECT DATE '2026-09-21' AS date,
                TIMESTAMP '2026-09-21 10:15:00' AS timestamp,
                TIMESTAMPTZ '2026-09-21 14:15:00+00' AS timestamptz`,
      );
      process.env.TZ = 'Asia/Tokyo';
      const tokyo = await handle.pool.query<{
        date: unknown;
        timestamp: unknown;
        timestamptz: unknown;
      }>(
        `SELECT DATE '2026-09-21' AS date,
                TIMESTAMP '2026-09-21 10:15:00' AS timestamp,
                TIMESTAMPTZ '2026-09-21 14:15:00+00' AS timestamptz`,
      );
      expect(hawaii.rows[0]).toEqual(tokyo.rows[0]);
      expect(hawaii.rows[0]).toEqual({
        date: '2026-09-21',
        timestamp: '2026-09-21 10:15:00',
        timestamptz: '2026-09-21 14:15:00+00',
      });
      expect(hawaii.rows[0]?.date).not.toBeInstanceOf(Date);
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it('has the resolver indexes and exact-school constraints installed', async () => {
    const indexes = await handle.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN (
           'section_membership_tenant_person_idx',
           'section_meeting_tenant_school_section_idx',
           'calendar_day_tenant_id_organization_id_date_key',
           'schedule_slot_tenant_id_schedule_template_id_ordinal_key'
         )`,
    );
    expect(indexes.rows.map((row) => row.indexname).sort()).toEqual([
      'calendar_day_tenant_id_organization_id_date_key',
      'schedule_slot_tenant_id_schedule_template_id_ordinal_key',
      'section_meeting_tenant_school_section_idx',
      'section_membership_tenant_person_idx',
    ]);
    const constraints = await handle.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conname IN (
         'location_parent_same_school_fk',
         'section_meeting_section_same_school_fk',
         'section_meeting_block_same_school_fk',
         'section_meeting_location_same_school_fk',
         'schedule_slot_template_same_school_fk',
         'schedule_slot_block_same_school_fk',
         'calendar_day_template_same_school_fk',
         'destination_location_same_school_fk'
       )`,
    );
    expect(constraints.rows).toHaveLength(8);
  });
});
