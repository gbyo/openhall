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

async function migrateTo(handle: ReturnType<typeof createDatabase>, target: string) {
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
  const admin = new Client({ connectionString: administration.toString() });
  await admin.connect();
  for (const name of createdDatabases) {
    await admin.query(`DROP DATABASE IF EXISTS ${quotedIdentifier(name)} WITH (FORCE)`);
  }
  await admin.end();
});

interface CategoryRow {
  name: string;
  icon_key: string;
  tone_key: string;
  student_surface: string;
  sort_order: number;
  status: string;
}

describe('migration 010 destination categories', () => {
  it('migrates a blank database 001 -> 010 with category invariants', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const names = (
        await scratch.query<{ name: string }>('SELECT name FROM kysely_migration ORDER BY name')
      ).rows.map((row) => row.name);
      expect(names[names.length - 1]).toBe('010_destination_categories');
      const table = await scratch.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'destination_category' ORDER BY 1`,
      );
      expect(table.rows.length).toBeGreaterThan(8);
      const destCols = await scratch.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'destination' AND column_name IN ('category_id', 'student_self_requestable')`,
      );
      expect(destCols.rows).toHaveLength(2);
      const notNull = await scratch.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_name = 'destination' AND column_name = 'category_id'`,
      );
      expect(notNull.rows[0]?.is_nullable).toBe('NO');
      const constraints = (
        await scratch.query<{ conname: string }>(
          `SELECT conname FROM pg_constraint WHERE conname LIKE '%phase10%' ORDER BY 1`,
        )
      ).rows.map((row) => row.conname);
      expect(constraints).toEqual([
        'destination_category_phase10_tenant_school_key',
        'destination_phase10_category_same_school_fk',
      ]);
      const indexes = (
        await scratch.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE indexname LIKE '%phase10%' ORDER BY 1`,
        )
      ).rows.map((row) => row.indexname);
      expect(indexes).toEqual([
        'destination_category_phase10_one_active_name',
        'destination_category_phase10_school_surface_idx',
        'destination_category_phase10_tenant_school_key',
        'destination_phase10_category_idx',
      ]);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('backfills one category per legacy service-type group with curated buckets', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '009_guided_setup_authentication');
      const tenantId = idOf(
        await scratch.query(`INSERT INTO tenant (name, slug) VALUES ('T', 'tback') RETURNING id`),
      );
      const school = idOf(
        await scratch.query(
          `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'S', 'sback', 'America/New_York') RETURNING id`,
          [tenantId],
        ),
      );
      const location = idOf(
        await scratch.query(
          `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'clinic', 'C') RETURNING id`,
          [tenantId, school],
        ),
      );
      // health + nurse collapse into one curated bucket; Planetarium casing
      // variants share one category; makerspace keeps its own generic one.
      const legacy = [
        'health',
        'nurse',
        'restroom',
        'counseling',
        'library',
        'office',
        'makerspace',
        'Planetarium',
        'planetarium',
      ];
      for (const serviceType of legacy) {
        await scratch.query(
          `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name)
           VALUES ($1, $2, $3, $4, $4)`,
          [tenantId, school, location, serviceType],
        );
      }
      await migrateToLatest(handle.database);

      const categories = (
        await scratch.query<CategoryRow>(
          `SELECT name, icon_key, tone_key, student_surface, sort_order, status
           FROM destination_category WHERE tenant_id = $1 ORDER BY sort_order, lower(name)`,
          [tenantId],
        )
      ).rows;
      // Curated buckets collapse legacy synonyms (health + nurse -> Nurse).
      expect(categories.slice(0, 5)).toEqual([
        {
          name: 'Restroom',
          icon_key: 'restroom',
          tone_key: 'aqua',
          student_surface: 'primary',
          sort_order: 10,
          status: 'active',
        },
        {
          name: 'Nurse',
          icon_key: 'medical',
          tone_key: 'rose',
          student_surface: 'primary',
          sort_order: 20,
          status: 'active',
        },
        {
          name: 'Counselor',
          icon_key: 'chat',
          tone_key: 'violet',
          student_surface: 'primary',
          sort_order: 30,
          status: 'active',
        },
        {
          name: 'Library',
          icon_key: 'book',
          tone_key: 'amber',
          student_surface: 'primary',
          sort_order: 40,
          status: 'active',
        },
        {
          name: 'Main Office',
          icon_key: 'building',
          tone_key: 'blue',
          student_surface: 'primary',
          sort_order: 50,
          status: 'active',
        },
      ]);
      // Unknown values each keep their own generic secondary category.
      expect(categories.slice(5, 6)).toEqual([
        {
          name: 'makerspace',
          icon_key: 'generic',
          tone_key: 'neutral',
          student_surface: 'secondary',
          sort_order: 100,
          status: 'active',
        },
      ]);
      // Casing variants share one category instead of duplicating (the
      // surviving display name depends on row order, so match loosely).
      const planetarium = categories.filter((c) => c.name.toLowerCase() === 'planetarium');
      expect(planetarium).toHaveLength(1);
      expect(planetarium[0]).toMatchObject({
        icon_key: 'generic',
        tone_key: 'neutral',
        student_surface: 'secondary',
        sort_order: 100,
        status: 'active',
      });
      const planetariumDests = await scratch.query<{ dests: number; cats: number }>(
        `SELECT count(DISTINCT d.id)::int AS dests, count(DISTINCT d.category_id)::int AS cats
         FROM destination d JOIN destination_category c ON c.id = d.category_id
         WHERE d.tenant_id = $1 AND lower(c.name) = 'planetarium'`,
        [tenantId],
      );
      expect(planetariumDests.rows[0]).toMatchObject({ dests: 2, cats: 1 });

      const unassigned = await scratch.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM destination WHERE tenant_id = $1 AND category_id IS NULL`,
        [tenantId],
      );
      expect(unassigned.rows[0]?.count).toBe(0);
      const notRequestable = await scratch.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM destination WHERE tenant_id = $1 AND student_self_requestable IS NOT true`,
        [tenantId],
      );
      expect(notRequestable.rows[0]?.count).toBe(0);
      // Legacy service_type values are preserved untouched.
      const types = (
        await scratch.query<{ service_type: string }>(
          `SELECT service_type FROM destination WHERE tenant_id = $1 ORDER BY 1`,
          [tenantId],
        )
      ).rows.map((row) => row.service_type);
      expect(types).toContain('makerspace');
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('migrates an empty school without creating categories', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '009_guided_setup_authentication');
      const tenantId = idOf(
        await scratch.query(`INSERT INTO tenant (name, slug) VALUES ('T', 'tempty') RETURNING id`),
      );
      await scratch.query(
        `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'S', 'sempty', 'America/New_York')`,
        [tenantId],
      );
      await migrateToLatest(handle.database);
      const count = await scratch.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM destination_category WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(count.rows[0]?.count).toBe(0);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('rejects duplicate active names but allows archived reuse', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const tenantId = idOf(
        await scratch.query(`INSERT INTO tenant (name, slug) VALUES ('T', 'tuniq') RETURNING id`),
      );
      const school = idOf(
        await scratch.query(
          `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'S', 'suniq', 'America/New_York') RETURNING id`,
          [tenantId],
        ),
      );
      await scratch.query(
        `INSERT INTO destination_category (tenant_id, organization_id, name) VALUES ($1, $2, 'Nurse')`,
        [tenantId, school],
      );
      await expect(
        scratch.query(
          `INSERT INTO destination_category (tenant_id, organization_id, name) VALUES ($1, $2, 'nurse')`,
          [tenantId, school],
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await scratch.query(
        `UPDATE destination_category SET status = 'archived' WHERE tenant_id = $1 AND organization_id = $2`,
        [tenantId, school],
      );
      await scratch.query(
        `INSERT INTO destination_category (tenant_id, organization_id, name) VALUES ($1, $2, 'NURSE')`,
        [tenantId, school],
      );
      const count = await scratch.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM destination_category WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(count.rows[0]?.count).toBe(2);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });
});
