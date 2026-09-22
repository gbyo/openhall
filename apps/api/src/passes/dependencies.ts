import { SystemClock } from '@openhall/domain';
import {
  DestinationFlowReconciler,
  ExpectedPlacementResolver,
  RelationshipAuthorizationService,
  cancelSelfPass,
  completeSelfPass,
  departSelfPass,
  departStudentPass,
  getActiveSelfPass,
  getOwnQueueStatus,
  getStationView,
  listSchoolLivePasses,
  listSectionLivePasses,
  listSectionStudents,
  arriveSelfPass,
  listPendingApprovals,
  listPendingOverrides,
  requestSelfPass,
  requestStudentPass,
  resolvePassApproval,
  requestPassOverride,
  resolvePassOverride,
  returnSelfPass,
  stationBeginReturnPass,
  stationCheckInPass,
  stationCompletePass,
  type ActivePassDependencies,
  type ApprovalCommandDependencies,
  type CancelPassDependencies,
  type DepartPassDependencies,
  type FlowReadDependencies,
  type OverrideCommandDependencies,
  type OperationalReadDependencies,
  type ProgressPassDependencies,
  type RequestPassDependencies,
} from '@openhall/application';
import {
  PostgresAuditWriter,
  PostgresAuthorizationRepository,
  PostgresRoomFlowRepository,
  PostgresExpectedPlacementRepository,
  PostgresIdempotencyRepository,
  PostgresOutboxWriter,
  PostgresOperationalReadRepository,
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
  readonly depart: DepartPassDependencies;
  readonly progress: ProgressPassDependencies;
  readonly reads: FlowReadDependencies;
  readonly operations: OperationalReadDependencies;
  readonly reconciler: DestinationFlowReconciler;
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
  const flow = new PostgresRoomFlowRepository(database);
  const policy = new PostgresPolicyRepository();
  const idempotency = new PostgresIdempotencyRepository();
  const audit = new PostgresAuditWriter();
  const outbox = new PostgresOutboxWriter();
  const operations = new PostgresOperationalReadRepository();
  const request: RequestPassDependencies = {
    clock,
    runner,
    authorization,
    facts,
    placement,
    passes,
    flow,
    policy,
    idempotency,
    audit,
    outbox,
  };
  return {
    request,
    cancel: { clock, runner, passes, flow, policy, idempotency, audit, outbox },
    active: { runner, passes, flow, policy },
    approvals: {
      clock,
      runner,
      authorization,
      facts,
      placement,
      passes,
      flow,
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
      flow,
      policy,
      idempotency,
      audit,
      outbox,
    },
    depart: {
      clock,
      runner,
      authorization,
      placement,
      passes,
      flow,
      policy,
      idempotency,
      audit,
      outbox,
    },
    progress: {
      clock,
      runner,
      authorization,
      passes,
      flow,
      policy,
      idempotency,
      audit,
      outbox,
    },
    reads: { clock, runner, passes, flow, authorization },
    operations: { clock, runner, authorization, operations },
    reconciler: new DestinationFlowReconciler({
      clock,
      runner,
      passes,
      flow,
      policy,
      placement,
      outbox,
    }),
  };
}

export {
  arriveSelfPass,
  cancelSelfPass,
  completeSelfPass,
  departSelfPass,
  departStudentPass,
  getActiveSelfPass,
  getOwnQueueStatus,
  getStationView,
  listSchoolLivePasses,
  listSectionLivePasses,
  listSectionStudents,
  listPendingApprovals,
  listPendingOverrides,
  requestPassOverride,
  requestSelfPass,
  requestStudentPass,
  resolvePassApproval,
  resolvePassOverride,
  returnSelfPass,
  stationBeginReturnPass,
  stationCheckInPass,
  stationCompletePass,
};
