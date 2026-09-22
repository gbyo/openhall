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

interface Fixture {
  tenant: string;
  school: string;
  locations: Record<'health' | 'guidance' | 'room305' | 'lab214' | 'oldGym', string>;
  destinations: Record<'health' | 'carter' | 'jackson' | 'lab214' | 'oldGym', string>;
  section: string;
  pass: string;
  scheduled: string;
}

/** Stage the full pre-rooms world at migration 009, then run 010 + 011. */
async function stagePreRoomsWorld(scratch: Pool): Promise<Fixture> {
  const tenant = idOf(
    await scratch.query(`INSERT INTO tenant (name, slug) VALUES ('T', $1) RETURNING id`, [
      `trooms${randomUUID().replaceAll('-', '').slice(0, 8)}`,
    ]),
  );
  const school = idOf(
    await scratch.query(
      `INSERT INTO organization (tenant_id, kind, name, slug, time_zone)
       VALUES ($1, 'school', 'S', $2, 'America/New_York') RETURNING id`,
      [tenant, `srooms${randomUUID().replaceAll('-', '').slice(0, 8)}`],
    ),
  );
  const location = async (
    kind: string,
    name: string,
    status = 'active',
    extra: Record<string, string | null> = {},
  ): Promise<string> =>
    idOf(
      await scratch.query(
        `INSERT INTO location (tenant_id, organization_id, kind, name, status, code, floor_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [tenant, school, kind, name, status, extra.code ?? null, extra.floor ?? null],
      ),
    );
  // L1 1:1 fold with its destination; L2 backs two distinct destinations;
  // L3 has no destination; L4 is a scheduled classroom (1:1 fold); L5/L6
  // cover archived states.
  const health = await location('clinic', 'Health Office', 'active', { code: 'HO', floor: '1' });
  const guidance = await location('office', 'Guidance Office');
  const room305 = await location('classroom', 'Room 305', 'inactive', { code: '305' });
  const lab214 = await location('classroom', 'Science Lab 214', 'active', { code: '214', floor: '2' });
  const oldGym = await location('gym', 'Old Gym', 'archived');

  const destination = async (
    locationId: string,
    serviceType: string,
    displayName: string | null,
    status = 'active',
  ): Promise<string> =>
    idOf(
      await scratch.query(
        `INSERT INTO destination (tenant_id, organization_id, location_id, service_type, display_name, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [tenant, school, locationId, serviceType, displayName, status],
      ),
    );
  const healthDest = await destination(health, 'nurse', 'Health Office');
  const carter = await destination(guidance, 'counseling', 'Mrs Carter');
  const jackson = await destination(guidance, 'counseling', 'Mr Jackson');
  const labDest = await destination(lab214, 'classroom', 'Science Lab 214', 'closed');
  const oldGymDest = await destination(oldGym, 'gym', 'Old Gym', 'archived');

  const session = idOf(
    await scratch.query(
      `INSERT INTO academic_session (tenant_id, organization_id, kind, name, starts_on, ends_on)
       VALUES ($1, $2, 'semester', 'Fall', '2026-08-01', '2026-12-31') RETURNING id`,
      [tenant, school],
    ),
  );
  const section = idOf(
    await scratch.query(
      `INSERT INTO section (tenant_id, organization_id, academic_session_id, code, title)
       VALUES ($1, $2, $3, 'SCI-214', 'Physical Science') RETURNING id`,
      [tenant, school, session],
    ),
  );
  const block = idOf(
    await scratch.query(
      `INSERT INTO schedule_block (tenant_id, organization_id, code, display_name, kind)
       VALUES ($1, $2, 'P2', 'Period 2', 'instructional') RETURNING id`,
      [tenant, school],
    ),
  );
  await scratch.query(
    `INSERT INTO section_meeting (tenant_id, organization_id, section_id, schedule_block_id, location_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenant, school, section, block, lab214],
  );

  const person = async (given: string, family: string): Promise<string> =>
    idOf(
      await scratch.query(
        `INSERT INTO person (tenant_id, given_name, family_name, display_name)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenant, given, family, `${given} ${family}`],
      ),
    );
  const student = await person('Stu', 'Dent');
  const staffer = await person('Nurse', 'Smith');
  await scratch.query(
    `INSERT INTO organization_membership (tenant_id, organization_id, person_id, affiliation)
     VALUES ($1, $2, $3, 'student'), ($1, $2, $4, 'staff')`,
    [tenant, school, student, staffer],
  );
  const staffAccount = idOf(
    await scratch.query(`INSERT INTO account (tenant_id, person_id) VALUES ($1, $2) RETURNING id`, [
      tenant,
      staffer,
    ]),
  );

  // Pass: classroom origin -> nurse destination -> guidance return.
  const pass = idOf(
    await scratch.query(
      `INSERT INTO pass (tenant_id, organization_id, student_id, origin_location_id,
                         destination_id, return_location_id, request_source, lifecycle_state)
       VALUES ($1, $2, $3, $4, $5, $6, 'student_web', 'requested') RETURNING id`,
      [tenant, school, student, lab214, healthDest, guidance],
    ),
  );
  const scheduled = idOf(
    await scratch.query(
      `INSERT INTO scheduled_authorization (tenant_id, organization_id, student_id, destination_id,
                                            created_by_person_id, valid_from, valid_until,
                                            approval_mode, origin_strategy, origin_location_id)
       VALUES ($1, $2, $3, $4, $5, now(), now() + interval '1 day', 'preapproved', 'specific', $6)
       RETURNING id`,
      [tenant, school, student, carter, staffer, health],
    ),
  );
  await scratch.query(
    `INSERT INTO authorization_grant (tenant_id, account_id, role, scope_kind, destination_id)
     VALUES ($1, $2, 'destination_staff', 'destination', $3)`,
    [tenant, staffAccount, carter],
  );
  const policyRule = idOf(
    await scratch.query(
      `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind,
                                scope_destination_id, configuration, override_mode)
       VALUES ($1, $2, 'Counselor approval', 'approval_requirement', 'destination', $3, '{}', 'authorized')
       RETURNING id`,
      [tenant, school, carter],
    ),
  );
  const evaluation = idOf(
    await scratch.query(
      `INSERT INTO policy_evaluation (tenant_id, pass_id, stage, decision, pass_revision)
       VALUES ($1, $2, 'request', 'approval_required', 1) RETURNING id`,
      [tenant, pass],
    ),
  );
  const evaluationResult = idOf(
    await scratch.query(
      `INSERT INTO policy_evaluation_result (tenant_id, evaluation_id, policy_rule_id,
                                             policy_rule_revision, outcome, reason_code, override_mode,
                                             contribution)
       VALUES ($1, $2, $3, 1, 'fail', 'current_section_teacher_approval_required', 'authorized',
               'approval_required')
       RETURNING id`,
      [tenant, evaluation, policyRule],
    ),
  );
  await scratch.query(
    `INSERT INTO pass_approval (tenant_id, organization_id, pass_id, origin_evaluation_result_id,
                                policy_rule_id, policy_rule_revision, required_section_id)
     VALUES ($1, $2, $3, $4, $5, 1, $6)`,
    [tenant, school, pass, evaluationResult, policyRule, section],
  );
  await scratch.query(
    `INSERT INTO queue_entry (tenant_id, organization_id, destination_id, pass_id,
                              policy_evaluation_id, flow_expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
    [tenant, school, healthDest, pass, evaluation],
  );
  await scratch.query(
    `INSERT INTO destination_reservation (tenant_id, organization_id, destination_id, pass_id,
                                          policy_evaluation_id, ready_expires_at, flow_expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '1 minute', now() + interval '10 minutes')`,
    [tenant, school, healthDest, pass, evaluation],
  );
  // Released history rows carrying the old unavailable vocabulary.
  await scratch.query(
    `INSERT INTO destination_reservation (tenant_id, organization_id, destination_id, pass_id,
                                          policy_evaluation_id, reserved_at, ready_expires_at, flow_expires_at,
                                          released_at, release_reason)
     VALUES ($1, $2, $3, $4, $5, now() - interval '5 minutes', now() - interval '2 minutes',
             now() + interval '10 minutes', now() - interval '1 minute', 'destination_unavailable')`,
    [tenant, school, healthDest, pass, evaluation],
  );
  await scratch.query(
    `INSERT INTO queue_entry (tenant_id, organization_id, destination_id, pass_id,
                              policy_evaluation_id, entered_at, flow_expires_at, released_at, release_reason)
     VALUES ($1, $2, $3, $4, $5, now() - interval '5 minutes', now() + interval '10 minutes',
             now() - interval '1 minute', 'destination_unavailable')`,
    [tenant, school, healthDest, pass, evaluation],
  );
  const incident = idOf(
    await scratch.query(
      `INSERT INTO operational_incident (tenant_id, organization_id, mode, activated_by_person_id)
       VALUES ($1, $2, 'other', $3) RETURNING id`,
      [tenant, school, staffer],
    ),
  );
  await scratch.query(
    `INSERT INTO incident_presence_report (tenant_id, incident_id, person_id, location_id,
                                           presence_state, reported_by_person_id)
     VALUES ($1, $2, $3, $4, 'observed_present', $5)`,
    [tenant, incident, student, health, staffer],
  );

  return {
    tenant,
    school,
    locations: { health, guidance, room305: room305, lab214, oldGym },
    destinations: { health: healthDest, carter, jackson, lab214: labDest, oldGym: oldGymDest },
    section,
    pass,
    scheduled,
  };
}

describe('migration 011 rooms unification', () => {
  it('unifies categories and rooms while preserving every reference', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '009_guided_setup_authentication');
      const fixture = await stagePreRoomsWorld(scratch);
      await migrateToLatest(handle.database);

      const lastMigration = await scratch.query<{ name: string }>(
        'SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1',
      );
      expect(lastMigration.rows[0]?.name).toBe('011_rooms_unification');

      // Legacy runtime tables are gone; room tables exist.
      const tables = (
        await scratch.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name IN ('destination', 'location', 'destination_category',
                                'destination_reservation', 'room', 'room_category', 'room_reservation')`,
        )
      ).rows.map((row) => row.table_name);
      expect(tables.sort()).toEqual(['room', 'room_category', 'room_reservation']);

      // 5 destinations + 2 unfolded locations (guidance split, room 305
      // alone); the three 1:1 pairs fold into their destination rooms.
      const roomCount = await scratch.query<{ count: string }>(
        'SELECT count(*) AS count FROM room WHERE tenant_id = $1',
        [fixture.tenant],
      );
      expect(Number(roomCount.rows[0]?.count)).toBe(7);

      // 1:1 fold keeps the destination UUID with the canonical name and
      // code/floor carried from the location.
      const healthRoom = (
        await scratch.query<{
          id: string;
          name: string;
          code: string | null;
          floor_label: string | null;
          status: string;
          student_self_requestable: boolean;
          origin_selectable: boolean;
          capacity: number | null;
          queue_enabled: boolean;
          check_in_mode: string;
          category_id: string | null;
          category_name: string;
          icon_key: string;
          tone_key: string;
          picker_mode: string;
        }>(
          `SELECT r.id, r.name, r.code, r.floor_label, r.status,
                  r.student_self_requestable, r.origin_selectable,
                  r.capacity, r.queue_enabled, r.check_in_mode,
                  r.category_id, c.name AS category_name,
                  c.icon_key, c.tone_key, c.picker_mode
           FROM room r JOIN room_category c ON c.id = r.category_id
           WHERE r.tenant_id = $1 AND r.id = $2`,
          [fixture.tenant, fixture.destinations.health],
        )
      ).rows[0];
      expect(healthRoom).toMatchObject({
        id: fixture.destinations.health,
        name: 'Health Office',
        code: 'HO',
        floor_label: '1',
        status: 'open',
        student_self_requestable: true,
        origin_selectable: true,
        category_name: 'Nurse',
        icon_key: 'medical',
        tone_key: 'rose',
        picker_mode: 'auto',
      });

      // 1:N split keeps every target: both counselor rooms plus the
      // guidance location room itself.
      const guidanceRooms = (
        await scratch.query<{ id: string; name: string; category_id: string | null }>(
          `SELECT id, name, category_id FROM room
           WHERE tenant_id = $1 AND name IN ('Mrs Carter', 'Mr Jackson', 'Guidance Office')
           ORDER BY name`,
          [fixture.tenant],
        )
      ).rows;
      expect(guidanceRooms.map((row) => row.name)).toEqual([
        'Guidance Office',
        'Mr Jackson',
        'Mrs Carter',
      ]);
      expect(guidanceRooms.map((row) => row.id).sort()).toEqual(
        [fixture.destinations.carter, fixture.destinations.jackson, fixture.locations.guidance].sort(),
      );
      const guidanceLocationRoom = guidanceRooms.find((row) => row.name === 'Guidance Office');
      expect(guidanceLocationRoom?.category_id).toBeNull();

      // Location-only rooms keep their UUID, lose nothing, gain no category.
      const room305 = (
        await scratch.query<{
          id: string;
          name: string;
          code: string | null;
          status: string;
          student_self_requestable: boolean;
          category_id: string | null;
        }>(
          `SELECT id, name, code, status, student_self_requestable, category_id
           FROM room WHERE tenant_id = $1 AND id = $2`,
          [fixture.tenant, fixture.locations.room305],
        )
      ).rows[0];
      expect(room305).toMatchObject({
        name: 'Room 305',
        code: '305',
        status: 'closed',
        student_self_requestable: false,
        category_id: null,
      });

      // Destination closed/archived states travel with the room.
      const statuses = (
        await scratch.query<{ id: string; status: string }>(
          'SELECT id, status FROM room WHERE tenant_id = $1 AND id = ANY ($2)',
          [fixture.tenant, [fixture.destinations.lab214, fixture.destinations.oldGym]],
        )
      ).rows;
      expect(new Map(statuses.map((row) => [row.id, row.status]))).toEqual(
        new Map([
          [fixture.destinations.lab214, 'closed'],
          [fixture.destinations.oldGym, 'archived'],
        ]),
      );

      // Pass movement is symmetrical room -> room -> room.
      const pass = (
        await scratch.query<{
          origin_room_id: string | null;
          destination_room_id: string;
          return_room_id: string | null;
          origin_section_id: string | null;
          origin_schedule_block_id: string | null;
        }>(
          `SELECT origin_room_id, destination_room_id, return_room_id,
                  origin_section_id, origin_schedule_block_id
           FROM pass WHERE tenant_id = $1 AND id = $2`,
          [fixture.tenant, fixture.pass],
        )
      ).rows[0];
      expect(pass).toMatchObject({
        origin_room_id: fixture.destinations.lab214,
        destination_room_id: fixture.destinations.health,
        return_room_id: fixture.locations.guidance,
      });

      // Scheduled specific origins and destinations survive.
      const scheduled = (
        await scratch.query<{
          origin_room_id: string | null;
          destination_room_id: string;
          origin_strategy: string;
        }>(
          `SELECT origin_room_id, destination_room_id, origin_strategy
           FROM scheduled_authorization WHERE tenant_id = $1 AND id = $2`,
          [fixture.tenant, fixture.scheduled],
        )
      ).rows[0];
      expect(scheduled).toMatchObject({
        origin_room_id: fixture.destinations.health,
        destination_room_id: fixture.destinations.carter,
        origin_strategy: 'specific',
      });

      // Classroom schedule meetings resolve to the folded room.
      const meeting = (
        await scratch.query<{ room_id: string }>(
          'SELECT room_id FROM section_meeting WHERE tenant_id = $1 AND section_id = $2',
          [fixture.tenant, fixture.section],
        )
      ).rows[0];
      expect(meeting?.room_id).toBe(fixture.destinations.lab214);

      // Explicit staff grants become room grants with the same target.
      const grant = (
        await scratch.query<{ role: string; scope_kind: string; room_id: string | null }>(
          'SELECT role, scope_kind, room_id FROM authorization_grant WHERE tenant_id = $1',
          [fixture.tenant],
        )
      ).rows[0];
      expect(grant).toMatchObject({
        role: 'room_staff',
        scope_kind: 'room',
        room_id: fixture.destinations.carter,
      });

      // Destination-scoped policy becomes room-scoped with the same target.
      const policy = (
        await scratch.query<{ scope_kind: string; scope_room_id: string | null }>(
          'SELECT scope_kind, scope_room_id FROM policy_rule WHERE tenant_id = $1',
          [fixture.tenant],
        )
      ).rows[0];
      expect(policy).toMatchObject({
        scope_kind: 'room',
        scope_room_id: fixture.destinations.carter,
      });

      // Legacy approvals backfill as current-section-teacher.
      const approval = (
        await scratch.query<{
          approver_kind: string;
          required_section_id: string | null;
          required_room_id: string | null;
        }>(
          `SELECT approver_kind, required_section_id, required_room_id
           FROM pass_approval WHERE tenant_id = $1`,
          [fixture.tenant],
        )
      ).rows[0];
      expect(approval).toMatchObject({
        approver_kind: 'current_section_teacher',
        required_section_id: fixture.section,
        required_room_id: null,
      });

      // Queue and reservation rows follow the destination room by identity.
      const queue = (
        await scratch.query<{ room_id: string }>('SELECT room_id FROM queue_entry WHERE tenant_id = $1', [
          fixture.tenant,
        ])
      ).rows[0];
      expect(queue?.room_id).toBe(fixture.destinations.health);
      const reservation = (
        await scratch.query<{ room_id: string }>(
          'SELECT room_id FROM room_reservation WHERE tenant_id = $1',
          [fixture.tenant],
        )
      ).rows[0];
      expect(reservation?.room_id).toBe(fixture.destinations.health);

      // Presence reports keep their observed place as a room.
      const presence = (
        await scratch.query<{ room_id: string }>(
          'SELECT room_id FROM incident_presence_report WHERE tenant_id = $1',
          [fixture.tenant],
        )
      ).rows[0];
      expect(presence?.room_id).toBe(fixture.destinations.health);

      // Old column names are gone from the new tables.
      const staleColumns = (
        await scratch.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name IN ('pass', 'scheduled_authorization', 'section_meeting',
                                'queue_entry', 'room_reservation', 'authorization_grant',
                                'policy_rule', 'pass_approval', 'incident_presence_report')
             AND column_name IN ('destination_id', 'origin_location_id', 'return_location_id',
                                 'location_id', 'scope_destination_id', 'destination_category_id',
                                 'service_type', 'display_name', 'kind', 'parent_location_id')`,
        )
      ).rows;
      expect(staleColumns).toEqual([]);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('carries flow release history onto the room vocabulary', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '009_guided_setup_authentication');
      const fixture = await stagePreRoomsWorld(scratch);
      await migrateToLatest(handle.database);

      const reasons = (
        await scratch.query<{ reason: string }>(
          `SELECT DISTINCT release_reason AS reason FROM room_reservation
           WHERE tenant_id = $1 AND release_reason IS NOT NULL
           UNION SELECT DISTINCT release_reason FROM queue_entry
           WHERE tenant_id = $1 AND release_reason IS NOT NULL`,
          [fixture.tenant],
        )
      ).rows.map((row) => row.reason);
      expect(reasons).toEqual(['room_unavailable']);
      const checks = (
        await scratch.query<{ name: string }>(
          `SELECT conname AS name FROM pg_constraint
           WHERE conname IN ('room_reservation_phase11_release_reason',
                             'queue_entry_phase11_release_reason')
           ORDER BY 1`,
        )
      ).rows.map((row) => row.name);
      expect(checks).toEqual([
        'queue_entry_phase11_release_reason',
        'room_reservation_phase11_release_reason',
      ]);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });

  it('enforces room invariants and same-school references after unification', async () => {
    const { url, pool: scratch } = await freshDatabase();
    const handle = createDatabase(url, { max: 1 });
    try {
      await migrateTo(handle, '009_guided_setup_authentication');
      const fixture = await stagePreRoomsWorld(scratch);
      await migrateToLatest(handle.database);

      // Student-requestable rooms require a category.
      await expect(
        scratch.query(
          `INSERT INTO room (tenant_id, organization_id, name, student_self_requestable)
           VALUES ($1, $2, 'No Category', true)`,
          [fixture.tenant, fixture.school],
        ),
      ).rejects.toThrow(/room_phase11_self_requestable_needs_category/);

      // Room-category policy scope is writable after unification.
      const categoryId = (
        await scratch.query<{ id: string }>(
          'SELECT id FROM room_category WHERE tenant_id = $1 LIMIT 1',
          [fixture.tenant],
        )
      ).rows[0]?.id;
      expect(categoryId).toBeDefined();
      await scratch.query(
        `INSERT INTO policy_rule (tenant_id, organization_id, name, rule_type, scope_kind,
                                  scope_room_category_id, configuration, override_mode)
         VALUES ($1, $2, 'Room visits approval', 'approval_requirement', 'room_category', $3, '{}', 'authorized')`,
        [fixture.tenant, fixture.school, categoryId],
      );

      // Cross-school room references are refused loudly.
      const otherSchool = idOf(
        await scratch.query(
          `INSERT INTO organization (tenant_id, kind, name, slug, time_zone)
           VALUES ($1, 'school', 'Other', $2, 'America/New_York') RETURNING id`,
          [fixture.tenant, `sother${randomUUID().replaceAll('-', '').slice(0, 8)}`],
        ),
      );
      const otherRoom = idOf(
        await scratch.query(
          `INSERT INTO room (tenant_id, organization_id, name) VALUES ($1, $2, 'Elsewhere') RETURNING id`,
          [fixture.tenant, otherSchool],
        ),
      );
      // A fresh student avoids the one-active-pass-per-student invariant so
      // the cross-school room reference is what fails.
      const student = idOf(
        await scratch.query(
          `INSERT INTO person (tenant_id, given_name, family_name, display_name)
           VALUES ($1, 'Cross', 'School', 'Cross School') RETURNING id`,
          [fixture.tenant],
        ),
      );
      await expect(
        scratch.query(
          `INSERT INTO pass (tenant_id, organization_id, student_id, destination_room_id,
                             request_source, lifecycle_state)
           VALUES ($1, $2, $3, $4, 'student_web', 'requested')`,
          [fixture.tenant, fixture.school, student, otherRoom],
        ),
      ).rejects.toThrow(/pass_phase11_destination_room_same_school/);
    } finally {
      await handle.destroy();
      await scratch.end();
    }
  });
});
