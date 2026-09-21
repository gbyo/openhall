import {
  archiveBlock,
  archiveTemplate,
  createBlock,
  createTemplate,
  listCalendarRange,
  listScheduleBlocks,
  listScheduleTemplates,
  putCalendarDays,
  updateBlock,
  updateTemplate,
  type Principal,
} from '@openhall/application';
import {
  CalendarBulkWriteBodySchema,
  CalendarDayListSchema,
  ScheduleBlockListSchema,
  ScheduleBlockResponseSchema,
  ScheduleBlockWriteBodySchema,
  ScheduleTemplateListSchema,
  ScheduleTemplateResponseSchema,
  ScheduleTemplateWriteBodySchema,
  UuidSchema,
} from '@openhall/contracts';
import { Type } from 'typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AuthDependencies } from '../auth/dependencies.js';
import { requireCsrf, requirePrincipal } from '../auth/session-context.js';
import type { ControlPlaneDependencies } from '../control-plane/dependencies.js';
import {
  CONTROL_PLANE_ERRORS,
  COOKIE_CSRF_SECURITY,
  COOKIE_SECURITY,
  MutationHeadersSchema,
  OrganizationIdParamsSchema,
  unauthenticated,
  type ControlPlaneHandler,
} from './control-plane-shared.js';

const BlockIdParamsSchema = Type.Object(
  { organizationId: UuidSchema, blockId: UuidSchema },
  { additionalProperties: false },
);
const TemplateIdParamsSchema = Type.Object(
  { organizationId: UuidSchema, templateId: UuidSchema },
  { additionalProperties: false },
);
const CalendarRangeQuerySchema = Type.Object(
  {
    from: Type.String({ minLength: 1, maxLength: 10 }),
    through: Type.String({ minLength: 1, maxLength: 10 }),
  },
  { additionalProperties: false },
);

const SCHEDULE_ERRORS = {
  400: CONTROL_PLANE_ERRORS[400],
  401: CONTROL_PLANE_ERRORS[401],
  403: CONTROL_PLANE_ERRORS[403],
  404: CONTROL_PLANE_ERRORS[404],
  409: CONTROL_PLANE_ERRORS[409],
  412: CONTROL_PLANE_ERRORS[412],
  428: CONTROL_PLANE_ERRORS[428],
};

export function registerScheduleRoutes(
  app: FastifyInstance,
  controlPlane: ControlPlaneDependencies,
  auth: AuthDependencies,
  handle: ControlPlaneHandler,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  function scheduleInput(request: FastifyRequest, principal: Principal) {
    const params = request.params as { organizationId: string };
    return {
      principal,
      organizationId: params.organizationId,
      ifMatch: request.headers['if-match'],
      idempotencyKey: request.headers['idempotency-key'],
      requestId: request.id,
    };
  }

  // ---- Reads (schedule.view; every response exposes the schedule ETag) ----

  typedApp.get(
    '/api/v1/organizations/:organizationId/schedule/blocks',
    {
      schema: {
        operationId: 'listScheduleBlocks',
        tags: ['control-plane'],
        description:
          'List schedule blocks with the current strong schedule ETag. Requires schedule.view on the exact school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: ScheduleBlockListSchema,
          400: CONTROL_PLANE_ERRORS[400],
          401: CONTROL_PLANE_ERRORS[401],
          403: CONTROL_PLANE_ERRORS[403],
          404: CONTROL_PLANE_ERRORS[404],
        },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await listScheduleBlocks(
          principal,
          request.params.organizationId,
          controlPlane.schedules,
        );
        return {
          body: { blocks: result.blocks, revision: result.revision },
          etag: result.etag,
          status: 200,
        };
      });
    },
  );

  typedApp.get(
    '/api/v1/organizations/:organizationId/schedule/templates',
    {
      schema: {
        operationId: 'listScheduleTemplates',
        tags: ['control-plane'],
        description:
          'List schedule templates with full slot sets and the current strong schedule ETag. Requires schedule.view on the exact school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: ScheduleTemplateListSchema,
          401: CONTROL_PLANE_ERRORS[401],
          403: CONTROL_PLANE_ERRORS[403],
          404: CONTROL_PLANE_ERRORS[404],
        },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await listScheduleTemplates(
          principal,
          request.params.organizationId,
          controlPlane.schedules,
        );
        return {
          body: { templates: result.templates, revision: result.revision },
          etag: result.etag,
          status: 200,
        };
      });
    },
  );

  typedApp.get(
    '/api/v1/organizations/:organizationId/schedule/calendar',
    {
      schema: {
        operationId: 'getScheduleCalendar',
        tags: ['control-plane'],
        description:
          'Read a bounded school-local calendar range (at most 366 days) with the current strong schedule ETag. Requires schedule.view on the exact school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        querystring: CalendarRangeQuerySchema,
        response: {
          200: CalendarDayListSchema,
          400: CONTROL_PLANE_ERRORS[400],
          401: CONTROL_PLANE_ERRORS[401],
          403: CONTROL_PLANE_ERRORS[403],
          404: CONTROL_PLANE_ERRORS[404],
        },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await listCalendarRange(
          principal,
          request.params.organizationId,
          request.query.from,
          request.query.through,
          controlPlane.schedules,
        );
        return {
          body: { days: result.days, revision: result.revision },
          etag: result.etag,
          status: 200,
        };
      });
    },
  );

  // ---- Blocks ----

  typedApp.post(
    '/api/v1/organizations/:organizationId/schedule/blocks',
    {
      schema: {
        operationId: 'createScheduleBlock',
        tags: ['control-plane'],
        description:
          'Create a schedule block (starts active) under the aggregate lock. Requires Idempotency-Key and the schedule If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: OrganizationIdParamsSchema,
        body: ScheduleBlockWriteBodySchema,
        headers: MutationHeadersSchema,
        response: { 201: ScheduleBlockResponseSchema, ...SCHEDULE_ERRORS },
      },
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await createBlock(
          {
            ...scheduleInput(request, principal),
            code: request.body.code,
            displayName: request.body.displayName,
            kind: request.body.kind,
          },
          controlPlane.schedules,
        );
        return {
          body: { block: result.value },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.put(
    '/api/v1/organizations/:organizationId/schedule/blocks/:blockId',
    {
      schema: {
        operationId: 'updateScheduleBlock',
        tags: ['control-plane'],
        description:
          'Replace a schedule block. Code is immutable while templates reference the block; displayName and kind remain editable and prospective. Requires Idempotency-Key and the schedule If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: BlockIdParamsSchema,
        body: ScheduleBlockWriteBodySchema,
        headers: MutationHeadersSchema,
        response: { 200: ScheduleBlockResponseSchema, ...SCHEDULE_ERRORS },
      },
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await updateBlock(
          {
            ...scheduleInput(request, principal),
            blockId: request.params.blockId,
            code: request.body.code,
            displayName: request.body.displayName,
            kind: request.body.kind,
          },
          controlPlane.schedules,
        );
        return {
          body: { block: result.value },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.post(
    '/api/v1/organizations/:organizationId/schedule/blocks/:blockId/archive',
    {
      schema: {
        operationId: 'archiveScheduleBlock',
        tags: ['control-plane'],
        description:
          'Archive a schedule block (terminal). Rejects with schedule_block_in_use while any non-archived template references it. Requires Idempotency-Key and the schedule If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: BlockIdParamsSchema,
        headers: MutationHeadersSchema,
        response: { 200: ScheduleBlockResponseSchema, ...SCHEDULE_ERRORS },
      },
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await archiveBlock(
          { ...scheduleInput(request, principal), blockId: request.params.blockId },
          controlPlane.schedules,
        );
        return {
          body: { block: result.value },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  // ---- Templates (atomic objects; the server derives ordinals) ----

  typedApp.post(
    '/api/v1/organizations/:organizationId/schedule/templates',
    {
      schema: {
        operationId: 'createScheduleTemplate',
        tags: ['control-plane'],
        description:
          'Create a schedule template with its full slot set (validated atomically: active same-school blocks, non-overlapping slots; ordinals derived from sorted order). Requires Idempotency-Key and the schedule If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: OrganizationIdParamsSchema,
        body: ScheduleTemplateWriteBodySchema,
        headers: MutationHeadersSchema,
        response: { 201: ScheduleTemplateResponseSchema, ...SCHEDULE_ERRORS },
      },
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await createTemplate(
          {
            ...scheduleInput(request, principal),
            name: request.body.name,
            slots: request.body.slots,
          },
          controlPlane.schedules,
        );
        return {
          body: { template: result.value },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.put(
    '/api/v1/organizations/:organizationId/schedule/templates/:templateId',
    {
      schema: {
        operationId: 'updateScheduleTemplate',
        tags: ['control-plane'],
        description:
          'Replace a template name plus its full slot set (never a merge). Requires Idempotency-Key and the schedule If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: TemplateIdParamsSchema,
        body: ScheduleTemplateWriteBodySchema,
        headers: MutationHeadersSchema,
        response: { 200: ScheduleTemplateResponseSchema, ...SCHEDULE_ERRORS },
      },
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await updateTemplate(
          {
            ...scheduleInput(request, principal),
            templateId: request.params.templateId,
            name: request.body.name,
            slots: request.body.slots,
          },
          controlPlane.schedules,
        );
        return {
          body: { template: result.value },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.post(
    '/api/v1/organizations/:organizationId/schedule/templates/:templateId/archive',
    {
      schema: {
        operationId: 'archiveScheduleTemplate',
        tags: ['control-plane'],
        description:
          'Archive a schedule template (terminal). Rejects with schedule_template_in_use while assigned to today or a future day; past assignments remain as history. Requires Idempotency-Key and the schedule If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: TemplateIdParamsSchema,
        headers: MutationHeadersSchema,
        response: { 200: ScheduleTemplateResponseSchema, ...SCHEDULE_ERRORS },
      },
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await archiveTemplate(
          { ...scheduleInput(request, principal), templateId: request.params.templateId },
          controlPlane.schedules,
        );
        return {
          body: { template: result.value },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  // ---- Calendar bulk assignment (atomic; one revision per command) ----

  typedApp.put(
    '/api/v1/organizations/:organizationId/schedule/calendar',
    {
      schema: {
        operationId: 'updateScheduleCalendar',
        tags: ['control-plane'],
        description:
          'Assign a bounded list of complete day assignments atomically (at most 366 days; the whole batch rolls back when any date is invalid). Requires Idempotency-Key and the schedule If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: OrganizationIdParamsSchema,
        body: CalendarBulkWriteBodySchema,
        headers: MutationHeadersSchema,
        response: { 200: CalendarDayListSchema, ...SCHEDULE_ERRORS },
      },
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await putCalendarDays(
          { ...scheduleInput(request, principal), days: request.body.days },
          controlPlane.schedules,
        );
        return {
          body: { days: result.value, revision: result.revision },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );
}
