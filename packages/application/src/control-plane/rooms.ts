import type { Temporal } from '@js-temporal/polyfill';
import type { Clock } from '@openhall/domain';
import type { AuditWriter } from '../auditing/audit.js';
import type { Principal } from '../authentication/principal.js';
import type { RelationshipAuthorizationService } from '../authorization/service.js';
import { roomFlowLockKey } from '../room-flow/locks.js';
import type { RoomFlowRepository } from '../room-flow/ports.js';
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
  RoomCategoryRecord,
  RoomCategoryRepository,
  RoomCheckInMode,
  RoomRecord,
  RoomRepository,
  RoomStatus,
} from './ports.js';
import { requireNormalSession, requireOrganizationCapability } from './shared.js';

export interface RoomDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly rooms: RoomRepository;
  readonly categories: RoomCategoryRepository;
  readonly flow: Pick<RoomFlowRepository, 'acquireRoomLock'>;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

export interface RoomView {
  readonly id: string;
  readonly organizationId: string;
  readonly categoryId: string | null;
  readonly name: string;
  readonly code: string | null;
  readonly floorLabel: string | null;
  readonly studentSelfRequestable: boolean;
  readonly originSelectable: boolean;
  readonly capacity: number | null;
  readonly queueEnabled: boolean;
  readonly checkInMode: RoomCheckInMode;
  readonly defaultDurationSeconds: number | null;
  readonly maxDurationSeconds: number | null;
  readonly readyClaimTimeoutSeconds: number;
  readonly queueTimeoutSeconds: number;
  readonly status: RoomStatus;
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Stable picker-safe projection: no occupants, identities, or policy internals. */
export interface RoomCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  readonly floorLabel: string | null;
  readonly categoryId: string | null;
  readonly checkInMode: RoomCheckInMode;
}

export interface StudentRoomCatalogRoom {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  readonly floorLabel: string | null;
  readonly checkInMode: RoomCheckInMode;
  readonly searchContext: {
    readonly teacherNames: readonly string[];
    readonly sectionLabels: readonly string[];
    readonly roomStaffNames: readonly string[];
  };
}

/** Category presentation for the student launcher (no policy/admin internals). */
export interface StudentRoomCatalogCategory {
  readonly id: string;
  readonly name: string;
  readonly iconKey: string;
  readonly toneKey: string;
  readonly pickerMode: 'auto' | 'list' | 'search';
  readonly sortOrder: number;
  readonly rooms: readonly StudentRoomCatalogRoom[];
}

export function toRoomView(row: RoomRecord): RoomView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    categoryId: row.categoryId,
    name: row.name,
    code: row.code,
    floorLabel: row.floorLabel,
    studentSelfRequestable: row.studentSelfRequestable,
    originSelectable: row.originSelectable,
    capacity: row.capacity,
    queueEnabled: row.queueEnabled,
    checkInMode: row.checkInMode,
    defaultDurationSeconds: row.defaultDurationSeconds,
    maxDurationSeconds: row.maxDurationSeconds,
    readyClaimTimeoutSeconds: row.readyClaimTimeoutSeconds,
    queueTimeoutSeconds: row.queueTimeoutSeconds,
    status: row.status,
    revision: row.revision.toString(10),
    createdAt: row.createdAt.toString(),
    updatedAt: row.updatedAt.toString(),
  };
}

export function etagForRoom(roomId: string, revision: bigint): string {
  return etagForResource('room', roomId, revision);
}

export interface RoomCommandInput {
  readonly principal: Principal;
  readonly idempotencyKey: unknown;
  readonly requestId: string;
}

export interface RoomConfigBody {
  readonly name: unknown;
  readonly code: string | null;
  readonly floorLabel: string | null;
  readonly categoryId: string | null;
  readonly studentSelfRequestable: unknown;
  readonly originSelectable: unknown;
  readonly capacity: number | null;
  readonly queueEnabled: unknown;
  readonly checkInMode: unknown;
  readonly defaultDurationSeconds: number | null;
  readonly maxDurationSeconds: number | null;
  readonly readyClaimTimeoutSeconds: unknown;
  readonly queueTimeoutSeconds: unknown;
}

export interface CreateRoomInput extends RoomCommandInput {
  readonly organizationId: string;
  readonly config: RoomConfigBody;
}

export interface UpdateRoomInput extends RoomCommandInput {
  readonly roomId: string;
  readonly ifMatch: unknown;
  readonly config: RoomConfigBody;
}

export interface RoomStatusInput extends RoomCommandInput {
  readonly roomId: string;
  readonly ifMatch: unknown;
}

export interface RoomResult {
  readonly room: RoomView;
  readonly etag: string;
  readonly status: 200 | 201;
  readonly replayed: boolean;
}

interface CanonicalRoomConfig {
  readonly name: string;
  readonly code: string | null;
  readonly floorLabel: string | null;
  readonly categoryId: string | null;
  readonly studentSelfRequestable: boolean;
  readonly originSelectable: boolean;
  readonly capacity: number | null;
  readonly queueEnabled: boolean;
  readonly checkInMode: RoomCheckInMode;
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

function cleanCheckInMode(value: unknown): RoomCheckInMode {
  if (value === 'none' || value === 'optional' || value === 'required') return value;
  throw new ControlPlaneError('invalid_precondition', 'Invalid checkInMode.');
}

/**
 * Canonicalizes room configuration using the same bounds Phase 7 expects
 * (ready-claim 5..600s, queue 60..14400s, positive capacity and durations,
 * max >= default, student-requestable rooms require a category). There is
 * exactly one validation rule set; the migration CHECKs stay as defense in
 * depth.
 */
function canonicalConfig(body: RoomConfigBody): CanonicalRoomConfig {
  const name = cleanName(body.name, 'name', 200);
  const code = cleanOptionalName(body.code, 'code', 40);
  const floorLabel = cleanOptionalName(body.floorLabel, 'floorLabel', 40);
  if (body.categoryId !== null && (typeof body.categoryId !== 'string' || body.categoryId.trim().length === 0)) {
    throw new ControlPlaneError('invalid_precondition', 'Invalid categoryId.');
  }
  if (typeof body.studentSelfRequestable !== 'boolean') {
    throw new ControlPlaneError('invalid_precondition', 'Invalid studentSelfRequestable.');
  }
  if (typeof body.originSelectable !== 'boolean') {
    throw new ControlPlaneError('invalid_precondition', 'Invalid originSelectable.');
  }
  if (typeof body.queueEnabled !== 'boolean') {
    throw new ControlPlaneError('invalid_precondition', 'Invalid queueEnabled.');
  }
  if (body.studentSelfRequestable && body.categoryId === null) {
    throw new ControlPlaneError(
      'invalid_precondition',
      'Student-requestable rooms require a category.',
    );
  }
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
    name,
    code,
    floorLabel,
    categoryId: body.categoryId === null ? null : body.categoryId.trim(),
    studentSelfRequestable: body.studentSelfRequestable,
    originSelectable: body.originSelectable,
    capacity,
    queueEnabled: body.queueEnabled,
    checkInMode,
    defaultDurationSeconds,
    maxDurationSeconds,
    readyClaimTimeoutSeconds,
    queueTimeoutSeconds,
  };
}

function fingerprintComponents(organizationId: string, config: CanonicalRoomConfig): string[] {
  return [
    organizationId,
    config.name,
    config.code ?? '',
    config.floorLabel ?? '',
    config.categoryId ?? '',
    config.studentSelfRequestable ? 'self-requestable' : 'not-self-requestable',
    config.originSelectable ? 'origin-selectable' : 'not-origin-selectable',
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
 * GET /api/v1/organizations/:organizationId/rooms — full admin DTO,
 * authorized with room.manage on the exact school.
 */
export async function listRooms(
  principal: Principal,
  organizationId: string,
  dependencies: RoomDependencies,
): Promise<{ readonly rooms: readonly RoomView[] }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    await requireOrganizationCapability(
      context,
      dependencies.authorization,
      principal,
      'room.manage',
      organizationId,
      now,
      'room_not_found',
    );
    const rows = await dependencies.rooms.listByOrganization(context, organizationId);
    return { rooms: rows.map(toRoomView) };
  });
}

/**
 * GET /api/v1/rooms/:roomId — authorized against the room's canonical
 * school; cross-school references are concealed.
 */
export async function getRoom(
  principal: Principal,
  roomId: string,
  dependencies: RoomDependencies,
): Promise<{ readonly room: RoomView; readonly etag: string }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const row = await dependencies.rooms.loadById(context, roomId);
    if (row?.tenantId !== principal.tenantId) {
      throw new ControlPlaneError('room_not_found', 'Room not found.');
    }
    await requireOrganizationCapability(
      context,
      dependencies.authorization,
      principal,
      'room.manage',
      row.organizationId,
      now,
      'room_not_found',
    );
    return {
      room: toRoomView(row),
      etag: etagForRoom(row.id, row.revision),
    };
  });
}

/**
 * GET /api/v1/me/organizations/:organizationId/rooms — stable safe catalog
 * for staff pickers. Any organization member may read it; only open rooms
 * with picker-safe fields are returned.
 */
export async function listMyRooms(
  principal: Principal,
  organizationId: string,
  dependencies: RoomDependencies,
): Promise<{ readonly rooms: readonly RoomCatalogEntry[] }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const decision = await dependencies.authorization.decideWithContext(context, {
      principal,
      capability: 'organization.context.read',
      resource: { kind: 'organization', organizationId },
      at: now,
    });
    if (!decision.allowed) {
      throw new ControlPlaneError('room_not_found', 'Room not found.');
    }
    const rows = await dependencies.rooms.listOpenCatalog(context, organizationId);
    return {
      rooms: rows
        .filter((row) => row.tenantId === principal.tenantId && row.status === 'open')
        .map((row) => ({
          id: row.id,
          name: row.name,
          code: row.code,
          floorLabel: row.floorLabel,
          categoryId: row.categoryId,
          checkInMode: row.checkInMode,
        })),
    };
  });
}

/**
 * GET /api/v1/me/organizations/:organizationId/student-room-catalog —
 * purpose-built student launcher catalog. Authorized with the canonical
 * `pass.request.self` relationship semantics: only a student who may request
 * their own pass sees it. Returns only what the launcher needs: active
 * primary/secondary categories (with pickerMode) and their eligible rooms,
 * each carrying derived search context (teachers, sections, room staff).
 * Hidden categories, archived categories, non-requestable rooms, rooms
 * without a category, and empty categories never appear. Staff and scheduled
 * flows are unaffected — they use the flat member catalog and direct
 * creation paths.
 *
 * Teacher membership never grants room staff here; staffing stays explicit.
 */
export async function listMyStudentRoomCatalog(
  principal: Principal,
  organizationId: string,
  studentId: string,
  dependencies: RoomDependencies,
): Promise<{ readonly categories: readonly StudentRoomCatalogCategory[] }> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const decision = await dependencies.authorization.decideWithContext(context, {
      principal,
      capability: 'pass.request.self',
      resource: { kind: 'student', organizationId, studentId },
      at: now,
    });
    if (!decision.allowed) {
      throw new ControlPlaneError('room_not_found', 'Room not found.');
    }
    const [categories, rooms, classContexts, staffRows] = await Promise.all([
      dependencies.categories.listByOrganization(context, organizationId),
      dependencies.rooms.listOpenCatalog(context, organizationId),
      dependencies.rooms.listRoomClassContexts(context, organizationId),
      dependencies.rooms.listActiveRoomStaff(context, organizationId),
    ]);
    const staffByRoom = new Map<string, string[]>();
    for (const row of staffRows) {
      const display = row.staffDisplayName.trim();
      if (!display) continue;
      const names = staffByRoom.get(row.roomId) ?? [];
      if (!names.includes(display)) names.push(display);
      staffByRoom.set(row.roomId, names);
    }
    const teachersByRoom = new Map<string, { teachers: string[]; sections: string[] }>();
    for (const row of classContexts) {
      const entry = teachersByRoom.get(row.roomId) ?? { teachers: [], sections: [] };
      if (!entry.teachers.includes(row.teacherDisplayName))
        entry.teachers.push(row.teacherDisplayName);
      const label =
        row.sectionCode === null || row.sectionCode.trim() === ''
          ? row.sectionTitle
          : `${row.sectionTitle} (${row.sectionCode})`;
      if (!entry.sections.includes(label)) entry.sections.push(label);
      teachersByRoom.set(row.roomId, entry);
    }
    const eligibleByCategory = new Map<string, StudentRoomCatalogRoom[]>();
    for (const row of rooms) {
      if (row.tenantId !== principal.tenantId) continue;
      if (row.status !== 'open' || !row.studentSelfRequestable) continue;
      if (row.categoryId === null) continue;
      const context = teachersByRoom.get(row.id);
      const entry: StudentRoomCatalogRoom = {
        id: row.id,
        name: row.name,
        code: row.code,
        floorLabel: row.floorLabel,
        checkInMode: row.checkInMode,
        searchContext: {
          teacherNames: context?.teachers ?? [],
          sectionLabels: context?.sections ?? [],
          roomStaffNames: staffByRoom.get(row.id) ?? [],
        },
      };
      const list = eligibleByCategory.get(row.categoryId);
      if (list) list.push(entry);
      else eligibleByCategory.set(row.categoryId, [entry]);
    }
    const result: StudentRoomCatalogCategory[] = [];
    for (const category of categories) {
      if (category.tenantId !== principal.tenantId) continue;
      if (category.status !== 'active') continue;
      if (category.studentSurface !== 'primary' && category.studentSurface !== 'secondary')
        continue;
      const eligible = eligibleByCategory.get(category.id);
      if (!eligible || eligible.length === 0) continue;
      eligible.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
      result.push({
        id: category.id,
        name: category.name,
        iconKey: category.iconKey,
        toneKey: category.toneKey,
        pickerMode: category.pickerMode,
        sortOrder: category.sortOrder,
        rooms: eligible,
      });
    }
    result.sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
    );
    return { categories: result };
  });
}

/**
 * Validates a room's category reference: null stays null; otherwise the
 * category must exist in the same tenant and school and be active.
 * Cross-school and archived references are rejected as
 * invalid_precondition. Category names never imply staffing.
 */
async function requireRoomCategory(
  context: TenantTransactionContext,
  dependencies: RoomDependencies,
  principal: Principal,
  organizationId: string,
  categoryId: string | null,
): Promise<RoomCategoryRecord | null> {
  if (categoryId === null) return null;
  const category = await dependencies.categories.loadById(context, categoryId);
  if (
    category?.tenantId !== principal.tenantId ||
    category.organizationId !== organizationId ||
    category.status !== 'active'
  ) {
    throw new ControlPlaneError('invalid_precondition', 'Invalid room category.');
  }
  return category;
}

/**
 * POST /api/v1/organizations/:organizationId/rooms — a new room starts
 * closed (never open) with its full configuration at revision 1; pass
 * visibility and staff grants are separate explicit steps.
 */
export async function createRoom(
  input: CreateRoomInput,
  dependencies: RoomDependencies,
): Promise<RoomResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const now = dependencies.clock.now();
  const config = canonicalConfig(input.config);
  const fingerprint = fingerprintControlPlane('room.create:v1', [
    ...fingerprintComponents(input.organizationId, config),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'room.create:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'room.create:v1',
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
        'room_not_found',
      );
      await requireRoomCategory(
        context,
        dependencies,
        input.principal,
        input.organizationId,
        config.categoryId,
      );
      const row = await dependencies.rooms.insert(context, {
        organizationId: input.organizationId,
        categoryId: config.categoryId,
        name: config.name,
        code: config.code,
        floorLabel: config.floorLabel,
        studentSelfRequestable: config.studentSelfRequestable,
        originSelectable: config.originSelectable,
        capacity: config.capacity,
        queueEnabled: config.queueEnabled,
        checkInMode: config.checkInMode,
        defaultDurationSeconds: config.defaultDurationSeconds,
        maxDurationSeconds: config.maxDurationSeconds,
        readyClaimTimeoutSeconds: config.readyClaimTimeoutSeconds,
        queueTimeoutSeconds: config.queueTimeoutSeconds,
      });
      await appendRoomAudit(dependencies, context, input, now, 'room.created', row);
      await appendRoomOutbox(dependencies, context, now, 'room.created', row);
      const room = toRoomView(row);
      return { room, etag: etagForRoom(row.id, row.revision) };
    },
    toStored: (value) => ({
      responseStatus: 201,
      responseBody: { room: value.room },
    }),
    fromStored: (record) => {
      const body = record.responseBody as { room: RoomView };
      return {
        room: body.room,
        etag: etagForRoom(body.room.id, BigInt(body.room.revision)),
      };
    },
  });
  return {
    room: outcome.value.room,
    etag: outcome.value.etag,
    status: 201,
    replayed: outcome.replayed,
  };
}

/**
 * PUT /api/v1/rooms/:roomId — configuration replacement only. Status
 * travels through the semantic open/close/archive commands. Edits are
 * prospective: capacity reductions never evict active reservations, queue
 * disabling never deletes queued history, and check-in changes never
 * reinterpret already-departed passes (the departure snapshot governs).
 */
export async function updateRoom(
  input: UpdateRoomInput,
  dependencies: RoomDependencies,
): Promise<RoomResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const expected = parseResourceIfMatch(input.ifMatch, {
    kind: 'room',
    id: input.roomId,
  });
  const now = dependencies.clock.now();
  const config = canonicalConfig(input.config);
  const fingerprint = fingerprintControlPlane('room.update:v1', [
    input.roomId,
    expected.revision.toString(10),
    ...fingerprintComponents('', config),
  ]);
  const outcome = await runControlPlaneCommand(dependencies.runner, dependencies.idempotency, now, {
    identity: {
      tenantId: input.principal.tenantId,
      actorAccountId: input.principal.accountId,
      command: 'room.update:v1',
      key,
      fingerprint,
    },
    lockKey: controlPlaneLockKey(
      input.principal.tenantId,
      input.principal.accountId,
      'room.update:v1',
      key,
    ),
    execute: async (context) => {
      const current = await dependencies.rooms.loadForUpdate(context, input.roomId);
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('room_not_found', 'Room not found.');
      }
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'room.manage',
        current.organizationId,
        now,
        'room_not_found',
      );
      if (current.revision !== expected.revision) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The room has changed since this client last read it.',
        );
      }
      if (current.status === 'archived') {
        throw new ControlPlaneError(
          'invalid_room_state',
          'Archived rooms cannot be edited.',
        );
      }
      await requireRoomCategory(
        context,
        dependencies,
        input.principal,
        current.organizationId,
        config.categoryId,
      );
      const row = await dependencies.rooms.updateToRevision(
        context,
        current.id,
        expected.revision,
        config,
        now,
      );
      if (row === null) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The room has changed since this client last read it.',
        );
      }
      await appendRoomAudit(dependencies, context, input, now, 'room.updated', row);
      await appendRoomOutbox(dependencies, context, now, 'room.updated', row);
      const room = toRoomView(row);
      return { room, etag: etagForRoom(row.id, row.revision) };
    },
    toStored: (value) => ({
      responseStatus: 200,
      responseBody: { room: value.room },
    }),
    fromStored: (record) => {
      const body = record.responseBody as { room: RoomView };
      return {
        room: body.room,
        etag: etagForRoom(body.room.id, BigInt(body.room.revision)),
      };
    },
  });
  return {
    room: outcome.value.room,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}

async function executeStatusCommand(
  command: ControlPlaneCommand,
  action: string,
  input: RoomStatusInput,
  from: RoomStatus | readonly RoomStatus[],
  to: RoomStatus,
  alreadyCode: 'room_already_open' | 'room_already_closed' | null,
  dependencies: RoomDependencies,
): Promise<RoomResult> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const expected = parseResourceIfMatch(input.ifMatch, {
    kind: 'room',
    id: input.roomId,
  });
  const now = dependencies.clock.now();
  const fingerprint = fingerprintControlPlane(command, [
    input.roomId,
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
      if (command === 'room.archive:v1') {
        // Archive inspects live reservations, so it coordinates with the
        // Phase 7 room lock before touching the config row. Lock order
        // (idempotency lock, flow lock, config row) cannot cycle: Phase 7
        // paths take pass row -> flow lock and only read the config row
        // without locking it.
        await dependencies.flow.acquireRoomLock(
          context,
          roomFlowLockKey(input.principal.tenantId, input.roomId),
        );
      }
      const current = await dependencies.rooms.loadForUpdate(context, input.roomId);
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('room_not_found', 'Room not found.');
      }
      await requireOrganizationCapability(
        context,
        dependencies.authorization,
        input.principal,
        'room.manage',
        current.organizationId,
        now,
        'room_not_found',
      );
      if (current.revision !== expected.revision) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The room has changed since this client last read it.',
        );
      }
      const allowed = Array.isArray(from) ? from : [from];
      if (!allowed.includes(current.status)) {
        if (alreadyCode !== null && current.status === to) {
          throw new ControlPlaneError(
            alreadyCode,
            `The room is already ${to === 'open' ? 'open' : 'closed'}.`,
          );
        }
        throw new ControlPlaneError(
          'invalid_room_state',
          'The room cannot change status from its current state.',
        );
      }
      if (command === 'room.archive:v1') {
        await assertArchivable(dependencies, context, now, current);
      }
      const row = await dependencies.rooms.transitionStatusToRevision(
        context,
        current.id,
        expected.revision,
        to,
        now,
      );
      if (row === null) {
        throw new ControlPlaneError(
          'stale_resource_revision',
          'The room has changed since this client last read it.',
        );
      }
      await appendRoomAudit(dependencies, context, input, now, action, row);
      await appendRoomOutbox(dependencies, context, now, action, row);
      const room = toRoomView(row);
      return { room, etag: etagForRoom(row.id, row.revision) };
    },
    toStored: (value) => ({
      responseStatus: 200,
      responseBody: { room: value.room },
    }),
    fromStored: (record) => {
      const body = record.responseBody as { room: RoomView };
      return {
        room: body.room,
        etag: etagForRoom(body.room.id, BigInt(body.room.revision)),
      };
    },
  });
  return {
    room: outcome.value.room,
    etag: outcome.value.etag,
    status: 200,
    replayed: outcome.replayed,
  };
}

async function assertArchivable(
  dependencies: RoomDependencies,
  context: TenantTransactionContext,
  now: Temporal.Instant,
  current: RoomRecord,
): Promise<void> {
  const [passes, grants, rules, scheduled, meetings, origins] = await Promise.all([
    dependencies.rooms.countLivePasses(context, current.id),
    dependencies.rooms.countActiveStaffGrants(context, current.id),
    dependencies.rooms.countEnabledPolicyRules(context, current.id),
    dependencies.rooms.countLiveScheduledAuthorizations(context, current.id, now),
    dependencies.rooms.countRelevantSectionMeetings(
      context,
      current.id,
      now.toZonedDateTimeISO('UTC').toPlainDate().toString(),
    ),
    dependencies.rooms.countActiveScheduledOrigins(context, current.id, now),
  ]);
  if (passes > 0 || grants > 0 || rules > 0 || scheduled > 0 || meetings > 0 || origins > 0) {
    // No dependency details: administrators resolve references explicitly
    // through rooms, grants, policy, and scheduling surfaces instead.
    throw new ControlPlaneError('room_in_use', 'The room is still in use.');
  }
}

/** POST /api/v1/rooms/:roomId/open — closed -> open. */
export async function openRoom(
  input: RoomStatusInput,
  dependencies: RoomDependencies,
): Promise<RoomResult> {
  return executeStatusCommand(
    'room.open:v1',
    'room.opened',
    input,
    'closed',
    'open',
    'room_already_open',
    dependencies,
  );
}

/**
 * POST /api/v1/rooms/:roomId/close — no new pre-departure movement.
 * Already-moving passes keep their explicit physical state; Phase 7
 * reconciliation handles queued/ready pre-departure work.
 */
export async function closeRoom(
  input: RoomStatusInput,
  dependencies: RoomDependencies,
): Promise<RoomResult> {
  return executeStatusCommand(
    'room.close:v1',
    'room.closed',
    input,
    'open',
    'closed',
    'room_already_closed',
    dependencies,
  );
}

/** POST /api/v1/rooms/:roomId/archive — terminal, guarded. */
export async function archiveRoom(
  input: RoomStatusInput,
  dependencies: RoomDependencies,
): Promise<RoomResult> {
  return executeStatusCommand(
    'room.archive:v1',
    'room.archived',
    input,
    ['open', 'closed'],
    'archived',
    null,
    dependencies,
  );
}

async function appendRoomAudit(
  dependencies: RoomDependencies,
  context: TenantTransactionContext,
  input: RoomCommandInput,
  now: Temporal.Instant,
  action: string,
  row: RoomRecord,
): Promise<void> {
  await dependencies.audit.append(context, {
    action,
    actorKind: 'account',
    actorId: input.principal.accountId,
    organizationId: row.organizationId,
    targetKind: 'room',
    targetId: row.id,
    outcome: 'success',
    occurredAt: now,
    requestId: input.requestId,
    metadata: {
      roomId: row.id,
      organizationId: row.organizationId,
      categoryId: row.categoryId ?? '',
      studentSelfRequestable: row.studentSelfRequestable ? 'true' : 'false',
      revision: row.revision.toString(10),
      requestId: input.requestId,
    },
  });
}

async function appendRoomOutbox(
  dependencies: RoomDependencies,
  context: TenantTransactionContext,
  now: Temporal.Instant,
  eventType: string,
  row: RoomRecord,
): Promise<void> {
  await dependencies.outbox.append(context, {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    aggregateKind: 'room',
    aggregateId: row.id,
    eventType,
    occurredAt: now.toString(),
    payload: {
      schemaVersion: 1,
      organizationId: row.organizationId,
      roomId: row.id,
      categoryId: row.categoryId,
      studentSelfRequestable: row.studentSelfRequestable,
      revision: row.revision.toString(10),
      status: row.status,
      checkInMode: row.checkInMode,
      queueEnabled: row.queueEnabled,
    },
  });
}
