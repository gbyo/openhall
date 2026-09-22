import type { Temporal } from '@js-temporal/polyfill';
import type {
  NewPendingApproval,
  NewPendingOverride,
  NewPolicyEvaluation,
  NewPolicyEvaluationResult,
  PendingApprovalView,
  PendingOverrideView,
  PersistedPolicyEvaluation,
  PolicyApprovalRecord,
  PolicyOverrideRecord,
  PolicyRepository,
} from '@openhall/application';
import type { TenantTransactionContext } from '@openhall/application';
import type { PolicyRuleInput } from '@openhall/application';
import type { PolicyContribution, PolicyDecision, PolicyRuleOutcome } from '@openhall/application';
import type { PolicyApprover, PolicyOverrideMode } from '@openhall/application';
import type { PolicyReasonCode } from '@openhall/application';
import {
  isOverrideCategory,
  isPolicyOverrideMode,
  isPolicyReasonCode,
  type OverrideCategory,
} from '@openhall/application';
import {
  connectionFor,
  fromDatabaseInstant,
  toBigInt,
  toDatabaseInstant,
} from '../transactions.js';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function toRuleInput(row: {
  id: string;
  organization_id: string;
  name: string;
  rule_type: string;
  scope_kind: string;
  scope_organization_id: string | null;
  scope_section_id: string | null;
  scope_destination_id: string | null;
  scope_destination_category_id: string | null;
  priority: number;
  configuration: unknown;
  override_mode: string;
  enabled: boolean;
  valid_from: string | null;
  valid_until: string | null;
  revision: number;
}): PolicyRuleInput {
  const scopeKind =
    row.scope_kind === 'organization' ||
    row.scope_kind === 'section' ||
    row.scope_kind === 'destination' ||
    row.scope_kind === 'destination_category'
      ? row.scope_kind
      : 'organization';
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    ruleType: row.rule_type,
    scopeKind,
    scopeOrganizationId: row.scope_organization_id,
    scopeSectionId: row.scope_section_id,
    scopeDestinationId: row.scope_destination_id,
    scopeDestinationCategoryId: row.scope_destination_category_id,
    priority: row.priority,
    configuration: row.configuration,
    overrideMode: row.override_mode,
    enabled: row.enabled,
    validFrom: row.valid_from === null ? null : fromDatabaseInstant(row.valid_from),
    validUntil: row.valid_until === null ? null : fromDatabaseInstant(row.valid_until),
    revision: row.revision,
  };
}

function toDecision(value: string): PolicyDecision {
  if (
    value === 'allow' ||
    value === 'deny' ||
    value === 'approval_required' ||
    value === 'override_required'
  ) {
    return value;
  }
  throw new Error(`Unknown persisted policy decision: ${value}`);
}

function toEvidenceDecision(
  value: string,
): 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired' {
  if (
    value === 'pending' ||
    value === 'approved' ||
    value === 'denied' ||
    value === 'cancelled' ||
    value === 'expired'
  ) {
    return value;
  }
  throw new Error(`Unknown persisted workflow decision: ${value}`);
}

function toOverrideCategory(value: string): OverrideCategory {
  if (isOverrideCategory(value)) return value;
  throw new Error(`Unknown persisted override category: ${value}`);
}

function toOverrideMode(value: string): PolicyOverrideMode {
  if (isPolicyOverrideMode(value)) return value;
  throw new Error(`Unknown persisted override mode: ${value}`);
}

function toApproverKind(value: string): PolicyApprover {
  if (value === 'current_section_teacher' || value === 'destination_responsible_staff') {
    return value;
  }
  throw new Error(`Unknown persisted approver kind: ${value}`);
}

function toReasonCode(value: string): PolicyReasonCode {
  if (isPolicyReasonCode(value)) return value;
  throw new Error(`Unknown persisted reason code: ${value}`);
}

function toActorKind(value: string | null): 'person' | 'system' | null {
  if (value === null) return null;
  if (value === 'person' || value === 'system') return value;
  throw new Error(`Unknown persisted actor kind: ${value}`);
}

/**
 * PostgreSQL policy persistence. Every method resolves its connection from
 * the tenant transaction context; there is no unscoped path. Callers lock
 * the pass row first and workflow rows second, in that order, everywhere.
 */
export class PostgresPolicyRepository implements PolicyRepository {
  async listEnabledRules(
    context: TenantTransactionContext,
    organizationId: string,
  ): Promise<readonly PolicyRuleInput[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('policy_rule')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .where('enabled', '=', true)
      .orderBy('priority', 'desc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map((row) =>
      toRuleInput({
        ...row,
        configuration: row.configuration,
      }),
    );
  }

  async createEvaluation(
    context: TenantTransactionContext,
    input: NewPolicyEvaluation,
  ): Promise<string> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('policy_evaluation')
      .values({
        tenant_id: context.tenantId,
        pass_id: input.passId,
        pass_revision: String(input.passRevision),
        stage: input.stage,
        decision: input.decision,
        evaluated_at: toDatabaseInstant(input.evaluatedAt),
        schema_version: 1,
        context_snapshot: { ...(input.contextSnapshot as Record<string, never>) },
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async addEvaluationResult(
    context: TenantTransactionContext,
    input: NewPolicyEvaluationResult,
  ): Promise<string> {
    const connection = connectionFor(context);
    const row = await connection
      .insertInto('policy_evaluation_result')
      .values({
        tenant_id: context.tenantId,
        evaluation_id: input.evaluationId,
        policy_rule_id: input.ruleId,
        policy_rule_revision: input.ruleRevision,
        outcome: input.outcome,
        reason_code: input.reasonCode,
        override_mode: input.overrideMode,
        contribution: input.contribution,
        rule_snapshot: { ...(input.ruleSnapshot as Record<string, never>) },
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async loadLatestEvaluation(
    context: TenantTransactionContext,
    passId: string,
  ): Promise<PersistedPolicyEvaluation | null> {
    const connection = connectionFor(context);
    const evaluation = await connection
      .selectFrom('policy_evaluation')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('pass_id', '=', passId)
      .orderBy('pass_revision', 'desc')
      .orderBy('evaluated_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (evaluation === undefined) return null;
    const results = await connection
      .selectFrom('policy_evaluation_result')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('evaluation_id', '=', evaluation.id)
      .orderBy('id', 'asc')
      .execute();
    return {
      id: evaluation.id,
      passRevision: toBigInt(evaluation.pass_revision),
      stage: evaluation.stage,
      decision: toDecision(evaluation.decision),
      evaluatedAt: fromDatabaseInstant(evaluation.evaluated_at),
      results: results.map((result) => ({
        id: result.id,
        ruleId: result.policy_rule_id,
        ruleRevision: result.policy_rule_revision,
        outcome: result.outcome as PolicyRuleOutcome,
        reasonCode: result.reason_code as PolicyReasonCode,
        overrideMode: result.override_mode,
        contribution: result.contribution as PolicyContribution,
      })),
    };
  }

  async listApprovalsForPass(
    context: TenantTransactionContext,
    passId: string,
  ): Promise<readonly PolicyApprovalRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('pass_approval')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('pass_id', '=', passId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map(toApprovalRecord);
  }

  async findPendingApproval(
    context: TenantTransactionContext,
    passId: string,
    ruleId: string,
    ruleRevision: number,
    requirement: {
      readonly requiredSectionId: string | null;
      readonly requiredDestinationId: string | null;
    },
  ): Promise<PolicyApprovalRecord | null> {
    const connection = connectionFor(context);
    let query = connection
      .selectFrom('pass_approval')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('pass_id', '=', passId)
      .where('policy_rule_id', '=', ruleId)
      .where('policy_rule_revision', '=', ruleRevision)
      .where('decision', '=', 'pending');
    // NULL never equals NULL in SQL: match the exactly-one-bound requirement
    // with an equality on the bound side and IS NULL on the other.
    if (requirement.requiredSectionId !== null) {
      query = query
        .where('required_section_id', '=', requirement.requiredSectionId)
        .where('required_destination_id', 'is', null);
    } else if (requirement.requiredDestinationId !== null) {
      query = query
        .where('required_section_id', 'is', null)
        .where('required_destination_id', '=', requirement.requiredDestinationId);
    } else {
      // Degenerate input binds no requirement; match nothing persistable
      // (the CHECK constraint forbids rows with both sides NULL).
      query = query
        .where('required_section_id', 'is', null)
        .where('required_destination_id', 'is', null);
    }
    const row = await query.executeTakeFirst();
    return row === undefined ? null : toApprovalRecord(row);
  }

  async createPendingApproval(
    context: TenantTransactionContext,
    input: NewPendingApproval,
  ): Promise<PolicyApprovalRecord> {
    const connection = connectionFor(context);
    try {
      const row = await connection
        .insertInto('pass_approval')
        .values({
          tenant_id: context.tenantId,
          organization_id: input.organizationId,
          pass_id: input.passId,
          origin_evaluation_result_id: input.originEvaluationResultId,
          policy_rule_id: input.ruleId,
          policy_rule_revision: input.ruleRevision,
          approver_kind: input.approverKind,
          required_section_id: input.requiredSectionId,
          required_destination_id: input.requiredDestinationId,
          decision: 'pending',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toApprovalRecord(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findPendingApproval(
        context,
        input.passId,
        input.ruleId,
        input.ruleRevision,
        {
          requiredSectionId: input.requiredSectionId,
          requiredDestinationId: input.requiredDestinationId,
        },
      );
      if (existing === null) throw error;
      return existing;
    }
  }

  async lockApprovalForUpdate(
    context: TenantTransactionContext,
    approvalId: string,
  ): Promise<PolicyApprovalRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('pass_approval')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', approvalId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? null : toApprovalRecord(row);
  }

  async resolveApproval(
    context: TenantTransactionContext,
    approvalId: string,
    resolution: {
      readonly decision: 'approved' | 'denied';
      readonly actorKind: 'person';
      readonly decidedByPersonId: string;
      readonly decidedAt: Temporal.Instant;
    },
  ): Promise<PolicyApprovalRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('pass_approval')
      .set({
        decision: resolution.decision,
        decision_actor_kind: resolution.actorKind,
        decided_by_person_id: resolution.decidedByPersonId,
        decided_at: toDatabaseInstant(resolution.decidedAt),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', approvalId)
      .where('decision', '=', 'pending')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toApprovalRecord(row);
  }

  async cancelObsoletePendingApprovals(
    context: TenantTransactionContext,
    passId: string,
    keepApprovalIds: readonly string[],
    at: Temporal.Instant,
  ): Promise<void> {
    const connection = connectionFor(context);
    let query = connection
      .updateTable('pass_approval')
      .set({
        decision: 'cancelled',
        decision_actor_kind: 'system',
        decided_by_person_id: null,
        decided_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('pass_id', '=', passId)
      .where('decision', '=', 'pending');
    if (keepApprovalIds.length > 0) {
      query = query.where('id', 'not in', [...keepApprovalIds]);
    }
    await query.execute();
  }

  async cancelAllPendingWorkflows(
    context: TenantTransactionContext,
    passId: string,
    at: Temporal.Instant,
  ): Promise<void> {
    const connection = connectionFor(context);
    await connection
      .updateTable('pass_approval')
      .set({
        decision: 'cancelled',
        decision_actor_kind: 'system',
        decided_by_person_id: null,
        decided_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('pass_id', '=', passId)
      .where('decision', '=', 'pending')
      .execute();
    await connection
      .updateTable('pass_override')
      .set({
        decision: 'cancelled',
        decision_actor_kind: 'system',
        decided_by_person_id: null,
        decided_at: toDatabaseInstant(at),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('pass_id', '=', passId)
      .where('decision', '=', 'pending')
      .execute();
  }

  async listOverridesForPass(
    context: TenantTransactionContext,
    passId: string,
  ): Promise<readonly PolicyOverrideRecord[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('pass_override')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('pass_id', '=', passId)
      .orderBy('requested_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map(toOverrideRecord);
  }

  async findLiveOverride(
    context: TenantTransactionContext,
    passId: string,
    ruleId: string,
    ruleRevision: number,
  ): Promise<PolicyOverrideRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('pass_override')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('pass_id', '=', passId)
      .where('policy_rule_id', '=', ruleId)
      .where('policy_rule_revision', '=', ruleRevision)
      .where('decision', 'in', ['pending', 'approved'])
      .orderBy('requested_at', 'desc')
      .executeTakeFirst();
    return row === undefined ? null : toOverrideRecord(row);
  }

  async createOverride(
    context: TenantTransactionContext,
    input: NewPendingOverride & { readonly decision: 'pending' | 'approved' },
  ): Promise<PolicyOverrideRecord> {
    const connection = connectionFor(context);
    try {
      const row = await connection
        .insertInto('pass_override')
        .values({
          tenant_id: context.tenantId,
          organization_id: input.organizationId,
          pass_id: input.passId,
          evaluation_result_id: input.evaluationResultId,
          requested_by_person_id: input.requestedByPersonId,
          requested_at: toDatabaseInstant(input.requestedAt),
          policy_rule_id: input.ruleId,
          policy_rule_revision: input.ruleRevision,
          override_mode: input.overrideMode,
          category: input.category,
          decision: input.decision,
          decision_actor_kind: input.decision === 'approved' ? 'person' : null,
          decided_by_person_id: input.decision === 'approved' ? input.requestedByPersonId : null,
          decided_at: input.decision === 'approved' ? toDatabaseInstant(input.requestedAt) : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toOverrideRecord(row);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findLiveOverride(
        context,
        input.passId,
        input.ruleId,
        input.ruleRevision,
      );
      if (existing === null) throw error;
      return existing;
    }
  }

  async lockOverrideForUpdate(
    context: TenantTransactionContext,
    overrideId: string,
  ): Promise<PolicyOverrideRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('pass_override')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', overrideId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? null : toOverrideRecord(row);
  }

  async resolveOverride(
    context: TenantTransactionContext,
    overrideId: string,
    resolution: {
      readonly decision: 'approved' | 'denied';
      readonly actorKind: 'person';
      readonly decidedByPersonId: string;
      readonly decidedAt: Temporal.Instant;
    },
  ): Promise<PolicyOverrideRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .updateTable('pass_override')
      .set({
        decision: resolution.decision,
        decision_actor_kind: resolution.actorKind,
        decided_by_person_id: resolution.decidedByPersonId,
        decided_at: toDatabaseInstant(resolution.decidedAt),
      })
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', overrideId)
      .where('decision', '=', 'pending')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toOverrideRecord(row);
  }

  async loadApprovalById(
    context: TenantTransactionContext,
    approvalId: string,
  ): Promise<PolicyApprovalRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('pass_approval')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', approvalId)
      .executeTakeFirst();
    return row === undefined ? null : toApprovalRecord(row);
  }

  async loadOverrideById(
    context: TenantTransactionContext,
    overrideId: string,
  ): Promise<PolicyOverrideRecord | null> {
    const connection = connectionFor(context);
    const row = await connection
      .selectFrom('pass_override')
      .selectAll()
      .where('tenant_id', '=', context.tenantId)
      .where('id', '=', overrideId)
      .executeTakeFirst();
    return row === undefined ? null : toOverrideRecord(row);
  }

  async listPendingApprovalViews(
    context: TenantTransactionContext,
  ): Promise<readonly PendingApprovalView[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('pass_approval')
      .innerJoin('pass', (join) =>
        join
          .onRef('pass.tenant_id', '=', 'pass_approval.tenant_id')
          .onRef('pass.id', '=', 'pass_approval.pass_id'),
      )
      .innerJoin('person', (join) =>
        join
          .onRef('person.tenant_id', '=', 'pass_approval.tenant_id')
          .onRef('person.id', '=', 'pass.student_id'),
      )
      .innerJoin('destination', (join) =>
        join
          .onRef('destination.tenant_id', '=', 'pass_approval.tenant_id')
          .onRef('destination.id', '=', 'pass.destination_id'),
      )
      .leftJoin('section', (join) =>
        join
          .onRef('section.tenant_id', '=', 'pass_approval.tenant_id')
          .onRef('section.id', '=', 'pass_approval.required_section_id'),
      )
      .select([
        'pass_approval.id as approval_id',
        'pass_approval.pass_id as pass_id',
        'pass_approval.organization_id as organization_id',
        'pass_approval.required_section_id as required_section_id',
        'pass_approval.required_destination_id as required_destination_id',
        'pass_approval.created_at as requested_at',
        'pass.revision as pass_revision',
        'pass.student_id as student_id',
        'pass.destination_id as destination_id',
        'person.display_name as student_display_name',
        'destination.display_name as destination_display_name',
        'destination.service_type as destination_service_type',
        'section.code as section_code',
        'section.title as section_title',
      ])
      .where('pass_approval.tenant_id', '=', context.tenantId)
      .where('pass_approval.decision', '=', 'pending')
      .orderBy('pass_approval.created_at', 'asc')
      .orderBy('pass_approval.id', 'asc')
      .execute();
    return rows.map((row) => ({
      approvalId: row.approval_id,
      passId: row.pass_id,
      passRevision: toBigInt(row.pass_revision),
      organizationId: row.organization_id,
      studentId: row.student_id,
      studentDisplayName: row.student_display_name,
      destinationId: row.destination_id,
      destinationDisplayName: row.destination_display_name ?? '',
      destinationServiceType: row.destination_service_type,
      requiredSectionId: row.required_section_id,
      requiredDestinationId: row.required_destination_id,
      sectionCode: row.section_code,
      sectionTitle: row.section_title,
      requestedAt: fromDatabaseInstant(row.requested_at),
    }));
  }

  async listPendingOverrideViews(
    context: TenantTransactionContext,
  ): Promise<readonly PendingOverrideView[]> {
    const connection = connectionFor(context);
    const rows = await connection
      .selectFrom('pass_override')
      .innerJoin('pass', (join) =>
        join
          .onRef('pass.tenant_id', '=', 'pass_override.tenant_id')
          .onRef('pass.id', '=', 'pass_override.pass_id'),
      )
      .innerJoin('person', (join) =>
        join
          .onRef('person.tenant_id', '=', 'pass_override.tenant_id')
          .onRef('person.id', '=', 'pass.student_id'),
      )
      .innerJoin('destination', (join) =>
        join
          .onRef('destination.tenant_id', '=', 'pass_override.tenant_id')
          .onRef('destination.id', '=', 'pass.destination_id'),
      )
      .innerJoin('policy_evaluation_result', (join) =>
        join
          .onRef('policy_evaluation_result.tenant_id', '=', 'pass_override.tenant_id')
          .onRef('policy_evaluation_result.id', '=', 'pass_override.evaluation_result_id'),
      )
      .select([
        'pass_override.id as override_id',
        'pass_override.pass_id as pass_id',
        'pass_override.organization_id as organization_id',
        'pass_override.category as category',
        'pass_override.override_mode as override_mode',
        'pass_override.requested_at as requested_at',
        'pass.revision as pass_revision',
        'pass.student_id as student_id',
        'pass.destination_id as destination_id',
        'person.display_name as student_display_name',
        'destination.display_name as destination_display_name',
        'destination.service_type as destination_service_type',
        'policy_evaluation_result.reason_code as reason_code',
      ])
      .where('pass_override.tenant_id', '=', context.tenantId)
      .where('pass_override.decision', '=', 'pending')
      .orderBy('pass_override.requested_at', 'asc')
      .orderBy('pass_override.id', 'asc')
      .execute();
    return rows.map((row) => ({
      overrideId: row.override_id,
      passId: row.pass_id,
      passRevision: toBigInt(row.pass_revision),
      organizationId: row.organization_id,
      studentId: row.student_id,
      studentDisplayName: row.student_display_name,
      destinationId: row.destination_id,
      destinationDisplayName: row.destination_display_name ?? '',
      destinationServiceType: row.destination_service_type,
      category: toOverrideCategory(row.category),
      overrideMode: toOverrideMode(row.override_mode),
      reasonCode: toReasonCode(row.reason_code),
      requestedAt: fromDatabaseInstant(row.requested_at),
    }));
  }
}

function toApprovalRecord(row: {
  id: string;
  organization_id: string;
  pass_id: string;
  origin_evaluation_result_id: string;
  policy_rule_id: string;
  policy_rule_revision: number;
  approver_kind: string;
  required_section_id: string | null;
  required_destination_id: string | null;
  decision: string;
  decision_actor_kind: string | null;
  decided_by_person_id: string | null;
  decided_at: string | null;
  created_at: string;
}): PolicyApprovalRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    passId: row.pass_id,
    originEvaluationResultId: row.origin_evaluation_result_id,
    policyRuleId: row.policy_rule_id,
    policyRuleRevision: row.policy_rule_revision,
    approverKind: toApproverKind(row.approver_kind),
    requiredSectionId: row.required_section_id,
    requiredDestinationId: row.required_destination_id,
    decision: toEvidenceDecision(row.decision),
    decisionActorKind: toActorKind(row.decision_actor_kind),
    decidedByPersonId: row.decided_by_person_id,
    decidedAt: row.decided_at === null ? null : fromDatabaseInstant(row.decided_at),
    createdAt: fromDatabaseInstant(row.created_at),
  };
}

function toOverrideRecord(row: {
  id: string;
  organization_id: string;
  pass_id: string;
  evaluation_result_id: string;
  policy_rule_id: string;
  policy_rule_revision: number;
  override_mode: string;
  category: string;
  requested_by_person_id: string;
  requested_at: string;
  decision: string;
  decision_actor_kind: string | null;
  decided_by_person_id: string | null;
  decided_at: string | null;
}): PolicyOverrideRecord {
  const overrideMode = row.override_mode as PolicyOverrideMode;
  return {
    id: row.id,
    organizationId: row.organization_id,
    passId: row.pass_id,
    evaluationResultId: row.evaluation_result_id,
    policyRuleId: row.policy_rule_id,
    policyRuleRevision: row.policy_rule_revision,
    overrideMode,
    category: row.category,
    requestedByPersonId: row.requested_by_person_id,
    requestedAt: fromDatabaseInstant(row.requested_at),
    decision: toEvidenceDecision(row.decision),
    decisionActorKind: toActorKind(row.decision_actor_kind),
    decidedByPersonId: row.decided_by_person_id,
    decidedAt: row.decided_at === null ? null : fromDatabaseInstant(row.decided_at),
  };
}
