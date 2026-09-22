import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/database.js';
import { migrateToLatest } from '../src/migrator.js';
import { PostgresAuthorizationRepository } from '../src/repositories/authorization-repository.js';
import { PostgresTenantTransactionRunner } from '../src/transactions.js';

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

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
});

afterAll(async () => {
  const base = new URL(process.env.DATABASE_URL ?? '');
  const administration = new URL(base);
  administration.pathname = '/postgres';
  const admin = new Client({ connectionString: administration.toString() });
  await admin.connect();
  for (const name of createdDatabases) {
    await admin.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(name)} WITH (FORCE)`);
  }
  await admin.end();
});

describe('PostgresAuthorizationRepository teaching meeting locations', () => {
  it('returns distinct locations of active teaching assignments only', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const facts = new PostgresAuthorizationRepository();
      const tenant = idOf(
        await scratch.query(`INSERT INTO tenant (name, slug) VALUES ('T', 't-loc') RETURNING id`),
      );
      const school = idOf(
        await scratch.query(
          `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'S', 's-loc', 'America/New_York') RETURNING id`,
          [tenant],
        ),
      );
      const session = idOf(
        await scratch.query(
          `INSERT INTO academic_session (tenant_id, organization_id, kind, name, starts_on, ends_on) VALUES ($1, $2, 'school_year', 'SY', '2026-08-01', '2027-06-01') RETURNING id`,
          [tenant, school],
        ),
      );
      const section = idOf(
        await scratch.query(
          `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title) VALUES ($1, $2, $3, 'P1', 'Period 1') RETURNING id`,
          [tenant, school, session],
        ),
      );
      const archivedSection = idOf(
        await scratch.query(
          `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title, status) VALUES ($1, $2, $3, 'P0', 'Old', 'archived') RETURNING id`,
          [tenant, school, session],
        ),
      );
      const room = idOf(
        await scratch.query(
          `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'classroom', 'Room 214') RETURNING id`,
          [tenant, school],
        ),
      );
      const gym = idOf(
        await scratch.query(
          `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'gym', 'Gym') RETURNING id`,
          [tenant, school],
        ),
      );
      const teacher = idOf(
        await scratch.query(
          `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'T', 'E', 'T E') RETURNING id`,
          [tenant],
        ),
      );
      const outsider = idOf(
        await scratch.query(
          `INSERT INTO person (tenant_id, given_name, family_name, display_name) VALUES ($1, 'O', 'U', 'O U') RETURNING id`,
          [tenant],
        ),
      );
      await scratch.query(
        `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation, status) VALUES ($1, $2, $3, 'staff', 'active'), ($1, $2, $4, 'staff', 'active')`,
        [tenant, school, teacher, outsider],
      );
      await scratch.query(
        `INSERT INTO section_membership (tenant_id, section_id, person_id, role, status) VALUES ($1, $2, $3, 'teacher', 'active')`,
        [tenant, section, teacher],
      );
      // Inactive membership on the archived section: never a location.
      await scratch.query(
        `INSERT INTO section_membership (tenant_id, section_id, person_id, role, status) VALUES ($1, $2, $3, 'teacher', 'inactive')`,
        [tenant, archivedSection, teacher],
      );
      const oldWing = idOf(
        await scratch.query(
          `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'classroom', 'Old wing') RETURNING id`,
          [tenant, school],
        ),
      );
      const block = idOf(
        await scratch.query(
          `INSERT INTO schedule_block (tenant_id, organization_id, code, display_name, kind) VALUES ($1, $2, 'P1', 'P1', 'instructional') RETURNING id`,
          [tenant, school],
        ),
      );
      // Two meetings at the room collapse to one location; the gym
      // meeting counts once and the location-less meeting adds nothing.
      await scratch.query(
        `INSERT INTO section_meeting (tenant_id, organization_id, section_id, schedule_block_id, location_id) VALUES ($1, $2, $3, $4, $5), ($1, $2, $3, $4, $5), ($1, $2, $3, $4, $6), ($1, $2, $3, $4, NULL)`,
        [tenant, school, section, block, room, gym],
      );
      // The archived section's old-wing meeting never leaks in.
      await scratch.query(
        `INSERT INTO section_meeting (tenant_id, organization_id, section_id, schedule_block_id, location_id) VALUES ($1, $2, $3, $4, $5)`,
        [tenant, school, archivedSection, block, oldWing],
      );

      const runner = new PostgresTenantTransactionRunner(handle.database);
      const locations = await runner.run(tenant, (context) =>
        facts.listTeachingMeetingLocations(context, teacher, school),
      );
      // Both Room 214 meetings collapse to one location alongside the
      // gym; the archived section's old wing stays out.
      expect([...locations].sort()).toEqual([gym, room].sort());

      // The archived section's gym meeting never leaks in, and a teacher
      // with no assignment resolves to nothing.
      const outsiderLocations = await runner.run(tenant, (context) =>
        facts.listTeachingMeetingLocations(context, outsider, school),
      );
      expect(outsiderLocations).toEqual([]);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });
});
