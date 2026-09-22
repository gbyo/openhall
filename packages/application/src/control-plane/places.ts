import type { Temporal } from '@js-temporal/polyfill';
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
import { toDestinationView, type DestinationView } from './destinations.js';
import { ControlPlaneError } from './errors.js';
import {
  controlPlaneLockKey,
  fingerprintControlPlane,
  requireControlPlaneIdempotencyKey,
  runControlPlaneCommand,
} from './idempotency.js';
import type {
  DestinationRecord,
  DestinationRepository,
  DestinationCategoryRepository,
  LocationRecord,
  LocationRepository,
  PlacesRepository,
} from './ports.js';
import { requireNormalSession, requireOrganizationCapability, schoolDateFor } from './shared.js';

export interface PlaceDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly locations: LocationRepository;
  readonly destinations: DestinationRepository;
  readonly categories: DestinationCategoryRepository;
  readonly places: PlacesRepository;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

export interface PlaceClassDetailView {
  readonly title: string;
  readonly code: string | null;
  readonly teacherNames: readonly string[];
}

export interface PlaceClassUsageView {
  readonly sectionCount: number;
  readonly teacherNames: readonly string[];
  /** Per-class detail. Empty on the list projection; filled on Place detail. */
  readonly classes: readonly PlaceClassDetailView[];
}

export interface PlaceDestinationEntry {
  readonly id: string;
  readonly displayName: string;
  readonly categoryId: string;
  readonly status: 'active' | 'closed' | 'archived';
  readonly studentSelfRequestable: boolean;
}

export interface PlaceDestinationSummary {
  readonly count: number;
  readonly destinations: readonly PlaceDestinationEntry[];
}

/**
 * Purpose-built admin Place projection. The main Places page represents
 * LOCATION rows; classroom teacher associations derive from current school
 * academic records and destination counts group ordinary Destination rows.
 * No private data beyond what administration already sees.
 */
export interface PlaceAdminView {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly kind: string;
  readonly code: string | null;
  readonly floorLabel: string | null;
  readonly parentLocationId: string | null;
  readonly parentName: string | null;
  readonly status: 'active' | 'inactive' | 'archived';
  readonly classUsage: PlaceClassUsageView;
  readonly destinationSummary: PlaceDestinationSummary;
  readonly revision: string;
  readonly updatedAt: string;
}

function destinationEntry(row: DestinationRecord): PlaceDestinationEntry {
  return {
    id: row.id,
    displayName: row.displayName ?? row.serviceType,
    categoryId: row.categoryId,
    status: row.status,
    studentSelfRequestable: row.studentSelfRequestable,
  };
}

function toPlaceAdminView(
  row: LocationRecord,
  parentName: string | null,
  teacherNames: readonly string[],
  sectionCount: number,
  classes: readonly PlaceClassDetailView[],
  destinations: readonly DestinationRecord[],
): PlaceAdminView {
  const entries = destinations.map(destinationEntry);
  entries.sort((a, b) => a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' }));
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    kind: row.kind,
    code: row.code,
    floorLabel: row.floorLabel,
    parentLocationId: row.parentLocationId,
    parentName,
    status: row.status,
    classUsage: { sectionCount, teacherNames, classes },
    destinationSummary: { count: entries.length, destinations: entries },
    revision: row.revision.toString(10),
    updatedAt: row.updatedAt.toString(),
  };
}

async function schoolToday(
  context: TenantTransactionContext,
  dependencies: PlaceDependencies,
  organizationId: string,
  now: Temporal.Instant,
): Promise<string | null> {
  const timeZone = await dependencies.locations.loadSchoolTimeZone(context, organizationId);
  if (timeZone === null) return null;
  return schoolDateFor(now, timeZone)?.toString() ?? null;
}

/**
 * GET /api/v1/organizations/:organizationId/places — admin Places list.
 * Authorized with destination.manage on the exact school. Exactly three
 * batched reads (locations, destinations, class usage): no N+1.
 */
export async function listPlaces(
  principal: Principal,
  organizationId: string,
  dependencies: PlaceDependencies,
): Promise<{ readonly places: readonly PlaceAdminView[] }> {
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
    const [locations, destinations] = await Promise.all([
      dependencies.locations.listByOrganization(context, organizationId),
      dependencies.destinations.listByOrganization(context, organizationId),
    ]);
    const today = await schoolToday(context, dependencies, organizationId, now);
    const usage =
      today === null
        ? []
        : await dependencies.places.listClassUsageByOrganization(context, organizationId, today);
    const usageByLocation = new Map(usage.map((entry) => [entry.locationId, entry]));
    const destinationsByLocation = new Map<string, DestinationRecord[]>();
    for (const row of destinations) {
      if (row.tenantId !== principal.tenantId) continue;
      if (row.status === 'archived') continue;
      const list = destinationsByLocation.get(row.locationId);
      if (list) list.push(row);
      else destinationsByLocation.set(row.locationId, [row]);
    }
    const names = new Map(
      locations
        .filter((location) => location.tenantId === principal.tenantId)
        .map((location) => [location.id, location.name] as const),
    );
    const places: PlaceAdminView[] = [];
    for (const row of locations) {
      if (row.tenantId !== principal.tenantId) continue;
      const used = usageByLocation.get(row.id);
      places.push(
        toPlaceAdminView(
          row,
          row.parentLocationId === null ? null : (names.get(row.parentLocationId) ?? null),
          used?.teacherNames ?? [],
          used?.sectionCount ?? 0,
          [],
          destinationsByLocation.get(row.id) ?? [],
        ),
      );
    }
    places.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    return { places };
  });
}

/**
 * GET /api/v1/places/:locationId — one Place with its classes and pass
 * destinations. Authorized against the Place's canonical school.
 */
export async function getPlace(
  principal: Principal,
  locationId: string,
  dependencies: PlaceDependencies,
): Promise<{ readonly place: PlaceAdminView }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const row = await dependencies.locations.loadById(context, locationId);
    if (row?.tenantId !== principal.tenantId) {
      throw new ControlPlaneError('location_not_found', 'Place not found.');
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
    const [destinations, locations] = await Promise.all([
      dependencies.destinations.listByOrganization(context, row.organizationId),
      dependencies.locations.listByOrganization(context, row.organizationId),
    ]);
    const today = await schoolToday(context, dependencies, row.organizationId, now);
    const usage =
      today === null
        ? []
        : await dependencies.places.listClassUsageByOrganization(
            context,
            row.organizationId,
            today,
          );
    const used = usage.find((entry) => entry.locationId === row.id);
    const names = new Map(locations.map((location) => [location.id, location.name] as const));
    const mine = destinations.filter(
      (destination) =>
        destination.tenantId === principal.tenantId &&
        destination.locationId === row.id &&
        destination.status !== 'archived',
    );
    const classes =
      today === null
        ? []
        : await dependencies.places.listClassDetailsByLocation(
            context,
            row.organizationId,
            row.id,
            today,
          );
    return {
      place: toPlaceAdminView(
        row,
        row.parentLocationId === null ? null : (names.get(row.parentLocationId) ?? null),
        used?.teacherNames ?? [],
        used?.sectionCount ?? 0,
        classes.map((entry) => ({
          title: entry.title,
          code: entry.code,
          teacherNames: entry.teacherNames,
        })),
        mine,
      ),
    };
  });
}

export interface BulkCreateDestinationsInput {
  readonly principal: Principal;
  readonly idempotencyKey: unknown;
  readonly requestId: string;
  readonly organizationId: string;
  readonly locationIds: readonly string[];
  readonly categoryId: string;
  readonly studentSelfRequestable: boolean;
  readonly checkInMode?: unknown;
  readonly capacity?: number | null | undefined;
  readonly defaultDurationSeconds?: number | null | undefined;
}

export interface BulkCreateDestinationsResult {
  readonly created: readonly DestinationView[];
  readonly skippedLocationIds: readonly string[];
  readonly status: 200 | 201;
  readonly replayed: boolean;
}

function assertCheckInMode(value: unknown): 'none' | 'optional' | 'required' {
  if (value === 'none' || value === 'optional' || value === 'required') return value;
  throw new ControlPlaneError('invalid_precondition', 'Invalid checkInMode.');
}

function cleanBulkIds(value: readonly string[]): string[] {
  const ids = [...new Set(value)];
  if (ids.length === 0 || ids.length > 500) {
    throw new ControlPlaneError('invalid_precondition', 'Invalid location selection.');
  }
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new ControlPlaneError('invalid_precondition', 'Invalid location selection.');
    }
  }
  return ids;
}

/**
 * Idempotent server-side bulk command: one ordinary destination per
 * selected Place (never one per class). Verifies every location belongs to
 * the school and is active, and the category is active in the same school,
 * before creating anything — partial invalid input creates nothing. A
 * Place is already covered when a non-archived destination exists at the
 * same Place in the selected category, so retries never duplicate. No
 * global unique category+location rule: several counselors may share one
 * Place. Classroom teachers never receive destination_staff grants here;
 * their association stays derived from scheduling.
 */
export async function bulkCreateDestinationsFromLocations(
  input: BulkCreateDestinationsInput,
  dependencies: PlaceDependencies,
): Promise<BulkCreateDestinationsResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const now = dependencies.clock.now();
  const locationIds = cleanBulkIds(input.locationIds);
  if (typeof input.categoryId !== 'string' || input.categoryId.trim().length === 0) {
    throw new ControlPlaneError('invalid_precondition', 'Invalid destination category.');
  }
  if (typeof input.studentSelfRequestable !== 'boolean') {
    throw new ControlPlaneError('invalid_precondition', 'Invalid studentSelfRequestable.');
  }
  const checkInMode: 'none' | 'optional' | 'required' =
    input.checkInMode === undefined || input.checkInMode === null
      ? 'none'
      : assertCheckInMode(input.checkInMode);
  const capacity = input.capacity ?? null;
  if (capacity !== null && (!Number.isInteger(capacity) || capacity <= 0)) {
    throw new ControlPlaneError('invalid_precondition', 'Invalid capacity.');
  }
  const defaultDurationSeconds = input.defaultDurationSeconds ?? null;
  if (
    defaultDurationSeconds !== null &&
    (!Number.isInteger(defaultDurationSeconds) || defaultDurationSeconds <= 0)
  ) {
    throw new ControlPlaneError('invalid_precondition', 'Invalid defaultDurationSeconds.');
  }
  const fingerprint = fingerprintControlPlane('destination.bulk_create_from_locations:v1', [
    input.organizationId,
    ...locationIds,
    input.categoryId,
    input.studentSelfRequestable ? 'self-requestable' : 'not-self-requestable',
    checkInMode,
    capacity === null ? '' : String(capacity),
    defaultDurationSeconds === null ? '' : String(defaultDurationSeconds),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'destination.bulk_create_from_locations:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'destination.bulk_create_from_locations:v1',
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
      const category = await dependencies.categories.loadById(context, input.categoryId);
      if (
        category?.tenantId !== input.principal.tenantId ||
        category.organizationId !== input.organizationId ||
        category.status !== 'active'
      ) {
        throw new ControlPlaneError('invalid_precondition', 'Invalid destination category.');
      }
      const byId = new Map<string, LocationRecord>();
      for (const locationId of locationIds) {
        const location = await dependencies.locations.loadById(context, locationId);
        if (
          location?.tenantId !== input.principal.tenantId ||
          location.organizationId !== input.organizationId ||
          location.status !== 'active'
        ) {
          throw new ControlPlaneError('invalid_precondition', 'Invalid place selection.');
        }
        byId.set(location.id, location);
      }
      const existing = await dependencies.destinations.listByOrganization(
        context,
        input.organizationId,
      );
      const covered = new Set<string>();
      for (const row of existing) {
        if (row.tenantId !== input.principal.tenantId) continue;
        if (row.status === 'archived') continue;
        if (row.categoryId !== input.categoryId) continue;
        covered.add(row.locationId);
      }
      const created: DestinationView[] = [];
      const skippedLocationIds: string[] = [];
      for (const locationId of locationIds) {
        if (covered.has(locationId)) {
          skippedLocationIds.push(locationId);
          continue;
        }
        const location = byId.get(locationId);
        if (!location) continue;
        const row = await dependencies.destinations.insert(context, {
          organizationId: input.organizationId,
          locationId: location.id,
          categoryId: input.categoryId,
          studentSelfRequestable: input.studentSelfRequestable,
          serviceType: 'room_visit',
          displayName: location.name,
          capacity,
          queueEnabled: false,
          checkInMode,
          defaultDurationSeconds,
          maxDurationSeconds: null,
          readyClaimTimeoutSeconds: 120,
          queueTimeoutSeconds: 1800,
        });
        await appendBulkAudit(dependencies, context, input, now, row);
        await appendBulkOutbox(dependencies, context, now, row);
        created.push(toDestinationView(row));
        covered.add(locationId);
      }
      return { created, skippedLocationIds };
    },
    toStored: (value) => ({
      responseStatus: 200,
      responseBody: {
        created: value.created,
        skippedLocationIds: value.skippedLocationIds,
      },
    }),
    fromStored: (record) => {
      const body = record.responseBody as {
        created: DestinationView[];
        skippedLocationIds: string[];
      };
      return { created: body.created, skippedLocationIds: body.skippedLocationIds };
    },
  });
  return {
    created: outcome.value.created,
    skippedLocationIds: outcome.value.skippedLocationIds,
    status: 200,
    replayed: outcome.replayed,
  };
}

async function appendBulkAudit(
  dependencies: PlaceDependencies,
  context: TenantTransactionContext,
  input: BulkCreateDestinationsInput,
  now: Temporal.Instant,
  row: DestinationRecord,
): Promise<void> {
  await dependencies.audit.append(context, {
    action: 'destination.created',
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
      categoryId: row.categoryId,
      studentSelfRequestable: row.studentSelfRequestable ? 'true' : 'false',
      revision: row.revision.toString(10),
      requestId: input.requestId,
    },
  });
}

async function appendBulkOutbox(
  dependencies: PlaceDependencies,
  context: TenantTransactionContext,
  now: Temporal.Instant,
  row: DestinationRecord,
): Promise<void> {
  await dependencies.outbox.append(context, {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    aggregateKind: 'destination',
    aggregateId: row.id,
    eventType: 'destination.created',
    occurredAt: now.toString(),
    payload: {
      schemaVersion: 1,
      organizationId: row.organizationId,
      destinationId: row.id,
      categoryId: row.categoryId,
      studentSelfRequestable: row.studentSelfRequestable,
      revision: row.revision.toString(10),
      status: row.status,
      checkInMode: row.checkInMode,
      queueEnabled: row.queueEnabled,
    },
  });
}
