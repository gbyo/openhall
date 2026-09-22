import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql.raw(DESTINATION_CATEGORIES_SQL).execute(database);
}

const DESTINATION_CATEGORIES_SQL = `
-- 010 destination categories: school-defined student grouping.
-- CATEGORY = what the student thinks they are doing (Counselor, Restroom).
-- DESTINATION = concrete endpoint (Mrs. Carter, First Floor Restroom).
-- LOCATION = physical place. Staffing stays in authorization_grant
-- (role = destination_staff). service_type is retained for compatibility
-- but no longer controls student grouping.

-- 1. Category table. icon/tone are bounded product keys validated in the
-- application registry; the DB keeps them non-empty, not an enum, so new
-- icons never require a migration.
CREATE TABLE destination_category (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  organization_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 100),
  icon_key text NOT NULL DEFAULT 'generic' CHECK (length(btrim(icon_key)) > 0 AND length(icon_key) <= 40),
  tone_key text NOT NULL DEFAULT 'neutral' CHECK (length(btrim(tone_key)) > 0 AND length(tone_key) <= 40),
  student_surface text NOT NULL DEFAULT 'secondary' CHECK (student_surface IN ('primary', 'secondary', 'hidden')),
  picker_mode text NOT NULL DEFAULT 'auto' CHECK (picker_mode IN ('auto', 'list', 'search')),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, organization_id) REFERENCES organization(tenant_id, id)
);

-- Helpful composite key so destination can bind (tenant, school, category).
ALTER TABLE destination_category
  ADD CONSTRAINT destination_category_phase10_tenant_school_key
  UNIQUE (tenant_id, organization_id, id);

-- One confusing duplicate active name per school is rejected
-- case-insensitively; archived history may reuse a name.
CREATE UNIQUE INDEX destination_category_phase10_one_active_name
  ON destination_category (tenant_id, organization_id, lower(btrim(name)))
  WHERE status = 'active';

CREATE INDEX destination_category_phase10_school_surface_idx
  ON destination_category (tenant_id, organization_id, student_surface, sort_order);

-- 2. Destination extensions. Nullable first so the backfill below can
-- populate every existing row before the NOT NULL invariant lands.
ALTER TABLE destination
  ADD COLUMN category_id uuid,
  ADD COLUMN student_self_requestable boolean NOT NULL DEFAULT false;

-- 3. Backfill: one school-owned category per distinct legacy service_type
-- group. Known values get curated presentation; unknown values each keep
-- their own category (never merged into "Other") with generic presentation
-- and secondary surface.
DO $$
DECLARE
  org record;
  dest record;
  norm text;
  cat_id uuid;
  cat_name text;
  cat_icon text;
  cat_tone text;
  cat_surface text;
  cat_sort integer;
BEGIN
  FOR org IN SELECT tenant_id, id FROM organization LOOP
    FOR dest IN
      SELECT DISTINCT btrim(service_type) AS raw_value
      FROM destination
      WHERE tenant_id = org.tenant_id AND organization_id = org.id
    LOOP
      norm := lower(dest.raw_value);
      IF norm IN ('restroom', 'bathroom', 'bathrooms', 'restrooms') THEN
        cat_name := 'Restroom'; cat_icon := 'restroom'; cat_tone := 'aqua'; cat_surface := 'primary'; cat_sort := 10;
      ELSIF norm IN ('health', 'nurse', 'clinic', 'medical') THEN
        cat_name := 'Nurse'; cat_icon := 'medical'; cat_tone := 'rose'; cat_surface := 'primary'; cat_sort := 20;
      ELSIF norm IN ('counseling', 'counselor', 'counselling', 'guidance') THEN
        cat_name := 'Counselor'; cat_icon := 'chat'; cat_tone := 'violet'; cat_surface := 'primary'; cat_sort := 30;
      ELSIF norm IN ('library', 'media center', 'media_center') THEN
        cat_name := 'Library'; cat_icon := 'book'; cat_tone := 'amber'; cat_surface := 'primary'; cat_sort := 40;
      ELSIF norm IN ('office', 'main_office', 'main-office', 'main office', 'front_office', 'front-office', 'front office') THEN
        cat_name := 'Main Office'; cat_icon := 'building'; cat_tone := 'blue'; cat_surface := 'primary'; cat_sort := 50;
      ELSE
        -- Preserve the distinct custom value as its own category name.
        cat_name := substring(btrim(regexp_replace(dest.raw_value, '[_\\-]+', ' ', 'g')) for 100);
        IF cat_name IS NULL OR length(btrim(cat_name)) = 0 THEN
          cat_name := dest.raw_value;
        END IF;
        cat_icon := 'generic'; cat_tone := 'neutral'; cat_surface := 'secondary'; cat_sort := 100;
      END IF;

      -- Reuse an already-created category for this org when two distinct
      -- legacy values map to the same curated bucket (e.g. health + nurse).
      SELECT id INTO cat_id
      FROM destination_category
      WHERE tenant_id = org.tenant_id AND organization_id = org.id AND lower(btrim(name)) = lower(btrim(cat_name))
      LIMIT 1;

      IF cat_id IS NULL THEN
        INSERT INTO destination_category (tenant_id, organization_id, name, icon_key, tone_key, student_surface, sort_order)
        VALUES (org.tenant_id, org.id, cat_name, cat_icon, cat_tone, cat_surface, cat_sort)
        RETURNING id INTO cat_id;
      END IF;

      UPDATE destination
      SET category_id = cat_id,
          student_self_requestable = true
      WHERE tenant_id = org.tenant_id
        AND organization_id = org.id
        AND btrim(service_type) = dest.raw_value;
    END LOOP;
  END LOOP;

  -- Every destination must now be assigned; fail loudly rather than lose one.
  IF EXISTS (SELECT 1 FROM destination WHERE category_id IS NULL) THEN
    RAISE EXCEPTION '010 destination categories: % destination row(s) without a category after backfill; resolve manually',
      (SELECT count(*) FROM destination WHERE category_id IS NULL);
  END IF;
END $$;

-- 4. Invariants only after successful backfill.
ALTER TABLE destination
  ALTER COLUMN category_id SET NOT NULL;

ALTER TABLE destination
  ADD CONSTRAINT destination_phase10_category_same_school_fk
  FOREIGN KEY (tenant_id, organization_id, category_id)
  REFERENCES destination_category (tenant_id, organization_id, id);

CREATE INDEX destination_phase10_category_idx
  ON destination (tenant_id, organization_id, category_id);
`;
