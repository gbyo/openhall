import { sql, type Kysely } from 'kysely';

/**
 * 011 rooms unification: Category -> Room becomes the single school movement
 * model, replacing `location` + `destination` + `destination_category`.
 *
 * - `destination_category` is renamed to `room_category` (IDs and data
 *   preserved) and gains `picker_mode` (`auto`/`list`/`search`).
 * - `location` + `destination` fold into one `room` aggregate. Destination
 *   rows keep their UUIDs as room UUIDs; locations with zero or several
 *   destinations keep their UUIDs as room UUIDs; a location with exactly
 *   one destination folds into that destination's room. A temporary mapping
 *   resolves every old location reference to its surviving room.
 * - Pass, scheduled authorization, section meeting, and presence report
 *   references move to `*_room_id` / `room_id` columns before the old
 *   tables are dropped. Nothing is silently lost: every old location and
 *   every old destination has a room mapping, and the migration fails
 *   loudly on any unmappable row.
 * - `destination_reservation` becomes `room_reservation`;
 *   `queue_entry.destination_id` becomes `room_id` (queue/capacity
 *   invariants unchanged).
 * - `destination_staff` grants become `room_staff` (`room` scope);
 *   policy scopes become `room` / `room_category`.
 * - `pass_approval` generalizes to `current_section_teacher`
 *   (required_section_id) or `room_responsible_staff` (required_room_id)
 *   with exact CHECK constraints; legacy rows backfill as section teacher.
 */
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql.raw(ROOMS_UNIFICATION_SQL).execute(database);
}

const ROOMS_UNIFICATION_SQL = `
-- 011 rooms unification.
-- Migrations 001-010 are never modified; everything here handles the
-- Location -> Destination -> Place era collapsing into Category -> Room.

-- 0. Preflights: fail loudly rather than lose a pass target, schedule
-- origin, staff grant, policy, queue, or reservation row.
DO $$
DECLARE
  orphan_destinations bigint;
  cross_school_pairs bigint;
  uncategorized_destinations bigint;
  unexpected_destination_status bigint;
  unexpected_location_status bigint;
  colliding_ids bigint;
BEGIN
  SELECT count(*) INTO orphan_destinations
  FROM destination d
  LEFT JOIN location l ON l.tenant_id = d.tenant_id AND l.id = d.location_id
  WHERE l.id IS NULL;
  IF orphan_destinations > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % destination row(s) reference a missing location; resolve manually',
      orphan_destinations;
  END IF;

  SELECT count(*) INTO cross_school_pairs
  FROM destination d
  JOIN location l ON l.tenant_id = d.tenant_id AND l.id = d.location_id
  WHERE l.organization_id <> d.organization_id;
  IF cross_school_pairs > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % destination row(s) pair with a location in another school; resolve manually',
      cross_school_pairs;
  END IF;

  SELECT count(*) INTO uncategorized_destinations
  FROM destination WHERE category_id IS NULL;
  IF uncategorized_destinations > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % destination row(s) have no category; resolve manually',
      uncategorized_destinations;
  END IF;

  SELECT count(*) INTO unexpected_destination_status
  FROM destination WHERE status NOT IN ('active', 'closed', 'archived');
  IF unexpected_destination_status > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % destination row(s) carry an unexpected status; resolve manually',
      unexpected_destination_status;
  END IF;

  SELECT count(*) INTO unexpected_location_status
  FROM location WHERE status NOT IN ('active', 'inactive', 'archived');
  IF unexpected_location_status > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % location row(s) carry an unexpected status; resolve manually',
      unexpected_location_status;
  END IF;

  -- Room UUIDs preserve old destination/location UUIDs where unambiguous,
  -- so the two old key spaces must be disjoint.
  SELECT count(*) INTO colliding_ids
  FROM location l JOIN destination d
    ON d.tenant_id = l.tenant_id AND d.id = l.id;
  IF colliding_ids > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % id(s) exist as both a location and a destination; resolve manually',
      colliding_ids;
  END IF;
END $$;

-- 1. Category table becomes room_category (IDs and data preserved) and
-- gains the student picker mode.
ALTER TABLE destination_category RENAME TO room_category;

ALTER TABLE room_category
  ADD COLUMN picker_mode text NOT NULL DEFAULT 'auto'
  CONSTRAINT room_category_phase11_picker_mode CHECK (picker_mode IN ('auto', 'list', 'search'));

-- 2. The single canonical room aggregate.
CREATE TABLE room (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  category_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 200),
  code text CHECK (code IS NULL OR (length(btrim(code)) > 0 AND length(code) <= 40)),
  floor_label text CHECK (floor_label IS NULL OR (length(btrim(floor_label)) > 0 AND length(floor_label) <= 40)),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
  student_self_requestable boolean NOT NULL DEFAULT false,
  origin_selectable boolean NOT NULL DEFAULT true,
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  queue_enabled boolean NOT NULL DEFAULT false,
  check_in_mode text NOT NULL DEFAULT 'none' CHECK (check_in_mode IN ('none', 'optional', 'required')),
  default_duration_seconds integer CHECK (default_duration_seconds IS NULL OR default_duration_seconds > 0),
  max_duration_seconds integer CHECK (max_duration_seconds IS NULL OR max_duration_seconds > 0),
  ready_claim_timeout_seconds integer NOT NULL DEFAULT 60 CHECK (ready_claim_timeout_seconds BETWEEN 5 AND 600),
  queue_timeout_seconds integer NOT NULL DEFAULT 600 CHECK (queue_timeout_seconds BETWEEN 60 AND 14400),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, organization_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id, category_id) REFERENCES room_category (tenant_id, organization_id, id),
  CHECK (max_duration_seconds IS NULL OR default_duration_seconds IS NULL OR max_duration_seconds >= default_duration_seconds),
  CONSTRAINT room_phase11_self_requestable_needs_category
  CHECK (student_self_requestable = false OR category_id IS NOT NULL)
);

CREATE INDEX room_phase11_school_category_idx
  ON room (tenant_id, organization_id, category_id);
CREATE INDEX room_phase11_school_status_idx
  ON room (tenant_id, organization_id, status);

-- 3. Deterministic location -> room mapping for every ambiguous
-- transformation. Destinations map by identity (each destination keeps its
-- UUID as a room UUID); locations map to the folded destination room when
-- they back exactly one destination, otherwise to their own room.
CREATE TEMPORARY TABLE room_location_map (
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL PRIMARY KEY,
  room_id uuid NOT NULL
) ON COMMIT DROP;

INSERT INTO room_location_map (tenant_id, location_id, room_id)
SELECT l.tenant_id, l.id,
  CASE WHEN single.destination_id IS NOT NULL THEN single.destination_id ELSE l.id END
FROM location l
LEFT JOIN (
  SELECT tenant_id, location_id, min(id::text)::uuid AS destination_id
  FROM destination
  GROUP BY tenant_id, location_id
  HAVING count(*) = 1
) single
  ON single.tenant_id = l.tenant_id AND single.location_id = l.id;

-- 4a. One room per destination, preserving the destination UUID. The room
-- name collapses the old display-name/service-type split into the single
-- canonical name; capacity/queue/check-in/flow settings travel with it.
INSERT INTO room (
  id, tenant_id, organization_id, category_id, name, code, floor_label,
  status, student_self_requestable, origin_selectable, capacity,
  queue_enabled, check_in_mode, default_duration_seconds,
  max_duration_seconds, ready_claim_timeout_seconds, queue_timeout_seconds,
  revision, created_at, updated_at
)
SELECT
  d.id, d.tenant_id, d.organization_id, d.category_id,
  coalesce(nullif(btrim(d.display_name), ''), l.name),
  l.code, l.floor_label,
  CASE d.status WHEN 'active' THEN 'open' WHEN 'closed' THEN 'closed' ELSE 'archived' END,
  d.student_self_requestable, true, d.capacity,
  d.queue_enabled, d.check_in_mode, d.default_duration_seconds,
  d.max_duration_seconds, d.ready_claim_timeout_seconds, d.queue_timeout_seconds,
  d.revision, l.created_at, greatest(d.updated_at, l.updated_at)
FROM destination d
JOIN location l ON l.tenant_id = d.tenant_id AND l.id = d.location_id;

-- 4b. One room per location that is NOT folded into a single destination
-- (no destination, or several genuinely distinct destinations), preserving
-- the location UUID so schedule/origin history keeps its identity.
INSERT INTO room (
  id, tenant_id, organization_id, category_id, name, code, floor_label,
  status, student_self_requestable, origin_selectable,
  revision, created_at, updated_at
)
SELECT
  l.id, l.tenant_id, l.organization_id, NULL, l.name, l.code, l.floor_label,
  CASE l.status WHEN 'active' THEN 'open' WHEN 'inactive' THEN 'closed' ELSE 'archived' END,
  false, true,
  l.revision, l.created_at, l.updated_at
FROM location l
LEFT JOIN (
  SELECT tenant_id, location_id, count(*) AS destination_count
  FROM destination
  GROUP BY tenant_id, location_id
) counts
  ON counts.tenant_id = l.tenant_id AND counts.location_id = l.id
WHERE coalesce(counts.destination_count, 0) <> 1;

-- 5a. Pass becomes symmetrical: origin Room -> destination Room ->
-- optional return Room. Destination references map by identity; origin and
-- return locations resolve through the mapping table.
ALTER TABLE pass
  DROP CONSTRAINT pass_phase5_destination_same_school,
  DROP CONSTRAINT pass_phase5_origin_location_same_school,
  DROP CONSTRAINT pass_phase5_return_location_same_school;

ALTER TABLE pass
  ADD COLUMN origin_room_id uuid,
  ADD COLUMN destination_room_id uuid,
  ADD COLUMN return_room_id uuid;

UPDATE pass p SET destination_room_id = p.destination_id;

UPDATE pass p SET origin_room_id = map.room_id
FROM room_location_map map
WHERE map.tenant_id = p.tenant_id AND map.location_id = p.origin_location_id
  AND p.origin_location_id IS NOT NULL;

UPDATE pass p SET return_room_id = map.room_id
FROM room_location_map map
WHERE map.tenant_id = p.tenant_id AND map.location_id = p.return_location_id
  AND p.return_location_id IS NOT NULL;

DO $$
DECLARE
  missing_destination_rooms bigint;
  unmapped_origin_rooms bigint;
  unmapped_return_rooms bigint;
BEGIN
  SELECT count(*) INTO missing_destination_rooms
  FROM pass p LEFT JOIN room r
    ON r.tenant_id = p.tenant_id AND r.id = p.destination_room_id
  WHERE p.destination_room_id IS NULL OR r.id IS NULL;
  IF missing_destination_rooms > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % pass row(s) without a destination room; resolve manually',
      missing_destination_rooms;
  END IF;

  SELECT count(*) INTO unmapped_origin_rooms
  FROM pass WHERE origin_location_id IS NOT NULL AND origin_room_id IS NULL;
  IF unmapped_origin_rooms > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % pass row(s) without an origin room mapping; resolve manually',
      unmapped_origin_rooms;
  END IF;

  SELECT count(*) INTO unmapped_return_rooms
  FROM pass WHERE return_location_id IS NOT NULL AND return_room_id IS NULL;
  IF unmapped_return_rooms > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % pass row(s) without a return room mapping; resolve manually',
      unmapped_return_rooms;
  END IF;
END $$;

ALTER TABLE pass ALTER COLUMN destination_room_id SET NOT NULL;

ALTER TABLE pass
  ADD CONSTRAINT pass_phase11_destination_room_same_school
  FOREIGN KEY (tenant_id, organization_id, destination_room_id)
  REFERENCES room (tenant_id, organization_id, id),
  ADD CONSTRAINT pass_phase11_origin_room_same_school
  FOREIGN KEY (tenant_id, organization_id, origin_room_id)
  REFERENCES room (tenant_id, organization_id, id),
  ADD CONSTRAINT pass_phase11_return_room_same_school
  FOREIGN KEY (tenant_id, organization_id, return_room_id)
  REFERENCES room (tenant_id, organization_id, id);

ALTER TABLE pass
  DROP COLUMN destination_id,
  DROP COLUMN origin_location_id,
  DROP COLUMN return_location_id;

-- 5b. Scheduled authorization keeps its behavior and validity windows;
-- only the endpoint identity changes. Specific origins now select a Room.
ALTER TABLE scheduled_authorization
  DROP CONSTRAINT scheduled_authorization_phase8_destination_same_school,
  DROP CONSTRAINT scheduled_authorization_phase8_origin_same_school;

ALTER TABLE scheduled_authorization
  ADD COLUMN origin_room_id uuid,
  ADD COLUMN destination_room_id uuid;

UPDATE scheduled_authorization sa SET destination_room_id = sa.destination_id;

UPDATE scheduled_authorization sa SET origin_room_id = map.room_id
FROM room_location_map map
WHERE map.tenant_id = sa.tenant_id AND map.location_id = sa.origin_location_id
  AND sa.origin_location_id IS NOT NULL;

DO $$
DECLARE
  missing_scheduled_rooms bigint;
  unmapped_scheduled_origins bigint;
BEGIN
  SELECT count(*) INTO missing_scheduled_rooms
  FROM scheduled_authorization sa LEFT JOIN room r
    ON r.tenant_id = sa.tenant_id AND r.id = sa.destination_room_id
  WHERE sa.destination_room_id IS NULL OR r.id IS NULL;
  IF missing_scheduled_rooms > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % scheduled_authorization row(s) without a destination room; resolve manually',
      missing_scheduled_rooms;
  END IF;

  SELECT count(*) INTO unmapped_scheduled_origins
  FROM scheduled_authorization
  WHERE origin_location_id IS NOT NULL AND origin_room_id IS NULL;
  IF unmapped_scheduled_origins > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % scheduled_authorization row(s) without an origin room mapping; resolve manually',
      unmapped_scheduled_origins;
  END IF;
END $$;

ALTER TABLE scheduled_authorization ALTER COLUMN destination_room_id SET NOT NULL;

ALTER TABLE scheduled_authorization
  ADD CONSTRAINT scheduled_authorization_phase11_destination_room_same_school
  FOREIGN KEY (tenant_id, organization_id, destination_room_id)
  REFERENCES room (tenant_id, organization_id, id),
  ADD CONSTRAINT scheduled_authorization_phase11_origin_room_same_school
  FOREIGN KEY (tenant_id, organization_id, origin_room_id)
  REFERENCES room (tenant_id, organization_id, id);

-- The origin-strategy coherence CHECK names the old column; restate it for
-- rooms (the foundation name is autogenerated, so look it up).
DO $$
DECLARE
  stale record;
BEGIN
  FOR stale IN
    SELECT conname, conrelid::regclass AS table_name
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid = 'scheduled_authorization'::regclass
      AND pg_get_constraintdef(oid) LIKE '%origin_location_id%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', stale.table_name, stale.conname);
  END LOOP;
END $$;

ALTER TABLE scheduled_authorization
  ADD CONSTRAINT scheduled_authorization_phase11_specific_origin_room
  CHECK ((origin_strategy = 'specific') = (origin_room_id IS NOT NULL));

ALTER TABLE scheduled_authorization
  DROP COLUMN destination_id,
  DROP COLUMN origin_location_id;

-- 5c. Section meetings move from locations to rooms. Teacher-room
-- ownership stays derived (Room <- SectionMeeting <- Section <-
-- SectionMembership), never persisted for display.
ALTER TABLE section_meeting
  DROP CONSTRAINT section_meeting_location_same_school_fk;

DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT conname, conrelid::regclass AS table_name
    FROM pg_constraint
    WHERE contype = 'f'
      AND conrelid = 'section_meeting'::regclass
      AND confrelid = 'location'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.table_name, fk.conname);
  END LOOP;
END $$;

ALTER TABLE section_meeting ADD COLUMN room_id uuid;

UPDATE section_meeting sm SET room_id = map.room_id
FROM room_location_map map
WHERE map.tenant_id = sm.tenant_id AND map.location_id = sm.location_id
  AND sm.location_id IS NOT NULL;

DO $$
DECLARE
  unmapped_meetings bigint;
BEGIN
  SELECT count(*) INTO unmapped_meetings
  FROM section_meeting WHERE location_id IS NOT NULL AND room_id IS NULL;
  IF unmapped_meetings > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % section_meeting row(s) without a room mapping; resolve manually',
      unmapped_meetings;
  END IF;
END $$;

ALTER TABLE section_meeting
  ADD CONSTRAINT section_meeting_phase11_room_same_school_fk
  FOREIGN KEY (tenant_id, organization_id, room_id)
  REFERENCES room (tenant_id, organization_id, id);

ALTER TABLE section_meeting DROP COLUMN location_id;

-- 5d. Presence reports keep their observed place as a room.
DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT conname, conrelid::regclass AS table_name
    FROM pg_constraint
    WHERE contype = 'f'
      AND conrelid = 'incident_presence_report'::regclass
      AND confrelid = 'location'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.table_name, fk.conname);
  END LOOP;
END $$;

ALTER TABLE incident_presence_report ADD COLUMN room_id uuid;

UPDATE incident_presence_report report SET room_id = map.room_id
FROM room_location_map map
WHERE map.tenant_id = report.tenant_id AND map.location_id = report.location_id;

DO $$
DECLARE
  unmapped_reports bigint;
BEGIN
  SELECT count(*) INTO unmapped_reports
  FROM incident_presence_report WHERE room_id IS NULL;
  IF unmapped_reports > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % incident_presence_report row(s) without a room mapping; resolve manually',
      unmapped_reports;
  END IF;
END $$;

ALTER TABLE incident_presence_report ALTER COLUMN room_id SET NOT NULL;

ALTER TABLE incident_presence_report
  ADD CONSTRAINT incident_presence_report_phase11_room_fk
  FOREIGN KEY (tenant_id, room_id) REFERENCES room (tenant_id, id);

ALTER TABLE incident_presence_report DROP COLUMN location_id;

-- 6. Queues, capacity, and flow move to rooms without rewriting the flow
-- engine: same tables, same invariants, room foreign keys.
ALTER TABLE destination_reservation
  DROP CONSTRAINT destination_reservation_phase7_destination_same_school;

ALTER TABLE destination_reservation RENAME TO room_reservation;
ALTER TABLE room_reservation RENAME COLUMN destination_id TO room_id;

ALTER TABLE room_reservation
  ADD CONSTRAINT room_reservation_phase11_room_same_school
  FOREIGN KEY (tenant_id, organization_id, room_id)
  REFERENCES room (tenant_id, organization_id, id);

ALTER TABLE queue_entry
  DROP CONSTRAINT queue_entry_phase7_destination_same_school;

ALTER TABLE queue_entry RENAME COLUMN destination_id TO room_id;

ALTER TABLE queue_entry
  ADD CONSTRAINT queue_entry_phase11_room_same_school
  FOREIGN KEY (tenant_id, organization_id, room_id)
  REFERENCES room (tenant_id, organization_id, id);

-- The release-reason vocabulary names the room that became unavailable.
-- Flow rows are transient, but released rows are terminal history: drop the
-- old CHECK first (the UPDATE would otherwise violate it), carry values
-- forward, then tighten with the room vocabulary so no history is orphaned.
ALTER TABLE room_reservation
  DROP CONSTRAINT destination_reservation_phase7_release_reason;

ALTER TABLE queue_entry
  DROP CONSTRAINT queue_entry_phase7_release_reason;

UPDATE room_reservation SET release_reason = 'room_unavailable'
  WHERE release_reason = 'destination_unavailable';
UPDATE queue_entry SET release_reason = 'room_unavailable'
  WHERE release_reason = 'destination_unavailable';

ALTER TABLE room_reservation
  ADD CONSTRAINT room_reservation_phase11_release_reason
  CHECK (release_reason IN (
    'ready_claim_expired',
    'cancelled',
    'return_started',
    'completed',
    'room_unavailable',
    'pass_terminal'
  ));

ALTER TABLE queue_entry
  ADD CONSTRAINT queue_entry_phase11_release_reason
  CHECK (release_reason IN (
    'promoted',
    'cancelled',
    'expired',
    'policy_changed',
    'room_unavailable',
    'pass_terminal',
    'ready_requeue_replaced'
  ));

-- 7. Explicit staffing moves from destinations to rooms. No explicit room
-- staff is ever inferred from a category name; grants stay explicit.
ALTER TABLE authorization_grant
  DROP CONSTRAINT authorization_grant_phase4_role_check,
  DROP CONSTRAINT authorization_grant_phase4_role_scope_check;

DROP INDEX authorization_grant_phase8_one_active_destination_duty;

-- The foundation role/scope CHECKs carry autogenerated names; drop the ones
-- naming the old destination vocabulary before renaming the column.
DO $$
DECLARE
  stale record;
BEGIN
  FOR stale IN
    SELECT conname, conrelid::regclass AS table_name
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid = 'authorization_grant'::regclass
      AND pg_get_constraintdef(oid) LIKE '%destination%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', stale.table_name, stale.conname);
  END LOOP;
END $$;

UPDATE authorization_grant SET role = 'room_staff' WHERE role = 'destination_staff';
UPDATE authorization_grant SET scope_kind = 'room' WHERE scope_kind = 'destination';

ALTER TABLE authorization_grant RENAME COLUMN destination_id TO room_id;

ALTER TABLE authorization_grant
  ADD CONSTRAINT authorization_grant_phase11_role_check
  CHECK (role IN ('room_staff', 'counselor', 'office_staff', 'school_admin', 'system_admin')),
  ADD CONSTRAINT authorization_grant_phase11_role_scope_check
  CHECK (
    (role = 'system_admin' AND scope_kind = 'tenant'
      AND organization_id IS NULL AND section_id IS NULL AND room_id IS NULL)
    OR (role = 'school_admin' AND scope_kind = 'organization'
      AND organization_id IS NOT NULL AND section_id IS NULL AND room_id IS NULL)
    OR (role = 'counselor' AND scope_kind = 'organization'
      AND organization_id IS NOT NULL AND section_id IS NULL AND room_id IS NULL)
    OR (role = 'office_staff' AND scope_kind = 'organization'
      AND organization_id IS NOT NULL AND section_id IS NULL AND room_id IS NULL)
    OR (role = 'room_staff' AND scope_kind = 'room'
      AND organization_id IS NULL AND section_id IS NULL AND room_id IS NOT NULL)
  );

ALTER TABLE authorization_grant
  ADD CONSTRAINT authorization_grant_phase11_room_same_school
  FOREIGN KEY (tenant_id, room_id) REFERENCES room (tenant_id, id);

CREATE UNIQUE INDEX authorization_grant_phase11_one_active_room_duty
  ON authorization_grant (tenant_id, account_id, room_id)
  WHERE status = 'active' AND role = 'room_staff';

-- 8. Policy scopes become room / room_category. A room-scoped policy
-- matches pass.destination_room_id; a room-category-scoped policy matches
-- the destination room's category. No policy behavior lives on Category.
ALTER TABLE policy_rule
  DROP CONSTRAINT policy_rule_phase6_destination_same_school;

DO $$
DECLARE
  stale record;
BEGIN
  FOR stale IN
    SELECT conname, conrelid::regclass AS table_name
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid = 'policy_rule'::regclass
      AND pg_get_constraintdef(oid) LIKE '%scope_destination%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', stale.table_name, stale.conname);
  END LOOP;
END $$;

-- The foundation scope_kind vocabulary names the old destination scopes;
-- replace it before repointing values (its autogenerated name is stable,
-- but restate both vocabularies so the intent is explicit).
ALTER TABLE policy_rule DROP CONSTRAINT policy_rule_scope_kind_check;

UPDATE policy_rule SET scope_kind = 'room' WHERE scope_kind = 'destination';

ALTER TABLE policy_rule RENAME COLUMN scope_destination_id TO scope_room_id;
ALTER TABLE policy_rule ADD COLUMN scope_room_category_id uuid;

ALTER TABLE policy_rule
  ADD CONSTRAINT policy_rule_phase11_scope_kind_check
  CHECK (scope_kind IN ('organization', 'section', 'room', 'room_category')),
  ADD CONSTRAINT policy_rule_phase11_room_same_school
  FOREIGN KEY (tenant_id, organization_id, scope_room_id)
  REFERENCES room (tenant_id, organization_id, id),
  ADD CONSTRAINT policy_rule_phase11_room_category_same_school
  FOREIGN KEY (tenant_id, organization_id, scope_room_category_id)
  REFERENCES room_category (tenant_id, organization_id, id),
  ADD CONSTRAINT policy_rule_phase11_scope_shape_check
  CHECK (
    (scope_kind = 'organization' AND scope_organization_id IS NOT NULL AND scope_section_id IS NULL AND scope_room_id IS NULL AND scope_room_category_id IS NULL) OR
    (scope_kind = 'section' AND scope_organization_id IS NULL AND scope_section_id IS NOT NULL AND scope_room_id IS NULL AND scope_room_category_id IS NULL) OR
    (scope_kind = 'room' AND scope_organization_id IS NULL AND scope_section_id IS NULL AND scope_room_id IS NOT NULL AND scope_room_category_id IS NULL) OR
    (scope_kind = 'room_category' AND scope_organization_id IS NULL AND scope_section_id IS NULL AND scope_room_id IS NULL AND scope_room_category_id IS NOT NULL)
  );

-- 9. Pass approvals generalize: current_section_teacher binds the section,
-- room_responsible_staff binds the room. Legacy rows backfill as section
-- teacher; no counselor/nurse/principal/classroom role is encoded.
ALTER TABLE pass_approval
  ADD COLUMN required_room_id uuid,
  ADD COLUMN approver_kind text;

UPDATE pass_approval SET approver_kind = 'current_section_teacher';

ALTER TABLE pass_approval ALTER COLUMN required_section_id DROP NOT NULL;
ALTER TABLE pass_approval ALTER COLUMN approver_kind SET NOT NULL;

ALTER TABLE pass_approval
  ADD CONSTRAINT pass_approval_phase11_exactly_one_requirement
  CHECK (
    (approver_kind = 'current_section_teacher' AND required_section_id IS NOT NULL AND required_room_id IS NULL) OR
    (approver_kind = 'room_responsible_staff' AND required_section_id IS NULL AND required_room_id IS NOT NULL)
  ),
  ADD CONSTRAINT pass_approval_phase11_room_fk
  FOREIGN KEY (tenant_id, required_room_id) REFERENCES room (tenant_id, id);

CREATE UNIQUE INDEX pass_approval_phase11_one_pending_room_requirement
  ON pass_approval (tenant_id, pass_id, policy_rule_id, policy_rule_revision, required_room_id)
  WHERE decision = 'pending' AND required_room_id IS NOT NULL;

-- 10. Reason vocabulary gains the room responsible-staff requirement.
ALTER TABLE policy_evaluation_result
  DROP CONSTRAINT policy_evaluation_result_phase8_reason_code;

ALTER TABLE policy_evaluation_result
  ADD CONSTRAINT policy_evaluation_result_phase11_reason_code
  CHECK (reason_code IN (
    'no_violation',
    'schedule_boundary_blackout',
    'current_section_teacher_approval_required',
    'room_responsible_staff_approval_required',
    'approval_context_unavailable',
    'approval_satisfied',
    'scheduled_preapproval_satisfied',
    'approval_denied',
    'override_denied',
    'rule_overridden',
    'policy_configuration_error'
  ));

-- 11. Every reference now targets rooms; drop the old movement tables and
-- prove nothing was lost.
-- Foundation tenant-only FKs that followed their renamed columns still point
-- at the old tables; drop them explicitly so any forgotten reference fails
-- loudly at DROP TABLE below instead of being silently cascaded.
DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT conname, conrelid::regclass AS table_name
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid IN ('destination'::regclass, 'location'::regclass)
      -- Self-references inside the legacy tables die with DROP TABLE below.
      AND conrelid NOT IN ('destination'::regclass, 'location'::regclass)
  LOOP
    IF fk.table_name::text IN ('authorization_grant', 'policy_rule') THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.table_name, fk.conname);
    ELSE
      RAISE EXCEPTION
        '011 rooms unification: unexpected surviving reference % on % to the legacy movement tables; resolve manually',
        fk.conname, fk.table_name;
    END IF;
  END LOOP;
END $$;

DROP TABLE destination;
DROP TABLE location;

DO $$
DECLARE
  actual_rooms bigint;
  dangling_pass_rooms bigint;
  dangling_scheduled_rooms bigint;
  dangling_queue_rooms bigint;
  dangling_reservation_rooms bigint;
  dangling_grant_rooms bigint;
  dangling_policy_rooms bigint;
  dangling_approval_rooms bigint;
BEGIN
  SELECT count(*) INTO actual_rooms FROM room;

  -- Every old destination became a room and every unfolded location became
  -- a room; folded 1:1 pairs share one. Every surviving reference must
  -- resolve to a room row.
  SELECT count(*) INTO dangling_pass_rooms
  FROM pass p LEFT JOIN room r
    ON r.tenant_id = p.tenant_id AND r.id = p.destination_room_id
  WHERE r.id IS NULL;
  IF dangling_pass_rooms > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % pass row(s) dangle after unification; resolve manually',
      dangling_pass_rooms;
  END IF;

  SELECT count(*) INTO dangling_scheduled_rooms
  FROM scheduled_authorization sa LEFT JOIN room r
    ON r.tenant_id = sa.tenant_id AND r.id = sa.destination_room_id
  WHERE r.id IS NULL;
  IF dangling_scheduled_rooms > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % scheduled_authorization row(s) dangle after unification; resolve manually',
      dangling_scheduled_rooms;
  END IF;

  SELECT count(*) INTO dangling_queue_rooms
  FROM queue_entry q LEFT JOIN room r
    ON r.tenant_id = q.tenant_id AND r.id = q.room_id
  WHERE r.id IS NULL;
  IF dangling_queue_rooms > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % queue_entry row(s) dangle after unification; resolve manually',
      dangling_queue_rooms;
  END IF;

  SELECT count(*) INTO dangling_reservation_rooms
  FROM room_reservation res LEFT JOIN room r
    ON r.tenant_id = res.tenant_id AND r.id = res.room_id
  WHERE r.id IS NULL;
  IF dangling_reservation_rooms > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % room_reservation row(s) dangle after unification; resolve manually',
      dangling_reservation_rooms;
  END IF;

  SELECT count(*) INTO dangling_grant_rooms
  FROM authorization_grant g LEFT JOIN room r
    ON r.tenant_id = g.tenant_id AND r.id = g.room_id
  WHERE g.room_id IS NOT NULL AND r.id IS NULL;
  IF dangling_grant_rooms > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % authorization_grant row(s) dangle after unification; resolve manually',
      dangling_grant_rooms;
  END IF;

  SELECT count(*) INTO dangling_policy_rooms
  FROM policy_rule rule LEFT JOIN room r
    ON r.tenant_id = rule.tenant_id AND r.id = rule.scope_room_id
  WHERE rule.scope_room_id IS NOT NULL AND r.id IS NULL;
  IF dangling_policy_rooms > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % policy_rule row(s) dangle after unification; resolve manually',
      dangling_policy_rooms;
  END IF;

  SELECT count(*) INTO dangling_approval_rooms
  FROM pass_approval approval LEFT JOIN room r
    ON r.tenant_id = approval.tenant_id AND r.id = approval.required_room_id
  WHERE approval.required_room_id IS NOT NULL AND r.id IS NULL;
  IF dangling_approval_rooms > 0 THEN
    RAISE EXCEPTION
      '011 rooms unification: % pass_approval row(s) dangle after unification; resolve manually',
      dangling_approval_rooms;
  END IF;

  IF actual_rooms = 0 AND EXISTS (
    SELECT 1 FROM pass
    UNION ALL
    SELECT 1 FROM scheduled_authorization
    UNION ALL
    SELECT 1 FROM queue_entry
    UNION ALL
    SELECT 1 FROM room_reservation
  ) THEN
    RAISE EXCEPTION '011 rooms unification: references survive but no rooms were created; resolve manually';
  END IF;

  -- No legacy runtime table may remain.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('destination', 'location', 'destination_category', 'destination_reservation')
  ) THEN
    RAISE EXCEPTION '011 rooms unification: legacy movement tables remain; resolve manually';
  END IF;
END $$;
`;
