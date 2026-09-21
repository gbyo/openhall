import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { createRequestedPass } from '@openhall/domain';
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
import type { ExpectedPlacementResolver, ExpectedPlacementResult } from '../scheduling/index.js';
import { PassApplicationError } from './errors.js';
import {
  advisoryLockKey,
  fingerprintSelfRequest,
  fingerprintStaffRequest,
  requireIdempotencyKey,
} from './idempotency.js';
import type { PassRepository, PassRow } from './ports.js';
import { etagForPass, placementKindFromRow, type PassRepresentation } from './representations.js';

export interface RequestPassDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly facts: AuthorizationFactsRepository;
  readonly placement: ExpectedPlacementResolver;
  readonly passes: PassRepository;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  /** Injected for testability; defaults to randomUUID. */
  readonly generatePassId?: () => string;
}

export interface RequestPassInput {
  readonly principal: Principal;
  readonly destinationId: string;
  readonly idempotencyKey: unknown;
  readonly requestId: string;
}

export interface RequestStudentPassInput extends RequestPassInput {
  readonly studentId: string;
}

export interface RequestPassResult {
  readonly pass: PassRepresentation;
  readonly etag: string;
  readonly status: 201;
  readonly replayed: boolean;
}

function toRepresentation(row: PassRow, placementKind: string): PassRepresentation {
  return {
    id: row.id,
    organizationId: row.organizationId,
    studentId: row.studentId,
    destination: {
      id: row.destinationId,
      displayName: row.destinationDisplayName,
      serviceType: row.destinationServiceType,
    },
    origin: {
      placementKind,
      block: row.originBlock,
      section: row.originSection,
      location: row.originLocation,
    },
    requestSource: row.requestSource,
    requestedAt: row.requestedAt.toString(),
    lifecycleState: row.lifecycleState,
    revision: row.revision.toString(10),
  };
}

interface OriginSnapshot {
  readonly blockId: string | null;
  readonly sectionId: string | null;
  readonly locationId: string | null;
  readonly kind: string;
}

function snapshotPlacement(placement: ExpectedPlacementResult): OriginSnapshot {
  switch (placement.kind) {
    case 'resolved':
      return {
        kind: 'resolved',
        blockId: placement.block.id,
        sectionId: placement.section.id,
        locationId: placement.expectedLocation?.id ?? null,
      };
    case 'block_only':
      return { kind: 'block_only', blockId: placement.block.id, sectionId: null, locationId: null };
    default:
      return { kind: placement.kind, blockId: null, sectionId: null, locationId: null };
  }
}

function requestedEventMetadata(input: {
  placement: ExpectedPlacementResult;
  snapshot: OriginSnapshot;
  destinationId: string;
}): Readonly<Record<string, unknown>> {
  const { placement, snapshot, destinationId } = input;
  const origin: Record<string, unknown> = { kind: snapshot.kind };
  if (placement.kind === 'resolved') {
    origin.blockId = snapshot.blockId;
    if (snapshot.sectionId !== null) origin.sectionId = snapshot.sectionId;
    if (snapshot.locationId !== null) origin.locationId = snapshot.locationId;
    origin.slotBeginsAt = placement.beginsAt.toString();
    origin.slotEndsAt = placement.endsAt.toString();
  } else if (placement.kind === 'block_only') {
    origin.blockId = snapshot.blockId;
  } else if (placement.kind === 'ambiguous') {
    origin.reason = placement.reason;
  } else if (placement.kind === 'configuration_error') {
    origin.code = placement.code;
  } else if (placement.kind === 'non_instructional_day') {
    origin.dayKind = placement.dayKind;
  }
  return {
    schemaVersion: 1,
    state: 'requested',
    revision: '1',
    origin,
    destinationId,
  };
}

function isActiveUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('pass_one_active_per_student');
}

function denyToPassError(reason: string): PassApplicationError {
  if (reason === 'recovery_session_restricted') {
    return new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot request passes.',
    );
  }
  return new PassApplicationError('forbidden', 'Forbidden.');
}

async function executeRequest(
  input: {
    principal: Principal;
    targetStudentId: string;
    destinationId: string;
    requestSource: 'student_web' | 'staff_web';
    command: 'pass.request.self:v1' | 'pass.request.student:v1';
    fingerprint: string;
    key: string;
    requestId: string;
    now: Temporal.Instant;
    placement: ExpectedPlacementResult;
    schoolId: string;
    authorizeSelf: boolean;
  },
  dependencies: RequestPassDependencies,
): Promise<RequestPassResult> {
  const {
    principal,
    targetStudentId,
    destinationId,
    requestSource,
    command,
    fingerprint,
    key,
    requestId,
    now,
    placement,
    schoolId,
    authorizeSelf,
  } = input;
  const { authorization, passes, idempotency, audit, outbox, runner } = dependencies;
  const generatePassId = dependencies.generatePassId ?? randomUUID;

  const outcome = await runIdempotentCommand(runner, idempotency, now, {
    identity: {
      tenantId: principal.tenantId,
      actorAccountId: principal.accountId,
      command,
      key,
      fingerprint,
    },
    lockKey: advisoryLockKey(principal.tenantId, principal.accountId, command, key),
    execute: async (context: TenantTransactionContext) => {
      const destination = await passes.loadDestination(context, destinationId);
      if (destination?.tenantId !== principal.tenantId) {
        throw new PassApplicationError('destination_not_found', 'Destination not found.');
      }
      if (destination.organizationId !== schoolId) {
        throw new PassApplicationError('destination_not_found', 'Destination not found.');
      }
      if (destination.status === 'archived') {
        throw new PassApplicationError('destination_not_found', 'Destination not found.');
      }
      if (destination.status !== 'active') {
        throw new PassApplicationError(
          'destination_unavailable',
          'Destination is not requestable.',
        );
      }
      const school = await dependencies.facts.loadOrganization(context, schoolId);
      if (school?.kind !== 'school' || school.status !== 'active') {
        throw new PassApplicationError('destination_not_found', 'Destination not found.');
      }
      const timeZone = school.timeZone ?? 'UTC';
      let schoolDate: Temporal.PlainDate;
      try {
        schoolDate = now.toZonedDateTimeISO(timeZone).toPlainDate();
      } catch {
        throw new PassApplicationError('destination_not_found', 'Destination not found.');
      }
      // Staff callers authorize before the student lookup so unauthorized
      // callers cannot distinguish missing students from active ones.
      const authorizeStaff = async (): Promise<void> => {
        const orgDecision = await authorization.decideWithContext(context, {
          principal,
          capability: 'pass.create.student',
          resource: { kind: 'student', organizationId: schoolId, studentId: targetStudentId },
          at: now,
        });
        if (!orgDecision.allowed) {
          if (orgDecision.reason === 'recovery_session_restricted') {
            throw denyToPassError(orgDecision.reason);
          }
          if (placement.kind === 'resolved') {
            const sectionDecision = await authorization.decideWithContext(context, {
              principal,
              capability: 'pass.create.student',
              resource: {
                kind: 'student_in_section',
                sectionId: placement.section.id,
                studentId: targetStudentId,
              },
              at: now,
            });
            if (!sectionDecision.allowed) throw denyToPassError(sectionDecision.reason);
          } else {
            throw denyToPassError(orgDecision.reason);
          }
        }
      };
      if (!authorizeSelf) {
        await authorizeStaff();
      }
      const active = await passes.loadActiveStudent(context, schoolId, targetStudentId, schoolDate);
      if (active === null) {
        if (authorizeSelf) {
          // Conceal cross-school destinations: a requester with no active
          // membership in the destination's school learns nothing about
          // which destinations exist there.
          const memberships = await dependencies.facts.listPersonMemberships(
            context,
            targetStudentId,
          );
          const present = memberships.some(
            (membership) =>
              membership.organizationId === schoolId &&
              membership.status === 'active' &&
              (membership.validFrom === null ||
                Temporal.PlainDate.compare(membership.validFrom, schoolDate) <= 0) &&
              (membership.validUntil === null ||
                Temporal.PlainDate.compare(schoolDate, membership.validUntil) <= 0),
          );
          if (!present) {
            throw new PassApplicationError('destination_not_found', 'Destination not found.');
          }
        }
        throw new PassApplicationError('student_not_found', 'Student not found.');
      }
      if (authorizeSelf) {
        const decision = await authorization.decideWithContext(context, {
          principal,
          capability: 'pass.request.self',
          resource: { kind: 'student', organizationId: schoolId, studentId: targetStudentId },
          at: now,
        });
        if (!decision.allowed) throw denyToPassError(decision.reason);
      }
      const snapshot = snapshotPlacement(placement);
      const aggregate = createRequestedPass({
        id: generatePassId(),
        tenantId: principal.tenantId,
        organizationId: schoolId,
        studentId: targetStudentId,
        originLocationId: snapshot.locationId,
        originSectionId: snapshot.sectionId,
        originScheduleBlockId: snapshot.blockId,
        destinationId,
        requestSource,
        requestedByPersonId: principal.personId,
        requestedAt: now,
      });
      let row: PassRow;
      try {
        row = await passes.insertRequestedPass(context, {
          id: aggregate.id,
          organizationId: aggregate.organizationId,
          studentId: aggregate.studentId,
          originLocationId: aggregate.originLocationId,
          originSectionId: aggregate.originSectionId,
          originScheduleBlockId: aggregate.originScheduleBlockId,
          destinationId: aggregate.destinationId,
          requestSource,
          requestedByPersonId: principal.personId,
          requestedAt: now,
        });
      } catch (error) {
        if (isActiveUniqueViolation(error)) {
          throw new PassApplicationError(
            'active_pass_exists',
            'An active pass already exists for this student.',
          );
        }
        throw error;
      }
      const metadata = requestedEventMetadata({ placement, snapshot, destinationId });
      await passes.appendPassEvent(context, {
        passId: row.id,
        sequence: 1n,
        eventType: 'pass.requested',
        actorPersonId: principal.personId,
        occurredAt: now,
        metadata,
      });
      await audit.append(context, {
        action: 'pass.requested',
        actorKind: 'account',
        actorId: principal.accountId,
        organizationId: schoolId,
        targetKind: 'pass',
        targetId: row.id,
        outcome: 'success',
        occurredAt: now,
        requestId,
        metadata: {
          passId: row.id,
          organizationId: schoolId,
          studentId: targetStudentId,
          requestSource,
          revision: '1',
          requestId,
        },
      });
      await outbox.append(context, {
        tenantId: principal.tenantId,
        organizationId: schoolId,
        aggregateKind: 'pass',
        aggregateId: row.id,
        eventType: 'pass.requested',
        occurredAt: now.toString(),
        payload: {
          schemaVersion: 1,
          passId: row.id,
          organizationId: schoolId,
          studentId: targetStudentId,
          lifecycleState: 'requested',
          revision: '1',
          destinationId,
        },
      });
      // Derive the placement kind from the stored row, exactly as later
      // reads do, so the create response matches subsequent GETs. The
      // detailed snapshot stays in the pass.requested event metadata.
      const representation = toRepresentation(row, placementKindFromRow(row));
      return {
        representation,
        etag: etagForPass(row.id, row.revision),
      };
    },
    toStored: (value) => ({
      responseStatus: 201,
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
    status: 201,
    replayed: outcome.replayed,
  };
}

async function loadSchoolForDestination(
  dependencies: RequestPassDependencies,
  principal: Principal,
  destinationId: string,
): Promise<string> {
  const schoolId = await dependencies.runner.run(principal.tenantId, async (context) => {
    const destination = await dependencies.passes.loadDestination(context, destinationId);
    if (destination?.tenantId !== principal.tenantId) {
      throw new PassApplicationError('destination_not_found', 'Destination not found.');
    }
    if (destination.status === 'archived') {
      throw new PassApplicationError('destination_not_found', 'Destination not found.');
    }
    return destination.organizationId;
  });
  return schoolId;
}

/**
 * POST /api/v1/me/passes — target student and source are server-derived.
 * Recovery sessions are rejected through Phase 4 authorization.
 */
export async function requestSelfPass(
  input: RequestPassInput,
  dependencies: RequestPassDependencies,
): Promise<RequestPassResult> {
  if (input.principal.authenticationMethod === 'recovery') {
    throw new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot request passes.',
    );
  }
  const key = requireIdempotencyKey(input.idempotencyKey);
  const now = dependencies.clock.now();
  const schoolId = await loadSchoolForDestination(
    dependencies,
    input.principal,
    input.destinationId,
  );
  const placement = await dependencies.placement.resolve({
    tenantId: input.principal.tenantId,
    organizationId: schoolId,
    personId: input.principal.personId,
    at: now,
  });
  return executeRequest(
    {
      principal: input.principal,
      targetStudentId: input.principal.personId,
      destinationId: input.destinationId,
      requestSource: 'student_web',
      command: 'pass.request.self:v1',
      fingerprint: fingerprintSelfRequest(input.destinationId),
      key,
      requestId: input.requestId,
      now,
      placement,
      schoolId,
      authorizeSelf: true,
    },
    dependencies,
  );
}

/**
 * POST /api/v1/students/:studentId/passes — staff path with org-level
 * authority plus teacher fallback against the resolved current section.
 */
export async function requestStudentPass(
  input: RequestStudentPassInput,
  dependencies: RequestPassDependencies,
): Promise<RequestPassResult> {
  if (input.principal.authenticationMethod === 'recovery') {
    throw new PassApplicationError(
      'recovery_session_restricted',
      'Recovery sessions cannot request passes.',
    );
  }
  const key = requireIdempotencyKey(input.idempotencyKey);
  const now = dependencies.clock.now();
  const schoolId = await loadSchoolForDestination(
    dependencies,
    input.principal,
    input.destinationId,
  );
  const placement = await dependencies.placement.resolve({
    tenantId: input.principal.tenantId,
    organizationId: schoolId,
    personId: input.studentId,
    at: now,
  });
  return executeRequest(
    {
      principal: input.principal,
      targetStudentId: input.studentId,
      destinationId: input.destinationId,
      requestSource: 'staff_web',
      command: 'pass.request.student:v1',
      fingerprint: fingerprintStaffRequest(input.studentId, input.destinationId),
      key,
      requestId: input.requestId,
      now,
      placement,
      schoolId,
      authorizeSelf: false,
    },
    dependencies,
  );
}
