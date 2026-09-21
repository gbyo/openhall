import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql.raw(GUIDED_SETUP_SQL).execute(database);
}

const GUIDED_SETUP_SQL = `
-- 009 guided setup: the canonical installation no longer depends on a
-- successful external OIDC ceremony. Base initialization creates the school
-- first and issues a temporary setup session; the first school sign-in
-- provider is connected afterwards through a purpose-bound transaction.
-- Migrations 001-008 are never modified; everything here is additive,
-- except the dormant CHECK replacements below, which are provably
-- structure-preserving via the preflights.

-- 0. Preflights: fail rather than fabricate historical facts where legacy
-- data cannot truthfully satisfy new invariants.
DO $$
DECLARE
  contradictory_sessions bigint;
  contradictory_transactions bigint;
BEGIN
  SELECT count(*) INTO contradictory_sessions
  FROM auth_session
  WHERE authentication_method NOT IN ('oidc', 'recovery');
  IF contradictory_sessions > 0 THEN
    RAISE EXCEPTION
      '009 guided setup: % existing auth_session row(s) carry an unknown authentication_method; resolve manually',
      contradictory_sessions;
  END IF;

  SELECT count(*) INTO contradictory_transactions
  FROM oidc_login_transaction
  WHERE (purpose = 'login'
      AND (tenant_id IS NULL OR identity_provider_id IS NULL OR bootstrap_setup_id IS NOT NULL
        OR identity_enrollment_grant_id IS NOT NULL))
    OR (purpose = 'bootstrap'
      AND (tenant_id IS NOT NULL OR identity_provider_id IS NOT NULL OR bootstrap_setup_id IS NULL
        OR identity_enrollment_grant_id IS NOT NULL))
    OR (purpose = 'enrollment'
      AND (tenant_id IS NULL OR identity_provider_id IS NULL OR bootstrap_setup_id IS NOT NULL
        OR identity_enrollment_grant_id IS NULL))
    OR (purpose NOT IN ('login', 'bootstrap', 'enrollment'));
  IF contradictory_transactions > 0 THEN
    RAISE EXCEPTION
      '009 guided setup: % existing oidc_login_transaction row(s) contradict the login/bootstrap/enrollment purpose structure; resolve manually',
      contradictory_transactions;
  END IF;
END $$;

-- 1. Temporary setup sessions. OIDC and recovery lifetimes are unchanged;
-- setup gets a genuinely useful 12-hour idle / 24-hour absolute window.
DO $$
DECLARE
  stale record;
BEGIN
  FOR stale IN
    SELECT conname, conrelid::regclass AS table_name
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid = 'auth_session'::regclass
      AND pg_get_constraintdef(oid) LIKE '%authentication_method%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', stale.table_name, stale.conname);
  END LOOP;
END $$;

ALTER TABLE auth_session
  ADD CONSTRAINT auth_session_phase9_authentication_method
  CHECK (authentication_method IN ('oidc', 'recovery', 'setup'));

-- 2. First-provider setup transactions. provider_setup binds the exact
-- predetermined administrator account; no canonical identity_provider row
-- exists yet at prepare time. Every purpose carries exactly the fields it
-- is supposed to carry; existing login/bootstrap/enrollment invariants are
-- restated below so nothing is weakened.
ALTER TABLE oidc_login_transaction
  ADD COLUMN provider_setup_account_id uuid;

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

ALTER TABLE oidc_login_transaction
  ADD CONSTRAINT oidc_login_transaction_phase9_purpose_structure
  CHECK (
    (purpose = 'login'
      AND tenant_id IS NOT NULL
      AND identity_provider_id IS NOT NULL
      AND bootstrap_setup_id IS NULL
      AND identity_enrollment_grant_id IS NULL
      AND provider_setup_account_id IS NULL)
    OR (purpose = 'bootstrap'
      AND tenant_id IS NULL
      AND identity_provider_id IS NULL
      AND bootstrap_setup_id IS NOT NULL
      AND identity_enrollment_grant_id IS NULL
      AND provider_setup_account_id IS NULL)
    OR (purpose = 'enrollment'
      AND tenant_id IS NOT NULL
      AND identity_provider_id IS NOT NULL
      AND bootstrap_setup_id IS NULL
      AND identity_enrollment_grant_id IS NOT NULL
      AND provider_setup_account_id IS NULL)
    OR (purpose = 'provider_setup'
      AND tenant_id IS NOT NULL
      AND identity_provider_id IS NULL
      AND bootstrap_setup_id IS NULL
      AND identity_enrollment_grant_id IS NULL
      AND provider_setup_account_id IS NOT NULL)
  ),
  ADD CONSTRAINT oidc_login_transaction_phase9_provider_setup_account_fk
  FOREIGN KEY (tenant_id, provider_setup_account_id)
  REFERENCES account (tenant_id, id);
`;
