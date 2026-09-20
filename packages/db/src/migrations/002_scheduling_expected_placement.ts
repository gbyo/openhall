import { sql, type Kysely } from 'kysely';

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql.raw(SCHEDULING_SQL).execute(database);
}

const SCHEDULING_SQL = `
ALTER TABLE organization_membership ADD COLUMN id uuid DEFAULT uuidv7();
ALTER TABLE organization_membership ALTER COLUMN id SET NOT NULL;
ALTER TABLE organization_membership DROP CONSTRAINT organization_membership_pkey;
ALTER TABLE organization_membership ADD CONSTRAINT organization_membership_pkey PRIMARY KEY (id);
ALTER TABLE organization_membership
  ADD CONSTRAINT organization_membership_tenant_id_id_key UNIQUE (tenant_id, id),
  ADD CONSTRAINT organization_membership_semantic_key
    UNIQUE (tenant_id, organization_id, person_id, affiliation);

ALTER TABLE section_membership ADD COLUMN id uuid DEFAULT uuidv7();
ALTER TABLE section_membership ALTER COLUMN id SET NOT NULL;
ALTER TABLE section_membership DROP CONSTRAINT section_membership_pkey;
ALTER TABLE section_membership ADD CONSTRAINT section_membership_pkey PRIMARY KEY (id);
ALTER TABLE section_membership
  ADD CONSTRAINT section_membership_tenant_id_id_key UNIQUE (tenant_id, id),
  ADD CONSTRAINT section_membership_semantic_key
    UNIQUE (tenant_id, section_id, person_id, role);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM location child
    JOIN location parent
      ON parent.tenant_id = child.tenant_id AND parent.id = child.parent_location_id
    WHERE child.parent_location_id IS NOT NULL
      AND child.organization_id <> parent.organization_id
  ) THEN
    RAISE EXCEPTION '002 scheduling migration: location parent belongs to a different school';
  END IF;

  IF EXISTS (
    SELECT 1 FROM section_meeting meeting
    JOIN section section_row
      ON section_row.tenant_id = meeting.tenant_id AND section_row.id = meeting.section_id
    JOIN schedule_block block
      ON block.tenant_id = meeting.tenant_id AND block.id = meeting.schedule_block_id
    LEFT JOIN location location_row
      ON location_row.tenant_id = meeting.tenant_id AND location_row.id = meeting.location_id
    WHERE section_row.organization_id <> block.organization_id
       OR (meeting.location_id IS NOT NULL AND section_row.organization_id <> location_row.organization_id)
  ) THEN
    RAISE EXCEPTION '002 scheduling migration: section meeting crosses school boundaries';
  END IF;

  IF EXISTS (
    SELECT 1 FROM schedule_slot slot
    JOIN schedule_template template
      ON template.tenant_id = slot.tenant_id AND template.id = slot.schedule_template_id
    JOIN schedule_block block
      ON block.tenant_id = slot.tenant_id AND block.id = slot.schedule_block_id
    WHERE template.organization_id <> block.organization_id
  ) THEN
    RAISE EXCEPTION '002 scheduling migration: schedule slot crosses school boundaries';
  END IF;

  IF EXISTS (
    SELECT 1 FROM calendar_day day
    JOIN schedule_template template
      ON template.tenant_id = day.tenant_id AND template.id = day.schedule_template_id
    WHERE day.schedule_template_id IS NOT NULL
      AND day.organization_id <> template.organization_id
  ) THEN
    RAISE EXCEPTION '002 scheduling migration: calendar day template belongs to a different school';
  END IF;

  IF EXISTS (
    SELECT 1 FROM destination destination_row
    JOIN location location_row
      ON location_row.tenant_id = destination_row.tenant_id
     AND location_row.id = destination_row.location_id
    WHERE destination_row.organization_id <> location_row.organization_id
  ) THEN
    RAISE EXCEPTION '002 scheduling migration: destination location belongs to a different school';
  END IF;
END $$;

ALTER TABLE section
  ADD CONSTRAINT section_tenant_organization_id_id_key UNIQUE (tenant_id, organization_id, id);
ALTER TABLE location
  ADD CONSTRAINT location_tenant_organization_id_id_key UNIQUE (tenant_id, organization_id, id);
ALTER TABLE schedule_block
  ADD CONSTRAINT schedule_block_tenant_organization_id_id_key UNIQUE (tenant_id, organization_id, id);
ALTER TABLE schedule_template
  ADD CONSTRAINT schedule_template_tenant_organization_id_id_key UNIQUE (tenant_id, organization_id, id);

ALTER TABLE location
  ADD CONSTRAINT location_parent_same_school_fk
  FOREIGN KEY (tenant_id, organization_id, parent_location_id)
  REFERENCES location (tenant_id, organization_id, id);

ALTER TABLE section_meeting ADD COLUMN organization_id uuid;
UPDATE section_meeting meeting
SET organization_id = section_row.organization_id
FROM section section_row
WHERE section_row.tenant_id = meeting.tenant_id AND section_row.id = meeting.section_id;
ALTER TABLE section_meeting ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE section_meeting
  ADD CONSTRAINT section_meeting_section_same_school_fk
    FOREIGN KEY (tenant_id, organization_id, section_id)
    REFERENCES section (tenant_id, organization_id, id),
  ADD CONSTRAINT section_meeting_block_same_school_fk
    FOREIGN KEY (tenant_id, organization_id, schedule_block_id)
    REFERENCES schedule_block (tenant_id, organization_id, id),
  ADD CONSTRAINT section_meeting_location_same_school_fk
    FOREIGN KEY (tenant_id, organization_id, location_id)
    REFERENCES location (tenant_id, organization_id, id);

ALTER TABLE schedule_slot ADD COLUMN organization_id uuid;
UPDATE schedule_slot slot
SET organization_id = template.organization_id
FROM schedule_template template
WHERE template.tenant_id = slot.tenant_id AND template.id = slot.schedule_template_id;
ALTER TABLE schedule_slot ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE schedule_slot
  ADD CONSTRAINT schedule_slot_template_same_school_fk
    FOREIGN KEY (tenant_id, organization_id, schedule_template_id)
    REFERENCES schedule_template (tenant_id, organization_id, id),
  ADD CONSTRAINT schedule_slot_block_same_school_fk
    FOREIGN KEY (tenant_id, organization_id, schedule_block_id)
    REFERENCES schedule_block (tenant_id, organization_id, id);

ALTER TABLE calendar_day
  ADD CONSTRAINT calendar_day_template_same_school_fk
  FOREIGN KEY (tenant_id, organization_id, schedule_template_id)
  REFERENCES schedule_template (tenant_id, organization_id, id);

ALTER TABLE destination
  ADD CONSTRAINT destination_location_same_school_fk
  FOREIGN KEY (tenant_id, organization_id, location_id)
  REFERENCES location (tenant_id, organization_id, id);

CREATE INDEX section_membership_tenant_person_idx
  ON section_membership (tenant_id, person_id);
CREATE INDEX section_meeting_tenant_school_section_idx
  ON section_meeting (tenant_id, organization_id, section_id);
`;
