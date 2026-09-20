import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql.raw(FOUNDATION_SQL).execute(database);
}

const FOUNDATION_SQL = `
CREATE TABLE tenant (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE TABLE organization (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  parent_id uuid,
  kind text NOT NULL CHECK (kind IN ('district', 'school')),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  time_zone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, slug),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES organization(tenant_id, id),
  CHECK (kind <> 'school' OR time_zone IS NOT NULL)
);

CREATE TABLE person (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  given_name text NOT NULL CHECK (length(btrim(given_name)) > 0),
  family_name text NOT NULL CHECK (length(btrim(family_name)) > 0),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE organization_membership (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  person_id uuid NOT NULL,
  affiliation text NOT NULL CHECK (affiliation IN ('student', 'staff', 'other')),
  grade_level text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  valid_from date,
  valid_until date,
  PRIMARY KEY (tenant_id, organization_id, person_id, affiliation),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES person(tenant_id, id),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);

CREATE TABLE account (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  person_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'disabled')),
  session_revision bigint NOT NULL DEFAULT 0 CHECK (session_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, person_id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES person(tenant_id, id)
);

CREATE TABLE auth_identity (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  account_id uuid NOT NULL,
  issuer text NOT NULL CHECK (length(btrim(issuer)) > 0),
  provider_subject text NOT NULL CHECK (length(provider_subject) > 0),
  email_snapshot text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, issuer, provider_subject),
  FOREIGN KEY (tenant_id, account_id) REFERENCES account(tenant_id, id)
);

CREATE TABLE academic_session (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  parent_id uuid,
  kind text NOT NULL CHECK (kind IN ('school_year', 'semester', 'term', 'quarter', 'other')),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('planned', 'active', 'completed', 'archived')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES academic_session(tenant_id, id),
  CHECK (ends_on >= starts_on)
);

CREATE TABLE course (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  code text,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id)
);

CREATE TABLE section (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  course_id uuid,
  academic_session_id uuid NOT NULL,
  code text,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('planned', 'active', 'completed', 'archived')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, course_id) REFERENCES course(tenant_id, id),
  FOREIGN KEY (tenant_id, academic_session_id) REFERENCES academic_session(tenant_id, id)
);

CREATE TABLE section_membership (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  section_id uuid NOT NULL,
  person_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('student', 'teacher')),
  starts_on date,
  ends_on date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  PRIMARY KEY (tenant_id, section_id, person_id, role),
  FOREIGN KEY (tenant_id, section_id) REFERENCES section(tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES person(tenant_id, id),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

CREATE TABLE location (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  parent_location_id uuid,
  kind text NOT NULL CHECK (length(btrim(kind)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  code text,
  floor_label text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, parent_location_id) REFERENCES location(tenant_id, id)
);

CREATE TABLE schedule_block (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  code text NOT NULL CHECK (length(btrim(code)) > 0),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  kind text NOT NULL CHECK (kind IN ('instructional', 'lunch', 'advisory', 'transition', 'other')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, organization_id, code),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id)
);

CREATE TABLE section_meeting (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  section_id uuid NOT NULL,
  schedule_block_id uuid NOT NULL,
  location_id uuid,
  cycle_code text,
  effective_from date,
  effective_until date,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, section_id) REFERENCES section(tenant_id, id),
  FOREIGN KEY (tenant_id, schedule_block_id) REFERENCES schedule_block(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES location(tenant_id, id),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until >= effective_from)
);

CREATE TABLE schedule_template (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id)
);

CREATE TABLE schedule_slot (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  schedule_template_id uuid NOT NULL,
  schedule_block_id uuid NOT NULL,
  starts_at time without time zone NOT NULL,
  ends_at time without time zone NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, schedule_template_id, ordinal),
  FOREIGN KEY (tenant_id, schedule_template_id) REFERENCES schedule_template(tenant_id, id),
  FOREIGN KEY (tenant_id, schedule_block_id) REFERENCES schedule_block(tenant_id, id),
  CHECK (ends_at > starts_at)
);

CREATE TABLE calendar_day (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  date date NOT NULL,
  day_kind text NOT NULL CHECK (day_kind IN ('instructional', 'non_instructional', 'closed')),
  schedule_template_id uuid,
  cycle_code text,
  operational_note text CHECK (operational_note IS NULL OR length(operational_note) <= 500),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, organization_id, date),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, schedule_template_id) REFERENCES schedule_template(tenant_id, id),
  CHECK ((day_kind = 'instructional' AND schedule_template_id IS NOT NULL) OR day_kind <> 'instructional')
);

CREATE TABLE destination (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  location_id uuid NOT NULL,
  service_type text NOT NULL CHECK (length(btrim(service_type)) > 0),
  display_name text,
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  queue_enabled boolean NOT NULL DEFAULT false,
  check_in_mode text NOT NULL DEFAULT 'none' CHECK (check_in_mode IN ('none', 'optional', 'required')),
  default_duration_seconds integer CHECK (default_duration_seconds IS NULL OR default_duration_seconds > 0),
  max_duration_seconds integer CHECK (max_duration_seconds IS NULL OR max_duration_seconds > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'archived')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES location(tenant_id, id),
  CHECK (max_duration_seconds IS NULL OR default_duration_seconds IS NULL OR max_duration_seconds >= default_duration_seconds)
);

CREATE TABLE authorization_grant (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  account_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('student', 'teacher', 'destination_staff', 'counselor', 'office_staff', 'school_admin', 'system_admin')),
  scope_kind text NOT NULL CHECK (scope_kind IN ('tenant', 'organization', 'section', 'destination')),
  organization_id uuid,
  section_id uuid,
  destination_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  valid_from timestamptz,
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES account(tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, section_id) REFERENCES section(tenant_id, id),
  FOREIGN KEY (tenant_id, destination_id) REFERENCES destination(tenant_id, id),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  CHECK (
    (scope_kind = 'tenant' AND organization_id IS NULL AND section_id IS NULL AND destination_id IS NULL) OR
    (scope_kind = 'organization' AND organization_id IS NOT NULL AND section_id IS NULL AND destination_id IS NULL) OR
    (scope_kind = 'section' AND organization_id IS NULL AND section_id IS NOT NULL AND destination_id IS NULL) OR
    (scope_kind = 'destination' AND organization_id IS NULL AND section_id IS NULL AND destination_id IS NOT NULL)
  )
);

CREATE TABLE integration (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid,
  integration_type text NOT NULL CHECK (length(btrim(integration_type)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('enabled', 'disabled', 'error')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuration) = 'object'),
  secret_ciphertext bytea,
  secret_key_id text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  CHECK ((secret_ciphertext IS NULL) = (secret_key_id IS NULL))
);

CREATE TABLE external_reference (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  integration_id uuid NOT NULL,
  entity_kind text NOT NULL CHECK (length(btrim(entity_kind)) > 0),
  canonical_entity_id uuid NOT NULL,
  external_object_type text NOT NULL CHECK (length(btrim(external_object_type)) > 0),
  external_id text NOT NULL CHECK (length(external_id) > 0),
  last_seen_at timestamptz,
  source_fingerprint text,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, integration_id, external_object_type, external_id),
  UNIQUE (tenant_id, integration_id, entity_kind, canonical_entity_id, external_object_type),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES integration(tenant_id, id)
);

CREATE TABLE sync_run (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  integration_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'succeeded', 'partial', 'failed')),
  processed_count integer NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  created_count integer NOT NULL DEFAULT 0 CHECK (created_count >= 0),
  updated_count integer NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  error_summary text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, integration_id) REFERENCES integration(tenant_id, id),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE policy_rule (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  rule_type text NOT NULL CHECK (length(btrim(rule_type)) > 0),
  scope_kind text NOT NULL CHECK (scope_kind IN ('organization', 'section', 'destination')),
  scope_organization_id uuid,
  scope_section_id uuid,
  scope_destination_id uuid,
  priority integer NOT NULL DEFAULT 0,
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
  override_mode text NOT NULL CHECK (override_mode IN ('never', 'authorized', 'approval_required')),
  enabled boolean NOT NULL DEFAULT true,
  valid_from timestamptz,
  valid_until timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, scope_organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, scope_section_id) REFERENCES section(tenant_id, id),
  FOREIGN KEY (tenant_id, scope_destination_id) REFERENCES destination(tenant_id, id),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  CHECK (
    (scope_kind = 'organization' AND scope_organization_id IS NOT NULL AND scope_section_id IS NULL AND scope_destination_id IS NULL) OR
    (scope_kind = 'section' AND scope_organization_id IS NULL AND scope_section_id IS NOT NULL AND scope_destination_id IS NULL) OR
    (scope_kind = 'destination' AND scope_organization_id IS NULL AND scope_section_id IS NULL AND scope_destination_id IS NOT NULL)
  )
);

CREATE TABLE scheduled_authorization (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  student_id uuid NOT NULL,
  destination_id uuid NOT NULL,
  created_by_person_id uuid NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'cancelled', 'expired')),
  approval_mode text NOT NULL CHECK (approval_mode IN ('preapproved', 'approval_required')),
  origin_strategy text NOT NULL CHECK (origin_strategy IN ('expected', 'specific', 'selected_at_request')),
  origin_location_id uuid,
  display_category text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, student_id) REFERENCES person(tenant_id, id),
  FOREIGN KEY (tenant_id, destination_id) REFERENCES destination(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_person_id) REFERENCES person(tenant_id, id),
  FOREIGN KEY (tenant_id, origin_location_id) REFERENCES location(tenant_id, id),
  CHECK (valid_until > valid_from),
  CHECK ((origin_strategy = 'specific') = (origin_location_id IS NOT NULL))
);

CREATE TABLE pass (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  student_id uuid NOT NULL,
  origin_location_id uuid,
  origin_section_id uuid,
  destination_id uuid NOT NULL,
  return_location_id uuid,
  request_source text NOT NULL CHECK (request_source IN ('student_web', 'staff_web', 'scheduled', 'integration', 'system')),
  requested_by_person_id uuid,
  requested_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('requested', 'queued', 'ready', 'outbound', 'at_destination', 'returning', 'completed', 'denied', 'cancelled', 'expired')),
  expected_return_at timestamptz,
  scheduled_authorization_id uuid,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, student_id) REFERENCES person(tenant_id, id),
  FOREIGN KEY (tenant_id, origin_location_id) REFERENCES location(tenant_id, id),
  FOREIGN KEY (tenant_id, origin_section_id) REFERENCES section(tenant_id, id),
  FOREIGN KEY (tenant_id, destination_id) REFERENCES destination(tenant_id, id),
  FOREIGN KEY (tenant_id, return_location_id) REFERENCES location(tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by_person_id) REFERENCES person(tenant_id, id),
  FOREIGN KEY (tenant_id, scheduled_authorization_id) REFERENCES scheduled_authorization(tenant_id, id)
);

CREATE UNIQUE INDEX pass_one_active_per_student
  ON pass (tenant_id, student_id)
  WHERE lifecycle_state IN ('requested', 'queued', 'ready', 'outbound', 'at_destination', 'returning');

CREATE TABLE pass_event (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  pass_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (length(btrim(event_type)) > 0),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person', 'integration', 'system')),
  actor_person_id uuid,
  actor_integration_id uuid,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (tenant_id, id),
  UNIQUE (pass_id, sequence),
  FOREIGN KEY (tenant_id, pass_id) REFERENCES pass(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_person_id) REFERENCES person(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_integration_id) REFERENCES integration(tenant_id, id),
  CHECK (
    (actor_kind = 'person' AND actor_person_id IS NOT NULL AND actor_integration_id IS NULL) OR
    (actor_kind = 'integration' AND actor_person_id IS NULL AND actor_integration_id IS NOT NULL) OR
    (actor_kind = 'system' AND actor_person_id IS NULL AND actor_integration_id IS NULL)
  )
);

CREATE TABLE policy_evaluation (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  pass_id uuid NOT NULL,
  stage text NOT NULL CHECK (length(btrim(stage)) > 0),
  decision text NOT NULL CHECK (decision IN ('allow', 'deny', 'queue', 'approval_required', 'override_required')),
  evaluated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, pass_id) REFERENCES pass(tenant_id, id)
);

CREATE TABLE policy_evaluation_result (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  evaluation_id uuid NOT NULL,
  policy_rule_id uuid NOT NULL,
  policy_rule_revision integer NOT NULL CHECK (policy_rule_revision > 0),
  outcome text NOT NULL CHECK (outcome IN ('pass', 'fail', 'not_applicable')),
  reason_code text NOT NULL CHECK (length(btrim(reason_code)) > 0),
  override_mode text NOT NULL CHECK (override_mode IN ('never', 'authorized', 'approval_required')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, evaluation_id) REFERENCES policy_evaluation(tenant_id, id),
  FOREIGN KEY (tenant_id, policy_rule_id) REFERENCES policy_rule(tenant_id, id)
);

CREATE TABLE pass_override (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  pass_id uuid NOT NULL,
  evaluation_result_id uuid NOT NULL,
  requested_by_person_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  category text,
  decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'approved', 'denied', 'cancelled')),
  decided_by_person_id uuid,
  decided_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, pass_id) REFERENCES pass(tenant_id, id),
  FOREIGN KEY (tenant_id, evaluation_result_id) REFERENCES policy_evaluation_result(tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by_person_id) REFERENCES person(tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by_person_id) REFERENCES person(tenant_id, id),
  CHECK ((decision = 'pending' AND decided_by_person_id IS NULL AND decided_at IS NULL) OR (decision <> 'pending' AND decided_by_person_id IS NOT NULL AND decided_at IS NOT NULL))
);

CREATE TABLE destination_reservation (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  destination_id uuid NOT NULL,
  pass_id uuid NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz,
  released_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, destination_id) REFERENCES destination(tenant_id, id),
  FOREIGN KEY (tenant_id, pass_id) REFERENCES pass(tenant_id, id),
  CHECK (expires_at IS NULL OR expires_at > reserved_at),
  CHECK (released_at IS NULL OR released_at >= reserved_at)
);

CREATE UNIQUE INDEX destination_reservation_one_active_per_pass
  ON destination_reservation (tenant_id, pass_id) WHERE released_at IS NULL;
CREATE INDEX destination_reservation_active_capacity
  ON destination_reservation (tenant_id, destination_id) WHERE released_at IS NULL;

CREATE TABLE queue_entry (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  destination_id uuid NOT NULL,
  pass_id uuid NOT NULL,
  entered_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  priority integer NOT NULL DEFAULT 0,
  released_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, destination_id) REFERENCES destination(tenant_id, id),
  FOREIGN KEY (tenant_id, pass_id) REFERENCES pass(tenant_id, id),
  CHECK (released_at IS NULL OR released_at >= entered_at)
);

CREATE UNIQUE INDEX queue_entry_one_active_per_pass
  ON queue_entry (tenant_id, pass_id) WHERE released_at IS NULL;
CREATE INDEX queue_entry_order
  ON queue_entry (tenant_id, destination_id, priority DESC, entered_at, id) WHERE released_at IS NULL;

CREATE TABLE operational_incident (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('restricted_movement', 'lockdown', 'evacuation', 'other')),
  activated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  activated_by_person_id uuid NOT NULL,
  ended_at timestamptz,
  ended_by_person_id uuid,
  operational_message text CHECK (operational_message IS NULL OR length(operational_message) <= 500),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, activated_by_person_id) REFERENCES person(tenant_id, id),
  FOREIGN KEY (tenant_id, ended_by_person_id) REFERENCES person(tenant_id, id),
  CHECK ((ended_at IS NULL) = (ended_by_person_id IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= activated_at)
);

CREATE UNIQUE INDEX operational_incident_one_active_per_school
  ON operational_incident (tenant_id, organization_id) WHERE ended_at IS NULL;

CREATE TABLE incident_affected_pass (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  incident_id uuid NOT NULL,
  pass_id uuid NOT NULL,
  pass_state_at_activation text NOT NULL CHECK (pass_state_at_activation IN ('requested', 'queued', 'ready', 'outbound', 'at_destination', 'returning', 'completed', 'denied', 'cancelled', 'expired')),
  PRIMARY KEY (tenant_id, incident_id, pass_id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES operational_incident(tenant_id, id),
  FOREIGN KEY (tenant_id, pass_id) REFERENCES pass(tenant_id, id)
);

CREATE TABLE incident_presence_report (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  incident_id uuid NOT NULL,
  person_id uuid NOT NULL,
  location_id uuid NOT NULL,
  presence_state text NOT NULL CHECK (presence_state IN ('observed_present', 'observed_absent', 'unknown')),
  reported_by_person_id uuid NOT NULL,
  reported_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES operational_incident(tenant_id, id),
  FOREIGN KEY (tenant_id, person_id) REFERENCES person(tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES location(tenant_id, id),
  FOREIGN KEY (tenant_id, reported_by_person_id) REFERENCES person(tenant_id, id)
);

CREATE TABLE audit_event (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid,
  actor_kind text NOT NULL CHECK (actor_kind IN ('account', 'integration', 'system')),
  actor_id uuid,
  action text NOT NULL CHECK (length(btrim(action)) > 0),
  target_kind text NOT NULL CHECK (length(btrim(target_kind)) > 0),
  target_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  request_id text NOT NULL CHECK (length(btrim(request_id)) > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id)
);

CREATE INDEX audit_event_tenant_time ON audit_event (tenant_id, occurred_at DESC, id);

CREATE TABLE outbox_event (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid,
  aggregate_kind text NOT NULL CHECK (length(btrim(aggregate_kind)) > 0),
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL CHECK (length(btrim(event_type)) > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id)
);

CREATE INDEX outbox_event_pending
  ON outbox_event (available_at, occurred_at, id) WHERE published_at IS NULL;

CREATE TABLE idempotency_record (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  actor_account_id uuid NOT NULL,
  command text NOT NULL CHECK (length(btrim(command)) > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  request_fingerprint text NOT NULL CHECK (length(request_fingerprint) > 0),
  response_status integer NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, actor_account_id, command, idempotency_key),
  FOREIGN KEY (tenant_id, actor_account_id) REFERENCES account(tenant_id, id),
  CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_record_expiration ON idempotency_record (expires_at);
`;
