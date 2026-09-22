import { Temporal } from '@js-temporal/polyfill';
import type { Principal } from '../authentication/principal.js';
import type { IdempotencyTransactionStore } from '../idempotency/coordinator.js';
import type { TenantTransactionContext, TenantTransactionRunner } from '../persistence.js';
import { createPassInTransaction, type RequestPassDependencies } from '../passes/request-pass.js';
import { fingerprintScheduledRequest } from '../passes/idempotency.js';
import { etagForPass, type PassRepresentation } from '../passes/representations.js';
import { ControlPlaneError } from './errors.js';
import { etagForResource, parseResourceIfMatch } from './etags.js';
import {
  controlPlaneLockKey,
  fingerprintControlPlane,
  requireControlPlaneIdempotencyKey,
  runControlPlaneCommand,
} from './idempotency.js';
import type {
  NewScheduledAuth,
  PeopleRepository,
  ScheduledAuthRecord,
  ScheduledAuthRepository,
} from './ports.js';
import { decodePersonCursor } from './people.js';
import { requireNormalSession, requireOrganizationCapability, schoolDateFor } from './shared.js';

export interface ScheduledDependencies {
  readonly requestPass: RequestPassDependencies;
  readonly scheduled: ScheduledAuthRepository;
  readonly people: PeopleRepository;
  readonly idempotency: IdempotencyTransactionStore;
}

export interface ScheduledAuthView {
  readonly id: string;
  readonly organizationId: string;
  readonly studentId: string;
  readonly student: {
    readonly id: string;
    readonly displayName: string;
    readonly gradeLevel: string | null;
  };
  readonly destinationRoomId: string;
  readonly destination: {
    readonly id: string;
    readonly name: string;
  };
  readonly validFrom: string;
  readonly validUntil: string;
  readonly status: string;
  readonly approvalMode: string;
  readonly originStrategy: string;
  readonly originRoomId: string | null;
  readonly originRoom: { readonly id: string; readonly name: string } | null;
  readonly revision: string;
  readonly createdByAccountId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly usedAt: string | null;
  readonly usedByAccountId: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledByAccountId: string | null;
  readonly lastAttemptAt: string | null;
}

export interface ScheduledAuthStudentView {
  readonly id: string;
  readonly organizationId: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly status: 'active' | 'used' | 'cancelled' | 'expired';
  readonly approvalMode: 'preapproved' | 'approval_required';
  readonly originStrategy: 'expected' | 'specific';
  readonly revision: string;
  readonly authorizationEtag: string;
  readonly destination: {
    readonly id: string;
    readonly name: string;
    readonly category: {
      readonly id: string;
      readonly name: string;
      readonly iconKey: string;
      readonly toneKey: string;
    } | null;
  };
  readonly originRoom: {
    readonly id: string;
    readonly name: string;
  } | null;
}

export function etagForScheduledAuth(scheduledAuthorizationId: string, revision: bigint): string {
  return etagForResource('scheduled-authorization', scheduledAuthorizationId, revision);
}

export function toScheduledAuthView(row: ScheduledAuthRecord): ScheduledAuthView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    studentId: row.studentId,
    student: {
      id: row.studentId,
      displayName: row.studentDisplayName,
      gradeLevel: row.studentGradeLevel,
    },
    destinationRoomId: row.destinationRoomId,
    destination: {
      id: row.destinationRoomId,
      name: row.destinationRoomName,
    },
    validFrom: row.validFrom.toString(),
    validUntil: row.validUntil.toString(),
    status: row.status,
    approvalMode: row.approvalMode,
    originStrategy: row.originStrategy,
    originRoomId: row.originRoomId,
    originRoom:
      row.originRoomId === null
        ? null
        : { id: row.originRoomId, name: row.originRoomName ?? 'Room' },
    revision: row.revision.toString(10),
    createdByAccountId: row.createdByAccountId,
    createdAt: row.createdAt.toString(),
    updatedAt: row.updatedAt.toString(),
    usedAt: row.usedAt === null ? null : row.usedAt.toString(),
    usedByAccountId: row.usedByAccountId,
    cancelledAt: row.cancelledAt === null ? null : row.cancelledAt.toString(),
    cancelledByAccountId: row.cancelledByAccountId,
    lastAttemptAt: row.lastAttemptAt === null ? null : row.lastAttemptAt.toString(),
  };
}

/** Appointment windows are bounded to a single school day of at most 12h. */
export const MAX_SCHEDULED_DURATION_HOURS = 12;
/** Appointments cannot start more than a year in the future. */
export const MAX_SCHEDULED_HORIZON_DAYS = 366;

function cleanInstant(value: string | null, field: string): Temporal.Instant {
  if (value === null) {
    throw new ControlPlaneError('invalid_scheduled_authorization_state', `Missing ${field}.`);
  }
  try {
    return Temporal.Instant.from(value);
  } catch {
    throw new ControlPlaneError('invalid_scheduled_authorization_state', `Invalid ${field}.`);
  }
}

export interface ScheduledAuthCreateBody {
  readonly studentId: unknown;
  readonly destinationRoomId: unknown;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly approvalMode: unknown;
  readonly originStrategy: unknown;
  readonly originRoomId: unknown;
}

interface CanonicalScheduledAuthCreate {
  readonly studentId: string;
  readonly destinationRoomId: string;
  readonly validFrom: Temporal.Instant;
  readonly validUntil: Temporal.Instant;
  readonly approvalMode: 'preapproved' | 'approval_required';
  readonly originStrategy: 'expected' | 'specific';
  readonly originRoomId: string | null;
}

function canonicalCreate(body: ScheduledAuthCreateBody): CanonicalScheduledAuthCreate {
  if (typeof body.studentId !== 'string' || body.studentId.length === 0) {
    throw new ControlPlaneError('invalid_scheduled_authorization_state', 'Invalid student.');
  }
  if (typeof body.destinationRoomId !== 'string' || body.destinationRoomId.length === 0) {
    throw new ControlPlaneError('invalid_scheduled_authorization_state', 'Invalid destination.');
  }
  if (body.approvalMode !== 'preapproved' && body.approvalMode !== 'approval_required') {
    throw new ControlPlaneError('invalid_scheduled_authorization_state', 'Invalid approval mode.');
  }
  if (body.originStrategy !== 'expected' && body.originStrategy !== 'specific') {
    throw new ControlPlaneError(
      'invalid_scheduled_authorization_state',
      'Invalid origin strategy.',
    );
  }
  let originRoomId: string | null = null;
  if (body.originStrategy === 'specific') {
    if (typeof body.originRoomId !== 'string' || body.originRoomId.length === 0) {
      throw new ControlPlaneError(
        'invalid_scheduled_authorization_state',
        'A specific origin requires a location.',
      );
    }
    originRoomId = body.originRoomId;
  } else if (body.originRoomId !== null && body.originRoomId !== undefined) {
    throw new ControlPlaneError(
      'invalid_scheduled_authorization_state',
      'An expected origin rejects a location.',
    );
  }
  return {
    studentId: body.studentId,
    destinationRoomId: body.destinationRoomId,
    validFrom: cleanInstant(body.validFrom, 'validFrom'),
    validUntil: cleanInstant(body.validUntil, 'validUntil'),
    approvalMode: body.approvalMode,
    originStrategy: body.originStrategy,
    originRoomId,
  };
}

function passRunnerOf(dependencies: ScheduledDependencies): TenantTransactionRunner {
  return dependencies.requestPass.runner;
}

function clockNowOf(dependencies: ScheduledDependencies): Temporal.Instant {
  return dependencies.requestPass.clock.now();
}

async function validateWindow(
  context: TenantTransactionContext,
  dependencies: ScheduledDependencies,
  organizationId: string,
  validFrom: Temporal.Instant,
  validUntil: Temporal.Instant,
  now: Temporal.Instant,
): Promise<{ readonly fromDate: string }> {
  if (Temporal.Instant.compare(validUntil, validFrom) <= 0) {
    throw new ControlPlaneError(
      'invalid_scheduled_authorization_state',
      'The window ends before it begins.',
    );
  }
  const timeZone = await dependencies.scheduled.loadSchoolTimeZone(context, organizationId);
  if (timeZone === null) {
    throw new ControlPlaneError('scheduled_authorization_not_found', 'Not found.');
  }
  const fromDate = schoolDateFor(validFrom, timeZone);
  const untilDate = schoolDateFor(validUntil, timeZone);
  if (fromDate === null || untilDate === null || !fromDate.equals(untilDate)) {
    throw new ControlPlaneError(
      'invalid_scheduled_authorization_state',
      'The window must sit within one school day.',
    );
  }
  const durationHours = (validUntil.epochMilliseconds - validFrom.epochMilliseconds) / 3_600_000;
  if (durationHours > MAX_SCHEDULED_DURATION_HOURS) {
    throw new ControlPlaneError(
      'invalid_scheduled_authorization_state',
      'The window is longer than 12 hours.',
    );
  }
  if (
    Temporal.Instant.compare(validFrom, now.add({ hours: 24 * MAX_SCHEDULED_HORIZON_DAYS })) > 0
  ) {
    throw new ControlPlaneError(
      'invalid_scheduled_authorization_state',
      'The window starts too far in the future.',
    );
  }
  return { fromDate: fromDate.toString() };
}

async function requireCanonicalDestination(
  context: TenantTransactionContext,
  dependencies: ScheduledDependencies,
  principal: Principal,
  organizationId: string,
  destinationRoomId: string,
): Promise<void> {
  const destination = await dependencies.requestPass.passes.loadRoom(context, destinationRoomId);
  if (destination?.tenantId !== principal.tenantId) {
    throw new ControlPlaneError('room_not_found', 'Destination not found.');
  }
  if (destination.organizationId !== organizationId || destination.status === 'archived') {
    throw new ControlPlaneError(
      'invalid_scheduled_authorization_state',
      'The destination cannot take scheduled movement.',
    );
  }
}

async function appendScheduledAudit(
  dependencies: ScheduledDependencies,
  context: TenantTransactionContext,
  principal: Principal,
  row: ScheduledAuthRecord,
  action: string,
  requestId: string,
  now: Temporal.Instant,
  outcome: 'success' | 'denied' = 'success',
): Promise<void> {
  await dependencies.requestPass.audit.append(context, {
    action,
    actorKind: 'account',
    actorId: principal.accountId,
    organizationId: row.organizationId,
    targetKind: 'scheduled_authorization',
    targetId: row.id,
    outcome,
    occurredAt: now,
    requestId,
    metadata: {
      scheduledAuthorizationId: row.id,
      studentId: row.studentId,
      status: row.status,
      revision: row.revision.toString(10),
      authorizationEtag: etagForScheduledAuth(row.id, row.revision),
      requestId,
    },
  });
}

async function appendScheduledOutbox(
  dependencies: ScheduledDependencies,
  context: TenantTransactionContext,
  row: ScheduledAuthRecord,
  eventType: string,
  now: Temporal.Instant,
  passId: string | null = null,
): Promise<void> {
  await dependencies.requestPass.outbox.append(context, {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    aggregateKind: 'scheduled_authorization',
    aggregateId: row.id,
    eventType,
    occurredAt: now.toString(),
    payload: {
      schemaVersion: 1,
      organizationId: row.organizationId,
      scheduledAuthorizationId: row.id,
      studentId: row.studentId,
      destinationRoomId: row.destinationRoomId,
      passId,
      status: row.status,
      revision: row.revision.toString(10),
    },
  });
}

export interface ScheduledCommandInput {
  readonly principal: Principal;
  readonly idempotencyKey: unknown;
  readonly requestId: string;
}

export interface CreateScheduledInput extends ScheduledCommandInput {
  readonly organizationId: string;
  readonly body: ScheduledAuthCreateBody;
}

export interface CancelScheduledInput extends ScheduledCommandInput {
  readonly scheduledAuthorizationId: string;
  readonly ifMatch: unknown;
}

export interface ScheduledAuthResult {
  readonly authorization: ScheduledAuthView;
  readonly etag: string;
  readonly status: 200 | 201;
  readonly replayed: boolean;
}

/**
 * POST /organizations/:id/scheduled-authorizations — books a staff-directed
 * appointment window for one student. The window must sit within a single
 * school day, last at most 12 hours, and start within 366 days.
 */
export async function createScheduledAuthorization(
  input: CreateScheduledInput,
  dependencies: ScheduledDependencies,
): Promise<ScheduledAuthResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const create = canonicalCreate(input.body);
  const now = clockNowOf(dependencies);
  const fingerprint = fingerprintControlPlane('scheduled_authorization.create:v1', [
    input.organizationId,
    create.studentId,
    create.destinationRoomId,
    create.validFrom.toString(),
    create.validUntil.toString(),
    create.approvalMode,
    create.originStrategy,
    create.originRoomId ?? '',
  ]);
  const outcome = await runControlPlaneCommand(
    passRunnerOf(dependencies),
    dependencies.idempotency,
    now,
    {
      identity: {
        tenantId: input.principal.tenantId,
        actorAccountId: input.principal.accountId,
        command: 'scheduled_authorization.create:v1',
        key,
        fingerprint,
      },
      lockKey: controlPlaneLockKey(
        input.principal.tenantId,
        input.principal.accountId,
        'scheduled_authorization.create:v1',
        key,
      ),
      execute: async (context) => {
        await requireOrganizationCapability(
          context,
          dependencies.requestPass.authorization,
          input.principal,
          'scheduled_authorization.manage',
          input.organizationId,
          now,
          'scheduled_authorization_not_found',
        );
        const { fromDate } = await validateWindow(
          context,
          dependencies,
          input.organizationId,
          create.validFrom,
          create.validUntil,
          now,
        );
        const student = await dependencies.scheduled.loadStudent(context, create.studentId);
        if (student?.tenantId !== input.principal.tenantId) {
          throw new ControlPlaneError('person_not_found', 'Student not found.');
        }
        if (student.status !== 'active') {
          throw new ControlPlaneError('person_not_found', 'Student not found.');
        }
        const membership = await dependencies.scheduled.loadActiveStudentMembership(
          context,
          create.studentId,
          input.organizationId,
          fromDate,
        );
        if (membership === null) {
          throw new ControlPlaneError('person_not_found', 'Student not found.');
        }
        await requireCanonicalDestination(
          context,
          dependencies,
          input.principal,
          input.organizationId,
          create.destinationRoomId,
        );
        if (create.originRoomId !== null) {
          const originRoom = await dependencies.scheduled.loadActiveRoom(
            context,
            input.organizationId,
            create.originRoomId,
          );
          // A manually chosen origin must be a room the school marked
          // origin-selectable. Schedule-derived origins (`expected`) never
          // reach here and stay governed by the schedule alone.
          if (!originRoom?.originSelectable) {
            throw new ControlPlaneError(
              'invalid_scheduled_authorization_state',
              'The origin room is not usable.',
            );
          }
        }
        const entry: NewScheduledAuth = {
          organizationId: input.organizationId,
          studentId: create.studentId,
          destinationRoomId: create.destinationRoomId,
          createdByPersonId: input.principal.personId,
          createdByAccountId: input.principal.accountId,
          validFrom: create.validFrom,
          validUntil: create.validUntil,
          approvalMode: create.approvalMode,
          originStrategy: create.originStrategy,
          originRoomId: create.originRoomId,
        };
        const row = await dependencies.scheduled.insert(context, entry);
        await appendScheduledAudit(
          dependencies,
          context,
          input.principal,
          row,
          'scheduled_authorization.created',
          input.requestId,
          now,
        );
        await appendScheduledOutbox(
          dependencies,
          context,
          row,
          'scheduled_authorization.created',
          now,
        );
        const authorization = toScheduledAuthView(row);
        return { authorization, etag: etagForScheduledAuth(row.id, row.revision) };
      },
      toStored: (value) => ({
        responseStatus: 201,
        responseBody: { authorization: value.authorization },
      }),
      fromStored: (record) => {
        const body = record.responseBody as { authorization: ScheduledAuthView };
        return {
          authorization: body.authorization,
          etag: etagForScheduledAuth(body.authorization.id, BigInt(body.authorization.revision)),
        };
      },
    },
  );
  return {
    authorization: outcome.value.authorization,
    etag: outcome.value.etag,
    status: 201,
    replayed: outcome.replayed,
  };
}

/**
 * POST /scheduled-authorizations/:id/cancel — cancels a live appointment
 * with staff provenance. Used, cancelled, and expired rows are refused;
 * the student's pass history is never touched.
 */
export async function cancelScheduledAuthorization(
  input: CancelScheduledInput,
  dependencies: ScheduledDependencies,
): Promise<ScheduledAuthResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const expected = parseResourceIfMatch(input.ifMatch, {
    kind: 'scheduled-authorization',
    id: input.scheduledAuthorizationId,
  });
  const now = clockNowOf(dependencies);
  const fingerprint = fingerprintControlPlane('scheduled_authorization.cancel:v1', [
    input.scheduledAuthorizationId,
    expected.revision.toString(10),
  ]);
  const outcome = await runControlPlaneCommand(
    passRunnerOf(dependencies),
    dependencies.idempotency,
    now,
    {
      identity: {
        tenantId: input.principal.tenantId,
        actorAccountId: input.principal.accountId,
        command: 'scheduled_authorization.cancel:v1',
        key,
        fingerprint,
      },
      lockKey: controlPlaneLockKey(
        input.principal.tenantId,
        input.principal.accountId,
        'scheduled_authorization.cancel:v1',
        key,
      ),
      execute: async (context) => {
        const current = await dependencies.scheduled.loadForUpdate(
          context,
          input.scheduledAuthorizationId,
        );
        if (current?.tenantId !== input.principal.tenantId) {
          throw new ControlPlaneError(
            'scheduled_authorization_not_found',
            'Scheduled authorization not found.',
          );
        }
        await requireOrganizationCapability(
          context,
          dependencies.requestPass.authorization,
          input.principal,
          'scheduled_authorization.manage',
          current.organizationId,
          now,
          'scheduled_authorization_not_found',
        );
        if (current.revision !== expected.revision) {
          throw new ControlPlaneError(
            'stale_resource_revision',
            'The authorization has changed since this client last read it.',
          );
        }
        if (current.status !== 'active') {
          throw new ControlPlaneError(
            'invalid_scheduled_authorization_state',
            'Only live authorizations can be cancelled.',
          );
        }
        const row = await dependencies.scheduled.cancelToRevision(
          context,
          current.id,
          current.revision,
          input.principal.accountId,
          now,
        );
        if (row === null) {
          throw new ControlPlaneError(
            'stale_resource_revision',
            'The authorization has changed since this client last read it.',
          );
        }
        await appendScheduledAudit(
          dependencies,
          context,
          input.principal,
          row,
          'scheduled_authorization.cancelled',
          input.requestId,
          now,
        );
        await appendScheduledOutbox(
          dependencies,
          context,
          row,
          'scheduled_authorization.cancelled',
          now,
        );
        const authorization = toScheduledAuthView(row);
        return { authorization, etag: etagForScheduledAuth(row.id, row.revision) };
      },
      toStored: (value) => ({
        responseStatus: 200,
        responseBody: { authorization: value.authorization },
      }),
      fromStored: (record) => {
        const body = record.responseBody as { authorization: ScheduledAuthView };
        return {
          authorization: body.authorization,
          etag: etagForScheduledAuth(body.authorization.id, BigInt(body.authorization.revision)),
        };
      },
    },
  );
  return {
    authorization: outcome.value.authorization,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}

/** GET /scheduled-authorizations/:id — staff detail with a strong ETag. */
export async function getScheduledAuthorization(
  principal: Principal,
  scheduledAuthorizationId: string,
  dependencies: ScheduledDependencies,
): Promise<{ readonly authorization: ScheduledAuthView; readonly etag: string }> {
  const now = clockNowOf(dependencies);
  return passRunnerOf(dependencies).run(principal.tenantId, async (context) => {
    const row = await dependencies.scheduled.loadById(context, scheduledAuthorizationId);
    if (row?.tenantId !== principal.tenantId) {
      throw new ControlPlaneError(
        'scheduled_authorization_not_found',
        'Scheduled authorization not found.',
      );
    }
    await requireOrganizationCapability(
      context,
      dependencies.requestPass.authorization,
      principal,
      'scheduled_authorization.manage',
      row.organizationId,
      now,
      'scheduled_authorization_not_found',
    );
    return {
      authorization: toScheduledAuthView(row),
      etag: etagForScheduledAuth(row.id, row.revision),
    };
  });
}

/** GET /organizations/:id/scheduled-authorizations — staff list, no-store. */
export async function listScheduledAuthorizations(
  principal: Principal,
  organizationId: string,
  dependencies: ScheduledDependencies,
): Promise<{ readonly authorizations: readonly ScheduledAuthView[] }> {
  const now = clockNowOf(dependencies);
  return passRunnerOf(dependencies).run(principal.tenantId, async (context) => {
    await requireOrganizationCapability(
      context,
      dependencies.requestPass.authorization,
      principal,
      'scheduled_authorization.manage',
      organizationId,
      now,
      'scheduled_authorization_not_found',
    );
    const rows = await dependencies.scheduled.listByOrganization(context, organizationId);
    return { authorizations: rows.map(toScheduledAuthView) };
  });
}

export interface StudentLookupQuery {
  readonly q: string | null;
  readonly limit: number;
  readonly cursor: unknown;
}

export interface StudentLookupEntry {
  readonly id: string;
  readonly displayName: string;
  readonly gradeLevel: string | null;
}

/**
 * GET /organizations/:id/students — narrow chooser for scheduled movement.
 * Authorized by scheduled_authorization.manage so counselors and office
 * staff get a dropdown without people.view.
 */
export async function listScheduledStudents(
  principal: Principal,
  organizationId: string,
  query: StudentLookupQuery,
  dependencies: ScheduledDependencies,
): Promise<{
  readonly students: readonly StudentLookupEntry[];
  readonly nextCursor: string | null;
}> {
  const now = clockNowOf(dependencies);
  return passRunnerOf(dependencies).run(principal.tenantId, async (context) => {
    await requireOrganizationCapability(
      context,
      dependencies.requestPass.authorization,
      principal,
      'scheduled_authorization.manage',
      organizationId,
      now,
      'scheduled_authorization_not_found',
    );
    const rows = await dependencies.people.searchPeople(context, organizationId, {
      q: query.q === null || query.q.trim().length === 0 ? null : query.q.trim().slice(0, 100),
      affiliation: 'student',
      limit: query.limit,
      cursor: decodePersonCursor(query.cursor),
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      students: page.map((entry) => ({
        id: entry.personId,
        displayName: entry.displayName,
        gradeLevel: entry.gradeLevel,
      })),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? Buffer.from(
              JSON.stringify({ displayName: last.displayName, personId: last.personId }),
              'utf8',
            ).toString('base64url')
          : null,
    };
  });
}

/**
 * GET /me/scheduled-authorizations — the student's own appointments with
 * safe destination/origin projections. Any authenticated account sees only
 * its own rows; the destination projection carries no policy internals,
 * occupants, or grant data.
 */
export async function listMyScheduledAuthorizations(
  principal: Principal,
  dependencies: ScheduledDependencies,
): Promise<{ readonly authorizations: ScheduledAuthStudentView[] }> {
  requireNormalSession(principal);
  return passRunnerOf(dependencies).run(principal.tenantId, async (context) => {
    const rows = await dependencies.scheduled.listByStudent(context, principal.personId);
    return { authorizations: await toStudentViews(context, dependencies, rows) };
  });
}

async function toStudentViews(
  context: TenantTransactionContext,
  dependencies: ScheduledDependencies,
  rows: readonly ScheduledAuthRecord[],
): Promise<ScheduledAuthStudentView[]> {
  const views: ScheduledAuthStudentView[] = [];
  for (const row of rows) {
    const destination = await dependencies.requestPass.passes.loadRoom(
      context,
      row.destinationRoomId,
    );
    if (destination === null) continue;
    let originRoom: { readonly id: string; readonly name: string } | null = null;
    if (row.originRoomId !== null) {
      const location = await dependencies.scheduled.loadActiveRoom(
        context,
        row.organizationId,
        row.originRoomId,
      );
      if (location !== null) {
        originRoom = { id: location.id, name: location.name };
      }
    }
    views.push({
      id: row.id,
      organizationId: row.organizationId,
      validFrom: row.validFrom.toString(),
      validUntil: row.validUntil.toString(),
      // The migration CHECK constrains these columns to the view unions.
      status: row.status as ScheduledAuthStudentView['status'],
      approvalMode: row.approvalMode as ScheduledAuthStudentView['approvalMode'],
      originStrategy: row.originStrategy as ScheduledAuthStudentView['originStrategy'],
      revision: row.revision.toString(10),
      authorizationEtag: etagForScheduledAuth(row.id, row.revision),
      destination: {
        id: destination.id,
        name: destination.name,
        category:
          destination.categoryId === null || destination.categoryPresentation === null
            ? null
            : {
                id: destination.categoryId,
                name: destination.categoryPresentation.name,
                iconKey: destination.categoryPresentation.iconKey,
                toneKey: destination.categoryPresentation.toneKey,
              },
      },
      originRoom,
    });
  }
  return views;
}

export interface StartScheduledInput extends ScheduledCommandInput {
  readonly scheduledAuthorizationId: string;
  readonly ifMatch: unknown;
}

export interface StartedScheduledPass {
  readonly pass: PassRepresentation;
  readonly etag: string;
  readonly authorization: ScheduledAuthView;
  readonly authorizationEtag: string;
  readonly status: 201;
  readonly replayed: boolean;
}

/**
 * POST /me/scheduled-authorizations/:id/start — the student starts
 * staff-directed movement. The full Phase 5/6/7 pass pipeline runs in the
 * same transaction that marks the authorization used (live pass) or records
 * the denied attempt (terminal denial). Preapproved authorizations satisfy
 * only the classroom approval for the exact scheduled movement.
 */
export async function startMyScheduledAuthorization(
  input: StartScheduledInput,
  dependencies: ScheduledDependencies,
): Promise<StartedScheduledPass> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const expected = parseResourceIfMatch(input.ifMatch, {
    kind: 'scheduled-authorization',
    id: input.scheduledAuthorizationId,
  });
  const requestPass = dependencies.requestPass;
  const now = requestPass.clock.now();
  // The advisory fingerprint binds the observed revision so a stale client
  // cannot replay a fresh key against the same observed state twice.
  const fingerprint = fingerprintScheduledRequest(
    input.scheduledAuthorizationId,
    expected.revision,
  );
  const outcome = await runControlPlaneCommand(requestPass.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'scheduled_authorization.start.self:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'scheduled_authorization.start.self:v1',
      key,
    ),
    execute: async (context) => {
      const current = await dependencies.scheduled.loadForUpdate(
        context,
        input.scheduledAuthorizationId,
      );
      const ownedByCaller =
        current !== null &&
        current.tenantId === input.principal.tenantId &&
        current.studentId === input.principal.personId;
      if (!ownedByCaller) {
        throw new ControlPlaneError(
          'scheduled_authorization_not_found',
          'Scheduled authorization not found.',
        );
      }
      if (current.status !== 'active') {
        throw new ControlPlaneError(
          'invalid_scheduled_authorization_state',
          'The authorization is no longer live.',
        );
      }
      if (Temporal.Instant.compare(now, current.validFrom) < 0) {
        throw new ControlPlaneError(
          'scheduled_authorization_not_yet_valid',
          'The authorization window has not opened.',
        );
      }
      if (Temporal.Instant.compare(now, current.validUntil) >= 0) {
        throw new ControlPlaneError(
          'scheduled_authorization_expired',
          'The authorization window has closed.',
        );
      }
      if (current.revision !== expected.revision) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The authorization has changed since this client last read it.',
        );
      }
      await requireCanonicalDestination(
        context,
        dependencies,
        input.principal,
        current.organizationId,
        current.destinationRoomId,
      );
      const placement = await requestPass.placement.resolve({
        tenantId: input.principal.tenantId,
        organizationId: current.organizationId,
        personId: current.studentId,
        at: now,
      });
      const created = await createPassInTransaction(
        context,
        {
          principal: input.principal,
          targetStudentId: current.studentId,
          destinationRoomId: current.destinationRoomId,
          requestSource: 'scheduled',
          requestId: input.requestId,
          now,
          placement,
          schoolId: current.organizationId,
          authorizeSelf: true,
          scheduled: {
            scheduledAuthorizationId: current.id,
            originLocationOverride:
              current.originStrategy === 'specific' ? current.originRoomId : null,
            scheduledPreapprovals:
              current.approvalMode === 'preapproved'
                ? [
                    {
                      scheduledAuthorizationId: current.id,
                      studentId: current.studentId,
                      destinationRoomId: current.destinationRoomId,
                    },
                  ]
                : [],
          },
        },
        requestPass,
      );
      const lifecycle = created.representation.lifecycleState;
      if (lifecycle === 'requested' || lifecycle === 'queued' || lifecycle === 'ready') {
        const used = await dependencies.scheduled.markUsed(
          context,
          current.id,
          current.revision,
          input.principal.accountId,
          now,
        );
        if (used === null) {
          throw new ControlPlaneError(
            'stale_resource_revision',
            'The authorization has changed since this client last read it.',
          );
        }
        await appendScheduledAudit(
          dependencies,
          context,
          input.principal,
          used,
          'scheduled_authorization.used',
          input.requestId,
          now,
        );
        await appendScheduledOutbox(
          dependencies,
          context,
          used,
          'scheduled_authorization.used',
          now,
          created.representation.id,
        );
        return {
          pass: created.representation,
          etag: created.etag,
          authorization: toScheduledAuthView(used),
          authorizationEtag: etagForScheduledAuth(used.id, used.revision),
        };
      }
      if (lifecycle !== 'denied') {
        throw new ControlPlaneError(
          'invalid_scheduled_authorization_state',
          'The scheduled movement did not start.',
        );
      }
      const attempted = await dependencies.scheduled.recordAttempt(
        context,
        current.id,
        current.revision,
        now,
      );
      if (attempted === null) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The authorization has changed since this client last read it.',
        );
      }
      await appendScheduledAudit(
        dependencies,
        context,
        input.principal,
        attempted,
        'scheduled_authorization.start_attempted',
        input.requestId,
        now,
        'denied',
      );
      await appendScheduledOutbox(
        dependencies,
        context,
        attempted,
        'scheduled_authorization.start_attempted',
        now,
        created.representation.id,
      );
      return {
        pass: created.representation,
        etag: created.etag,
        authorization: toScheduledAuthView(attempted),
        authorizationEtag: etagForScheduledAuth(attempted.id, attempted.revision),
      };
    },
    toStored: (value) => ({
      responseStatus: 201,
      responseBody: { pass: value.pass, authorization: value.authorization },
    }),
    fromStored: (record) => {
      const body = record.responseBody as {
        pass: PassRepresentation;
        authorization: ScheduledAuthView;
      };
      return {
        pass: body.pass,
        etag: etagForPass(body.pass.id, BigInt(body.pass.revision)),
        authorization: body.authorization,
        authorizationEtag: etagForScheduledAuth(
          body.authorization.id,
          BigInt(body.authorization.revision),
        ),
      };
    },
  });
  return {
    pass: outcome.value.pass,
    etag: outcome.value.etag,
    authorization: outcome.value.authorization,
    authorizationEtag: outcome.value.authorizationEtag,
    status: 201,
    replayed: outcome.replayed,
  };
}
