import { SystemClock } from '@openhall/domain';
import {
  ExpectedPlacementResolver,
  RelationshipAuthorizationService,
  UserContextService,
} from '@openhall/application';
import {
  PostgresAuthorizationRepository,
  PostgresExpectedPlacementRepository,
  PostgresTenantTransactionRunner,
  type DB as Database,
} from '@openhall/db';
import type { Kysely } from 'kysely';

export interface AuthorizationDependencies {
  readonly authorization: RelationshipAuthorizationService;
  readonly userContext: UserContextService;
}

/**
 * Separate authorization dependency bundle. Reuses the shared database
 * handle/runner infrastructure; OIDC secrets and session crypto stay in the
 * Phase 3 AuthDependencies bundle.
 */
export function createAuthorizationDependencies(
  database: Kysely<Database>,
  tenantRunner?: PostgresTenantTransactionRunner,
): AuthorizationDependencies {
  const runner = tenantRunner ?? new PostgresTenantTransactionRunner(database);
  const facts = new PostgresAuthorizationRepository();
  const authorization = new RelationshipAuthorizationService(facts, runner);
  const placement = new ExpectedPlacementResolver(
    new PostgresExpectedPlacementRepository(database),
  );
  const userContext = new UserContextService({
    authorization,
    facts,
    placement,
    clock: new SystemClock(),
    runner,
  });
  return { authorization, userContext };
}
