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
import {
  isRoomCategoryIconKey,
  isRoomCategorySurface,
  isRoomCategoryToneKey,
} from './room-category-presentation.js';
import { ControlPlaneError } from './errors.js';
import { etagForResource, parseResourceIfMatch } from './etags.js';
import {
  controlPlaneLockKey,
  fingerprintControlPlane,
  requireControlPlaneIdempotencyKey,
  runControlPlaneCommand,
} from './idempotency.js';
import type { RoomCategoryRecord, RoomCategoryRepository } from './ports.js';
import { requireNormalSession, requireOrganizationCapability } from './shared.js';

export interface RoomCategoryDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly categories: RoomCategoryRepository;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

export interface RoomCategoryView {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly iconKey: string;
  readonly toneKey: string;
  readonly studentSurface: 'primary' | 'secondary' | 'hidden';
  readonly pickerMode: 'auto' | 'list' | 'search';
  readonly sortOrder: number;
  readonly status: 'active' | 'archived';
  readonly revision: string;
  readonly updatedAt: string;
}

export function toRoomCategoryView(row: RoomCategoryRecord): RoomCategoryView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    iconKey: row.iconKey,
    toneKey: row.toneKey,
    studentSurface: row.studentSurface,
    pickerMode: row.pickerMode,
    sortOrder: row.sortOrder,
    status: row.status,
    revision: row.revision.toString(10),
    updatedAt: row.updatedAt.toString(),
  };
}

export function etagForRoomCategory(categoryId: string, revision: bigint): string {
  return etagForResource('room-category', categoryId, revision);
}

export interface RoomCategoryCommandInput {
  readonly principal: Principal;
  readonly idempotencyKey: unknown;
  readonly requestId: string;
}

export interface RoomCategoryConfigBody {
  readonly name: unknown;
  readonly iconKey: unknown;
  readonly toneKey: unknown;
  readonly studentSurface: unknown;
  readonly pickerMode: unknown;
  readonly sortOrder: unknown;
}

export interface CreateRoomCategoryInput extends RoomCategoryCommandInput {
  readonly organizationId: string;
  readonly config: RoomCategoryConfigBody;
}

export interface UpdateRoomCategoryInput extends RoomCategoryCommandInput {
  readonly categoryId: string;
  readonly ifMatch: unknown;
  readonly config: RoomCategoryConfigBody;
}

export interface ArchiveRoomCategoryInput extends RoomCategoryCommandInput {
  readonly categoryId: string;
  readonly ifMatch: unknown;
}

export interface RoomCategoryResult {
  readonly category: RoomCategoryView;
  readonly etag: string;
  readonly status: 200 | 201;
  readonly replayed: boolean;
}

interface CanonicalCategoryConfig {
  readonly name: string;
  readonly iconKey: string;
  readonly toneKey: string;
  readonly studentSurface: 'primary' | 'secondary' | 'hidden';
  readonly pickerMode: 'auto' | 'list' | 'search';
  readonly sortOrder: number;
}

function cleanCategoryName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ControlPlaneError('invalid_precondition', 'Invalid category name.');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 100) {
    throw new ControlPlaneError('invalid_precondition', 'Invalid category name.');
  }
  return trimmed;
}

function cleanIconKey(value: unknown): string {
  if (typeof value !== 'string' || !isRoomCategoryIconKey(value)) {
    throw new ControlPlaneError('invalid_precondition', 'Invalid category icon.');
  }
  return value;
}

function cleanToneKey(value: unknown): string {
  if (typeof value !== 'string' || !isRoomCategoryToneKey(value)) {
    throw new ControlPlaneError('invalid_precondition', 'Invalid category color.');
  }
  return value;
}

function cleanSurface(value: unknown): 'primary' | 'secondary' | 'hidden' {
  if (typeof value !== 'string' || !isRoomCategorySurface(value)) {
    throw new ControlPlaneError('invalid_precondition', 'Invalid student launcher surface.');
  }
  return value;
}

function cleanSortOrder(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100000) {
    throw new ControlPlaneError('invalid_precondition', 'Invalid display order.');
  }
  return value;
}

function cleanPickerMode(value: unknown): 'auto' | 'list' | 'search' {
  if (value === 'auto' || value === 'list' || value === 'search') return value;
  throw new ControlPlaneError('invalid_precondition', 'Invalid student picker mode.');
}

/**
 * Canonicalizes category presentation metadata. There is exactly one
 * validation rule set; the migration CHECKs stay as defense in depth. The
 * icon/tone registries live in room-category-presentation.ts so new
 * choices never require a migration.
 */
function canonicalCategoryConfig(body: RoomCategoryConfigBody): CanonicalCategoryConfig {
  return {
    name: cleanCategoryName(body.name),
    iconKey: cleanIconKey(body.iconKey),
    toneKey: cleanToneKey(body.toneKey),
    studentSurface: cleanSurface(body.studentSurface),
    pickerMode: cleanPickerMode(body.pickerMode),
    sortOrder: cleanSortOrder(body.sortOrder),
  };
}

function fingerprintComponents(config: CanonicalCategoryConfig): string[] {
  return [
    config.name,
    config.iconKey,
    config.toneKey,
    config.studentSurface,
    config.pickerMode,
    String(config.sortOrder),
  ];
}

/**
 * GET /api/v1/organizations/:organizationId/destination-categories — admin
 * list, authorized with room.manage on the exact school. Ordered by
 * sort_order with a deterministic tie-break, matching the student launcher.
 */
export async function listRoomCategories(
  principal: Principal,
  organizationId: string,
  dependencies: RoomCategoryDependencies,
): Promise<{ readonly categories: readonly RoomCategoryView[] }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    await requireOrganizationCapability(
      context,
      dependencies.authorization,
      principal,
      'room.manage',
      organizationId,
      now,
      'room_category_not_found',
    );
    const rows = await dependencies.categories.listByOrganization(context, organizationId);
    return { categories: rows.map(toRoomCategoryView) };
  });
}

/**
 * GET /api/v1/destination-categories/:categoryId — authorized against the
 * category's canonical school; cross-school references are concealed.
 */
export async function getRoomCategory(
  principal: Principal,
  categoryId: string,
  dependencies: RoomCategoryDependencies,
): Promise<{ readonly category: RoomCategoryView; readonly etag: string }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const row = await dependencies.categories.loadById(context, categoryId);
    if (row?.tenantId !== principal.tenantId) {
      throw new ControlPlaneError('room_category_not_found', 'Category not found.');
    }
    await requireOrganizationCapability(
      context,
      dependencies.authorization,
      principal,
      'room.manage',
      row.organizationId,
      now,
      'room_category_not_found',
    );
    return {
      category: toRoomCategoryView(row),
      etag: etagForRoomCategory(row.id, row.revision),
    };
  });
}

/**
 * POST /api/v1/organizations/:organizationId/destination-categories — a new
 * category starts active and is immediately usable for destination grouping.
 * Active names are unique per school (case-insensitive); the partial unique
 * index enforces this and surfaces here as room_category_exists.
 */
export async function createRoomCategory(
  input: CreateRoomCategoryInput,
  dependencies: RoomCategoryDependencies,
): Promise<RoomCategoryResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const now = dependencies.clock.now();
  const config = canonicalCategoryConfig(input.config);
  const fingerprint = fingerprintControlPlane('room_category.create:v1', [
    input.organizationId,
    ...fingerprintComponents(config),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'room_category.create:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'room_category.create:v1',
      key,
    ),
    execute: async (context) => {
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'room.manage',
        input.organizationId,
        now,
        'room_category_not_found',
      );
      let row: RoomCategoryRecord;
      try {
        row = await dependencies.categories.insert(context, {
          organizationId: input.organizationId,
          ...config,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ControlPlaneError(
            'room_category_exists',
            'An active category with this name already exists.',
          );
        }
        throw error;
      }
      await appendCategoryAudit(dependencies, context, input, now, 'room_category.created', row);
      await appendCategoryOutbox(dependencies, context, now, 'room_category.created', row);
      const category = toRoomCategoryView(row);
      return { category, etag: etagForRoomCategory(row.id, row.revision) };
    },
    toStored: (value) => ({
      responseStatus: 201,
      responseBody: { category: value.category },
    }),
    fromStored: (record) => {
      const body = record.responseBody as { category: RoomCategoryView };
      return {
        category: body.category,
        etag: etagForRoomCategory(body.category.id, BigInt(body.category.revision)),
      };
    },
  });
  return {
    category: outcome.value.category,
    etag: outcome.value.etag,
    status: 201,
    replayed: outcome.replayed,
  };
}

/**
 * PUT /api/v1/destination-categories/:categoryId — presentation replacement
 * only. Status travels through the archive command. Renames never mutate
 * destination serviceType values or move destinations.
 */
export async function updateRoomCategory(
  input: UpdateRoomCategoryInput,
  dependencies: RoomCategoryDependencies,
): Promise<RoomCategoryResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const expected = parseResourceIfMatch(input.ifMatch, {
    kind: 'room-category',
    id: input.categoryId,
  });
  const now = dependencies.clock.now();
  const config = canonicalCategoryConfig(input.config);
  const fingerprint = fingerprintControlPlane('room_category.update:v1', [
    input.categoryId,
    expected.revision.toString(10),
    ...fingerprintComponents(config),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'room_category.update:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'room_category.update:v1',
      key,
    ),
    execute: async (context) => {
      const current = await dependencies.categories.loadForUpdate(context, input.categoryId);
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('room_category_not_found', 'Category not found.');
      }
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'room.manage',
        current.organizationId,
        now,
        'room_category_not_found',
      );
      if (current.revision !== expected.revision) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The category has changed since this client last read it.',
        );
      }
      if (current.status === 'archived') {
        throw new ControlPlaneError(
          'invalid_precondition',
          'Archived categories cannot be edited.',
        );
      }
      let row: RoomCategoryRecord | null;
      try {
        row = await dependencies.categories.updateToRevision(
          context,
          current.id,
          expected.revision,
          config,
          now,
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ControlPlaneError(
            'room_category_exists',
            'An active category with this name already exists.',
          );
        }
        throw error;
      }
      if (row === null) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The category has changed since this client last read it.',
        );
      }
      await appendCategoryAudit(dependencies, context, input, now, 'room_category.updated', row);
      await appendCategoryOutbox(dependencies, context, now, 'room_category.updated', row);
      const category = toRoomCategoryView(row);
      return { category, etag: etagForRoomCategory(row.id, row.revision) };
    },
    toStored: (value) => ({
      responseStatus: 200,
      responseBody: { category: value.category },
    }),
    fromStored: (record) => {
      const body = record.responseBody as { category: RoomCategoryView };
      return {
        category: body.category,
        etag: etagForRoomCategory(body.category.id, BigInt(body.category.revision)),
      };
    },
  });
  return {
    category: outcome.value.category,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}

/**
 * POST /api/v1/destination-categories/:categoryId/archive — terminal and
 * conservative. Archive is blocked while any non-archived destination still
 * references the category; archived historical destinations may keep
 * referencing it. Nothing is moved, hidden, or deleted.
 */
export async function archiveRoomCategory(
  input: ArchiveRoomCategoryInput,
  dependencies: RoomCategoryDependencies,
): Promise<RoomCategoryResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const expected = parseResourceIfMatch(input.ifMatch, {
    kind: 'room-category',
    id: input.categoryId,
  });
  const now = dependencies.clock.now();
  const fingerprint = fingerprintControlPlane('room_category.archive:v1', [
    input.categoryId,
    expected.revision.toString(10),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'room_category.archive:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'room_category.archive:v1',
      key,
    ),
    execute: async (context) => {
      const current = await dependencies.categories.loadForUpdate(context, input.categoryId);
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('room_category_not_found', 'Category not found.');
      }
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'room.manage',
        current.organizationId,
        now,
        'room_category_not_found',
      );
      if (current.revision !== expected.revision) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The category has changed since this client last read it.',
        );
      }
      if (current.status === 'archived') {
        throw new ControlPlaneError('invalid_precondition', 'The category is already archived.');
      }
      const references = await dependencies.categories.countActiveRoomReferences(
        context,
        current.id,
      );
      if (references > 0) {
        throw new ControlPlaneError(
          'room_category_in_use',
          'This category still contains destinations. Move or archive those destinations first.',
        );
      }
      const row = await dependencies.categories.archiveToRevision(
        context,
        current.id,
        expected.revision,
        now,
      );
      if (row === null) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The category has changed since this client last read it.',
        );
      }
      await appendCategoryAudit(dependencies, context, input, now, 'room_category.archived', row);
      await appendCategoryOutbox(dependencies, context, now, 'room_category.archived', row);
      const category = toRoomCategoryView(row);
      return { category, etag: etagForRoomCategory(row.id, row.revision) };
    },
    toStored: (value) => ({
      responseStatus: 200,
      responseBody: { category: value.category },
    }),
    fromStored: (record) => {
      const body = record.responseBody as { category: RoomCategoryView };
      return {
        category: body.category,
        etag: etagForRoomCategory(body.category.id, BigInt(body.category.revision)),
      };
    },
  });
  return {
    category: outcome.value.category,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('destination_category_phase10_one_active_name') ||
    message.includes('duplicate key value violates unique constraint')
  );
}

async function appendCategoryAudit(
  dependencies: RoomCategoryDependencies,
  context: TenantTransactionContext,
  input: RoomCategoryCommandInput,
  now: Temporal.Instant,
  action: string,
  row: RoomCategoryRecord,
): Promise<void> {
  await dependencies.audit.append(context, {
    action,
    actorKind: 'account',
    actorId: input.principal.accountId,
    organizationId: row.organizationId,
    targetKind: 'room_category',
    targetId: row.id,
    outcome: 'success',
    occurredAt: now,
    requestId: input.requestId,
    metadata: {
      roomCategoryId: row.id,
      organizationId: row.organizationId,
      revision: row.revision.toString(10),
      requestId: input.requestId,
    },
  });
}

async function appendCategoryOutbox(
  dependencies: RoomCategoryDependencies,
  context: TenantTransactionContext,
  now: Temporal.Instant,
  eventType: string,
  row: RoomCategoryRecord,
): Promise<void> {
  await dependencies.outbox.append(context, {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    aggregateKind: 'room_category',
    aggregateId: row.id,
    eventType,
    occurredAt: now.toString(),
    payload: {
      schemaVersion: 1,
      organizationId: row.organizationId,
      roomCategoryId: row.id,
      revision: row.revision.toString(10),
      status: row.status,
      studentSurface: row.studentSurface,
    },
  });
}
