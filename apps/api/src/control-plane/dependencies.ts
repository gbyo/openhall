import { SystemClock } from '@openhall/domain';
import type {
  AuditDependencies,
  CredentialDigester,
  DestinationCategoryDependencies,
  DestinationDependencies,
  EnrollmentDependencies,
  GrantDependencies,
  IdentityDirectory,
  LocationDependencies,
  PeopleDependencies,
  PlaceDependencies,
  PolicyDependencies,
  RequestPassDependencies,
  ScheduledDependencies,
  ScheduleDependencies,
  SecureRandomSource,
} from '@openhall/application';
import {
  PostgresAuditRepository,
  PostgresAuditWriter,
  PostgresAuthorizationRepository,
  PostgresDestinationCategoryRepository,
  PostgresDestinationRepository,
  PostgresDestinationFlowRepository,
  PostgresEnrollmentRepository,
  PostgresGrantAdminRepository,
  PostgresIdempotencyRepository,
  PostgresLocationRepository,
  PostgresOutboxWriter,
  PostgresPlacesRepository,
  PostgresPeopleRepository,
  PostgresPolicyAdminRepository,
  PostgresScheduleAdminRepository,
  PostgresScheduledAuthRepository,
  PostgresTenantTransactionRunner,
} from '@openhall/db';
import { RelationshipAuthorizationService } from '@openhall/application';
import type { Kysely } from 'kysely';
import type { DB as Database } from '@openhall/db';

export interface ControlPlaneDependencies {
  readonly locations: LocationDependencies;
  readonly destinations: DestinationDependencies;
  readonly destinationCategories: DestinationCategoryDependencies;
  readonly places: PlaceDependencies;
  readonly schedules: ScheduleDependencies;
  readonly policies: PolicyDependencies;
  readonly grants: GrantDependencies;
  readonly people: PeopleDependencies;
  readonly enrollment: EnrollmentDependencies;
  readonly scheduled: ScheduledDependencies;
  readonly audit: AuditDependencies;
}

/**
 * Composition root for school control-plane commands. Reuses the shared
 * database handle/runner infrastructure plus the authentication singletons
 * (directory, randomness, digests); routes never touch Kysely directly.
 */
export function createControlPlaneDependencies(
  database: Kysely<Database>,
  shared: {
    readonly directory: IdentityDirectory;
    readonly random: SecureRandomSource;
    readonly digester: CredentialDigester;
    readonly requestPass: RequestPassDependencies;
  },
): ControlPlaneDependencies {
  const clock = new SystemClock();
  const runner = new PostgresTenantTransactionRunner(database);
  const destinationCategoriesRepo = new PostgresDestinationCategoryRepository();
  const facts = new PostgresAuthorizationRepository();
  const authorization = new RelationshipAuthorizationService(facts, runner);
  const locationsRepo = new PostgresLocationRepository();
  const destinationsRepo = new PostgresDestinationRepository();
  const placesRepo = new PostgresPlacesRepository();
  const schedulesRepo = new PostgresScheduleAdminRepository();
  const peopleRepo = new PostgresPeopleRepository();
  const flow = new PostgresDestinationFlowRepository(database);
  const idempotency = new PostgresIdempotencyRepository();
  const audit = new PostgresAuditWriter();
  const outbox = new PostgresOutboxWriter();
  return {
    locations: {
      clock,
      runner,
      authorization,
      locations: locationsRepo,
      idempotency,
      audit,
      outbox,
    },
    destinations: {
      clock,
      runner,
      authorization,
      destinations: destinationsRepo,
      categories: destinationCategoriesRepo,
      locations: locationsRepo,
      places: placesRepo,
      flow,
      idempotency,
      audit,
      outbox,
    },
    places: {
      clock,
      runner,
      authorization,
      locations: locationsRepo,
      destinations: destinationsRepo,
      categories: destinationCategoriesRepo,
      places: placesRepo,
      idempotency,
      audit,
      outbox,
    },
    destinationCategories: {
      clock,
      runner,
      authorization,
      categories: destinationCategoriesRepo,
      idempotency,
      audit,
      outbox,
    },
    schedules: {
      clock,
      runner,
      authorization,
      schedules: schedulesRepo,
      locations: locationsRepo,
      idempotency,
      audit,
      outbox,
    },
    policies: {
      clock,
      runner,
      authorization,
      policies: new PostgresPolicyAdminRepository(),
      destinations: destinationsRepo,
      idempotency,
      audit,
      outbox,
    },
    grants: {
      clock,
      runner,
      authorization,
      grants: new PostgresGrantAdminRepository(),
      destinations: destinationsRepo,
      idempotency,
      audit,
      outbox,
    },
    people: {
      clock,
      runner,
      authorization,
      people: peopleRepo,
    },
    enrollment: {
      clock,
      runner,
      authorization,
      enrollments: new PostgresEnrollmentRepository(database),
      directory: shared.directory,
      random: shared.random,
      digester: shared.digester,
      idempotency,
      audit,
      outbox,
    },
    scheduled: {
      requestPass: shared.requestPass,
      scheduled: new PostgresScheduledAuthRepository(),
      people: peopleRepo,
      idempotency,
    },
    audit: {
      clock,
      runner,
      authorization,
      audit: new PostgresAuditRepository(),
    },
  };
}
