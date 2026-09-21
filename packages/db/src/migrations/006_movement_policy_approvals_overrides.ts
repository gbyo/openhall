import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql.raw(POLICY_APPROVALS_OVERRIDES_SQL).execute(database);
}

const POLICY_APPROVALS_OVERRIDES_SQL = `
-- Phase 6 movement policy, approvals & overrides (forward-only).
-- Migrations 001-005 are never modified; everything here is additive,
-- except CHECK replacements on dormant policy tables, which are provably
-- empty via the preflight below.

-- 0. Preflight: refuse to silently reinterpret existing policy data.
DO $$
DECLARE
  bad_rule_type bigint;
  bad_rule_config bigint;
  legacy_evaluations bigint;
  legacy_results bigint;
  legacy_overrides bigint;
BEGIN
  SELECT count(*) INTO bad_rule_type
  FROM policy_rule
  WHERE rule_type NOT IN ('schedule_boundary', 'approval_requirement');
  IF bad_rule_type > 0 THEN
    RAISE EXCEPTION
      '006 movement policy: % existing policy_rule row(s) use rule types Phase 6 cannot interpret safely; resolve manually',
      bad_rule_type;
  END IF;

  SELECT count(*) INTO bad_rule_config
  FROM policy_rule
  WHERE rule_type IN ('schedule_boundary', 'approval_requirement')
    AND (configuration IS NULL OR (configuration ->> 'schemaVersion') IS DISTINCT FROM '1');
  IF bad_rule_config > 0 THEN
    RAISE EXCEPTION
      '006 movement policy: % existing policy_rule row(s) lack a Phase 6 schemaVersion 1 configuration; resolve manually',
      bad_rule_config;
  END IF;

  SELECT count(*) INTO legacy_evaluations FROM policy_evaluation;
  IF legacy_evaluations > 0 THEN
    RAISE EXCEPTION
      '006 movement policy: % existing policy_evaluation row(s) predate immutable evaluation context; OpenHall never recorded pass revisions or context snapshots for them, resolve manually',
      legacy_evaluations;
  END IF;

  SELECT count(*) INTO legacy_results FROM policy_evaluation_result;
  IF legacy_results > 0 THEN
    RAISE EXCEPTION
      '006 movement policy: % existing policy_evaluation_result row(s) predate immutable rule snapshots; resolve manually',
      legacy_results;
  END IF;

  SELECT count(*) INTO legacy_overrides FROM pass_override;
  IF legacy_overrides > 0 THEN
    RAISE EXCEPTION
      '006 movement policy: % existing pass_override row(s) predate rule-specific override evidence; OpenHall never recorded override category or rule bindings for them, resolve manually',
      legacy_overrides;
  END IF;
END $$;

-- 1. Close the initial rule vocabulary to the two Phase 6 families.
ALTER TABLE policy_rule
  ADD CONSTRAINT policy_rule_phase6_rule_type
  CHECK (rule_type IN ('schedule_boundary', 'approval_requirement'));

-- 2. Same-school policy integrity: a rule cannot scope a section or
-- destination that belongs to another school, and an organization-scoped
-- rule must name its own school exactly. Uses the composite same-school
-- keys established by Phase 5 (005).
ALTER TABLE policy_rule
  ADD CONSTRAINT policy_rule_phase6_section_same_school
  FOREIGN KEY (tenant_id, organization_id, scope_section_id)
  REFERENCES section (tenant_id, organization_id, id),
  ADD CONSTRAINT policy_rule_phase6_destination_same_school
  FOREIGN KEY (tenant_id, organization_id, scope_destination_id)
  REFERENCES destination (tenant_id, organization_id, id);

ALTER TABLE policy_rule
  ADD CONSTRAINT policy_rule_phase6_org_scope_exact
  CHECK (scope_kind <> 'organization' OR scope_organization_id = organization_id);

-- 3. Harden policy_evaluation with immutable decision context.
ALTER TABLE policy_evaluation
  ADD COLUMN IF NOT EXISTS pass_revision bigint NOT NULL,
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE policy_evaluation
  ADD CONSTRAINT policy_evaluation_phase6_schema_version
  CHECK (schema_version = 1),
  ADD CONSTRAINT policy_evaluation_phase6_snapshot_object
  CHECK (jsonb_typeof(context_snapshot) = 'object'),
  ADD CONSTRAINT policy_evaluation_phase6_stage
  CHECK (stage IN ('request', 'approval', 'override', 'reevaluation'));

-- One aggregate version carries at most one persisted policy decision.
CREATE UNIQUE INDEX IF NOT EXISTS policy_evaluation_one_per_pass_revision
  ON policy_evaluation (tenant_id, pass_id, pass_revision);

CREATE INDEX IF NOT EXISTS policy_evaluation_latest_per_pass
  ON policy_evaluation (tenant_id, pass_id, pass_revision DESC, evaluated_at DESC, id DESC);

-- 4. Snapshot evaluated rules in results; persist the safety contribution.
ALTER TABLE policy_evaluation_result
  ADD COLUMN IF NOT EXISTS rule_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS contribution text NOT NULL DEFAULT 'none';

ALTER TABLE policy_evaluation_result
  ADD CONSTRAINT policy_evaluation_result_phase6_snapshot_object
  CHECK (jsonb_typeof(rule_snapshot) = 'object'),
  ADD CONSTRAINT policy_evaluation_result_phase6_contribution
  CHECK (contribution IN ('none', 'deny', 'approval_required', 'override_required')),
  ADD CONSTRAINT policy_evaluation_result_phase6_outcome_contribution
  CHECK (
    (outcome IN ('pass', 'not_applicable') AND contribution = 'none') OR
    (outcome = 'fail' AND contribution <> 'none')
  ),
  ADD CONSTRAINT policy_evaluation_result_phase6_reason_code
  CHECK (reason_code IN (
    'no_violation',
    'schedule_boundary_blackout',
    'current_section_teacher_approval_required',
    'approval_context_unavailable',
    'approval_satisfied',
    'approval_denied',
    'override_denied',
    'rule_overridden',
    'policy_configuration_error'
  ));

-- 5. First-class standard approval table.
CREATE TABLE IF NOT EXISTS pass_approval (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  pass_id uuid NOT NULL,
  origin_evaluation_result_id uuid NOT NULL,
  policy_rule_id uuid NOT NULL,
  policy_rule_revision integer NOT NULL CHECK (policy_rule_revision > 0),
  required_section_id uuid NOT NULL,
  decision text NOT NULL DEFAULT 'pending'
    CHECK (decision IN ('pending', 'approved', 'denied', 'cancelled', 'expired')),
  decision_actor_kind text CHECK (decision_actor_kind IN ('person', 'system')),
  decided_by_person_id uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, pass_id) REFERENCES pass(tenant_id, id),
  FOREIGN KEY (tenant_id, origin_evaluation_result_id)
    REFERENCES policy_evaluation_result(tenant_id, id),
  FOREIGN KEY (tenant_id, policy_rule_id) REFERENCES policy_rule(tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id, required_section_id)
    REFERENCES section (tenant_id, organization_id, id),
  FOREIGN KEY (tenant_id, decided_by_person_id) REFERENCES person(tenant_id, id),
  CHECK (
    (decision = 'pending' AND decision_actor_kind IS NULL AND decided_by_person_id IS NULL AND decided_at IS NULL) OR
    (decision <> 'pending' AND decided_at IS NOT NULL AND (
      (decision_actor_kind = 'person' AND decided_by_person_id IS NOT NULL) OR
      (decision_actor_kind = 'system' AND decided_by_person_id IS NULL)
    ))
  )
);

-- Reuse an existing pending requirement instead of duplicating it; terminal
-- history (approved/denied/cancelled/expired) never blocks future needs.
CREATE UNIQUE INDEX IF NOT EXISTS pass_approval_one_pending_per_requirement
  ON pass_approval (tenant_id, pass_id, policy_rule_id, policy_rule_revision, required_section_id)
  WHERE decision = 'pending';

CREATE INDEX IF NOT EXISTS pass_approval_pending_lookup
  ON pass_approval (tenant_id, pass_id, decision, id);

-- 6. Harden pass_override into rule-specific override evidence.
ALTER TABLE pass_override
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS policy_rule_id uuid,
  ADD COLUMN IF NOT EXISTS policy_rule_revision integer,
  ADD COLUMN IF NOT EXISTS override_mode text,
  ADD COLUMN IF NOT EXISTS decision_actor_kind text;

-- Drop the foundation decision CHECK (autogenerated name: lookup, as in 005)
-- so 'expired' can join the vocabulary.
DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT conname, conrelid::regclass AS table_name
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid = 'pass_override'::regclass
      AND pg_get_constraintdef(oid) LIKE '%pending%approved%denied%cancelled%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.table_name, fk.conname);
  END LOOP;
END $$;

-- Drop the foundation pending-resolution CHECK; provenance below replaces it.
DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT conname, conrelid::regclass AS table_name
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid = 'pass_override'::regclass
      AND pg_get_constraintdef(oid) LIKE '%decided_by_person_id%decided_at%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.table_name, fk.conname);
  END LOOP;
END $$;

-- The preflight guarantees an empty table, so backfill-free tightening is honest.
ALTER TABLE pass_override
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN policy_rule_id SET NOT NULL,
  ALTER COLUMN policy_rule_revision SET NOT NULL,
  ALTER COLUMN override_mode SET NOT NULL,
  ALTER COLUMN category SET NOT NULL;

ALTER TABLE pass_override
  ADD CONSTRAINT pass_override_phase6_revision_positive
  CHECK (policy_rule_revision > 0),
  ADD CONSTRAINT pass_override_phase6_category
  CHECK (category IN ('urgent', 'private', 'safety', 'staff_directed')),
  ADD CONSTRAINT pass_override_phase6_decision
  CHECK (decision IN ('pending', 'approved', 'denied', 'cancelled', 'expired')),
  ADD CONSTRAINT pass_override_phase6_override_mode
  CHECK (override_mode IN ('never', 'authorized', 'approval_required')),
  ADD CONSTRAINT pass_override_phase6_actor_kind
  CHECK (decision_actor_kind IN ('person', 'system')),
  ADD CONSTRAINT pass_override_phase6_provenance
  CHECK (
    (decision = 'pending' AND decision_actor_kind IS NULL AND decided_by_person_id IS NULL AND decided_at IS NULL) OR
    ((decision = 'approved' OR decision = 'denied') AND decided_at IS NOT NULL AND (
      (decision_actor_kind = 'person' AND decided_by_person_id IS NOT NULL) OR
      (decision_actor_kind = 'system' AND decided_by_person_id IS NULL)
    )) OR
    ((decision = 'cancelled' OR decision = 'expired') AND decided_at IS NOT NULL AND decision_actor_kind = 'system' AND decided_by_person_id IS NULL)
  ),
  -- Separation of duties: an approval_required override must be resolved by
  -- someone other than the requester. System cleanup is exempt.
  ADD CONSTRAINT pass_override_phase6_independent_approver
  CHECK (
    override_mode <> 'approval_required' OR
    decision NOT IN ('approved', 'denied') OR
    decision_actor_kind <> 'person' OR
    decided_by_person_id IS DISTINCT FROM requested_by_person_id
  ),
  ADD CONSTRAINT pass_override_phase6_org_fk
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  ADD CONSTRAINT pass_override_phase6_rule_fk
  FOREIGN KEY (tenant_id, policy_rule_id) REFERENCES policy_rule(tenant_id, id);

-- One live (pending/approved) override per rule revision; denied, cancelled,
-- and expired history never blocks a fresh legitimate request.
CREATE UNIQUE INDEX IF NOT EXISTS pass_override_one_live_per_rule
  ON pass_override (tenant_id, pass_id, policy_rule_id, policy_rule_revision)
  WHERE decision IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS pass_override_pending_lookup
  ON pass_override (tenant_id, pass_id, decision, id);
`;
