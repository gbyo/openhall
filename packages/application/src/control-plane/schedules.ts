import { Temporal } from '@js-temporal/polyfill';
import {
  SCHEDULE_BLOCK_KINDS,
  type CalendarDayKind,
  type ScheduleBlockKind,
} from '@openhall/domain';
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
import { etagForSchedule, parseResourceIfMatch } from './etags.js';
import {
  controlPlaneLockKey,
  fingerprintControlPlane,
  requireControlPlaneIdempotencyKey,
  runControlPlaneCommand,
  type ControlPlaneCommand,
} from './idempotency.js';
import type {
  CalendarDayRecord,
  LocationRepository,
  ScheduleAdminRepository,
  ScheduleBlockRecord,
  ScheduleConfigurationRecord,
  ScheduleSlotRecord,
  ScheduleTemplateRecord,
} from './ports.js';
import { requireNormalSession, requireOrganizationCapability, schoolDateFor } from './shared.js';

export interface ScheduleDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly schedules: ScheduleAdminRepository;
  readonly locations: LocationRepository;
  readonly idempotency: IdempotencyTransactionStore;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
}

export interface ScheduleBlockView {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  readonly kind: ScheduleBlockKind;
  readonly status: 'active' | 'archived';
}

export interface ScheduleSlotView {
  readonly id: string;
  readonly blockId: string;
  readonly blockCode: string;
  readonly blockDisplayName: string;
  readonly blockKind: ScheduleBlockKind;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly ordinal: number;
}

export interface ScheduleTemplateView {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'archived';
  readonly slots: readonly ScheduleSlotView[];
}

export interface CalendarDayView {
  readonly date: string;
  readonly dayKind: CalendarDayKind;
  readonly templateId: string | null;
  readonly templateName: string | null;
  readonly cycleCode: string | null;
  readonly operationalNote: string | null;
}

export function toScheduleBlockView(row: ScheduleBlockRecord): ScheduleBlockView {
  return {
    id: row.id,
    code: row.code,
    displayName: row.displayName,
    kind: row.kind,
    status: row.status,
  };
}

export function toScheduleSlotView(row: ScheduleSlotRecord): ScheduleSlotView {
  return {
    id: row.id,
    blockId: row.blockId,
    blockCode: row.blockCode,
    blockDisplayName: row.blockDisplayName,
    blockKind: row.blockKind,
    startsAt: row.startsAt.toString().slice(0, 8),
    endsAt: row.endsAt.toString().slice(0, 8),
    ordinal: row.ordinal,
  };
}

export function toScheduleTemplateView(
  row: ScheduleTemplateRecord,
  slots: readonly ScheduleSlotRecord[],
): ScheduleTemplateView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    slots: slots.map(toScheduleSlotView),
  };
}

export function toCalendarDayView(row: CalendarDayRecord): CalendarDayView {
  return {
    date: row.date.toString(),
    dayKind: row.dayKind,
    templateId: row.templateId,
    templateName: row.templateName,
    cycleCode: row.cycleCode,
    operationalNote: row.operationalNote,
  };
}

export interface ScheduleCommandInput {
  readonly principal: Principal;
  readonly organizationId: string;
  readonly ifMatch: unknown;
  readonly idempotencyKey: unknown;
  readonly requestId: string;
}

export interface ScheduleResult<T> {
  readonly value: T;
  readonly etag: string;
  readonly revision: string;
  readonly status: 200 | 201;
  readonly replayed: boolean;
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

function cleanBlockKind(value: unknown): ScheduleBlockKind {
  if (typeof value === 'string' && (SCHEDULE_BLOCK_KINDS as readonly string[]).includes(value)) {
    return value as ScheduleBlockKind;
  }
  throw new ControlPlaneError('invalid_precondition', 'Invalid block kind.');
}

function cleanDayKind(value: unknown): CalendarDayKind {
  if (value === 'instructional' || value === 'non_instructional' || value === 'closed') {
    return value;
  }
  throw new ControlPlaneError('invalid_precondition', 'Invalid day kind.');
}

function parseDate(value: unknown): Temporal.PlainDate {
  if (typeof value !== 'string') {
    throw new ControlPlaneError('invalid_precondition', 'Invalid date.');
  }
  try {
    return Temporal.PlainDate.from(value);
  } catch {
    throw new ControlPlaneError('invalid_precondition', 'Invalid date.');
  }
}

function parseTime(value: unknown, field: string): Temporal.PlainTime {
  if (typeof value !== 'string') {
    throw new ControlPlaneError('invalid_precondition', `Invalid ${field}.`);
  }
  try {
    return Temporal.PlainTime.from(value);
  } catch {
    throw new ControlPlaneError('invalid_precondition', `Invalid ${field}.`);
  }
}

interface CanonicalSlot {
  readonly blockId: string;
  readonly startsAt: Temporal.PlainTime;
  readonly endsAt: Temporal.PlainTime;
  readonly ordinal: number;
}

/**
 * Authorizes schedule.manage on the exact school, locks the schedule
 * configuration aggregate, and binds the caller schedule ETag. The
 * aggregate revision is the only concurrency token: blocks and templates
 * carry no per-row revisions.
 */
async function lockAggregate(
  context: TenantTransactionContext,
  dependencies: ScheduleDependencies,
  principal: Principal,
  organizationId: string,
  ifMatch: unknown,
  now: Temporal.Instant,
): Promise<ScheduleConfigurationRecord> {
  await requireOrganizationCapability(
    context,
    dependencies.authorization,
    principal,
    'schedule.manage',
    organizationId,
    now,
    'schedule_not_found',
  );
  const configuration = await dependencies.schedules.loadConfigurationForUpdate(
    context,
    organizationId,
  );
  if (configuration === null) {
    // Never fabricate a missing aggregate: school provisioning owns creation.
    throw new ControlPlaneError('schedule_not_found', 'Schedule not found.');
  }
  const expected = parseResourceIfMatch(ifMatch, { kind: 'schedule', id: organizationId });
  if (configuration.revision !== expected.revision) {
    throw new ControlPlaneError(
      'stale_resource_revision',
      'The schedule has changed since this client last read it.',
    );
  }
  return configuration;
}

async function todayForSchool(
  context: TenantTransactionContext,
  dependencies: ScheduleDependencies,
  organizationId: string,
  now: Temporal.Instant,
): Promise<string> {
  const timeZone = await dependencies.locations.loadSchoolTimeZone(context, organizationId);
  const date = timeZone === null ? null : schoolDateFor(now, timeZone);
  if (date === null) {
    throw new ControlPlaneError('invalid_precondition', 'School time zone is unusable.');
  }
  return date.toString();
}

async function appendScheduleAudit(
  dependencies: ScheduleDependencies,
  context: TenantTransactionContext,
  principal: Principal,
  organizationId: string,
  action: string,
  revision: bigint,
  requestId: string,
  now: Temporal.Instant,
  resource: Record<string, string>,
): Promise<void> {
  await dependencies.audit.append(context, {
    action,
    actorKind: 'account',
    actorId: principal.accountId,
    organizationId,
    targetKind: 'school_schedule',
    targetId: organizationId,
    outcome: 'success',
    occurredAt: now,
    requestId,
    metadata: {
      organizationId,
      revision: revision.toString(10),
      requestId,
      ...resource,
    },
  });
}

/**
 * Every schedule change emits one minimized schedule.updated outbox fact for
 * the aggregate revision — never per-slot or per-day facts, and never the
 * raw configuration when it is not needed.
 */
async function appendScheduleOutbox(
  dependencies: ScheduleDependencies,
  context: TenantTransactionContext,
  organizationId: string,
  tenantId: string,
  revision: bigint,
  now: Temporal.Instant,
): Promise<void> {
  await dependencies.outbox.append(context, {
    tenantId,
    organizationId,
    aggregateKind: 'school_schedule',
    aggregateId: organizationId,
    eventType: 'schedule.updated',
    occurredAt: now.toString(),
    payload: {
      schemaVersion: 1,
      organizationId,
      revision: revision.toString(10),
    },
  });
}

async function executeScheduleCommand<T>(
  command: ControlPlaneCommand,
  input: ScheduleCommandInput,
  fingerprintComponents: readonly string[],
  dependencies: ScheduleDependencies,
  mutate: (
    context: TenantTransactionContext,
    now: Temporal.Instant,
  ) => Promise<{ readonly value: T; readonly action: string }>,
  toStored: (value: T) => { readonly responseStatus: number; readonly responseBody: unknown },
  fromStoredValue: (storedValue: unknown) => T,
  created: boolean,
): Promise<ScheduleResult<T>> {
  requireNormalSession(input.principal);
  const key = requireControlPlaneIdempotencyKey(input.idempotencyKey);
  const now = dependencies.clock.now();
  const fingerprint = fingerprintControlPlane(command, [
    input.organizationId,
    ...fingerprintComponents,
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
      const configuration = await lockAggregate(
        context,
        dependencies,
        input.principal,
        input.organizationId,
        input.ifMatch,
        now,
      );
      const mutated = await mutate(context, now);
      const bumped = await dependencies.schedules.bumpConfigurationRevision(
        context,
        input.organizationId,
        now,
      );
      await appendScheduleAudit(
        dependencies,
        context,
        input.principal,
        input.organizationId,
        mutated.action,
        bumped.revision,
        input.requestId,
        now,
        { expectedRevision: configuration.revision.toString(10) },
      );
      await appendScheduleOutbox(
        dependencies,
        context,
        input.organizationId,
        input.principal.tenantId,
        bumped.revision,
        now,
      );
      return {
        value: mutated.value,
        revision: bumped.revision.toString(10),
      };
    },
    toStored: (value) => ({
      responseStatus: created ? 201 : 200,
      responseBody: { value: toStored(value.value).responseBody, revision: value.revision },
    }),
    fromStored: (record) => {
      const body = record.responseBody as { value: unknown; revision: string };
      return { value: fromStoredValue(body.value), revision: body.revision };
    },
  });
  return {
    value: outcome.value.value,
    etag: etagForSchedule(input.organizationId, BigInt(outcome.value.revision)),
    revision: outcome.value.revision,
    status: created ? 201 : 200,
    replayed: outcome.replayed,
  };
}

/**
 * Validates a template slot set atomically and derives ordinals from
 * validated sorted order (1..n by start time). The client never assigns
 * ordinals. Exact adjacent boundaries are allowed; any overlap is rejected.
 */
function validateSlots(
  rawSlots: readonly {
    readonly blockId: string;
    readonly startsAt: unknown;
    readonly endsAt: unknown;
  }[],
  blocksById: ReadonlyMap<string, ScheduleBlockRecord>,
): CanonicalSlot[] {
  const parsed = rawSlots.map((slot, index) => {
    const startsAt = parseTime(slot.startsAt, `slot startsAt at index ${String(index)}`);
    const endsAt = parseTime(slot.endsAt, `slot endsAt at index ${String(index)}`);
    if (Temporal.PlainTime.compare(startsAt, endsAt) >= 0) {
      throw new ControlPlaneError(
        'schedule_slots_overlap',
        `Slot at index ${String(index)} ends before it starts.`,
      );
    }
    const block = blocksById.get(slot.blockId);
    if (block?.status !== 'active') {
      throw new ControlPlaneError('schedule_block_not_found', 'Schedule block not found.');
    }
    return { blockId: slot.blockId, startsAt, endsAt };
  });
  const byStart = [...parsed].sort((a, b) => Temporal.PlainTime.compare(a.startsAt, b.startsAt));
  for (let index = 1; index < byStart.length; index += 1) {
    const previous = byStart[index - 1];
    const current = byStart[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      Temporal.PlainTime.compare(current.startsAt, previous.endsAt) < 0
    ) {
      throw new ControlPlaneError('schedule_slots_overlap', 'Schedule slots overlap.');
    }
  }
  return byStart.map((slot, index) => ({ ...slot, ordinal: index + 1 }));
}

/**
 * Schedule reads are views of one aggregate, so every response carries the
 * same current strong schedule ETag. Reads authorize schedule.view: they
 * never mutate and never require the caller to hold a stale token.
 */
async function readAggregate(
  context: TenantTransactionContext,
  dependencies: ScheduleDependencies,
  principal: Principal,
  organizationId: string,
  now: Temporal.Instant,
): Promise<{ readonly revision: bigint; readonly etag: string }> {
  await requireOrganizationCapability(
    context,
    dependencies.authorization,
    principal,
    'schedule.view',
    organizationId,
    now,
    'schedule_not_found',
  );
  const configuration = await dependencies.schedules.loadConfigurationForUpdate(
    context,
    organizationId,
  );
  if (configuration === null) {
    throw new ControlPlaneError('schedule_not_found', 'Schedule not found.');
  }
  return {
    revision: configuration.revision,
    etag: etagForSchedule(organizationId, configuration.revision),
  };
}

/** GET /schedule/blocks — every response exposes the current schedule ETag. */
export async function listScheduleBlocks(
  principal: Principal,
  organizationId: string,
  dependencies: ScheduleDependencies,
): Promise<{
  readonly blocks: readonly ScheduleBlockView[];
  readonly revision: string;
  readonly etag: string;
}> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const aggregate = await readAggregate(context, dependencies, principal, organizationId, now);
    const blocks = await dependencies.schedules.listBlocks(context, organizationId);
    return {
      blocks: blocks.map(toScheduleBlockView),
      revision: aggregate.revision.toString(10),
      etag: aggregate.etag,
    };
  });
}

/** GET /schedule/templates — templates with their full slot sets plus the schedule ETag. */
export async function listScheduleTemplates(
  principal: Principal,
  organizationId: string,
  dependencies: ScheduleDependencies,
): Promise<{
  readonly templates: readonly ScheduleTemplateView[];
  readonly revision: string;
  readonly etag: string;
}> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const aggregate = await readAggregate(context, dependencies, principal, organizationId, now);
    const templates = await dependencies.schedules.listTemplates(context, organizationId);
    const withSlots = await Promise.all(
      templates.map(async (template) => ({
        template,
        slots: await dependencies.schedules.listSlotsByTemplate(
          context,
          organizationId,
          template.id,
        ),
      })),
    );
    return {
      templates: withSlots.map(({ template, slots }) => toScheduleTemplateView(template, slots)),
      revision: aggregate.revision.toString(10),
      etag: aggregate.etag,
    };
  });
}

const MAX_CALENDAR_RANGE_DAYS = 366;

/**
 * GET /schedule/calendar?from&through — bounded school-local date range read.
 * Unassigned dates are simply absent; the range never dumps the table.
 */
export async function listCalendarRange(
  principal: Principal,
  organizationId: string,
  from: unknown,
  through: unknown,
  dependencies: ScheduleDependencies,
): Promise<{
  readonly days: readonly CalendarDayView[];
  readonly revision: string;
  readonly etag: string;
}> {
  const start = parseDate(from);
  const end = parseDate(through);
  const span = end.since(start, { largestUnit: 'days' }).days;
  if (span < 0 || span > MAX_CALENDAR_RANGE_DAYS) {
    throw new ControlPlaneError('invalid_precondition', 'Invalid calendar range.');
  }
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const aggregate = await readAggregate(context, dependencies, principal, organizationId, now);
    const days: CalendarDayView[] = [];
    let cursor: Temporal.PlainDate = start;
    while (Temporal.PlainDate.compare(cursor, end) <= 0) {
      const row = await dependencies.schedules.loadDayByDate(
        context,
        organizationId,
        cursor.toString(),
      );
      if (row !== null && row.tenantId === principal.tenantId) {
        days.push(toCalendarDayView(row));
      }
      cursor = cursor.add({ days: 1 });
    }
    return {
      days,
      revision: aggregate.revision.toString(10),
      etag: aggregate.etag,
    };
  });
}

export interface BlockWriteInput extends ScheduleCommandInput {
  readonly code: unknown;
  readonly displayName: unknown;
  readonly kind: unknown;
}

/** POST /schedule/blocks — new blocks start active. */
export async function createBlock(
  input: BlockWriteInput,
  dependencies: ScheduleDependencies,
): Promise<ScheduleResult<ScheduleBlockView>> {
  const code = cleanName(input.code, 'code', 50);
  const displayName = cleanName(input.displayName, 'displayName', 200);
  const kind = cleanBlockKind(input.kind);
  return executeScheduleCommand(
    'schedule.block.create:v1',
    input,
    [code, displayName, kind],
    dependencies,
    async (context) => {
      const duplicate = await dependencies.schedules.loadBlockByCode(
        context,
        input.organizationId,
        code,
      );
      if (duplicate !== null) {
        throw new ControlPlaneError('schedule_block_exists', 'A block with this code exists.');
      }
      const row = await dependencies.schedules.insertBlock(context, {
        organizationId: input.organizationId,
        code,
        displayName,
        kind,
      });
      const value = toScheduleBlockView(row);
      return {
        value,
        action: 'schedule.block_created',
      };
    },
    (value) => ({ responseStatus: 201, responseBody: { block: value } }),
    (storedValue) => (storedValue as { block: ScheduleBlockView }).block,
    true,
  );
}

export interface UpdateBlockInput extends BlockWriteInput {
  readonly blockId: string;
}

/** PUT /schedule/blocks/:blockId — full replacement of code, display name, and kind. */
export async function updateBlock(
  input: UpdateBlockInput,
  dependencies: ScheduleDependencies,
): Promise<ScheduleResult<ScheduleBlockView>> {
  const code = cleanName(input.code, 'code', 50);
  const displayName = cleanName(input.displayName, 'displayName', 200);
  const kind = cleanBlockKind(input.kind);
  return executeScheduleCommand(
    'schedule.block.update:v1',
    input,
    [input.blockId, code, displayName, kind],
    dependencies,
    async (context) => {
      const current = await dependencies.schedules.loadBlock(
        context,
        input.organizationId,
        input.blockId,
      );
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('schedule_block_not_found', 'Schedule block not found.');
      }
      if (current.status !== 'active') {
        throw new ControlPlaneError('invalid_schedule_state', 'Archived blocks cannot be edited.');
      }
      const duplicate = await dependencies.schedules.loadBlockByCode(
        context,
        input.organizationId,
        code,
      );
      if (duplicate !== null && duplicate.id !== current.id) {
        throw new ControlPlaneError('schedule_block_exists', 'A block with this code exists.');
      }
      if (code !== current.code) {
        // Slot references resolve blocks by id, but the code is the stable
        // human key administrators and policy configuration rely on: a code
        // change on a used block is a rename, not an edit. Only displayName
        // and kind may change while templates reference the block.
        const referenced = await dependencies.schedules.countTemplateSlotsForBlock(
          context,
          input.organizationId,
          current.id,
        );
        if (referenced > 0) {
          throw new ControlPlaneError(
            'invalid_schedule_state',
            'The block code cannot change while templates reference it.',
          );
        }
      }
      const row = await dependencies.schedules.updateBlock(
        context,
        input.organizationId,
        current.id,
        {
          code,
          displayName,
          kind,
        },
      );
      if (row === null) {
        throw new ControlPlaneError('schedule_block_not_found', 'Schedule block not found.');
      }
      const value = toScheduleBlockView(row);
      return {
        value,
        action: 'schedule.block_updated',
      };
    },
    (value) => ({ responseStatus: 200, responseBody: { block: value } }),
    (storedValue) => (storedValue as { block: ScheduleBlockView }).block,
    false,
  );
}

export interface BlockResourceInput extends ScheduleCommandInput {
  readonly blockId: string;
}

/**
 * POST /schedule/blocks/:blockId/archive — terminal. Rejects while any
 * non-archived template still references the block, because placement
 * silently drops archived blocks. Remove or replace the slot first; templates
 * are never mutated automatically.
 */
export async function archiveBlock(
  input: BlockResourceInput,
  dependencies: ScheduleDependencies,
): Promise<ScheduleResult<ScheduleBlockView>> {
  return executeScheduleCommand(
    'schedule.block.archive:v1',
    input,
    [input.blockId],
    dependencies,
    async (context) => {
      const current = await dependencies.schedules.loadBlock(
        context,
        input.organizationId,
        input.blockId,
      );
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('schedule_block_not_found', 'Schedule block not found.');
      }
      if (current.status !== 'active') {
        throw new ControlPlaneError('invalid_schedule_state', 'The block is already archived.');
      }
      const slots = await dependencies.schedules.countTemplateSlotsForBlock(
        context,
        input.organizationId,
        current.id,
      );
      if (slots > 0) {
        throw new ControlPlaneError('schedule_block_in_use', 'The block is still in use.');
      }
      const row = await dependencies.schedules.archiveBlock(
        context,
        input.organizationId,
        current.id,
      );
      if (row === null) {
        throw new ControlPlaneError('schedule_block_not_found', 'Schedule block not found.');
      }
      const value = toScheduleBlockView(row);
      return {
        value,
        action: 'schedule.block_archived',
      };
    },
    (value) => ({ responseStatus: 200, responseBody: { block: value } }),
    (storedValue) => (storedValue as { block: ScheduleBlockView }).block,
    false,
  );
}

export interface TemplateWriteInput extends ScheduleCommandInput {
  readonly name: unknown;
  readonly slots: readonly {
    readonly blockId: string;
    readonly startsAt: unknown;
    readonly endsAt: unknown;
  }[];
}

async function canonicalTemplateSlots(
  context: TenantTransactionContext,
  dependencies: ScheduleDependencies,
  organizationId: string,
  rawSlots: TemplateWriteInput['slots'],
): Promise<CanonicalSlot[]> {
  // The repository scopes every row to the transaction tenant, so every
  // block here belongs to the caller's tenant and the exact school.
  const blocks = await dependencies.schedules.listBlocks(context, organizationId);
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  return validateSlots(rawSlots, blocksById);
}

/** POST /schedule/templates — name plus full slot set, validated atomically. */
export async function createTemplate(
  input: TemplateWriteInput,
  dependencies: ScheduleDependencies,
): Promise<ScheduleResult<ScheduleTemplateView>> {
  const name = cleanName(input.name, 'name', 200);
  const slots = input.slots;
  return executeScheduleCommand(
    'schedule.template.create:v1',
    input,
    [name, ...slots.flatMap((slot) => [slot.blockId, String(slot.startsAt), String(slot.endsAt)])],
    dependencies,
    async (context) => {
      const canonical = await canonicalTemplateSlots(
        context,
        dependencies,
        input.organizationId,
        slots,
      );
      const row = await dependencies.schedules.insertTemplate(context, {
        organizationId: input.organizationId,
        name,
      });
      const stored = await dependencies.schedules.replaceTemplateSlots(context, {
        organizationId: input.organizationId,
        templateId: row.id,
        slots: canonical.map((slot) => ({
          blockId: slot.blockId,
          startsAt: slot.startsAt.toString().slice(0, 8),
          endsAt: slot.endsAt.toString().slice(0, 8),
          ordinal: slot.ordinal,
        })),
      });
      const value = toScheduleTemplateView(row, stored);
      return {
        value,
        action: 'schedule.template_created',
      };
    },
    (value) => ({ responseStatus: 201, responseBody: { template: value } }),
    (storedValue) => (storedValue as { template: ScheduleTemplateView }).template,
    true,
  );
}

export interface UpdateTemplateInput extends TemplateWriteInput {
  readonly templateId: string;
}

/** PUT /schedule/templates/:templateId — name plus full slot replacement, never a merge. */
export async function updateTemplate(
  input: UpdateTemplateInput,
  dependencies: ScheduleDependencies,
): Promise<ScheduleResult<ScheduleTemplateView>> {
  const name = cleanName(input.name, 'name', 200);
  const slots = input.slots;
  return executeScheduleCommand(
    'schedule.template.update:v1',
    input,
    [
      input.templateId,
      name,
      ...slots.flatMap((slot) => [slot.blockId, String(slot.startsAt), String(slot.endsAt)]),
    ],
    dependencies,
    async (context) => {
      const current = await dependencies.schedules.loadTemplate(
        context,
        input.organizationId,
        input.templateId,
      );
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('schedule_template_not_found', 'Schedule template not found.');
      }
      if (current.status !== 'active') {
        throw new ControlPlaneError(
          'invalid_schedule_state',
          'Archived templates cannot be edited.',
        );
      }
      const canonical = await canonicalTemplateSlots(
        context,
        dependencies,
        input.organizationId,
        slots,
      );
      const renamed = await dependencies.schedules.updateTemplateName(
        context,
        input.organizationId,
        current.id,
        name,
      );
      if (renamed === null) {
        throw new ControlPlaneError('schedule_template_not_found', 'Schedule template not found.');
      }
      const stored = await dependencies.schedules.replaceTemplateSlots(context, {
        organizationId: input.organizationId,
        templateId: current.id,
        slots: canonical.map((slot) => ({
          blockId: slot.blockId,
          startsAt: slot.startsAt.toString().slice(0, 8),
          endsAt: slot.endsAt.toString().slice(0, 8),
          ordinal: slot.ordinal,
        })),
      });
      const value = toScheduleTemplateView(renamed, stored);
      return {
        value,
        action: 'schedule.template_updated',
      };
    },
    (value) => ({ responseStatus: 200, responseBody: { template: value } }),
    (storedValue) => (storedValue as { template: ScheduleTemplateView }).template,
    false,
  );
}

export interface TemplateResourceInput extends ScheduleCommandInput {
  readonly templateId: string;
}

/**
 * POST /schedule/templates/:templateId/archive — terminal. Rejects while the
 * template is assigned to today or a future calendar day in the school-local
 * date. Past assignments remain as truthful history and never block archival.
 */
export async function archiveTemplate(
  input: TemplateResourceInput,
  dependencies: ScheduleDependencies,
): Promise<ScheduleResult<ScheduleTemplateView>> {
  return executeScheduleCommand(
    'schedule.template.archive:v1',
    input,
    [input.templateId],
    dependencies,
    async (context, now) => {
      const current = await dependencies.schedules.loadTemplate(
        context,
        input.organizationId,
        input.templateId,
      );
      if (current?.tenantId !== input.principal.tenantId) {
        throw new ControlPlaneError('schedule_template_not_found', 'Schedule template not found.');
      }
      if (current.status !== 'active') {
        throw new ControlPlaneError('invalid_schedule_state', 'The template is already archived.');
      }
      const today = await todayForSchool(context, dependencies, input.organizationId, now);
      const assignments =
        await dependencies.schedules.countCurrentOrFutureCalendarAssignmentsForTemplate(
          context,
          input.organizationId,
          current.id,
          today,
        );
      if (assignments > 0) {
        throw new ControlPlaneError('schedule_template_in_use', 'The template is still in use.');
      }
      const row = await dependencies.schedules.archiveTemplate(
        context,
        input.organizationId,
        current.id,
      );
      if (row === null) {
        throw new ControlPlaneError('schedule_template_not_found', 'Schedule template not found.');
      }
      const value = toScheduleTemplateView(row, []);
      return {
        value,
        action: 'schedule.template_archived',
      };
    },
    (value) => ({ responseStatus: 200, responseBody: { template: value } }),
    (storedValue) => (storedValue as { template: ScheduleTemplateView }).template,
    false,
  );
}

export interface CalendarDayInput {
  readonly date: unknown;
  readonly dayKind: unknown;
  readonly templateId: string | null;
  readonly cycleCode: string | null;
  readonly operationalNote: string | null;
}

export interface CalendarBulkInput extends ScheduleCommandInput {
  readonly days: readonly CalendarDayInput[];
}

interface CanonicalDay {
  readonly date: string;
  readonly dayKind: CalendarDayKind;
  readonly templateId: string | null;
  readonly cycleCode: string | null;
  readonly operationalNote: string | null;
}

const MAX_CALENDAR_BULK_DAYS = 366;

function canonicalDay(day: CalendarDayInput): CanonicalDay {
  const date = parseDate(day.date).toString();
  const dayKind = cleanDayKind(day.dayKind);
  const cycleCode = day.cycleCode === null ? null : cleanName(day.cycleCode, 'cycleCode', 50);
  const operationalNote =
    day.operationalNote === null ? null : cleanName(day.operationalNote, 'operationalNote', 500);
  if (dayKind === 'instructional' && day.templateId === null) {
    throw new ControlPlaneError('invalid_precondition', 'Instructional days require a template.');
  }
  if (dayKind !== 'instructional' && day.templateId !== null) {
    throw new ControlPlaneError(
      'invalid_precondition',
      'Only instructional days may carry a template.',
    );
  }
  return { date, dayKind, templateId: day.templateId, cycleCode, operationalNote };
}

/**
 * PUT /schedule/calendar — bulk day assignment. The whole batch is atomic:
 * one command, one schedule revision increment, rollback of the entire set
 * when any one date is invalid. An instructional day always names its
 * explicit active template (including a holiday operating on a schedule);
 * anything else carries no template.
 */
export async function putCalendarDays(
  input: CalendarBulkInput,
  dependencies: ScheduleDependencies,
): Promise<ScheduleResult<readonly CalendarDayView[]>> {
  if (input.days.length === 0 || input.days.length > MAX_CALENDAR_BULK_DAYS) {
    throw new ControlPlaneError('invalid_precondition', 'Invalid calendar batch.');
  }
  const canonical = input.days.map(canonicalDay);
  const dates = canonical.map((day) => day.date).sort();
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index] === dates[index - 1]) {
      throw new ControlPlaneError('invalid_precondition', 'Duplicate calendar date.');
    }
  }
  return executeScheduleCommand<readonly CalendarDayView[]>(
    'schedule.calendar.update:v1',
    input,
    dates.flatMap((date) => {
      const day = canonical.find((entry) => entry.date === date);
      return [
        date,
        day?.dayKind ?? '',
        day?.templateId ?? '',
        day?.cycleCode ?? '',
        day?.operationalNote ?? '',
      ];
    }),
    dependencies,
    async (context) => {
      const templates = new Map<string, { readonly status: string; readonly tenantId: string }>();
      for (const day of canonical) {
        if (day.templateId === null) continue;
        let template = templates.get(day.templateId);
        if (template === undefined) {
          const row = await dependencies.schedules.loadTemplate(
            context,
            input.organizationId,
            day.templateId,
          );
          if (row?.tenantId !== input.principal.tenantId) {
            throw new ControlPlaneError(
              'schedule_template_not_found',
              'Schedule template not found.',
            );
          }
          template = { status: row.status, tenantId: row.tenantId };
          templates.set(day.templateId, template);
        }
        if (template.status !== 'active') {
          throw new ControlPlaneError(
            'invalid_schedule_state',
            'Archived templates cannot be assigned.',
          );
        }
      }
      const stored: CalendarDayView[] = [];
      for (const day of canonical) {
        const row = await dependencies.schedules.upsertDay(context, {
          organizationId: input.organizationId,
          date: day.date,
          dayKind: day.dayKind,
          templateId: day.templateId,
          cycleCode: day.cycleCode,
          operationalNote: day.operationalNote,
        });
        stored.push(toCalendarDayView(row));
      }
      return {
        value: stored,
        action: 'schedule.calendar_updated',
      };
    },
    (value) => ({ responseStatus: 200, responseBody: { days: value } }),
    (storedValue) => (storedValue as { days: readonly CalendarDayView[] }).days,
    false,
  );
}
