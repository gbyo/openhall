import { sql, type Kysely } from 'kysely';

/**
 * PR C: generic destination approval + pass-category policy scope.
 *
 * - `pass_approval` gains an `approver_kind` plus an optional
 *   `required_destination_id`. Each approval now binds exactly one
 *   requirement: `current_section_teacher` keeps the section binding and
 *   `destination_responsible_staff` binds the destination. Section
 *   semantics are unchanged; destination approvals resolve through the
 *   destination responsible staff instead of the section roster.
 *   Existing rows backfill as `current_section_teacher`.
 * - `policy_rule` gains the `destination_category` scope kind so one rule
 *   can cover every destination in a pass category (e.g. all Room visits).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE pass_approval
      ADD COLUMN required_destination_id uuid
  `.execute(db);
  await sql`
    ALTER TABLE pass_approval
      ALTER COLUMN required_section_id DROP NOT NULL
  `.execute(db);
  await sql`
    ALTER TABLE pass_approval
      ADD COLUMN approver_kind text
  `.execute(db);
  await sql`
    UPDATE pass_approval SET approver_kind = 'current_section_teacher'
  `.execute(db);
  await sql`
    ALTER TABLE pass_approval
      ALTER COLUMN approver_kind SET NOT NULL
  `.execute(db);
  await sql`
    ALTER TABLE pass_approval
      ADD CONSTRAINT pass_approval_phase11_exactly_one_requirement
      CHECK (
        (approver_kind = 'current_section_teacher' AND required_section_id IS NOT NULL AND required_destination_id IS NULL) OR
        (approver_kind = 'destination_responsible_staff' AND required_section_id IS NULL AND required_destination_id IS NOT NULL)
      )
  `.execute(db);
  await sql`
    ALTER TABLE pass_approval
      ADD CONSTRAINT pass_approval_phase11_destination_fk
      FOREIGN KEY (tenant_id, required_destination_id)
      REFERENCES destination (tenant_id, id)
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX pass_approval_phase11_one_pending_destination
      ON pass_approval (tenant_id, pass_id, policy_rule_id, policy_rule_revision, required_destination_id)
      WHERE decision = 'pending' AND required_destination_id IS NOT NULL
  `.execute(db);

  await sql`
    ALTER TABLE policy_rule
      DROP CONSTRAINT policy_rule_scope_kind_check
  `.execute(db);
  await sql`
    ALTER TABLE policy_rule
      ADD CONSTRAINT policy_rule_scope_kind_check
      CHECK (scope_kind IN ('organization', 'section', 'destination', 'destination_category'))
  `.execute(db);
  await sql`
    ALTER TABLE policy_rule
      ADD COLUMN scope_destination_category_id uuid
  `.execute(db);
  await sql`
    ALTER TABLE policy_rule
      ADD CONSTRAINT policy_rule_phase11_category_fk
      FOREIGN KEY (tenant_id, organization_id, scope_destination_category_id)
      REFERENCES destination_category (tenant_id, organization_id, id)
  `.execute(db);
  await sql`
    ALTER TABLE policy_rule
      DROP CONSTRAINT policy_rule_check1
  `.execute(db);
  await sql`
    ALTER TABLE policy_evaluation_result
      DROP CONSTRAINT policy_evaluation_result_phase8_reason_code
  `.execute(db);
  await sql`
    ALTER TABLE policy_evaluation_result
      ADD CONSTRAINT policy_evaluation_result_phase11_reason_code
      CHECK (reason_code IN (
        'no_violation',
        'schedule_boundary_blackout',
        'current_section_teacher_approval_required',
        'destination_responsible_staff_approval_required',
        'approval_context_unavailable',
        'approval_satisfied',
        'approval_denied',
        'scheduled_preapproval_satisfied',
        'override_denied',
        'rule_overridden',
        'policy_configuration_error'
      ))
  `.execute(db);
  await sql`
    ALTER TABLE policy_rule
      ADD CONSTRAINT policy_rule_scope_shape_check
      CHECK (
        (scope_kind = 'organization' AND scope_organization_id IS NOT NULL AND scope_section_id IS NULL AND scope_destination_id IS NULL AND scope_destination_category_id IS NULL) OR
        (scope_kind = 'section' AND scope_organization_id IS NULL AND scope_section_id IS NOT NULL AND scope_destination_id IS NULL AND scope_destination_category_id IS NULL) OR
        (scope_kind = 'destination' AND scope_organization_id IS NULL AND scope_section_id IS NULL AND scope_destination_id IS NOT NULL AND scope_destination_category_id IS NULL) OR
        (scope_kind = 'destination_category' AND scope_organization_id IS NULL AND scope_section_id IS NULL AND scope_destination_id IS NULL AND scope_destination_category_id IS NOT NULL)
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE policy_evaluation_result
      DROP CONSTRAINT policy_evaluation_result_phase11_reason_code
  `.execute(db);
  await sql`
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
      ))
  `.execute(db);
  await sql`
    ALTER TABLE policy_rule
      DROP CONSTRAINT policy_rule_scope_shape_check
  `.execute(db);
  await sql`
    ALTER TABLE policy_rule
      ADD CONSTRAINT policy_rule_check1
      CHECK (
        (scope_kind = 'organization' AND scope_organization_id IS NOT NULL AND scope_section_id IS NULL AND scope_destination_id IS NULL) OR
        (scope_kind = 'section' AND scope_organization_id IS NULL AND scope_section_id IS NOT NULL AND scope_destination_id IS NULL) OR
        (scope_kind = 'destination' AND scope_organization_id IS NULL AND scope_section_id IS NULL AND scope_destination_id IS NOT NULL)
      )
  `.execute(db);
  await sql`
    ALTER TABLE policy_rule
      DROP CONSTRAINT policy_rule_phase11_category_fk
  `.execute(db);
  await sql`
    ALTER TABLE policy_rule
      DROP COLUMN scope_destination_category_id
  `.execute(db);
  await sql`
    ALTER TABLE policy_rule
      DROP CONSTRAINT policy_rule_scope_kind_check
  `.execute(db);
  await sql`
    ALTER TABLE policy_rule
      ADD CONSTRAINT policy_rule_scope_kind_check
      CHECK (scope_kind IN ('organization', 'section', 'destination'))
  `.execute(db);

  await sql`
    DROP INDEX pass_approval_phase11_one_pending_destination
  `.execute(db);
  await sql`
    ALTER TABLE pass_approval
      DROP CONSTRAINT pass_approval_phase11_destination_fk
  `.execute(db);
  await sql`
    ALTER TABLE pass_approval
      DROP CONSTRAINT pass_approval_phase11_exactly_one_requirement
  `.execute(db);
  await sql`
    ALTER TABLE pass_approval
      ALTER COLUMN required_section_id SET NOT NULL
  `.execute(db);
  await sql`
    ALTER TABLE pass_approval
      DROP COLUMN approver_kind
  `.execute(db);
  await sql`
    ALTER TABLE pass_approval
      DROP COLUMN required_destination_id
  `.execute(db);
}
