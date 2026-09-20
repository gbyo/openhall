import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql.raw(IDENTITY_SQL).execute(database);
}

const IDENTITY_SQL = `
ALTER TABLE tenant ADD COLUMN slug text;

-- Deterministic, collision-free backfill: the full UUID in hex form satisfies
-- the lowercase slug shape and maps 1:1 from the existing id. Human-readable
-- slugs are chosen for new installations during bootstrap instead.
UPDATE tenant SET slug = replace(id::text, '-', '') WHERE slug IS NULL;

ALTER TABLE tenant ALTER COLUMN slug SET NOT NULL;
ALTER TABLE tenant
  ADD CONSTRAINT tenant_slug_check CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  ADD CONSTRAINT tenant_slug_key UNIQUE (slug);

CREATE TABLE identity_provider (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  key text NOT NULL CHECK (key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) > 0),
  issuer text NOT NULL CHECK (issuer ~ '^https?://[^@?#]+$'),
  client_id text NOT NULL CHECK (length(btrim(client_id)) > 0),
  client_secret_ciphertext bytea NOT NULL,
  client_secret_nonce bytea NOT NULL,
  client_secret_tag bytea NOT NULL,
  client_secret_key_id text NOT NULL CHECK (length(btrim(client_secret_key_id)) > 0),
  token_endpoint_auth_method text NOT NULL
    CHECK (token_endpoint_auth_method IN ('client_secret_post', 'client_secret_basic')),
  scopes text[] NOT NULL CHECK ('openid' = ANY (scopes)),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, key),
  UNIQUE (tenant_id, issuer, client_id)
);

CREATE TABLE local_operator_grant (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  purpose text NOT NULL CHECK (purpose IN ('bootstrap', 'recovery')),
  tenant_id uuid REFERENCES tenant(id),
  account_id uuid,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (
    (purpose = 'bootstrap' AND tenant_id IS NULL AND account_id IS NULL)
    OR (purpose = 'recovery' AND tenant_id IS NOT NULL AND account_id IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, account_id) REFERENCES account(tenant_id, id)
);

CREATE TABLE bootstrap_setup (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  operator_grant_id uuid NOT NULL UNIQUE REFERENCES local_operator_grant(id),
  tenant_name text NOT NULL CHECK (length(btrim(tenant_name)) > 0),
  tenant_slug text NOT NULL CHECK (tenant_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  school_name text NOT NULL CHECK (length(btrim(school_name)) > 0),
  school_slug text NOT NULL CHECK (school_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  school_time_zone text NOT NULL CHECK (length(btrim(school_time_zone)) > 0),
  admin_given_name text NOT NULL CHECK (length(btrim(admin_given_name)) > 0),
  admin_family_name text NOT NULL CHECK (length(btrim(admin_family_name)) > 0),
  admin_display_name text NOT NULL CHECK (length(btrim(admin_display_name)) > 0),
  provider_key text NOT NULL CHECK (provider_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  provider_display_name text NOT NULL CHECK (length(btrim(provider_display_name)) > 0),
  provider_issuer text NOT NULL CHECK (provider_issuer ~ '^https?://[^@?#]+$'),
  provider_client_id text NOT NULL CHECK (length(btrim(provider_client_id)) > 0),
  provider_secret_ciphertext bytea NOT NULL,
  provider_secret_nonce bytea NOT NULL,
  provider_secret_tag bytea NOT NULL,
  provider_secret_key_id text NOT NULL CHECK (length(btrim(provider_secret_key_id)) > 0),
  provider_auth_method text NOT NULL
    CHECK (provider_auth_method IN ('client_secret_post', 'client_secret_basic')),
  provider_scopes text[] NOT NULL CHECK ('openid' = ANY (provider_scopes)),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE TABLE oidc_login_transaction (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid REFERENCES tenant(id),
  identity_provider_id uuid,
  bootstrap_setup_id uuid REFERENCES bootstrap_setup(id),
  purpose text NOT NULL CHECK (purpose IN ('login', 'bootstrap')),
  provider_revision integer CHECK (provider_revision IS NULL OR provider_revision >= 1),
  state_hash bytea NOT NULL UNIQUE,
  browser_binding_hash bytea NOT NULL,
  transaction_secret_ciphertext bytea NOT NULL,
  transaction_secret_nonce bytea NOT NULL,
  transaction_secret_tag bytea NOT NULL,
  transaction_secret_key_id text NOT NULL
    CHECK (length(btrim(transaction_secret_key_id)) > 0),
  return_path text NOT NULL DEFAULT '/'
    CHECK (return_path LIKE '/%' AND return_path NOT LIKE '//%'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'consumed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  processing_started_at timestamptz,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (
    (purpose = 'login'
      AND tenant_id IS NOT NULL
      AND identity_provider_id IS NOT NULL
      AND bootstrap_setup_id IS NULL)
    OR (purpose = 'bootstrap'
      AND tenant_id IS NULL
      AND identity_provider_id IS NULL
      AND bootstrap_setup_id IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, identity_provider_id)
    REFERENCES identity_provider(tenant_id, id)
);

CREATE TABLE auth_session (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  account_id uuid NOT NULL,
  identity_provider_id uuid,
  token_hash bytea NOT NULL UNIQUE,
  csrf_token_hash bytea NOT NULL,
  account_session_revision bigint NOT NULL CHECK (account_session_revision >= 0),
  authentication_method text NOT NULL CHECK (authentication_method IN ('oidc', 'recovery')),
  client_kind text NOT NULL DEFAULT 'web' CHECK (client_kind = 'web'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  authenticated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES account(tenant_id, id),
  FOREIGN KEY (tenant_id, identity_provider_id)
    REFERENCES identity_provider(tenant_id, id),
  CHECK (idle_expires_at > created_at),
  CHECK (absolute_expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL))
);

CREATE INDEX auth_session_account_active_idx
  ON auth_session (tenant_id, account_id)
  WHERE revoked_at IS NULL;

CREATE INDEX auth_session_expiry_idx
  ON auth_session (idle_expires_at, absolute_expires_at)
  WHERE revoked_at IS NULL;
`;
