import {
  archiveRoom,
  bulkUpdateRooms,
  closeRoom,
  createRoom,
  getRoom,
  listMyRooms,
  listRoomContexts,
  listRooms,
  openRoom,
  updateRoom,
} from '@openhall/application';
import {
  RoomBulkResponseSchema,
  RoomBulkWriteBodySchema,
  RoomCatalogSchema,
  RoomContextListSchema,
  RoomListSchema,
  RoomResponseSchema,
  RoomWriteBodySchema,
} from '@openhall/contracts';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { requireCsrf, requirePrincipal } from '../auth/session-context.js';
import { registerAuditRoutes } from './control-plane-audit.js';
import { registerRoomCategoryRoutes } from './control-plane-room-categories.js';
import { registerEnrollmentRoutes } from './control-plane-enrollment.js';
import { registerGrantRoutes } from './control-plane-grants.js';
import { registerPeopleRoutes } from './control-plane-people.js';
import { registerScheduledRoutes } from './control-plane-scheduled.js';
import { registerScheduledStudentRoutes } from './scheduled-student.js';
import { registerPolicyRoutes } from './control-plane-policies.js';
import { registerScheduleRoutes } from './control-plane-schedules.js';

import {
  CONTROL_PLANE_ERRORS,
  COOKIE_CSRF_SECURITY,
  COOKIE_SECURITY,
  CreateHeadersSchema,
  MutationHeadersSchema,
  OrganizationIdParamsSchema,
  RoomIdParamsSchema,
  handleControlPlane,
  unauthenticated,
  type ControlPlaneHandler,
  type RegisterControlPlaneOptions,
} from './control-plane-shared.js';
export {
  CONTROL_PLANE_ERRORS,
  COOKIE_CSRF_SECURITY,
  COOKIE_SECURITY,
  CreateHeadersSchema,
  MutationHeadersSchema,
  OrganizationIdParamsSchema,
  handleControlPlane,
  unauthenticated,
  type ControlPlaneHandler,
} from './control-plane-shared.js';
export function registerControlPlaneRoutes(
  app: FastifyInstance,
  options: RegisterControlPlaneOptions,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();
  const { controlPlane, auth } = options;
  const handle: ControlPlaneHandler = handleControlPlane;

  // ---- Rooms ----

  typedApp.get(
    '/api/v1/organizations/:organizationId/rooms',
    {
      schema: {
        operationId: 'listRooms',
        tags: ['control-plane'],
        description:
          'List school rooms with full admin DTO. Requires room.manage on the exact school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: RoomListSchema,
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
      await handle(request, reply, async () => ({
        body: await listRooms(principal, request.params.organizationId, controlPlane.rooms),
        status: 200,
      }));
    },
  );

  typedApp.post(
    '/api/v1/organizations/:organizationId/rooms',
    {
      schema: {
        operationId: 'createRoom',
        tags: ['control-plane'],
        description:
          'Create a room starting closed (never open) for post-configuration review. Requires Idempotency-Key. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: OrganizationIdParamsSchema,
        body: RoomWriteBodySchema,
        headers: CreateHeadersSchema,
        response: { 201: RoomResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await createRoom(
          {
            principal,
            organizationId: request.params.organizationId,
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            config: {
              categoryId: request.body.categoryId,
              name: request.body.name,
              code: request.body.code,
              floorLabel: request.body.floorLabel,
              studentSelfRequestable: request.body.studentSelfRequestable,
              originSelectable: request.body.originSelectable,
              capacity: request.body.capacity,
              queueEnabled: request.body.queueEnabled,
              checkInMode: request.body.checkInMode,
              defaultDurationSeconds: request.body.defaultDurationSeconds,
              maxDurationSeconds: request.body.maxDurationSeconds,
              readyClaimTimeoutSeconds: request.body.readyClaimTimeoutSeconds,
              queueTimeoutSeconds: request.body.queueTimeoutSeconds,
            },
          },
          controlPlane.rooms,
        );
        return {
          body: { room: result.room },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.post(
    '/api/v1/organizations/:organizationId/rooms/bulk',
    {
      schema: {
        operationId: 'bulkUpdateRooms',
        tags: ['control-plane'],
        description:
          'Apply one change (category, student-requestable, or open/close) to many rooms in a single transaction: the whole selection lands or none of it does. Rooms already in the requested state are left untouched. Archiving stays a single-room command. Requires Idempotency-Key. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: OrganizationIdParamsSchema,
        body: RoomBulkWriteBodySchema,
        headers: CreateHeadersSchema,
        response: { 200: RoomBulkResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await bulkUpdateRooms(
          {
            principal,
            organizationId: request.params.organizationId,
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            roomIds: request.body.roomIds,
            change: request.body.change,
          },
          controlPlane.rooms,
        );
        return { body: { rooms: result.rooms }, status: 200 };
      });
    },
  );

  typedApp.get(
    '/api/v1/rooms/:roomId',
    {
      schema: {
        operationId: 'getRoom',
        tags: ['control-plane'],
        description:
          'Read one room with its strong ETag. Authorized against the canonical school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: RoomIdParamsSchema,
        response: {
          200: RoomResponseSchema,
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
        const result = await getRoom(principal, request.params.roomId, controlPlane.rooms);
        return { body: { room: result.room }, etag: result.etag, status: 200 };
      });
    },
  );

  typedApp.put(
    '/api/v1/rooms/:roomId',
    {
      schema: {
        operationId: 'updateRoom',
        tags: ['control-plane'],
        description:
          'Replace room configuration (never status; revision + 1). Edits are prospective and never rewrite active movement. Requires Idempotency-Key and If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: RoomIdParamsSchema,
        body: RoomWriteBodySchema,
        headers: MutationHeadersSchema,
        response: { 200: RoomResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await updateRoom(
          {
            principal,
            roomId: request.params.roomId,
            ifMatch: request.headers['if-match'],
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            config: {
              categoryId: request.body.categoryId,
              name: request.body.name,
              code: request.body.code,
              floorLabel: request.body.floorLabel,
              studentSelfRequestable: request.body.studentSelfRequestable,
              originSelectable: request.body.originSelectable,
              capacity: request.body.capacity,
              queueEnabled: request.body.queueEnabled,
              checkInMode: request.body.checkInMode,
              defaultDurationSeconds: request.body.defaultDurationSeconds,
              maxDurationSeconds: request.body.maxDurationSeconds,
              readyClaimTimeoutSeconds: request.body.readyClaimTimeoutSeconds,
              queueTimeoutSeconds: request.body.queueTimeoutSeconds,
            },
          },
          controlPlane.rooms,
        );
        return {
          body: { room: result.room },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  for (const verb of ['open', 'close', 'archive'] as const) {
    typedApp.post(
      `/api/v1/rooms/:roomId/${verb}`,
      {
        schema: {
          operationId:
            verb === 'open' ? 'openRoom' : verb === 'close' ? 'closeRoom' : 'archiveRoom',
          tags: ['control-plane'],
          description:
            verb === 'archive'
              ? 'Archive a room (terminal). Rejects with room_in_use while live references remain. Requires Idempotency-Key and If-Match. Cache-Control: no-store.'
              : `Semantic room ${verb} (revision + 1). Requires Idempotency-Key and If-Match. Cache-Control: no-store.`,
          security: COOKIE_CSRF_SECURITY,
          params: RoomIdParamsSchema,
          headers: MutationHeadersSchema,
          response: { 200: RoomResponseSchema, ...CONTROL_PLANE_ERRORS },
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
          const input = {
            principal,
            roomId: request.params.roomId,
            ifMatch: request.headers['if-match'],
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
          };
          const result =
            verb === 'open'
              ? await openRoom(input, controlPlane.rooms)
              : verb === 'close'
                ? await closeRoom(input, controlPlane.rooms)
                : await archiveRoom(input, controlPlane.rooms);
          return {
            body: { room: result.room },
            etag: result.etag,
            status: result.status,
          };
        });
      },
    );
  }

  typedApp.get(
    '/api/v1/organizations/:organizationId/room-contexts',
    {
      schema: {
        operationId: 'listRoomContexts',
        tags: ['control-plane'],
        description:
          'Schedule- and staffing-derived context (teachers, classes, room staff) for every room in the school, including closed and uncategorized rooms. Requires room.manage on the exact school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: RoomContextListSchema,
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
      await handle(request, reply, async () => ({
        body: await listRoomContexts(principal, request.params.organizationId, controlPlane.rooms),
        status: 200,
      }));
    },
  );

  typedApp.get(
    '/api/v1/me/organizations/:organizationId/rooms',
    {
      schema: {
        operationId: 'listMyRooms',
        tags: ['control-plane'],
        description:
          'Stable safe room catalog for organization members (open rooms, picker-safe fields only). Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: RoomCatalogSchema,
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
      await handle(request, reply, async () => ({
        body: await listMyRooms(principal, request.params.organizationId, controlPlane.rooms),
        status: 200,
      }));
    },
  );

  registerRoomCategoryRoutes(typedApp, controlPlane, auth, handle);
  registerAuditRoutes(typedApp, controlPlane, auth, handle);
  registerScheduleRoutes(typedApp, controlPlane, auth, handle);
  registerPolicyRoutes(typedApp, controlPlane, auth, handle);
  registerGrantRoutes(typedApp, controlPlane, auth, handle);
  registerPeopleRoutes(typedApp, controlPlane, auth, handle);
  registerEnrollmentRoutes(typedApp, controlPlane, auth, handle);
  registerScheduledRoutes(typedApp, controlPlane, auth, handle);
  registerScheduledStudentRoutes(typedApp, controlPlane, auth);
}
