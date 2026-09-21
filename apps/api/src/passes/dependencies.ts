import { SystemClock } from '@openhall/domain';
import {
  ExpectedPlacementResolver,
  RelationshipAuthorizationService,
  cancelSelfPass,
  getActiveSelfPass,
  listPendingApprovals,
  listPendingOverrides,
  requestSelfPass,
  requestStudentPass,
  resolvePassApproval,
  requestPassOverride,
  resolvePassOverride,
  type ActivePassDependencies,
  type ApprovalCommandDependencies,
  type CancelPassDependencies,
  type OverrideCommandDependencies,
  type RequestPassDependencies,
} from '@openhall/application';
import {
  PostgresAuditWriter,
  PostgresAuthorizationRepository,
  PostgresExpectedPlacementRepository,
  PostgresIdempotencyRepository,
  PostgresOutboxWriter,
  PostgresPassRepository,
  PostgresPolicyRepository,
  PostgresTenantTransactionRunner,
  type DB as Database,
} from '@openhall/db';
import type { Kysely } from 'kysely';

export interface PassDependencies {
  readonly request: RequestPassDependencies;
  readonly cancel: CancelPassDependencies;
  readonly active: ActivePassDependencies;
  readonly approvals: ApprovalCommandDependencies;
  readonly overrides: OverrideCommandDependencies;
}

/**
 * Composition root for pass commands. Reuses the shared database
 * handle/runner infrastructure; routes never touch Kysely directly.
 */
export function createPassDependencies(database: Kysely<Database>): PassDependencies {
  const clock = new SystemClock();
  const runner = new PostgresTenantTransactionRunner(database);
  const facts = new PostgresAuthorizationRepository();
  const authorization = new RelationshipAuthorizationService(facts, runner);
  const placement = new ExpectedPlacementResolver(
    new PostgresExpectedPlacementRepository(database),
  );
  const passes = new PostgresPassRepository();
  const policy = new PostgresPolicyRepository();
  const idempotency = new PostgresIdempotencyRepository();
  const audit = new PostgresAuditWriter();
  const outbox = new PostgresOutboxWriter();
  const request: RequestPassDependencies = {
    clock,
    runner,
    authorization,
    facts,
    placement,
    passes,
    policy,
    idempotency,
    audit,
    outbox,
  };
  return {
    request,
    cancel: { clock, runner, passes, policy, idempotency, audit, outbox },
    active: { runner, passes, policy },
    approvals: {
      clock,
      runner,
      authorization,
      facts,
      placement,
      passes,
      policy,
      idempotency,
      audit,
      outbox,
    },
    overrides: {
      clock,
      runner,
      authorization,
      facts,
      placement,
      passes,
      policy,
      idempotency,
      audit,
      outbox,
    },
  };
}

export {
  cancelSelfPass,
  getActiveSelfPass,
  listPendingApprovals,
  listPendingOverrides,
  requestPassOverride,
  requestSelfPass,
  requestStudentPass,
  resolvePassApproval,
  resolvePassOverride,
};
