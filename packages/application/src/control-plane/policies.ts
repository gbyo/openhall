import { Temporal } from '@js-temporal/polyfill';
import type { Clock } from '@openhall/domain';
import type { AuditWriter } from '../auditing/audit.js';
import type { Principal } from '../authentication/principal.js';
import type { RelationshipAuthorizationService } from '../authorization/service.js';
import type { IdempotencyTransactionStore } from '../idempotency/coordinator.js';
import type {
  OutboxWriter,
  TenantTransactionContext,
  TenantTransactionRunner,
} from '../persistence.js';
import {
  isPolicyOverrideMode,
  isPolicyRuleType,
  parsePolicyRuleConfiguration,
} from '../policy/configurations.js';
import { ControlPlaneError } from './errors.js';
import { etagForResource, parseResourceIfMatch } from './etags.js';
import {
  controlPlaneLockKey,
  fingerprintControlPlane,
  requireControlPlaneIdempotencyKey,
  runControlPlaneCommand,
  type ControlPlaneCommand,
} from './idempotency.js';
import type {
  DestinationRepository,
  PolicyAdminRepository,
  PolicyRuleRecord,
  PolicyRuleWrite,
  PolicyScopeKind,
} from './ports.js';
import { requireNormalSession, requireOrganizationCapability } from './shared.js';

export interface PolicyDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly policies: PolicyAdminRepository;
  readonly destinations: DestinationRepository;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

export interface PolicyRuleView {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly ruleType: string;
  readonly scope: {
    readonly kind: PolicyScopeKind;
    readonly organizationId: string | null;
    readonly sectionId: string | null;
    readonly destinationId: string | null;
  };
  readonly priority: number;
  readonly configuration: unknown;
  readonly overrideMode: string;
  readonly enabled: boolean;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly revision: number;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPolicyRuleView(row: PolicyRuleRecord): PolicyRuleView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    ruleType: row.ruleType,
    scope: {
      kind: row.scopeKind,
      organizationId: row.scopeOrganizationId,
      sectionId: row.scopeSectionId,
      destinationId: row.scopeDestinationId,
    },
    priority: row.priority,
    configuration: row.configuration,
    overrideMode: row.overrideMode,
    enabled: row.enabled,
    validFrom: row.validFrom?.toString() ?? null,
    validUntil: row.validUntil?.toString() ?? null,
    revision: row.revision,
    archivedAt: row.archivedAt?.toString() ?? null,
    createdAt: row.createdAt.toString(),
    updatedAt: row.updatedAt.toString(),
  };
}

export function etagForPolicyRule(ruleId: string, revision: number): string {
  return etagForResource('policy', ruleId, BigInt(revision));
}

export interface PolicyCommandInput {
  readonly principal: Principal;
  readonly idempotencyKey: unknown;
  readonly requestId: string;
}

export interface PolicyScopeInput {
  readonly kind: unknown;
  readonly organizationId: string | null;
  readonly sectionId: string | null;
  readonly destinationId: string | null;
}

export interface PolicyWriteBody {
  readonly name: unknown;
  readonly ruleType: unknown;
  readonly scope: PolicyScopeInput;
  readonly priority: unknown;
  readonly configuration: unknown;
  readonly overrideMode: unknown;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export interface CreatePolicyInput extends PolicyCommandInput {
  readonly organizationId: string;
  readonly body: PolicyWriteBody;
}

export interface UpdatePolicyInput extends PolicyCommandInput {
  readonly ruleId: string;
  readonly ifMatch: unknown;
  readonly body: PolicyWriteBody;
}

export interface PolicyStatusInput extends PolicyCommandInput {
  readonly ruleId: string;
  readonly ifMatch: unknown;
}

export interface PolicyResult {
  readonly rule: PolicyRuleView;
  readonly etag: string;
  readonly status: 200 | 201;
  readonly replayed: boolean;
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ControlPlaneError('policy_rule_invalid', 'Invalid policy name.');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw new ControlPlaneError('policy_rule_invalid', 'Invalid policy name.');
  }
  return trimmed;
}

function cleanPriority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ControlPlaneError('policy_rule_invalid', 'Invalid policy priority.');
  }
  return value;
}

function cleanInstant(value: string | null, field: string): Temporal.Instant | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new ControlPlaneError('policy_rule_invalid', `Invalid ${field}.`);
  }
  try {
    return Temporal.Instant.from(value);
  } catch {
    throw new ControlPlaneError('policy_rule_invalid', `Invalid ${field}.`);
  }
}

function cleanScopeKind(value: unknown): PolicyScopeKind {
  if (value === 'organization' || value === 'section' || value === 'destination') return value;
  throw new ControlPlaneError('policy_rule_invalid', 'Invalid policy scope.');
}

/**
 * Canonicalizes the closed policy write body and validates the
 * configuration through the same Phase 6 parser the evaluation engine
 * uses. There is no second, weaker validation path.
 */
function canonicalWrite(body: PolicyWriteBody): PolicyRuleWrite {
  const name = cleanName(body.name);
  if (typeof body.ruleType !== 'string' || !isPolicyRuleType(body.ruleType)) {
    throw new ControlPlaneError('policy_rule_invalid', 'Invalid rule type.');
  }
  if (typeof body.overrideMode !== 'string' || !isPolicyOverrideMode(body.overrideMode)) {
    throw new ControlPlaneError('policy_rule_invalid', 'Invalid override mode.');
  }
  const scopeKind = cleanScopeKind(body.scope.kind);
  const { organizationId, sectionId, destinationId } = body.scope;
  let scopeOrganizationId: string | null = null;
  let scopeSectionId: string | null = null;
  let scopeDestinationId: string | null = null;
  if (scopeKind === 'organization') {
    if (typeof organizationId !== 'string' || sectionId !== null || destinationId !== null) {
      throw new ControlPlaneError('policy_rule_invalid', 'Invalid policy scope.');
    }
    scopeOrganizationId = organizationId;
  } else if (scopeKind === 'section') {
    if (typeof sectionId !== 'string' || organizationId !== null || destinationId !== null) {
      throw new ControlPlaneError('policy_rule_invalid', 'Invalid policy scope.');
    }
    scopeSectionId = sectionId;
  } else {
    if (typeof destinationId !== 'string' || organizationId !== null || sectionId !== null) {
      throw new ControlPlaneError('policy_rule_invalid', 'Invalid policy scope.');
    }
    scopeDestinationId = destinationId;
  }
  const parsed = parsePolicyRuleConfiguration(body.ruleType, body.configuration);
  if (!parsed.valid) {
    throw new ControlPlaneError(
      'policy_rule_invalid',
      `Invalid policy configuration: ${parsed.reason}.`,
    );
  }
  const validFrom = cleanInstant(body.validFrom, 'validFrom');
  const validUntil = cleanInstant(body.validUntil, 'validUntil');
  if (
    validFrom !== null &&
    validUntil !== null &&
    Temporal.Instant.compare(validUntil, validFrom) <= 0
  ) {
    throw new ControlPlaneError('policy_rule_invalid', 'Invalid validity interval.');
  }
  return {
    name,
    ruleType: body.ruleType,
    scopeKind,
    scopeOrganizationId,
    scopeSectionId,
    scopeDestinationId,
    priority: cleanPriority(body.priority),
    configuration: body.configuration,
    overrideMode: body.overrideMode,
    validFrom,
    validUntil,
  };
}

/**
 * Validates that the scope still designates a live same-school resource.
 * Organization scope must be the exact route school; section scope must
 * belong to it; destination scope must belong to it and not be archived.
 */
async function assertScopeValid(
  context: TenantTransactionContext,
  dependencies: PolicyDependencies,
  organizationId: string,
  tenantId: string,
  write: PolicyRuleWrite,
): Promise<void> {
  if (write.scopeKind === 'organization') {
    if (write.scopeOrganizationId !== organizationId) {
      throw new ControlPlaneError('policy_rule_invalid', 'Invalid policy scope.');
    }
    return;
  }
  if (write.scopeKind === 'section') {
    const section = await dependencies.policies.loadSectionSchool(
      context,
      write.scopeSectionId ?? '',
    );
    if (section?.organizationId !== organizationId || section.status === 'archived') {
      throw new ControlPlaneError('policy_rule_invalid', 'Invalid policy scope.');
    }
    return;
  }
  const destination = await dependencies.destinations.loadById(
    context,
    write.scopeDestinationId ?? '',
  );
  if (
    destination?.tenantId !== tenantId ||
    destination.organizationId !== organizationId ||
    destination.status === 'archived'
  ) {
    throw new ControlPlaneError('policy_rule_invalid', 'Invalid policy scope.');
  }
}

function fingerprintWrite(write: PolicyRuleWrite): string[] {
  return [
    write.name,
    write.ruleType,
    write.scopeKind,
    write.scopeOrganizationId ?? '',
    write.scopeSectionId ?? '',
    write.scopeDestinationId ?? '',
    String(write.priority),
    JSON.stringify(write.configuration),
    write.overrideMode,
    write.validFrom?.toString() ?? '',
    write.validUntil?.toString() ?? '',
  ];
}

async function appendPolicyAudit(
  dependencies: PolicyDependencies,
  context: TenantTransactionContext,
  principal: Principal,
  row: PolicyRuleRecord,
  action: string,
  requestId: string,
  now: Temporal.Instant,
): Promise<void> {
  await dependencies.audit.append(context, {
    action,
    actorKind: 'account',
    actorId: principal.accountId,
    organizationId: row.organizationId,
    targetKind: 'policy_rule',
    targetId: row.id,
    outcome: 'success',
    occurredAt: now,
    requestId,
    metadata: {
      policyRuleId: row.id,
      organizationId: row.organizationId,
      revision: String(row.revision),
      requestId,
    },
  });
}

async function appendPolicyOutbox(
  dependencies: PolicyDependencies,
  context: TenantTransactionContext,
  row: PolicyRuleRecord,
  eventType: string,
  now: Temporal.Instant,
): Promise<void> {
  await dependencies.outbox.append(context, {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    aggregateKind: 'policy_rule',
    aggregateId: row.id,
    eventType,
    occurredAt: now.toString(),
    payload: {
      schemaVersion: 1,
      organizationId: row.organizationId,
      policyRuleId: row.id,
      revision: row.revision,
      enabled: row.enabled,
      ruleType: row.ruleType,
    },
  });
}

/** GET /organizations/:id/policy-rules — policy.manage read of the exact school. */
export async function listPolicyRules(
  principal: Principal,
  organizationId: string,
  dependencies: PolicyDependencies,
): Promise<{ readonly rules: readonly PolicyRuleView[] }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    await requireOrganizationCapability(
      context,
      dependencies.authorization,
      principal,
      'policy.manage',
      organizationId,
      now,
      'policy_rule_not_found',
    );
    const rows = await dependencies.policies.listByOrganization(context, organizationId);
    return { rules: rows.map(toPolicyRuleView) };
  });
}

/** GET /policy-rules/:id — authorized against the canonical school. */
export async function getPolicyRule(
  principal: Principal,
  ruleId: string,
  dependencies: PolicyDependencies,
): Promise<{ readonly rule: PolicyRuleView; readonly etag: string }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const row = await dependencies.policies.loadById(context, ruleId);
    if (row?.tenantId !== principal.tenantId) {
      throw new ControlPlaneError('policy_rule_not_found', 'Policy rule not found.');
    }
    await requireOrganizationCapability(
      context,
      dependencies.authorization,
      principal,
      'policy.manage',
      row.organizationId,
      now,
      'policy_rule_not_found',
    );
    return {
      rule: toPolicyRuleView(row),
      etag: etagForPolicyRule(row.id, row.revision),
    };
  });
}

/**
 * POST /organizations/:id/policy-rules — new rules start disabled at
 * revision 1 with no archived marker. Creation alone never affects students;
 * an administrator explicitly activates the rule afterwards.
 */
export async function createPolicyRule(
  input: CreatePolicyInput,
  dependencies: PolicyDependencies,
): Promise<PolicyResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const now = dependencies.clock.now();
  const write = canonicalWrite(input.body);
  const fingerprint = fingerprintControlPlane('policy.create:v1', [
    input.organizationId,
    ...fingerprintWrite(write),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'policy.create:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'policy.create:v1',
      key,
    ),
    execute: async (context) => {
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'policy.manage',
        input.organizationId,
        now,
        'policy_rule_not_found',
      );
      await assertScopeValid(
        context,
        dependencies,
        input.organizationId,
        input.principal.tenantId,
        write,
      );
      const row = await dependencies.policies.insert(context, {
        ...write,
        organizationId: input.organizationId,
      });
      await appendPolicyAudit(
        dependencies,
        context,
        input.principal,
        row,
        'policy_rule.created',
        input.requestId,
        now,
      );
      await appendPolicyOutbox(dependencies, context, row, 'policy_rule.created', now);
      const rule = toPolicyRuleView(row);
      return { rule, etag: etagForPolicyRule(row.id, row.revision) };
    },
    toStored: (value) => ({ responseStatus: 201, responseBody: { rule: value.rule } }),
    fromStored: (record) => {
      const body = record.responseBody as { rule: PolicyRuleView };
      return {
        rule: body.rule,
        etag: etagForPolicyRule(body.rule.id, body.rule.revision),
      };
    },
  });
  return {
    rule: outcome.value.rule,
    etag: outcome.value.etag,
    status: 201,
    replayed: outcome.replayed,
  };
}

/**
 * PUT /policy-rules/:id — full semantic replacement of mutable
 * configuration. An active rule may be edited while active; the new revision
 * takes effect for future evaluations while old evaluation snapshots stay
 * authoritative for past decisions.
 */
export async function updatePolicyRule(
  input: UpdatePolicyInput,
  dependencies: PolicyDependencies,
): Promise<PolicyResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const expected = parseResourceIfMatch(input.ifMatch, { kind: 'policy', id: input.ruleId });
  const now = dependencies.clock.now();
  const write = canonicalWrite(input.body);
  const fingerprint = fingerprintControlPlane('policy.update:v1', [
    input.ruleId,
    expected.revision.toString(10),
    ...fingerprintWrite(write),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'policy.update:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'policy.update:v1',
      key,
    ),
    execute: async (context) => {
      const current = await dependencies.policies.loadForUpdate(context, input.ruleId);
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('policy_rule_not_found', 'Policy rule not found.');
      }
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'policy.manage',
        current.organizationId,
        now,
        'policy_rule_not_found',
      );
      if (BigInt(current.revision) !== expected.revision) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The policy rule has changed since this client last read it.',
        );
      }
      if (current.archivedAt !== null) {
        throw new ControlPlaneError('policy_rule_archived', 'The policy rule is archived.');
      }
      await assertScopeValid(
        context,
        dependencies,
        current.organizationId,
        input.principal.tenantId,
        write,
      );
      const row = await dependencies.policies.updateToRevision(
        context,
        current.id,
        current.revision,
        write,
        now,
      );
      if (row === null) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The policy rule has changed since this client last read it.',
        );
      }
      await appendPolicyAudit(
        dependencies,
        context,
        input.principal,
        row,
        'policy_rule.updated',
        input.requestId,
        now,
      );
      await appendPolicyOutbox(dependencies, context, row, 'policy_rule.updated', now);
      const rule = toPolicyRuleView(row);
      return { rule, etag: etagForPolicyRule(row.id, row.revision) };
    },
    toStored: (value) => ({ responseStatus: 200, responseBody: { rule: value.rule } }),
    fromStored: (record) => {
      const body = record.responseBody as { rule: PolicyRuleView };
      return {
        rule: body.rule,
        etag: etagForPolicyRule(body.rule.id, body.rule.revision),
      };
    },
  });
  return {
    rule: outcome.value.rule,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}

async function executePolicyStatus(
  command: ControlPlaneCommand,
  action: 'policy_rule.activated' | 'policy_rule.deactivated' | 'policy_rule.archived',
  input: PolicyStatusInput,
  dependencies: PolicyDependencies,
  transition: (
    context: TenantTransactionContext,
    current: PolicyRuleRecord,
    now: Temporal.Instant,
  ) => Promise<PolicyRuleRecord | null>,
): Promise<PolicyResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const expected = parseResourceIfMatch(input.ifMatch, { kind: 'policy', id: input.ruleId });
  const now = dependencies.clock.now();
  const fingerprint = fingerprintControlPlane(command, [
    input.ruleId,
    expected.revision.toString(10),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command,
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(input.principal.tenantId, input.principal.accountId, command, key),
    execute: async (context) => {
      const current = await dependencies.policies.loadForUpdate(context, input.ruleId);
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('policy_rule_not_found', 'Policy rule not found.');
      }
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'policy.manage',
        current.organizationId,
        now,
        'policy_rule_not_found',
      );
      if (BigInt(current.revision) !== expected.revision) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The policy rule has changed since this client last read it.',
        );
      }
      if (current.archivedAt !== null) {
        throw new ControlPlaneError('policy_rule_archived', 'The policy rule is archived.');
      }
      const row = await transition(context, current, now);
      if (row === null) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The policy rule has changed since this client last read it.',
        );
      }
      await appendPolicyAudit(
        dependencies,
        context,
        input.principal,
        row,
        action,
        input.requestId,
        now,
      );
      await appendPolicyOutbox(dependencies, context, row, action, now);
      const rule = toPolicyRuleView(row);
      return { rule, etag: etagForPolicyRule(row.id, row.revision) };
    },
    toStored: (value) => ({ responseStatus: 200, responseBody: { rule: value.rule } }),
    fromStored: (record) => {
      const body = record.responseBody as { rule: PolicyRuleView };
      return {
        rule: body.rule,
        etag: etagForPolicyRule(body.rule.id, body.rule.revision),
      };
    },
  });
  return {
    rule: outcome.value.rule,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}

/**
 * POST /policy-rules/:id/activate — revalidates with the current canonical
 * parser, refuses archived rules, invalid scopes, and invalid intervals,
 * then enables at a new revision.
 */
export async function activatePolicyRule(
  input: PolicyStatusInput,
  dependencies: PolicyDependencies,
): Promise<PolicyResult> {
  return executePolicyStatus(
    'policy.activate:v1',
    'policy_rule.activated',
    input,
    dependencies,
    async (context, current, now) => {
      const parsed = parsePolicyRuleConfiguration(current.ruleType, current.configuration);
      if (!parsed.valid) {
        throw new ControlPlaneError(
          'policy_rule_invalid',
          `Invalid policy configuration: ${parsed.reason}.`,
        );
      }
      await assertScopeValid(
        context,
        dependencies,
        current.organizationId,
        input.principal.tenantId,
        {
          name: current.name,
          ruleType: current.ruleType,
          scopeKind: current.scopeKind,
          scopeOrganizationId: current.scopeOrganizationId,
          scopeSectionId: current.scopeSectionId,
          scopeDestinationId: current.scopeDestinationId,
          priority: current.priority,
          configuration: current.configuration,
          overrideMode: current.overrideMode,
          validFrom: current.validFrom,
          validUntil: current.validUntil,
        },
      );
      if (
        current.validFrom !== null &&
        current.validUntil !== null &&
        Temporal.Instant.compare(current.validUntil, current.validFrom) <= 0
      ) {
        throw new ControlPlaneError('policy_rule_invalid', 'Invalid validity interval.');
      }
      return dependencies.policies.setEnabledToRevision(
        context,
        current.id,
        current.revision,
        true,
        now,
      );
    },
  );
}

/** POST /policy-rules/:id/deactivate — enabled=false at a new revision. */
export async function deactivatePolicyRule(
  input: PolicyStatusInput,
  dependencies: PolicyDependencies,
): Promise<PolicyResult> {
  return executePolicyStatus(
    'policy.deactivate:v1',
    'policy_rule.deactivated',
    input,
    dependencies,
    async (context, current, now) =>
      dependencies.policies.setEnabledToRevision(context, current.id, current.revision, false, now),
  );
}

/**
 * POST /policy-rules/:id/archive — atomically enabled=false,
 * archived_at=now, revision+=1. Reactivation afterwards is refused; there is
 * no delete, so equivalent policy later means a new rule.
 */
export async function archivePolicyRule(
  input: PolicyStatusInput,
  dependencies: PolicyDependencies,
): Promise<PolicyResult> {
  return executePolicyStatus(
    'policy.archive:v1',
    'policy_rule.archived',
    input,
    dependencies,
    async (context, current, now) =>
      dependencies.policies.archiveToRevision(context, current.id, current.revision, now),
  );
}
