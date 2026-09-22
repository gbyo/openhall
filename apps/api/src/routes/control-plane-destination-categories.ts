import {
  archiveDestinationCategory,
  createDestinationCategory,
  getDestinationCategory,
  listDestinationCategories,
  listMyStudentDestinationCatalog,
  updateDestinationCategory,
} from '@openhall/application';
import {
  DestinationCategoryListSchema,
  DestinationCategoryResponseSchema,
  DestinationCategoryWriteBodySchema,
  StudentDestinationCatalogSchema,
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
  DestinationCategoryIdParamsSchema,
  MutationHeadersSchema,
  OrganizationIdParamsSchema,
  unauthenticated,
  type ControlPlaneHandler,
} from './control-plane-shared.js';

/**
 * Destination-category administration plus the purpose-built student
 * launcher catalog. Categories live under `destination.manage` on the exact
 * school — no separate capability. The student catalog is a separate
 * endpoint authorized with `pass.request.self` semantics; the flat member
 * catalog stays untouched for staff workflows.
 */
export function registerDestinationCategoryRoutes(
  app: FastifyInstance,
  controlPlane: ControlPlaneDependencies,
  auth: AuthDependencies,
  handle: ControlPlaneHandler,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.get(
    '/api/v1/organizations/:organizationId/destination-categories',
    {
      schema: {
        operationId: 'listDestinationCategories',
        tags: ['control-plane'],
        description:
          'List school destination categories with full admin DTO. Requires destination.manage on the exact school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: DestinationCategoryListSchema,
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
        body: await listDestinationCategories(
          principal,
          request.params.organizationId,
          controlPlane.destinationCategories,
        ),
        status: 200,
      }));
    },
  );

  typedApp.post(
    '/api/v1/organizations/:organizationId/destination-categories',
    {
      schema: {
        operationId: 'createDestinationCategory',
        tags: ['control-plane'],
        description:
          'Create a school destination category (status active, revision 1). Requires Idempotency-Key. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: OrganizationIdParamsSchema,
        body: DestinationCategoryWriteBodySchema,
        headers: CreateHeadersSchema,
        response: { 201: DestinationCategoryResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await createDestinationCategory(
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
          controlPlane.destinationCategories,
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
    '/api/v1/destination-categories/:categoryId',
    {
      schema: {
        operationId: 'getDestinationCategory',
        tags: ['control-plane'],
        description:
          'Read one destination category with its strong ETag. Authorized against the canonical school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: DestinationCategoryIdParamsSchema,
        response: {
          200: DestinationCategoryResponseSchema,
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
        const result = await getDestinationCategory(
          principal,
          request.params.categoryId,
          controlPlane.destinationCategories,
        );
        return { body: { category: result.category }, etag: result.etag, status: 200 };
      });
    },
  );

  typedApp.put(
    '/api/v1/destination-categories/:categoryId',
    {
      schema: {
        operationId: 'updateDestinationCategory',
        tags: ['control-plane'],
        description:
          'Replace category presentation metadata (never status; revision + 1). Renames never mutate destination service types. Requires Idempotency-Key and If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: DestinationCategoryIdParamsSchema,
        body: DestinationCategoryWriteBodySchema,
        headers: MutationHeadersSchema,
        response: { 200: DestinationCategoryResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await updateDestinationCategory(
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
          controlPlane.destinationCategories,
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
    '/api/v1/destination-categories/:categoryId/archive',
    {
      schema: {
        operationId: 'archiveDestinationCategory',
        tags: ['control-plane'],
        description:
          'Archive a destination category (terminal). Rejects with destination_category_in_use while non-archived destinations still reference it. Requires Idempotency-Key and If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: DestinationCategoryIdParamsSchema,
        headers: MutationHeadersSchema,
        response: { 200: DestinationCategoryResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await archiveDestinationCategory(
          {
            principal,
            categoryId: request.params.categoryId,
            ifMatch: request.headers['if-match'],
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
          },
          controlPlane.destinationCategories,
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
    '/api/v1/me/organizations/:organizationId/student-destination-catalog',
    {
      schema: {
        operationId: 'listMyStudentDestinationCatalog',
        tags: ['control-plane'],
        description:
          'Purpose-built student launcher catalog: active primary/secondary categories with eligible destinations only. Authorized with pass.request.self semantics. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: StudentDestinationCatalogSchema,
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
        body: await listMyStudentDestinationCatalog(
          principal,
          request.params.organizationId,
          principal.personId,
          controlPlane.destinations,
        ),
        status: 200,
      }));
    },
  );
}
