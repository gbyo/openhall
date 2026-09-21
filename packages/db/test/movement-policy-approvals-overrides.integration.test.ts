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

const VALID_CONFIG = JSON.stringify({
  schemaVersion: 1,
  firstMinutes: 10,
  lastMinutes: 10,
  blockKinds: ['instructional'],
  requestSources: ['student_web', 'staff_web'],
});

/** Minimal school graph: tenant, school, section, student, destination. */
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
  const sessionId = idOf(
    await scratch.query(
      `INSERT INTO academic_session (tenant_id, organization_id, kind, name, starts_on, ends_on) VALUES ($1, $2, 'school_year', 'SY', '2026-08-01', '2027-06-01') RETURNING id`,
      [tenantId, school],
    ),
  );
  const section = idOf(
    await scratch.query(
      `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title) VALUES ($1, $2, $3, 'P1', 'Period 1') RETURNING id`,
      [tenantId, school, sessionId],
    ),
  );
  const foreignSection = idOf(
    await scratch.query(
      `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title) VALUES ($1, $2, $3, 'Q1', 'Foreign') RETURNING id`,
      [tenantId, otherSchool, sessionId],
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
  return { tenantId, school, otherSchool, section, foreignSection, student, destination, pass };
}

async function seedRule(
  scratch: Pool,
  school: { tenantId: string; school: string },
  overrides: {
    ruleType?: string;
    configuration?: string;
    scopeKind?: string;
    scopeId?: string;
  } = {},
): Promise<string> {
  const scopeKind = overrides.scopeKind ?? 'organization';
  const scopeColumn =
    scopeKind === 'organization'
      ? 'scope_organization_id'
      : scopeKind === 'section'
        ? 'scope_section_id'
        : 'scope_destination_id';
  return idOf(
    await scratch.query(
      `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind, ${scopeColumn}, configuration, override_mode)
       VALUES ($1, $2, 'R', $3, $4, $5, $6::jsonb, 'authorized') RETURNING id`,
      [
        school.tenantId,
        school.school,
        overrides.ruleType ?? 'schedule_boundary',
        scopeKind,
        overrides.scopeId ?? school.school,
        overrides.configuration ?? VALID_CONFIG,
      ],
    ),
  );
}

describe('migration 006 movement policy approvals overrides', () => {
  it('migrates a blank database 001 -> 006 with policy hardening', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const tables = await scratch.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'pass_approval'`,
      );
      expect(tables.rows).toHaveLength(1);
      const constraints = await scratch.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conname LIKE '%phase6%' ORDER BY 1`,
      );
      expect(constraints.rows.length).toBeGreaterThan(15);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('upgrades a real Phase 5 database 005 -> 006 preserving valid rules', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '005_pass_command_core');
      const tag = nonce();
      const school = await seedSchool(scratch, tag);
      const ruleId = await seedRule(scratch, school);
      await migrateToLatest(handle.database);
      const rows = await scratch.query<{ id: string }>(`SELECT id FROM policy_rule`);
      expect(rows.rows.map((row) => row.id)).toEqual([ruleId]);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('refuses uninterpretable rule types instead of reinterpreting them', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '005_pass_command_core');
      const school = await seedSchool(scratch, nonce());
      await scratch.query(
        `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind, scope_organization_id, configuration, override_mode)
         VALUES ($1, $2, 'R', 'daily_limit', 'organization', $2, '{}', 'never')`,
        [school.tenantId, school.school],
      );
      await expect(migrateToLatest(handle.database)).rejects.toThrow(/cannot interpret safely/);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('refuses rules without a Phase 6 schema version', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '005_pass_command_core');
      const school = await seedSchool(scratch, nonce());
      await seedRule(scratch, school, { configuration: JSON.stringify({ firstMinutes: 5 }) });
      await expect(migrateToLatest(handle.database)).rejects.toThrow(/schemaVersion 1/);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('refuses legacy evaluations and overrides it cannot migrate truthfully', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '005_pass_command_core');
      const school = await seedSchool(scratch, nonce());
      const ruleId = await seedRule(scratch, school);
      const evaluation = idOf(
        await scratch.query(
          `INSERT INTO policy_evaluation (tenant_id, pass_id, stage, decision) VALUES ($1, $2, 'request', 'allow') RETURNING id`,
          [school.tenantId, school.pass],
        ),
      );
      const result = idOf(
        await scratch.query(
          `INSERT INTO policy_evaluation_result (tenant_id, evaluation_id, policy_rule_id, policy_rule_revision, outcome, reason_code, override_mode)
           VALUES ($1, $2, $3, 1, 'pass', 'no_violation', 'never') RETURNING id`,
          [school.tenantId, evaluation, ruleId],
        ),
      );
      await scratch.query(
        `INSERT INTO pass_override (tenant_id, pass_id, evaluation_result_id, requested_by_person_id) VALUES ($1, $2, $3, $4)`,
        [school.tenantId, school.pass, result, school.student],
      );
      await expect(migrateToLatest(handle.database)).rejects.toThrow(/predate/);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('closes rule vocabulary and same-school scope at the database', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const school = await seedSchool(scratch, nonce());
      await expect(seedRule(scratch, school, { ruleType: 'capacity' })).rejects.toThrow();
      await expect(
        seedRule(scratch, school, { scopeKind: 'section', scopeId: school.foreignSection }),
      ).rejects.toThrow();
      await expect(
        scratch.query(
          `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind, scope_organization_id, configuration, override_mode)
           VALUES ($1, $3, 'R', 'schedule_boundary', 'organization', $2, $4, 'never')`,
          [school.tenantId, school.otherSchool, school.school, VALID_CONFIG],
        ),
      ).rejects.toThrow();
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('enforces outcome contribution coherence and pending deduplication', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const school = await seedSchool(scratch, nonce());
      const ruleId = await seedRule(scratch, school);
      const evaluation = idOf(
        await scratch.query(
          `INSERT INTO policy_evaluation (tenant_id, pass_id, pass_revision, stage, decision, context_snapshot)
           VALUES ($1, $2, 1, 'request', 'approval_required', '{}') RETURNING id`,
          [school.tenantId, school.pass],
        ),
      );
      await expect(
        scratch.query(
          `INSERT INTO policy_evaluation_result (tenant_id, evaluation_id, policy_rule_id, policy_rule_revision, outcome, reason_code, override_mode, contribution, rule_snapshot)
           VALUES ($1, $2, $3, 1, 'pass', 'no_violation', 'never', 'deny', '{}')`,
          [school.tenantId, evaluation, ruleId],
        ),
      ).rejects.toThrow();
      const result = idOf(
        await scratch.query(
          `INSERT INTO policy_evaluation_result (tenant_id, evaluation_id, policy_rule_id, policy_rule_revision, outcome, reason_code, override_mode, contribution, rule_snapshot)
           VALUES ($1, $2, $3, 1, 'fail', 'current_section_teacher_approval_required', 'never', 'approval_required', '{}') RETURNING id`,
          [school.tenantId, evaluation, ruleId],
        ),
      );
      const approval = `INSERT INTO pass_approval (tenant_id, organization_id, pass_id, origin_evaluation_result_id, policy_rule_id, policy_rule_revision, required_section_id)
        VALUES ($1, $2, $3, $4, $5, 1, $6)`;
      await scratch.query(approval, [
        school.tenantId,
        school.school,
        school.pass,
        result,
        ruleId,
        school.section,
      ]);
      await expect(
        scratch.query(approval, [
          school.tenantId,
          school.school,
          school.pass,
          result,
          ruleId,
          school.section,
        ]),
      ).rejects.toThrow();
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('enforces separation of duties for approval_required overrides', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateToLatest(handle.database);
      const school = await seedSchool(scratch, nonce());
      const ruleId = await seedRule(scratch, school);
      const evaluation = idOf(
        await scratch.query(
          `INSERT INTO policy_evaluation (tenant_id, pass_id, pass_revision, stage, decision, context_snapshot)
           VALUES ($1, $2, 1, 'override', 'override_required', '{}') RETURNING id`,
          [school.tenantId, school.pass],
        ),
      );
      const result = idOf(
        await scratch.query(
          `INSERT INTO policy_evaluation_result (tenant_id, evaluation_id, policy_rule_id, policy_rule_revision, outcome, reason_code, override_mode, contribution, rule_snapshot)
           VALUES ($1, $2, $3, 1, 'fail', 'schedule_boundary_blackout', 'approval_required', 'override_required', '{}') RETURNING id`,
          [school.tenantId, evaluation, ruleId],
        ),
      );
      // Same-person approval of an approval_required override is rejected.
      await expect(
        scratch.query(
          `INSERT INTO pass_override (tenant_id, organization_id, pass_id, evaluation_result_id, requested_by_person_id, policy_rule_id, policy_rule_revision, override_mode, category, decision, decision_actor_kind, decided_by_person_id, decided_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1, 'approval_required', 'urgent', 'approved', 'person', $5, now())`,
          [school.tenantId, school.school, school.pass, result, school.student, ruleId],
        ),
      ).rejects.toThrow();
      // Direct self-resolution stays available for authorized mode.
      const authorized = idOf(
        await scratch.query(
          `INSERT INTO policy_evaluation_result (tenant_id, evaluation_id, policy_rule_id, policy_rule_revision, outcome, reason_code, override_mode, contribution, rule_snapshot)
           VALUES ($1, $2, $3, 1, 'fail', 'schedule_boundary_blackout', 'authorized', 'override_required', '{}') RETURNING id`,
          [school.tenantId, evaluation, ruleId],
        ),
      );
      await scratch.query(
        `INSERT INTO pass_override (tenant_id, organization_id, pass_id, evaluation_result_id, requested_by_person_id, policy_rule_id, policy_rule_revision, override_mode, category, decision, decision_actor_kind, decided_by_person_id, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 'authorized', 'urgent', 'approved', 'person', $5, now())`,
        [school.tenantId, school.school, school.pass, authorized, school.student, ruleId],
      );
      // Live duplicates are rejected while denied history is retained.
      await expect(
        scratch.query(
          `INSERT INTO pass_override (tenant_id, organization_id, pass_id, evaluation_result_id, requested_by_person_id, policy_rule_id, policy_rule_revision, override_mode, category)
           VALUES ($1, $2, $3, $4, $5, $6, 1, 'authorized', 'private')`,
          [school.tenantId, school.school, school.pass, authorized, school.student, ruleId],
        ),
      ).rejects.toThrow();
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });
});
