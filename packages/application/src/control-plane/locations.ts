import type { Clock } from '@openhall/domain';
import type { AuditWriter } from '../auditing/audit.js';
import type { Principal } from '../authentication/principal.js';
import type { RelationshipAuthorizationService } from '../authorization/service.js';
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
} from './idempotency.js';
import type { LocationRecord, LocationRepository } from './ports.js';
import { requireNormalSession, requireOrganizationCapability, schoolDateFor } from './shared.js';

export interface LocationDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly locations: LocationRepository;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

export interface LocationView {
  readonly id: string;
  readonly organizationId: string;
  readonly parentLocationId: string | null;
  readonly kind: string;
  readonly name: string;
  readonly code: string | null;
  readonly floorLabel: string | null;
  readonly status: 'active' | 'inactive' | 'archived';
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toLocationView(row: LocationRecord): LocationView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    parentLocationId: row.parentLocationId,
    kind: row.kind,
    name: row.name,
    code: row.code,
    floorLabel: row.floorLabel,
    status: row.status,
    revision: row.revision.toString(10),
    createdAt: row.createdAt.toString(),
    updatedAt: row.updatedAt.toString(),
  };
}

export function etagForLocation(locationId: string, revision: bigint): string {
  return etagForResource('location', locationId, revision);
}

export interface LocationCommandInput {
  readonly principal: Principal;
  readonly idempotencyKey: unknown;
  readonly requestId: string;
}

export interface CreateLocationInput extends LocationCommandInput {
  readonly organizationId: string;
  readonly parentLocationId: string | null;
  readonly kind: unknown;
  readonly name: unknown;
  readonly code: string | null;
  readonly floorLabel: string | null;
}

export interface UpdateLocationInput extends LocationCommandInput {
  readonly locationId: string;
  readonly ifMatch: unknown;
  readonly parentLocationId: string | null;
  readonly kind: unknown;
  readonly name: unknown;
  readonly code: string | null;
  readonly floorLabel: string | null;
}

export interface ArchiveLocationInput extends LocationCommandInput {
  readonly locationId: string;
  readonly ifMatch: unknown;
}

export interface LocationResult {
  readonly location: LocationView;
  readonly etag: string;
  readonly status: 200 | 201;
  readonly replayed: boolean;
}

function cleanText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new ControlPlaneError('invalid_precondition', `Invalid ${field}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new ControlPlaneError('invalid_precondition', `Invalid ${field}.`);
  }
  return trimmed;
}

function cleanOptionalText(value: string | null, field: string, maxLength: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new ControlPlaneError('invalid_precondition', `Invalid ${field}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new ControlPlaneError('invalid_precondition', `Invalid ${field}.`);
  }
  return trimmed;
}

function canonicalCreateBody(input: {
  readonly parentLocationId: string | null;
  readonly kind: string;
  readonly name: string;
  readonly code: string | null;
  readonly floorLabel: string | null;
}): string[] {
  return [
    input.parentLocationId ?? '',
    input.kind,
    input.name,
    input.code ?? '',
    input.floorLabel ?? '',
  ];
}

async function assertUsableParent(
  context: TenantTransactionContext,
  locations: LocationRepository,
  organizationId: string,
  tenantId: string,
  parentLocationId: string | null,
  selfId: string | null,
): Promise<void> {
  if (parentLocationId === null) return;
  if (parentLocationId === selfId) {
    throw new ControlPlaneError('invalid_location_parent', 'A location cannot parent itself.');
  }
  const parent = await locations.loadById(context, parentLocationId);
  if (parent?.tenantId !== tenantId || parent.organizationId !== organizationId) {
    throw new ControlPlaneError('invalid_location_parent', 'Unknown parent location.');
  }
  if (parent.status === 'archived') {
    throw new ControlPlaneError('invalid_location_parent', 'Parent location is archived.');
  }
  if (selfId !== null) {
    const pairs = await locations.listHierarchyPairs(context, organizationId);
    const byId = new Map(pairs.map((pair) => [pair.id, pair.parentLocationId]));
    let cursor: string | null | undefined = parent.id;
    while (cursor !== null && cursor !== undefined) {
      if (cursor === selfId) {
        throw new ControlPlaneError(
          'invalid_location_parent',
          'A location cannot move beneath its own descendant.',
        );
      }
      cursor = byId.get(cursor);
    }
  }
}

/**
 * GET /api/v1/organizations/:organizationId/locations — destination.manage
 * read of the exact school's locations.
 */
export async function listLocations(
  principal: Principal,
  organizationId: string,
  dependencies: LocationDependencies,
): Promise<{ readonly locations: readonly LocationView[] }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    await requireOrganizationCapability(
      context,
      dependencies.authorization,
      principal,
      'destination.manage',
      organizationId,
      now,
      'location_not_found',
    );
    const rows = await dependencies.locations.listByOrganization(context, organizationId);
    return { locations: rows.map(toLocationView) };
  });
}

/**
 * GET /api/v1/locations/:locationId — authorized against the location's
 * canonical school; cross-school references are concealed as not found.
 */
export async function getLocation(
  principal: Principal,
  locationId: string,
  dependencies: LocationDependencies,
): Promise<{ readonly location: LocationView; readonly etag: string }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const row = await dependencies.locations.loadById(context, locationId);
    if (row?.tenantId !== principal.tenantId) {
      throw new ControlPlaneError('location_not_found', 'Location not found.');
    }
    await requireOrganizationCapability(
      context,
      dependencies.authorization,
      principal,
      'destination.manage',
      row.organizationId,
      now,
      'location_not_found',
    );
    return { location: toLocationView(row), etag: etagForLocation(row.id, row.revision) };
  });
}

/** POST /api/v1/organizations/:organizationId/locations — status starts active, revision 1. */
export async function createLocation(
  input: CreateLocationInput,
  dependencies: LocationDependencies,
): Promise<LocationResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const now = dependencies.clock.now();
  const kind = cleanText(input.kind, 'kind', 100);
  const name = cleanText(input.name, 'name', 200);
  const code = cleanOptionalText(input.code, 'code', 100);
  const floorLabel = cleanOptionalText(input.floorLabel, 'floorLabel', 100);
  const fingerprint = fingerprintControlPlane('location.create:v1', [
    input.organizationId,
    ...canonicalCreateBody({
      parentLocationId: input.parentLocationId,
      kind,
      name,
      code,
      floorLabel,
    }),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'location.create:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'location.create:v1',
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
        'location_not_found',
      );
      await assertUsableParent(
        context,
        dependencies.locations,
        input.organizationId,
        input.principal.tenantId,
        input.parentLocationId,
        null,
      );
      const row = await dependencies.locations.insert(context, {
        organizationId: input.organizationId,
        parentLocationId: input.parentLocationId,
        kind,
        name,
        code,
        floorLabel,
      });
      await dependencies.audit.append(context, {
        action: 'location.created',
        actorKind: 'account',
        actorId: input.principal.accountId,
        organizationId: row.organizationId,
        targetKind: 'location',
        targetId: row.id,
        outcome: 'success',
        occurredAt: now,
        requestId: input.requestId,
        metadata: {
          locationId: row.id,
          organizationId: row.organizationId,
          revision: row.revision.toString(10),
          requestId: input.requestId,
        },
      });
      await dependencies.outbox.append(context, {
        tenantId: row.tenantId,
        organizationId: row.organizationId,
        aggregateKind: 'location',
        aggregateId: row.id,
        eventType: 'location.created',
        occurredAt: now.toString(),
        payload: {
          schemaVersion: 1,
          organizationId: row.organizationId,
          locationId: row.id,
          revision: row.revision.toString(10),
          status: row.status,
        },
      });
      const location = toLocationView(row);
      return { location, etag: etagForLocation(row.id, row.revision) };
    },
    toStored: (value) => ({ responseStatus: 201, responseBody: { location: value.location } }),
    fromStored: (record) => {
      const body = record.responseBody as { location: LocationView };
      return {
        location: body.location,
        etag: etagForLocation(body.location.id, BigInt(body.location.revision)),
      };
    },
  });
  return {
    location: outcome.value.location,
    etag: outcome.value.etag,
    status: 201,
    replayed: outcome.replayed,
  };
}

/** PUT /api/v1/locations/:locationId — full replacement of mutable metadata. */
export async function updateLocation(
  input: UpdateLocationInput,
  dependencies: LocationDependencies,
): Promise<LocationResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const expected = parseResourceIfMatch(input.ifMatch, { kind: 'location', id: input.locationId });
  const now = dependencies.clock.now();
  const kind = cleanText(input.kind, 'kind', 100);
  const name = cleanText(input.name, 'name', 200);
  const code = cleanOptionalText(input.code, 'code', 100);
  const floorLabel = cleanOptionalText(input.floorLabel, 'floorLabel', 100);
  const fingerprint = fingerprintControlPlane('location.update:v1', [
    input.locationId,
    expected.revision.toString(10),
    ...canonicalCreateBody({
      parentLocationId: input.parentLocationId,
      kind,
      name,
      code,
      floorLabel,
    }),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'location.update:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'location.update:v1',
      key,
    ),
    execute: async (context) => {
      const current = await dependencies.locations.loadForUpdate(context, input.locationId);
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('location_not_found', 'Location not found.');
      }
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'destination.manage',
        current.organizationId,
        now,
        'location_not_found',
      );
      if (current.revision !== expected.revision) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The location has changed since this client last read it.',
        );
      }
      await assertUsableParent(
        context,
        dependencies.locations,
        current.organizationId,
        input.principal.tenantId,
        input.parentLocationId,
        current.id,
      );
      const row = await dependencies.locations.updateToRevision(
        context,
        current.id,
        expected.revision,
        { parentLocationId: input.parentLocationId, kind, name, code, floorLabel },
        now,
      );
      if (row === null) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The location has changed since this client last read it.',
        );
      }
      await dependencies.audit.append(context, {
        action: 'location.updated',
        actorKind: 'account',
        actorId: input.principal.accountId,
        organizationId: row.organizationId,
        targetKind: 'location',
        targetId: row.id,
        outcome: 'success',
        occurredAt: now,
        requestId: input.requestId,
        metadata: {
          locationId: row.id,
          organizationId: row.organizationId,
          revision: row.revision.toString(10),
          requestId: input.requestId,
        },
      });
      await dependencies.outbox.append(context, {
        tenantId: row.tenantId,
        organizationId: row.organizationId,
        aggregateKind: 'location',
        aggregateId: row.id,
        eventType: 'location.updated',
        occurredAt: now.toString(),
        payload: {
          schemaVersion: 1,
          organizationId: row.organizationId,
          locationId: row.id,
          revision: row.revision.toString(10),
          status: row.status,
        },
      });
      const location = toLocationView(row);
      return { location, etag: etagForLocation(row.id, row.revision) };
    },
    toStored: (value) => ({ responseStatus: 200, responseBody: { location: value.location } }),
    fromStored: (record) => {
      const body = record.responseBody as { location: LocationView };
      return {
        location: body.location,
        etag: etagForLocation(body.location.id, BigInt(body.location.revision)),
      };
    },
  });
  return {
    location: outcome.value.location,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}

/**
 * POST /api/v1/locations/:locationId/archive — semantic archive, never a
 * delete. Conservatively rejects while the location is still required by an
 * active destination, a current/future section meeting, or an active
 * scheduled authorization with a specific origin, because the placement
 * resolver ignores inactive locations and silent archiving would change
 * current expected placement.
 */
export async function archiveLocation(
  input: ArchiveLocationInput,
  dependencies: LocationDependencies,
): Promise<LocationResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const expected = parseResourceIfMatch(input.ifMatch, { kind: 'location', id: input.locationId });
  const now = dependencies.clock.now();
  const fingerprint = fingerprintControlPlane('location.archive:v1', [
    input.locationId,
    expected.revision.toString(10),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'location.archive:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'location.archive:v1',
      key,
    ),
    execute: async (context) => {
      const current = await dependencies.locations.loadForUpdate(context, input.locationId);
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('location_not_found', 'Location not found.');
      }
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'destination.manage',
        current.organizationId,
        now,
        'location_not_found',
      );
      if (current.revision !== expected.revision) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The location has changed since this client last read it.',
        );
      }
      if (current.status === 'archived') {
        throw new ControlPlaneError('invalid_location_state', 'The location is already archived.');
      }
      const destinations = await dependencies.locations.countActiveDestinationReferences(
        context,
        current.id,
      );
      if (destinations > 0) {
        throw new ControlPlaneError('location_in_use', 'The location is still in use.');
      }
      const timeZone = await dependencies.locations.loadSchoolTimeZone(
        context,
        current.organizationId,
      );
      const schoolDate = timeZone === null ? null : schoolDateFor(now, timeZone);
      if (schoolDate === null) {
        throw new ControlPlaneError('invalid_precondition', 'School time zone is unusable.');
      }
      const meetings = await dependencies.locations.countRelevantSectionMeetings(
        context,
        current.id,
        schoolDate.toString(),
      );
      if (meetings > 0) {
        throw new ControlPlaneError('location_in_use', 'The location is still in use.');
      }
      const scheduled = await dependencies.locations.countActiveScheduledOrigins(
        context,
        current.id,
        now,
      );
      if (scheduled > 0) {
        throw new ControlPlaneError('location_in_use', 'The location is still in use.');
      }
      const row = await dependencies.locations.archiveToRevision(
        context,
        current.id,
        expected.revision,
        now,
      );
      if (row === null) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The location has changed since this client last read it.',
        );
      }
      await dependencies.audit.append(context, {
        action: 'location.archived',
        actorKind: 'account',
        actorId: input.principal.accountId,
        organizationId: row.organizationId,
        targetKind: 'location',
        targetId: row.id,
        outcome: 'success',
        occurredAt: now,
        requestId: input.requestId,
        metadata: {
          locationId: row.id,
          organizationId: row.organizationId,
          revision: row.revision.toString(10),
          requestId: input.requestId,
        },
      });
      await dependencies.outbox.append(context, {
        tenantId: row.tenantId,
        organizationId: row.organizationId,
        aggregateKind: 'location',
        aggregateId: row.id,
        eventType: 'location.archived',
        occurredAt: now.toString(),
        payload: {
          schemaVersion: 1,
          organizationId: row.organizationId,
          locationId: row.id,
          revision: row.revision.toString(10),
          status: row.status,
        },
      });
      const location = toLocationView(row);
      return { location, etag: etagForLocation(row.id, row.revision) };
    },
    toStored: (value) => ({ responseStatus: 200, responseBody: { location: value.location } }),
    fromStored: (record) => {
      const body = record.responseBody as { location: LocationView };
      return {
        location: body.location,
        etag: etagForLocation(body.location.id, BigInt(body.location.revision)),
      };
    },
  });
  return {
    location: outcome.value.location,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}
