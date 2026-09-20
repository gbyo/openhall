import { SystemClock } from '@openhall/domain';
import {
  ExpectedPlacementResolver,
  RelationshipAuthorizationService,
  cancelSelfPass,
  getActiveSelfPass,
  requestSelfPass,
  requestStudentPass,
  type ActivePassDependencies,
  type CancelPassDependencies,
  type RequestPassDependencies,
} from '@openhall/application';
import {
  PostgresAuditWriter,
  PostgresAuthorizationRepository,
  PostgresExpectedPlacementRepository,
  PostgresIdempotencyRepository,
  PostgresOutboxWriter,
  PostgresPassRepository,
  PostgresTenantTransactionRunner,
  type DB as Database,
} from '@openhall/db';
import type { Kysely } from 'kysely';

export interface PassDependencies {
  readonly request: RequestPassDependencies;
  readonly cancel: CancelPassDependencies;
  readonly active: ActivePassDependencies;
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
    idempotency,
    audit,
    outbox,
  };
  return {
    request,
    cancel: { clock, runner, passes, idempotency, audit, outbox },
    active: { runner, passes },
  };
}

export { cancelSelfPass, getActiveSelfPass, requestSelfPass, requestStudentPass };
