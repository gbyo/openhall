import type { Temporal } from '@js-temporal/polyfill';
import type { Clock } from '@openhall/domain';
import type { Principal } from '../authentication/principal.js';
import type { AuditWriter } from '../auditing/audit.js';
import type {
  AuthorizationFactsRepository,
  RelationshipAuthorizationService,
} from '../authorization/index.js';
import type { IdempotencyTransactionStore } from '../idempotency/coordinator.js';
import { runIdempotentCommand } from '../idempotency/coordinator.js';
import type {
  OutboxWriter,
  TenantTransactionContext,
  TenantTransactionRunner,
} from '../persistence.js';
import type { ExpectedPlacementResolver } from '../scheduling/index.js';
import { PassApplicationError } from './errors.js';
import {
  advisoryLockKey,
  fingerprintApprovalResolve,
  requireIdempotencyKey,
} from './idempotency.js';
import type { PassRepository } from './ports.js';
import type { DestinationFlowRepository } from '../destination-flow/ports.js';
import { loadMovementForRow } from '../destination-flow/projections.js';
import type { PendingApprovalView, PolicyRepository } from '../policy/index.js';
import {
  etagForPass,
  parseAnyIfMatch,
  toPassRepresentation,
  type PassRepresentation,
} from './representations.js';
import { reevaluatePersistAndApply } from './workflow.js';

export interface ApprovalCommandDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly facts: AuthorizationFactsRepository;
  readonly placement: ExpectedPlacementResolver;
  readonly passes: PassRepository;
  readonly flow: DestinationFlowRepository;
  readonly policy: PolicyRepository;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

export interface ResolveApprovalInput {
  readonly principal: Principal;
  readonly approvalId: string;
  readonly decision: 'approved' | 'denied';
  readonly idempotencyKey: unknown;
  /** Raw If-Match header value; exact strong pass ETag required. */
  readonly ifMatch: unknown;
  readonly requestId: string;
}

export interface ResolveApprovalResult {
  readonly pass: PassRepresentation;
  readonly etag: string;
  readonly status: 200;
  readonly replayed: boolean;
}

function concealAuthDenial(reason: string): PassApplicationError {
  if (reason === 'recovery_session_restricted') {
    return new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot resolve approvals.',
    );
  }
  return new PassApplicationError('approval_not_found', 'Approval not found.');
}

/**
 * POST /api/v1/pass-approvals/:approvalId/approve|deny — resolves one exact
 * standard approval requirement, then reevaluates current movement policy.
 * The approval ID identifies the workflow requirement; pass, student,
 * school, section, and rule revision are server-derived.
 */
export async function resolvePassApproval(
  input: ResolveApprovalInput,
  dependencies: ApprovalCommandDependencies,
): Promise<ResolveApprovalResult> {
  const key = requireIdempotencyKey(input.idempotencyKey);
  const parsedMatch = parseAnyIfMatch(input.ifMatch);
  const now = dependencies.clock.now();
  const { authorization, passes, policy, idempotency, audit, outbox, runner } = dependencies;
  const command =
    input.decision === 'approved' ? 'pass.approval.approve:v1' : 'pass.approval.deny:v1';

  // Fingerprint inputs and current placement are resolved before the mutation
  // transaction using the same command instant; the transaction revalidates
  // every canonical fact authoritatively.
  const binding = await runner.run(input.principal.tenantId, async (context) => {
    const approval = await policy.loadApprovalById(context, input.approvalId);
    if (approval === null) {
      throw new PassApplicationError('approval_not_found', 'Approval not found.');
    }
    const pass = await passes.loadPassForUpdate(context, approval.passId);
    if (pass?.tenantId !== input.principal.tenantId) {
      throw new PassApplicationError('approval_not_found', 'Approval not found.');
    }
    return { passId: pass.id, studentId: pass.studentId, schoolId: pass.organizationId };
  });
  if (parsedMatch.passId !== binding.passId) {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  const placement = await dependencies.placement.resolve({
    tenantId: input.principal.tenantId,
    organizationId: binding.schoolId,
    personId: binding.studentId,
    at: now,
  });
  const fingerprint = fingerprintApprovalResolve(
    input.approvalId,
    binding.passId,
    parsedMatch.revision,
    input.decision,
  );

  const outcome = await runIdempotentCommand(runner, idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command,
      key,
      fingerprint,
    },
    lockKey: advisoryLockKey(input.principal.tenantId, input.principal.accountId, command, key),
    execute: async (context: TenantTransactionContext) => {
      const row = await passes.loadPassForUpdate(context, binding.passId);
      if (row?.tenantId !== input.principal.tenantId) {
        throw new PassApplicationError('approval_not_found', 'Approval not found.');
      }
      const approval = await policy.lockApprovalForUpdate(context, input.approvalId);
      if (approval?.passId !== row.id) {
        throw new PassApplicationError('approval_not_found', 'Approval not found.');
      }
      if (row.revision !== parsedMatch.revision) {
        throw new PassApplicationError(
          'stale_pass_revision',
          'The pass has changed since this client last read it.',
        );
      }
      if (approval.decision !== 'pending') {
        throw new PassApplicationError(
          'invalid_approval_state',
          'This approval is no longer pending.',
        );
      }
      if (row.lifecycleState !== 'requested') {
        throw new PassApplicationError(
          'invalid_approval_state',
          'This approval is no longer actionable.',
        );
      }
      const authDecision = await authorization.decideWithContext(context, {
        principal: input.principal,
        capability: 'pass.approve.section',
        resource: {
          kind: 'student_in_section',
          sectionId: approval.requiredSectionId,
          studentId: row.studentId,
        },
        at: now,
      });
      if (!authDecision.allowed) throw concealAuthDenial(authDecision.reason);
      const resolved = await policy.resolveApproval(context, approval.id, {
        decision: input.decision,
        actorKind: 'person',
        decidedByPersonId: input.principal.personId,
        decidedAt: now,
      });
      if (resolved === null) {
        throw new PassApplicationError(
          'invalid_approval_state',
          'This approval is no longer pending.',
        );
      }
      const bumped = await passes.touchPassRevision(context, row.id, row.revision, now);
      if (bumped === null) {
        throw new PassApplicationError(
          'stale_pass_revision',
          'The pass has changed since this client last read it.',
        );
      }
      const eventType =
        input.decision === 'approved' ? 'pass.approval_granted' : 'pass.approval_denied';
      await passes.appendPassEvent(context, {
        passId: row.id,
        sequence: bumped.revision,
        eventType,
        actorKind: 'person',
        actorPersonId: input.principal.personId,
        occurredAt: now,
        metadata: {
          schemaVersion: 1,
          approvalId: approval.id,
          decision: input.decision,
          revision: bumped.revision.toString(10),
        },
      });
      await audit.append(context, {
        action: eventType,
        actorKind: 'account',
        actorId: input.principal.accountId,
        organizationId: row.organizationId,
        targetKind: 'pass',
        targetId: row.id,
        outcome: 'success',
        occurredAt: now,
        requestId: input.requestId,
        metadata: {
          passId: row.id,
          approvalId: approval.id,
          organizationId: row.organizationId,
          studentId: row.studentId,
          revision: bumped.revision.toString(10),
          requestId: input.requestId,
        },
      });
      await outbox.append(context, {
        tenantId: row.tenantId,
        organizationId: row.organizationId,
        aggregateKind: 'pass',
        aggregateId: row.id,
        eventType,
        occurredAt: now.toString(),
        payload: {
          schemaVersion: 1,
          approvalId: approval.id,
          passId: row.id,
          organizationId: row.organizationId,
          studentId: row.studentId,
          requiredSectionId: approval.requiredSectionId,
          passRevision: bumped.revision.toString(10),
        },
      });
      const tail = await reevaluatePersistAndApply(
        context,
        { passes, flow: dependencies.flow, policy, outbox },
        {
          passId: row.id,
          schoolId: row.organizationId,
          studentId: row.studentId,
          destinationId: row.destinationId,
          placement,
          at: now,
          stage: 'approval',
          workflowRow: bumped,
          requestSource: row.requestSource,
        },
      );
      const representation = toPassRepresentation(
        tail.row,
        tail.projection,
        await loadMovementForRow(context, passes, dependencies.flow, tail.row),
      );
      return {
        representation,
        etag: etagForPass(tail.row.id, tail.row.revision),
      };
    },
    toStored: (value) => ({
      responseStatus: 200,
      responseBody: { pass: value.representation },
    }),
    fromStored: (record) => {
      const body = record.responseBody as { pass: PassRepresentation };
      return {
        representation: body.pass,
        etag: etagForPass(body.pass.id, BigInt(body.pass.revision)),
      };
    },
  });
  return {
    pass: outcome.value.representation,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}

export interface PendingApprovalItem {
  readonly approvalId: string;
  readonly passId: string;
  readonly passRevision: string;
  readonly passEtag: string;
  readonly student: { readonly id: string; readonly displayName: string };
  readonly destination: {
    readonly id: string;
    readonly displayName: string;
    readonly serviceType: string;
  };
  readonly requiredSection: {
    readonly id: string;
    readonly code: string | null;
    readonly title: string;
  };
  readonly requestedAt: string;
}

function toPendingItem(view: PendingApprovalView): PendingApprovalItem {
  return {
    approvalId: view.approvalId,
    passId: view.passId,
    passRevision: view.passRevision.toString(10),
    passEtag: etagForPass(view.passId, view.passRevision),
    student: { id: view.studentId, displayName: view.studentDisplayName },
    destination: {
      id: view.destinationId,
      displayName: view.destinationDisplayName,
      serviceType: view.destinationServiceType,
    },
    requiredSection: {
      id: view.requiredSectionId,
      code: view.sectionCode,
      title: view.sectionTitle,
    },
    requestedAt: view.requestedAt.toString(),
  };
}

/**
 * GET /api/v1/me/pass-approvals/pending — pending approvals the principal
 * may legitimately resolve. Each candidate is authorized through Phase 4;
 * recovery sessions are rejected.
 */
export async function listPendingApprovals(
  principal: Principal,
  dependencies: Pick<ApprovalCommandDependencies, 'clock' | 'runner' | 'authorization' | 'policy'>,
): Promise<readonly PendingApprovalItem[]> {
  if (principal.authenticationMethod === 'recovery') {
    throw new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot resolve approvals.',
    );
  }
  const at: Temporal.Instant = dependencies.clock.now();
  const views = await dependencies.runner.run(principal.tenantId, (context) =>
    dependencies.policy.listPendingApprovalViews(context),
  );
  const items: PendingApprovalItem[] = [];
  for (const view of views) {
    const decision = await dependencies.authorization.decide({
      principal,
      capability: 'pass.approve.section',
      resource: {
        kind: 'student_in_section',
        sectionId: view.requiredSectionId,
        studentId: view.studentId,
      },
      at,
    });
    if (decision.allowed) items.push(toPendingItem(view));
  }
  return items;
}
