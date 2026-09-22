import {
  archiveRoomCategory,
  createRoomCategory,
  getRoomCategory,
  listMyStudentRoomCatalog,
  listRoomCategories,
  updateRoomCategory,
} from '@openhall/application';
import {
  RoomCategoryListSchema,
  RoomCategoryResponseSchema,
  RoomCategoryWriteBodySchema,
  StudentRoomCatalogSchema,
} from '@openhall/contracts';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { requireCsrf, requirePrincipal } from '../auth/session-context.js';
import type { AuthDependencies } from '../auth/dependencies.js';
import type { ControlPlaneDependencies } from '../control-plane/dependencies.js';
import {
  CONTROL_PLANE_ERRORS,
  COOKIE_CSRF_SECURITY,
  COOKIE_SECURITY,
  CreateHeadersSchema,
  RoomCategoryIdParamsSchema,
  MutationHeadersSchema,
  OrganizationIdParamsSchema,
  unauthenticated,
  type ControlPlaneHandler,
} from './control-plane-shared.js';

/**
 * Room-category administration plus the purpose-built student
 * launcher catalog. Categories live under `room.manage` on the exact
 * school — no separate capability. The student catalog is a separate
 * endpoint authorized with `pass.request.self` semantics; the flat member
 * catalog stays untouched for staff workflows.
 */
export function registerRoomCategoryRoutes(
  app: FastifyInstance,
  controlPlane: ControlPlaneDependencies,
  auth: AuthDependencies,
  handle: ControlPlaneHandler,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.get(
    '/api/v1/organizations/:organizationId/room-categories',
    {
      schema: {
        operationId: 'listRoomCategories',
        tags: ['control-plane'],
        description:
          'List school room categories with full admin DTO. Requires room.manage on the exact school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: RoomCategoryListSchema,
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
        body: await listRoomCategories(
          principal,
          request.params.organizationId,
          controlPlane.roomCategories,
        ),
        status: 200,
      }));
    },
  );

  typedApp.post(
    '/api/v1/organizations/:organizationId/room-categories',
    {
      schema: {
        operationId: 'createRoomCategory',
        tags: ['control-plane'],
        description:
          'Create a school room category (status active, revision 1). Requires Idempotency-Key. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: OrganizationIdParamsSchema,
        body: RoomCategoryWriteBodySchema,
        headers: CreateHeadersSchema,
        response: { 201: RoomCategoryResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await createRoomCategory(
          {
            principal,
            organizationId: request.params.organizationId,
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            config: {
              name: request.body.name,
              iconKey: request.body.iconKey,
              toneKey: request.body.toneKey,
              studentSurface: request.body.studentSurface,
              pickerMode: request.body.pickerMode,
              sortOrder: request.body.sortOrder,
            },
          },
          controlPlane.roomCategories,
        );
        return {
          body: { category: result.category },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.get(
    '/api/v1/room-categories/:categoryId',
    {
      schema: {
        operationId: 'getRoomCategory',
        tags: ['control-plane'],
        description:
          'Read one room category with its strong ETag. Authorized against the canonical school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: RoomCategoryIdParamsSchema,
        response: {
          200: RoomCategoryResponseSchema,
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
        const result = await getRoomCategory(
          principal,
          request.params.categoryId,
          controlPlane.roomCategories,
        );
        return { body: { category: result.category }, etag: result.etag, status: 200 };
      });
    },
  );

  typedApp.put(
    '/api/v1/room-categories/:categoryId',
    {
      schema: {
        operationId: 'updateRoomCategory',
        tags: ['control-plane'],
        description:
          'Replace category presentation metadata (never status; revision + 1). Requires Idempotency-Key and If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: RoomCategoryIdParamsSchema,
        body: RoomCategoryWriteBodySchema,
        headers: MutationHeadersSchema,
        response: { 200: RoomCategoryResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await updateRoomCategory(
          {
            principal,
            categoryId: request.params.categoryId,
            ifMatch: request.headers['if-match'],
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            config: {
              name: request.body.name,
              iconKey: request.body.iconKey,
              toneKey: request.body.toneKey,
              studentSurface: request.body.studentSurface,
              pickerMode: request.body.pickerMode,
              sortOrder: request.body.sortOrder,
            },
          },
          controlPlane.roomCategories,
        );
        return {
          body: { category: result.category },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.post(
    '/api/v1/room-categories/:categoryId/archive',
    {
      schema: {
        operationId: 'archiveRoomCategory',
        tags: ['control-plane'],
        description:
          'Archive a room category (terminal). Rejects with room_category_in_use while non-archived rooms still reference it. Requires Idempotency-Key and If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: RoomCategoryIdParamsSchema,
        headers: MutationHeadersSchema,
        response: { 200: RoomCategoryResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await archiveRoomCategory(
          {
            principal,
            categoryId: request.params.categoryId,
            ifMatch: request.headers['if-match'],
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
          },
          controlPlane.roomCategories,
        );
        return {
          body: { category: result.category },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.get(
    '/api/v1/me/organizations/:organizationId/student-room-catalog',
    {
      schema: {
        operationId: 'listMyStudentRoomCatalog',
        tags: ['control-plane'],
        description:
          'Purpose-built student launcher catalog: active primary/secondary categories with eligible rooms only. Authorized with pass.request.self semantics. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: StudentRoomCatalogSchema,
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
        body: await listMyStudentRoomCatalog(
          principal,
          request.params.organizationId,
          principal.personId,
          controlPlane.rooms,
        ),
        status: 200,
      }));
    },
  );
}
