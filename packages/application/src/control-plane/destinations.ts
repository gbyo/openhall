import type { Temporal } from '@js-temporal/polyfill';
import type { Clock } from '@openhall/domain';
import type { AuditWriter } from '../auditing/audit.js';
import type { Principal } from '../authentication/principal.js';
import type { RelationshipAuthorizationService } from '../authorization/service.js';
import { destinationFlowLockKey } from '../destination-flow/locks.js';
import type { DestinationFlowRepository } from '../destination-flow/ports.js';
import type { IdempotencyTransactionStore } from '../idempotency/coordinator.js';
import type {
  OutboxWriter,
  TenantTransactionContext,
  TenantTransactionRunner,
} from '../persistence.js';
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
  DestinationCheckInMode,
  DestinationRecord,
  DestinationRepository,
  DestinationStatus,
  LocationRepository,
} from './ports.js';
import { requireNormalSession, requireOrganizationCapability } from './shared.js';

export interface DestinationDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly destinations: DestinationRepository;
  readonly locations: LocationRepository;
  readonly flow: DestinationFlowRepository;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

export interface DestinationView {
  readonly id: string;
  readonly organizationId: string;
  readonly locationId: string;
  readonly serviceType: string;
  readonly displayName: string | null;
  readonly capacity: number | null;
  readonly queueEnabled: boolean;
  readonly checkInMode: DestinationCheckInMode;
  readonly defaultDurationSeconds: number | null;
  readonly maxDurationSeconds: number | null;
  readonly readyClaimTimeoutSeconds: number;
  readonly queueTimeoutSeconds: number;
  readonly status: DestinationStatus;
  readonly revision: string;
  readonly updatedAt: string;
}

/** Stable picker-safe projection: no occupants, identities, or policy internals. */
export interface DestinationCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly serviceType: string;
  readonly checkInMode: DestinationCheckInMode;
}

export function toDestinationView(row: DestinationRecord): DestinationView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    locationId: row.locationId,
    serviceType: row.serviceType,
    displayName: row.displayName,
    capacity: row.capacity,
    queueEnabled: row.queueEnabled,
    checkInMode: row.checkInMode,
    defaultDurationSeconds: row.defaultDurationSeconds,
    maxDurationSeconds: row.maxDurationSeconds,
    readyClaimTimeoutSeconds: row.readyClaimTimeoutSeconds,
    queueTimeoutSeconds: row.queueTimeoutSeconds,
    status: row.status,
    revision: row.revision.toString(10),
    updatedAt: row.updatedAt.toString(),
  };
}

export function etagForDestination(destinationId: string, revision: bigint): string {
  return etagForResource('destination', destinationId, revision);
}

export interface DestinationCommandInput {
  readonly principal: Principal;
  readonly idempotencyKey: unknown;
  readonly requestId: string;
}

export interface DestinationConfigBody {
  readonly locationId: string;
  readonly serviceType: unknown;
  readonly displayName: string | null;
  readonly capacity: number | null;
  readonly queueEnabled: unknown;
  readonly checkInMode: unknown;
  readonly defaultDurationSeconds: number | null;
  readonly maxDurationSeconds: number | null;
  readonly readyClaimTimeoutSeconds: unknown;
  readonly queueTimeoutSeconds: unknown;
}

export interface CreateDestinationInput extends DestinationCommandInput {
  readonly organizationId: string;
  readonly config: DestinationConfigBody;
}

export interface UpdateDestinationInput extends DestinationCommandInput {
  readonly destinationId: string;
  readonly ifMatch: unknown;
  readonly config: DestinationConfigBody;
}

export interface DestinationStatusInput extends DestinationCommandInput {
  readonly destinationId: string;
  readonly ifMatch: unknown;
}

export interface DestinationResult {
  readonly destination: DestinationView;
  readonly etag: string;
  readonly status: 200 | 201;
  readonly replayed: boolean;
}

interface CanonicalDestinationConfig {
  readonly locationId: string;
  readonly serviceType: string;
  readonly displayName: string | null;
  readonly capacity: number | null;
  readonly queueEnabled: boolean;
  readonly checkInMode: DestinationCheckInMode;
  readonly defaultDurationSeconds: number | null;
  readonly maxDurationSeconds: number | null;
  readonly readyClaimTimeoutSeconds: number;
  readonly queueTimeoutSeconds: number;
}

function cleanName(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new ControlPlaneError('invalid_precondition', `Invalid ${field}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new ControlPlaneError('invalid_precondition', `Invalid ${field}.`);
  }
  return trimmed;
}

function cleanOptionalName(value: string | null, field: string, maxLength: number): string | null {
  if (value === null) return null;
  return cleanName(value, field, maxLength);
}

function cleanOptionalPositiveInt(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ControlPlaneError('invalid_precondition', `Invalid ${field}.`);
  }
  return value;
}

function cleanBoundedInt(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ControlPlaneError('invalid_precondition', `Invalid ${field}.`);
  }
  return value;
}

function cleanCheckInMode(value: unknown): DestinationCheckInMode {
  if (value === 'none' || value === 'optional' || value === 'required') return value;
  throw new ControlPlaneError('invalid_precondition', 'Invalid checkInMode.');
}

/**
 * Canonicalizes destination configuration using the same bounds Phase 7
 * expects (ready-claim 5..600s, queue 60..14400s, positive capacity and
 * durations, max >= default). There is exactly one validation rule set;
 * the migration CHECKs stay as defense in depth.
 */
function canonicalConfig(body: DestinationConfigBody): CanonicalDestinationConfig {
  if (typeof body.queueEnabled !== 'boolean') {
    throw new ControlPlaneError('invalid_precondition', 'Invalid queueEnabled.');
  }
  const serviceType = cleanName(body.serviceType, 'serviceType', 100);
  const displayName = cleanOptionalName(body.displayName, 'displayName', 200);
  const capacity = cleanOptionalPositiveInt(body.capacity, 'capacity');
  const checkInMode = cleanCheckInMode(body.checkInMode);
  const defaultDurationSeconds = cleanOptionalPositiveInt(
    body.defaultDurationSeconds,
    'defaultDurationSeconds',
  );
  const maxDurationSeconds = cleanOptionalPositiveInt(
    body.maxDurationSeconds,
    'maxDurationSeconds',
  );
  if (
    defaultDurationSeconds !== null &&
    maxDurationSeconds !== null &&
    maxDurationSeconds < defaultDurationSeconds
  ) {
    throw new ControlPlaneError('invalid_precondition', 'Invalid duration bounds.');
  }
  const readyClaimTimeoutSeconds = cleanBoundedInt(
    body.readyClaimTimeoutSeconds,
    'readyClaimTimeoutSeconds',
    5,
    600,
  );
  const queueTimeoutSeconds = cleanBoundedInt(
    body.queueTimeoutSeconds,
    'queueTimeoutSeconds',
    60,
    14400,
  );
  return {
    locationId: body.locationId,
    serviceType,
    displayName,
    capacity,
    queueEnabled: body.queueEnabled,
    checkInMode,
    defaultDurationSeconds,
    maxDurationSeconds,
    readyClaimTimeoutSeconds,
    queueTimeoutSeconds,
  };
}

function fingerprintComponents(
  organizationId: string,
  config: CanonicalDestinationConfig,
): string[] {
  return [
    organizationId,
    config.locationId,
    config.serviceType,
    config.displayName ?? '',
    config.capacity === null ? '' : String(config.capacity),
    config.queueEnabled ? 'queue' : 'no-queue',
    config.checkInMode,
    config.defaultDurationSeconds === null ? '' : String(config.defaultDurationSeconds),
    config.maxDurationSeconds === null ? '' : String(config.maxDurationSeconds),
    String(config.readyClaimTimeoutSeconds),
    String(config.queueTimeoutSeconds),
  ];
}

/**
 * GET /api/v1/organizations/:organizationId/destinations — full admin DTO,
 * authorized with destination.manage on the exact school.
 */
export async function listDestinations(
  principal: Principal,
  organizationId: string,
  dependencies: DestinationDependencies,
): Promise<{ readonly destinations: readonly DestinationView[] }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    await requireOrganizationCapability(
      context,
      dependencies.authorization,
      principal,
      'destination.manage',
      organizationId,
      now,
      'destination_not_found',
    );
    const rows = await dependencies.destinations.listByOrganization(context, organizationId);
    return { destinations: rows.map(toDestinationView) };
  });
}

/**
 * GET /api/v1/destinations/:destinationId — authorized against the
 * destination's canonical school; cross-school references are concealed.
 */
export async function getDestination(
  principal: Principal,
  destinationId: string,
  dependencies: DestinationDependencies,
): Promise<{ readonly destination: DestinationView; readonly etag: string }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const row = await dependencies.destinations.loadById(context, destinationId);
    if (row?.tenantId !== principal.tenantId) {
      throw new ControlPlaneError('destination_not_found', 'Destination not found.');
    }
    await requireOrganizationCapability(
      context,
      dependencies.authorization,
      principal,
      'destination.manage',
      row.organizationId,
      now,
      'destination_not_found',
    );
    return {
      destination: toDestinationView(row),
      etag: etagForDestination(row.id, row.revision),
    };
  });
}

/**
 * GET /api/v1/me/organizations/:organizationId/destinations — stable safe
 * catalog for the future picker. Any organization member may read it; only
 * active destinations with picker-safe fields are returned.
 */
export async function listMyDestinations(
  principal: Principal,
  organizationId: string,
  dependencies: DestinationDependencies,
): Promise<{ readonly destinations: readonly DestinationCatalogEntry[] }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const decision = await dependencies.authorization.decideWithContext(context, {
      principal,
      capability: 'organization.context.read',
      resource: { kind: 'organization', organizationId },
      at: now,
    });
    if (!decision.allowed) {
      throw new ControlPlaneError('destination_not_found', 'Destination not found.');
    }
    const rows = await dependencies.destinations.listActiveCatalog(context, organizationId);
    return {
      destinations: rows
        .filter((row) => row.tenantId === principal.tenantId && row.status === 'active')
        .map((row) => ({
          id: row.id,
          displayName: row.displayName ?? row.serviceType,
          serviceType: row.serviceType,
          checkInMode: row.checkInMode,
        })),
    };
  });
}

/**
 * POST /api/v1/organizations/:organizationId/destinations — a new
 * destination starts closed, never active, so partially configured
 * destinations cannot enter movement allocation before review.
 */
export async function createDestination(
  input: CreateDestinationInput,
  dependencies: DestinationDependencies,
): Promise<DestinationResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const now = dependencies.clock.now();
  const config = canonicalConfig(input.config);
  const fingerprint = fingerprintControlPlane('destination.create:v1', [
    ...fingerprintComponents(input.organizationId, config),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'destination.create:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'destination.create:v1',
      key,
    ),
    execute: async (context) => {
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'destination.manage',
        input.organizationId,
        now,
        'destination_not_found',
      );
      const location = await dependencies.locations.loadById(context, config.locationId);
      if (
        location?.tenantId !== input.principal.tenantId ||
        location.organizationId !== input.organizationId ||
        location.status === 'archived'
      ) {
        throw new ControlPlaneError('invalid_precondition', 'Invalid destination location.');
      }
      const row = await dependencies.destinations.insert(context, {
        organizationId: input.organizationId,
        ...config,
      });
      await appendDestinationAudit(dependencies, context, input, now, 'destination.created', row);
      await appendDestinationOutbox(dependencies, context, now, 'destination.created', row);
      const destination = toDestinationView(row);
      return { destination, etag: etagForDestination(row.id, row.revision) };
    },
    toStored: (value) => ({
      responseStatus: 201,
      responseBody: { destination: value.destination },
    }),
    fromStored: (record) => {
      const body = record.responseBody as { destination: DestinationView };
      return {
        destination: body.destination,
        etag: etagForDestination(body.destination.id, BigInt(body.destination.revision)),
      };
    },
  });
  return {
    destination: outcome.value.destination,
    etag: outcome.value.etag,
    status: 201,
    replayed: outcome.replayed,
  };
}

/**
 * PUT /api/v1/destinations/:destinationId — configuration replacement only.
 * Status travels through the semantic open/close/archive commands. Edits are
 * prospective: capacity reductions never evict active reservations, queue
 * disabling never deletes queued history, and check-in changes never
 * reinterpret already-departed passes (the departure snapshot governs).
 */
export async function updateDestination(
  input: UpdateDestinationInput,
  dependencies: DestinationDependencies,
): Promise<DestinationResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const expected = parseResourceIfMatch(input.ifMatch, {
    kind: 'destination',
    id: input.destinationId,
  });
  const now = dependencies.clock.now();
  const config = canonicalConfig(input.config);
  const fingerprint = fingerprintControlPlane('destination.update:v1', [
    input.destinationId,
    expected.revision.toString(10),
    ...fingerprintComponents('', config),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'destination.update:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'destination.update:v1',
      key,
    ),
    execute: async (context) => {
      const current = await dependencies.destinations.loadForUpdate(context, input.destinationId);
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('destination_not_found', 'Destination not found.');
      }
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'destination.manage',
        current.organizationId,
        now,
        'destination_not_found',
      );
      if (current.revision !== expected.revision) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The destination has changed since this client last read it.',
        );
      }
      if (current.status === 'archived') {
        throw new ControlPlaneError(
          'invalid_destination_state',
          'Archived destinations cannot be edited.',
        );
      }
      const location = await dependencies.locations.loadById(context, config.locationId);
      if (
        location?.tenantId !== input.principal.tenantId ||
        location.organizationId !== current.organizationId ||
        location.status === 'archived'
      ) {
        throw new ControlPlaneError('invalid_precondition', 'Invalid destination location.');
      }
      const row = await dependencies.destinations.updateToRevision(
        context,
        current.id,
        expected.revision,
        config,
        now,
      );
      if (row === null) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The destination has changed since this client last read it.',
        );
      }
      await appendDestinationAudit(dependencies, context, input, now, 'destination.updated', row);
      await appendDestinationOutbox(dependencies, context, now, 'destination.updated', row);
      const destination = toDestinationView(row);
      return { destination, etag: etagForDestination(row.id, row.revision) };
    },
    toStored: (value) => ({
      responseStatus: 200,
      responseBody: { destination: value.destination },
    }),
    fromStored: (record) => {
      const body = record.responseBody as { destination: DestinationView };
      return {
        destination: body.destination,
        etag: etagForDestination(body.destination.id, BigInt(body.destination.revision)),
      };
    },
  });
  return {
    destination: outcome.value.destination,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}

async function executeStatusCommand(
  command: ControlPlaneCommand,
  action: string,
  input: DestinationStatusInput,
  from: DestinationStatus | readonly DestinationStatus[],
  to: DestinationStatus,
  alreadyCode: 'destination_already_open' | 'destination_already_closed' | null,
  dependencies: DestinationDependencies,
): Promise<DestinationResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const expected = parseResourceIfMatch(input.ifMatch, {
    kind: 'destination',
    id: input.destinationId,
  });
  const now = dependencies.clock.now();
  const fingerprint = fingerprintControlPlane(command, [
    input.destinationId,
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
      if (command === 'destination.archive:v1') {
        // Archive inspects live reservations, so it coordinates with the
        // Phase 7 destination lock before touching the config row. Lock
        // order (idempotency lock, flow lock, config row) cannot cycle:
        // Phase 7 paths take pass row -> flow lock and only read the
        // config row without locking it.
        await dependencies.flow.acquireDestinationLock(
          context,
          destinationFlowLockKey(input.principal.tenantId, input.destinationId),
        );
      }
      const current = await dependencies.destinations.loadForUpdate(context, input.destinationId);
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('destination_not_found', 'Destination not found.');
      }
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'destination.manage',
        current.organizationId,
        now,
        'destination_not_found',
      );
      if (current.revision !== expected.revision) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The destination has changed since this client last read it.',
        );
      }
      const allowed = Array.isArray(from) ? from : [from];
      if (!allowed.includes(current.status)) {
        if (alreadyCode !== null && current.status === to) {
          throw new ControlPlaneError(
            alreadyCode,
            `The destination is already ${to === 'active' ? 'open' : 'closed'}.`,
          );
        }
        throw new ControlPlaneError(
          'invalid_destination_state',
          'The destination cannot change status from its current state.',
        );
      }
      if (command === 'destination.archive:v1') {
        await assertArchivable(dependencies, context, now, current);
      }
      const row = await dependencies.destinations.transitionStatusToRevision(
        context,
        current.id,
        expected.revision,
        to,
        now,
      );
      if (row === null) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The destination has changed since this client last read it.',
        );
      }
      await appendDestinationAudit(dependencies, context, input, now, action, row);
      await appendDestinationOutbox(dependencies, context, now, action, row);
      const destination = toDestinationView(row);
      return { destination, etag: etagForDestination(row.id, row.revision) };
    },
    toStored: (value) => ({
      responseStatus: 200,
      responseBody: { destination: value.destination },
    }),
    fromStored: (record) => {
      const body = record.responseBody as { destination: DestinationView };
      return {
        destination: body.destination,
        etag: etagForDestination(body.destination.id, BigInt(body.destination.revision)),
      };
    },
  });
  return {
    destination: outcome.value.destination,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}

async function assertArchivable(
  dependencies: DestinationDependencies,
  context: TenantTransactionContext,
  now: Temporal.Instant,
  current: DestinationRecord,
): Promise<void> {
  const [passes, grants, rules, scheduled] = await Promise.all([
    dependencies.destinations.countLivePasses(context, current.id),
    dependencies.destinations.countActiveStaffGrants(context, current.id),
    dependencies.destinations.countEnabledPolicyRules(context, current.id),
    dependencies.destinations.countLiveScheduledAuthorizations(context, current.id, now),
  ]);
  if (passes > 0 || grants > 0 || rules > 0 || scheduled > 0) {
    // No dependency details: administrators resolve references explicitly
    // through grants, policy, and scheduling surfaces instead.
    throw new ControlPlaneError('destination_in_use', 'The destination is still in use.');
  }
}

/** POST /api/v1/destinations/:destinationId/open — closed -> active. */
export async function openDestination(
  input: DestinationStatusInput,
  dependencies: DestinationDependencies,
): Promise<DestinationResult> {
  return executeStatusCommand(
    'destination.open:v1',
    'destination.opened',
    input,
    'closed',
    'active',
    'destination_already_open',
    dependencies,
  );
}

/**
 * POST /api/v1/destinations/:destinationId/close — no new pre-departure
 * movement. Already-moving passes keep their explicit physical state;
 * Phase 7 reconciliation handles queued/ready pre-departure work.
 */
export async function closeDestination(
  input: DestinationStatusInput,
  dependencies: DestinationDependencies,
): Promise<DestinationResult> {
  return executeStatusCommand(
    'destination.close:v1',
    'destination.closed',
    input,
    'active',
    'closed',
    'destination_already_closed',
    dependencies,
  );
}

/** POST /api/v1/destinations/:destinationId/archive — terminal, guarded. */
export async function archiveDestination(
  input: DestinationStatusInput,
  dependencies: DestinationDependencies,
): Promise<DestinationResult> {
  return executeStatusCommand(
    'destination.archive:v1',
    'destination.archived',
    input,
    ['active', 'closed'],
    'archived',
    null,
    dependencies,
  );
}

async function appendDestinationAudit(
  dependencies: DestinationDependencies,
  context: TenantTransactionContext,
  input: DestinationCommandInput,
  now: Temporal.Instant,
  action: string,
  row: DestinationRecord,
): Promise<void> {
  await dependencies.audit.append(context, {
    action,
    actorKind: 'account',
    actorId: input.principal.accountId,
    organizationId: row.organizationId,
    targetKind: 'destination',
    targetId: row.id,
    outcome: 'success',
    occurredAt: now,
    requestId: input.requestId,
    metadata: {
      destinationId: row.id,
      organizationId: row.organizationId,
      revision: row.revision.toString(10),
      requestId: input.requestId,
    },
  });
}

async function appendDestinationOutbox(
  dependencies: DestinationDependencies,
  context: TenantTransactionContext,
  now: Temporal.Instant,
  eventType: string,
  row: DestinationRecord,
): Promise<void> {
  await dependencies.outbox.append(context, {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    aggregateKind: 'destination',
    aggregateId: row.id,
    eventType,
    occurredAt: now.toString(),
    payload: {
      schemaVersion: 1,
      organizationId: row.organizationId,
      destinationId: row.id,
      revision: row.revision.toString(10),
      status: row.status,
      checkInMode: row.checkInMode,
      queueEnabled: row.queueEnabled,
    },
  });
}
