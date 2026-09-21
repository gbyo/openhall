import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHOOL_CONTROL_PLANE_SQL).execute(database);
}

const SCHOOL_CONTROL_PLANE_SQL = `
-- Phase 8 school control plane: versioned configuration, schedule aggregate,
-- departure-time check-in snapshot, policy archival, grant provenance,
-- scheduled-authorization hardening, identity enrollment, and the OIDC
-- enrollment purpose (forward-only). Migrations 001-007 are never modified;
-- everything here is additive, except the dormant OIDC purpose CHECK
-- replacement below, which is provably structure-preserving via the
-- preflight.

-- 0. Preflights: fail rather than fabricate historical facts where legacy
-- data cannot truthfully satisfy new invariants.
DO $$
DECLARE
  duplicate_org_grants bigint;
  duplicate_destination_grants bigint;
  cross_school_scheduled_destination bigint;
  cross_school_scheduled_origin bigint;
  contradictory_transactions bigint;
BEGIN
  SELECT count(*) INTO duplicate_org_grants
  FROM (
    SELECT tenant_id, account_id, role, organization_id
    FROM authorization_grant
    WHERE status = 'active'
      AND role IN ('counselor', 'office_staff', 'school_admin')
    GROUP BY tenant_id, account_id, role, organization_id
    HAVING count(*) > 1
  ) duplicates;
  IF duplicate_org_grants > 0 THEN
    RAISE EXCEPTION
      '008 school control plane: % duplicate active organization-scoped authorization grant group(s) predate duplicate prevention; resolve manually',
      duplicate_org_grants;
  END IF;

  SELECT count(*) INTO duplicate_destination_grants
  FROM (
    SELECT tenant_id, account_id, destination_id
    FROM authorization_grant
    WHERE status = 'active' AND role = 'destination_staff'
    GROUP BY tenant_id, account_id, destination_id
    HAVING count(*) > 1
  ) duplicates;
  IF duplicate_destination_grants > 0 THEN
    RAISE EXCEPTION
      '008 school control plane: % duplicate active destination_staff authorization grant group(s) predate duplicate prevention; resolve manually',
      duplicate_destination_grants;
  END IF;

  SELECT count(*) INTO cross_school_scheduled_destination
  FROM scheduled_authorization sa
  JOIN destination d ON d.tenant_id = sa.tenant_id AND d.id = sa.destination_id
  WHERE d.organization_id <> sa.organization_id;
  IF cross_school_scheduled_destination > 0 THEN
    RAISE EXCEPTION
      '008 school control plane: % existing scheduled_authorization row(s) reference a destination in another school; resolve manually',
      cross_school_scheduled_destination;
  END IF;

  SELECT count(*) INTO cross_school_scheduled_origin
  FROM scheduled_authorization sa
  JOIN location l ON l.tenant_id = sa.tenant_id AND l.id = sa.origin_location_id
  WHERE sa.origin_location_id IS NOT NULL AND l.organization_id <> sa.organization_id;
  IF cross_school_scheduled_origin > 0 THEN
    RAISE EXCEPTION
      '008 school control plane: % existing scheduled_authorization row(s) reference an origin location in another school; resolve manually',
      cross_school_scheduled_origin;
  END IF;

  SELECT count(*) INTO contradictory_transactions
  FROM oidc_login_transaction
  WHERE (purpose = 'login'
      AND (tenant_id IS NULL OR identity_provider_id IS NULL OR bootstrap_setup_id IS NOT NULL))
    OR (purpose = 'bootstrap'
      AND (tenant_id IS NOT NULL OR identity_provider_id IS NOT NULL OR bootstrap_setup_id IS NULL))
    OR (purpose NOT IN ('login', 'bootstrap'));
  IF contradictory_transactions > 0 THEN
    RAISE EXCEPTION
      '008 school control plane: % existing oidc_login_transaction row(s) contradict the login/bootstrap purpose structure; resolve manually',
      contradictory_transactions;
  END IF;
END $$;

-- 1. Location revisions. created_at/updated_at already exist; reuse them.
ALTER TABLE location
  ADD COLUMN revision bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT location_phase8_revision_positive CHECK (revision > 0);

-- 2. Destination revisions and explicit configuration timestamps. No
-- created_at is invented for existing destinations: backfilling a fictional
-- creation time would rewrite history, so only updated_at is added.
ALTER TABLE destination
  ADD COLUMN revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ADD CONSTRAINT destination_phase8_revision_positive CHECK (revision > 0);

-- 3. Departure-time check-in snapshot. Phase 7 consults the live destination
-- check_in_mode while movement progresses; once administrators can edit
-- destination configuration, active movement must keep its departure-time
-- semantics. Snapshot on ready -> outbound; movement commands afterwards
-- read the pass, never the mutable destination setting. Nullable so legacy
-- pre-Phase-8 passes stay honestly unsnapshotted instead of backfilled.
ALTER TABLE pass
  ADD COLUMN departure_check_in_mode text,
  ADD COLUMN departure_destination_revision bigint,
  ADD CONSTRAINT pass_phase8_departure_check_in_mode
  CHECK (departure_check_in_mode IN ('none', 'optional', 'required')),
  ADD CONSTRAINT pass_phase8_departure_destination_revision
  CHECK (departure_destination_revision IS NULL OR departure_destination_revision > 0);

-- 4. School schedule configuration aggregate: one consistency universe per
-- school for blocks, templates, slots, and calendar assignments. District
-- organizations never get a row; future school provisioning must create its
-- row transactionally with the school.
CREATE TABLE school_schedule_configuration (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, organization_id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  CHECK (revision > 0)
);

INSERT INTO school_schedule_configuration (tenant_id, organization_id)
SELECT tenant_id, id FROM organization WHERE kind = 'school'
ON CONFLICT DO NOTHING;

-- 5. Policy archival. Archived rules are historical configuration: they
-- stay readable, cannot remain enabled, cannot reactivate, and are never
-- deleted. Equivalent policy later means a new rule.
ALTER TABLE policy_rule
  ADD COLUMN archived_at timestamptz,
  ADD CONSTRAINT policy_rule_phase8_archived_disabled
  CHECK (archived_at IS NULL OR enabled = false);

-- 6. Authorization grant provenance and active uniqueness. Existing rows
-- keep unknown creator provenance (nullable) rather than fabricated IDs;
-- new Phase 8 mutations always populate the actor. Partial unique indexes
-- prevent duplicate active duties without depending on NULL semantics.
ALTER TABLE authorization_grant
  ADD COLUMN revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN created_by_account_id uuid,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by_account_id uuid,
  ADD CONSTRAINT authorization_grant_phase8_revision_positive CHECK (revision > 0),
  ADD CONSTRAINT authorization_grant_phase8_revocation_coherence
  CHECK ((revoked_at IS NULL) = (revoked_by_account_id IS NULL)),
  ADD CONSTRAINT authorization_grant_phase8_created_by_fk
  FOREIGN KEY (tenant_id, created_by_account_id) REFERENCES account(tenant_id, id),
  ADD CONSTRAINT authorization_grant_phase8_revoked_by_fk
  FOREIGN KEY (tenant_id, revoked_by_account_id) REFERENCES account(tenant_id, id);

CREATE UNIQUE INDEX authorization_grant_phase8_one_active_org_duty
  ON authorization_grant (tenant_id, account_id, role, organization_id)
  WHERE status = 'active' AND role IN ('counselor', 'office_staff', 'school_admin');

CREATE UNIQUE INDEX authorization_grant_phase8_one_active_destination_duty
  ON authorization_grant (tenant_id, account_id, destination_id)
  WHERE status = 'active' AND role = 'destination_staff';

-- 7. Scheduled authorization hardening. The foundation table becomes
-- operational in Phase 8: optimistic-concurrency revision, actor
-- provenance (nullable for foundation rows), terminal state evidence, and
-- an explicit attempt marker so a denied start still advances the resource
-- revision/state instead of leaving concurrent stale clients indefinitely
-- repeatable. Same-school composite FKs mirror Phase 5/7: a scheduled
-- authorization for School A cannot reference School B resources even if
-- the application contains a bug.
ALTER TABLE scheduled_authorization
  ADD COLUMN revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN created_by_account_id uuid,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by_account_id uuid,
  ADD COLUMN used_at timestamptz,
  ADD COLUMN used_by_account_id uuid,
  ADD COLUMN last_attempt_at timestamptz,
  ADD CONSTRAINT scheduled_authorization_phase8_revision_positive CHECK (revision > 0),
  ADD CONSTRAINT scheduled_authorization_phase8_cancel_coherence
  CHECK ((cancelled_at IS NULL) = (cancelled_by_account_id IS NULL)),
  ADD CONSTRAINT scheduled_authorization_phase8_use_coherence
  CHECK ((used_at IS NULL) = (used_by_account_id IS NULL)),
  ADD CONSTRAINT scheduled_authorization_phase8_terminal_exclusion
  CHECK (cancelled_at IS NULL OR used_at IS NULL),
  ADD CONSTRAINT scheduled_authorization_phase8_created_by_fk
  FOREIGN KEY (tenant_id, created_by_account_id) REFERENCES account(tenant_id, id),
  ADD CONSTRAINT scheduled_authorization_phase8_cancelled_by_fk
  FOREIGN KEY (tenant_id, cancelled_by_account_id) REFERENCES account(tenant_id, id),
  ADD CONSTRAINT scheduled_authorization_phase8_used_by_fk
  FOREIGN KEY (tenant_id, used_by_account_id) REFERENCES account(tenant_id, id);

-- Drop only the legacy tenant-only destination/origin FKs (autogenerated
-- names, as in 005/007) so they can be replaced by same-school composite
-- FKs. Tenant-bound organization/student/creator references are untouched.
DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT conname, conrelid::regclass AS table_name
    FROM pg_constraint
    WHERE contype = 'f'
      AND conrelid = 'scheduled_authorization'::regclass
      AND confrelid IN ('destination'::regclass, 'location'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.table_name, fk.conname);
  END LOOP;
END $$;

ALTER TABLE scheduled_authorization
  ADD CONSTRAINT scheduled_authorization_phase8_destination_same_school
  FOREIGN KEY (tenant_id, organization_id, destination_id)
  REFERENCES destination (tenant_id, organization_id, id),
  ADD CONSTRAINT scheduled_authorization_phase8_origin_same_school
  FOREIGN KEY (tenant_id, organization_id, origin_location_id)
  REFERENCES location (tenant_id, organization_id, id);

-- 8. Identity enrollment grants. One-time, revocable, 24-hour invitations
-- binding a verified OIDC identity to a predetermined canonical
-- person/account. Only the token digest is stored; the raw token is
-- returned exactly once at issuance and never logged, audited, or
-- outboxed. A consumed/revoked/expired grant remains permanently for
-- audit/history.
CREATE TABLE identity_enrollment_grant (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  account_id uuid NOT NULL,
  identity_provider_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_by_account_id uuid,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  revoked_by_account_id uuid,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES account(tenant_id, id),
  FOREIGN KEY (tenant_id, identity_provider_id) REFERENCES identity_provider(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_account_id) REFERENCES account(tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by_account_id) REFERENCES account(tenant_id, id),
  CHECK (revision > 0),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CHECK ((revoked_at IS NULL) = (revoked_by_account_id IS NULL)),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

-- At most one live (neither consumed nor revoked) grant per account and
-- provider. Expiry is a wall-clock predicate, so re-issuance after expiry
-- is an application check; the index keeps the live set duplicate-free.
CREATE UNIQUE INDEX identity_enrollment_grant_phase8_one_live_per_account_provider
  ON identity_enrollment_grant (tenant_id, account_id, identity_provider_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX identity_enrollment_grant_phase8_token_lookup
  ON identity_enrollment_grant (token_hash);

-- 9. OIDC enrollment purpose. Enrollment transactions are tenant- and
-- provider-bound like logins and additionally bind their exact enrollment
-- grant; every purpose carries exactly the fields it is supposed to carry.
-- The preflight above refuses contradictory rows instead of normalizing
-- them, and the existing login/bootstrap invariants are restated below so
-- nothing is weakened.
ALTER TABLE oidc_login_transaction
  ADD COLUMN identity_enrollment_grant_id uuid;

DO $$
DECLARE
  stale record;
BEGIN
  FOR stale IN
    SELECT conname, conrelid::regclass AS table_name
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid = 'oidc_login_transaction'::regclass
      AND pg_get_constraintdef(oid) LIKE '%purpose%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', stale.table_name, stale.conname);
  END LOOP;
END $$;

-- 10. Phase 8 policy reason vocabulary. Scheduled preapproval introduces
-- one new machine-stable reason code; the persisted CHECK is rebuilt so
-- rows carrying it survive the write path.
ALTER TABLE policy_evaluation_result
  DROP CONSTRAINT IF EXISTS policy_evaluation_result_phase6_reason_code;

ALTER TABLE policy_evaluation_result
  ADD CONSTRAINT policy_evaluation_result_phase8_reason_code
  CHECK (reason_code IN (
    'no_violation',
    'schedule_boundary_blackout',
    'current_section_teacher_approval_required',
    'approval_context_unavailable',
    'approval_satisfied',
    'scheduled_preapproval_satisfied',
    'approval_denied',
    'override_denied',
    'rule_overridden',
    'policy_configuration_error'
  ));

ALTER TABLE oidc_login_transaction
  ADD CONSTRAINT oidc_login_transaction_phase8_purpose_structure
  CHECK (
    (purpose = 'login'
      AND tenant_id IS NOT NULL
      AND identity_provider_id IS NOT NULL
      AND bootstrap_setup_id IS NULL
      AND identity_enrollment_grant_id IS NULL)
    OR (purpose = 'bootstrap'
      AND tenant_id IS NULL
      AND identity_provider_id IS NULL
      AND bootstrap_setup_id IS NOT NULL
      AND identity_enrollment_grant_id IS NULL)
    OR (purpose = 'enrollment'
      AND tenant_id IS NOT NULL
      AND identity_provider_id IS NOT NULL
      AND bootstrap_setup_id IS NULL
      AND identity_enrollment_grant_id IS NOT NULL)
  ),
  ADD CONSTRAINT oidc_login_transaction_phase8_enrollment_grant_fk
  FOREIGN KEY (tenant_id, identity_enrollment_grant_id)
  REFERENCES identity_enrollment_grant (tenant_id, id);
`;
