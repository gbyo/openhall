import { SystemClock } from '@openhall/domain';
import type {
  AuditDependencies,
  CredentialDigester,
  EnrollmentDependencies,
  GrantDependencies,
  IdentityDirectory,
  PeopleDependencies,
  PolicyDependencies,
  RequestPassDependencies,
  RoomCategoryDependencies,
  RoomDependencies,
  ScheduledDependencies,
  ScheduleDependencies,
  SecureRandomSource,
} from '@openhall/application';
import {
  PostgresAuditRepository,
  PostgresAuditWriter,
  PostgresAuthorizationRepository,
  PostgresEnrollmentRepository,
  PostgresGrantAdminRepository,
  PostgresIdempotencyRepository,
  PostgresOutboxWriter,
  PostgresPeopleRepository,
  PostgresPolicyAdminRepository,
  PostgresRoomCategoryRepository,
  PostgresRoomFlowRepository,
  PostgresRoomRepository,
  PostgresScheduleAdminRepository,
  PostgresScheduledAuthRepository,
  PostgresTenantTransactionRunner,
} from '@openhall/db';
import { RelationshipAuthorizationService } from '@openhall/application';
import type { Kysely } from 'kysely';
import type { DB as Database } from '@openhall/db';

export interface ControlPlaneDependencies {
  readonly rooms: RoomDependencies;
  readonly roomCategories: RoomCategoryDependencies;
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
  const roomCategoriesRepo = new PostgresRoomCategoryRepository();
  const facts = new PostgresAuthorizationRepository();
  const authorization = new RelationshipAuthorizationService(facts, runner);
  const roomsRepo = new PostgresRoomRepository();
  const schedulesRepo = new PostgresScheduleAdminRepository();
  const peopleRepo = new PostgresPeopleRepository();
  const flow = new PostgresRoomFlowRepository(database);
  const idempotency = new PostgresIdempotencyRepository();
  const audit = new PostgresAuditWriter();
  const outbox = new PostgresOutboxWriter();
  return {
    rooms: {
      clock,
      runner,
      authorization,
      rooms: roomsRepo,
      categories: roomCategoriesRepo,
      flow,
      idempotency,
      audit,
      outbox,
    },
    roomCategories: {
      clock,
      runner,
      authorization,
      categories: roomCategoriesRepo,
      idempotency,
      audit,
      outbox,
    },
    schedules: {
      clock,
      runner,
      authorization,
      schedules: schedulesRepo,
      rooms: roomsRepo,
      idempotency,
      audit,
      outbox,
    },
    policies: {
      clock,
      runner,
      authorization,
      policies: new PostgresPolicyAdminRepository(),
      rooms: roomsRepo,
      categories: roomCategoriesRepo,
      idempotency,
      audit,
      outbox,
    },
    grants: {
      clock,
      runner,
      authorization,
      grants: new PostgresGrantAdminRepository(),
      rooms: roomsRepo,
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
