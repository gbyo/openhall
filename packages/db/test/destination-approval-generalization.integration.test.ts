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

/** Minimal graph for one legacy section-bound approval at migration 010. */
async function seedLegacyApproval(scratch: Pool, tag: string) {
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
  const session = idOf(
    await scratch.query(
      `INSERT INTO academic_session (tenant_id, organization_id, kind, name, starts_on, ends_on) VALUES ($1, $2, 'school_year', 'SY', '2026-08-01', '2027-06-01') RETURNING id`,
      [tenantId, school],
    ),
  );
  const section = idOf(
    await scratch.query(
      `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title) VALUES ($1, $2, $3, 'P1', 'Period 1') RETURNING id`,
      [tenantId, school, session],
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
      `INSERT INTO location (tenant_id, organization_id, kind, name) VALUES ($1, $2, 'classroom', 'Room 214') RETURNING id`,
      [tenantId, school],
    ),
  );
  const category = idOf(
    await scratch.query(
      `INSERT INTO destination_category (tenant_id, organization_id, name) VALUES ($1, $2, 'Room visits') RETURNING id`,
      [tenantId, school],
    ),
  );
  const destination = idOf(
    await scratch.query(
      `INSERT INTO destination (tenant_id, organization_id, location_id, category_id, service_type, display_name) VALUES ($1, $2, $3, $4, 'room_visit', 'Room 214') RETURNING id`,
      [tenantId, school, location, category],
    ),
  );
  const pass = idOf(
    await scratch.query(
      `INSERT INTO pass (tenant_id, organization_id, student_id, destination_id, request_source, lifecycle_state) VALUES ($1, $2, $3, $4, 'student_web', 'requested') RETURNING id`,
      [tenantId, school, student, destination],
    ),
  );
  const rule = idOf(
    await scratch.query(
      `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind, scope_organization_id, configuration, override_mode)
       VALUES ($1, $2, 'R', 'approval_requirement', 'organization', $2, '{"schemaVersion":1,"requestSources":["student_web"],"approver":"current_section_teacher"}'::jsonb, 'never') RETURNING id`,
      [tenantId, school],
    ),
  );
  const evaluation = idOf(
    await scratch.query(
      `INSERT INTO policy_evaluation (tenant_id, pass_id, pass_revision, stage, decision, context_snapshot)
       VALUES ($1, $2, 1, 'request', 'approval_required', '{}') RETURNING id`,
      [tenantId, pass],
    ),
  );
  const result = idOf(
    await scratch.query(
      `INSERT INTO policy_evaluation_result (tenant_id, evaluation_id, policy_rule_id, policy_rule_revision, outcome, reason_code, override_mode, contribution, rule_snapshot)
       VALUES ($1, $2, $3, 1, 'fail', 'current_section_teacher_approval_required', 'never', 'approval_required', '{}') RETURNING id`,
      [tenantId, evaluation, rule],
    ),
  );
  const approval = idOf(
    await scratch.query(
      `INSERT INTO pass_approval (tenant_id, organization_id, pass_id, origin_evaluation_result_id, policy_rule_id, policy_rule_revision, required_section_id)
       VALUES ($1, $2, $3, $4, $5, 1, $6) RETURNING id`,
      [tenantId, school, pass, result, rule, section],
    ),
  );
  return { tenantId, school, section, destination, category, pass, rule, result, approval };
}

describe('migration 011 destination approval generalization', () => {
  it('migrates a blank database 001 -> 011 with approval invariants', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const names = (
        await scratch.query<{ name: string }>('SELECT name FROM kysely_migration ORDER BY name')
      ).rows.map((row) => row.name);
      expect(names[names.length - 1]).toBe('011_destination_approval_generalization');

      const approvalCols = (
        await scratch.query<{ column_name: string; is_nullable: string }>(
          `SELECT column_name, is_nullable FROM information_schema.columns
           WHERE table_name = 'pass_approval' AND column_name IN ('approver_kind', 'required_section_id', 'required_destination_id')
           ORDER BY 1`,
        )
      ).rows;
      expect(approvalCols).toEqual([
        { column_name: 'approver_kind', is_nullable: 'NO' },
        { column_name: 'required_destination_id', is_nullable: 'YES' },
        { column_name: 'required_section_id', is_nullable: 'YES' },
      ]);

      const ruleCols = (
        await scratch.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'policy_rule' AND column_name = 'scope_destination_category_id'`,
        )
      ).rows;
      expect(ruleCols).toHaveLength(1);

      const constraints = (
        await scratch.query<{ conname: string }>(
          `SELECT conname FROM pg_constraint WHERE conname LIKE '%phase11%' ORDER BY 1`,
        )
      ).rows.map((row) => row.conname);
      expect(constraints).toEqual([
        'pass_approval_phase11_destination_fk',
        'pass_approval_phase11_exactly_one_requirement',
        'policy_evaluation_result_phase11_reason_code',
        'policy_rule_phase11_category_fk',
      ]);
      const shape = (
        await scratch.query<{ conname: string }>(
          `SELECT conname FROM pg_constraint WHERE conname = 'policy_rule_scope_shape_check'`,
        )
      ).rows;
      expect(shape).toHaveLength(1);
      const indexes = (
        await scratch.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE indexname = 'pass_approval_phase11_one_pending_destination'`,
        )
      ).rows;
      expect(indexes).toHaveLength(1);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('backfills legacy approvals and enforces exactly one requirement', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '010_destination_categories');
      const seed = await seedLegacyApproval(scratch, 'backfill');
      await migrateToLatest(handle.database);

      // History survives with the section-teacher kind backfilled.
      const backfilled = (
        await scratch.query<{ approver_kind: string; required_destination_id: string | null }>(
          `SELECT approver_kind, required_destination_id FROM pass_approval WHERE id = $1`,
          [seed.approval],
        )
      ).rows[0];
      expect(backfilled).toMatchObject({
        approver_kind: 'current_section_teacher',
        required_destination_id: null,
      });

      // Destination-bound approvals persist with the new kind.
      const destApproval = idOf(
        await scratch.query(
          `INSERT INTO pass_approval (tenant_id, organization_id, pass_id, origin_evaluation_result_id, policy_rule_id, policy_rule_revision, approver_kind, required_destination_id)
           VALUES ($1, $2, $3, $4, $5, 1, 'destination_responsible_staff', $6) RETURNING id`,
          [seed.tenantId, seed.school, seed.pass, seed.result, seed.rule, seed.destination],
        ),
      );
      expect(destApproval).toBeDefined();

      // Exactly one requirement: both-bound, neither-bound, and
      // kind/binding mismatches are all rejected.
      const bad = [
        `INSERT INTO pass_approval (tenant_id, organization_id, pass_id, origin_evaluation_result_id, policy_rule_id, policy_rule_revision, approver_kind, required_section_id, required_destination_id)
         VALUES ('${seed.tenantId}', '${seed.school}', '${seed.pass}', '${seed.result}', '${seed.rule}', 1, 'current_section_teacher', '${seed.section}', '${seed.destination}')`,
        `INSERT INTO pass_approval (tenant_id, organization_id, pass_id, origin_evaluation_result_id, policy_rule_id, policy_rule_revision, approver_kind)
         VALUES ('${seed.tenantId}', '${seed.school}', '${seed.pass}', '${seed.result}', '${seed.rule}', 1, 'current_section_teacher')`,
        `INSERT INTO pass_approval (tenant_id, organization_id, pass_id, origin_evaluation_result_id, policy_rule_id, policy_rule_revision, approver_kind, required_section_id)
         VALUES ('${seed.tenantId}', '${seed.school}', '${seed.pass}', '${seed.result}', '${seed.rule}', 1, 'destination_responsible_staff', '${seed.section}')`,
      ];
      for (const statement of bad) {
        await expect(scratch.query(statement)).rejects.toThrow();
      }

      // One logical pending requirement reuses without collapsing
      // unrelated requirements: duplicate destination pending rejected,
      // duplicate section pending rejected.
      await expect(
        scratch.query(
          `INSERT INTO pass_approval (tenant_id, organization_id, pass_id, origin_evaluation_result_id, policy_rule_id, policy_rule_revision, approver_kind, required_destination_id)
           VALUES ($1, $2, $3, $4, $5, 1, 'destination_responsible_staff', $6)`,
          [seed.tenantId, seed.school, seed.pass, seed.result, seed.rule, seed.destination],
        ),
      ).rejects.toThrow();
      await expect(
        scratch.query(
          `INSERT INTO pass_approval (tenant_id, organization_id, pass_id, origin_evaluation_result_id, policy_rule_id, policy_rule_revision, approver_kind, required_section_id)
           VALUES ($1, $2, $3, $4, $5, 1, 'current_section_teacher', $6)`,
          [seed.tenantId, seed.school, seed.pass, seed.result, seed.rule, seed.section],
        ),
      ).rejects.toThrow();
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('scopes rules to a pass category with same-school integrity', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '010_destination_categories');
      const seed = await seedLegacyApproval(scratch, 'catscope');
      await migrateToLatest(handle.database);

      // One category-scoped destination-approval rule persists.
      const rule = idOf(
        await scratch.query(
          `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind, scope_destination_category_id, configuration, override_mode)
           VALUES ($1, $2, 'Room visits', 'approval_requirement', 'destination_category', $3, '{"schemaVersion":1,"requestSources":["student_web"],"approver":"destination_responsible_staff"}'::jsonb, 'never') RETURNING id`,
          [seed.tenantId, seed.school, seed.category],
        ),
      );
      expect(rule).toBeDefined();

      // Cross-school category binding is rejected at the database layer.
      const foreign = idOf(
        await scratch.query(
          `INSERT INTO organization (tenant_id, kind, name, slug, time_zone) VALUES ($1, 'school', 'F', 'f-catscope', 'America/New_York') RETURNING id`,
          [seed.tenantId],
        ),
      );
      await expect(
        scratch.query(
          `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind, scope_destination_category_id, configuration, override_mode)
           VALUES ($1, $2, 'Foreign', 'approval_requirement', 'destination_category', $3, '{"schemaVersion":1,"requestSources":["student_web"],"approver":"destination_responsible_staff"}'::jsonb, 'never')`,
          [seed.tenantId, foreign, seed.category],
        ),
      ).rejects.toThrow();

      // The new reason vocabulary persists on evaluation results.
      // Reuse the seeded evaluation: one evaluation per pass revision.
      const evaluation = (
        await scratch.query<{ id: string }>(
          `SELECT id FROM policy_evaluation WHERE tenant_id = $1 AND pass_id = $2 AND pass_revision = 1`,
          [seed.tenantId, seed.pass],
        )
      ).rows[0]?.id;
      if (evaluation === undefined) throw new Error('Expected seeded evaluation');
      const result = idOf(
        await scratch.query(
          `INSERT INTO policy_evaluation_result (tenant_id, evaluation_id, policy_rule_id, policy_rule_revision, outcome, reason_code, override_mode, contribution, rule_snapshot)
           VALUES ($1, $2, $3, 1, 'fail', 'destination_responsible_staff_approval_required', 'never', 'approval_required', '{}') RETURNING id`,
          [seed.tenantId, evaluation, rule],
        ),
      );
      expect(result).toBeDefined();
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });
});
