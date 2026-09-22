import { bulkCreateDestinationsFromLocations, getPlace, listPlaces } from '@openhall/application';
import {
  BulkCreateDestinationsBodySchema,
  BulkCreateDestinationsResponseSchema,
  PlaceListSchema,
  PlaceResponseSchema,
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
  LocationIdParamsSchema,
  OrganizationIdParamsSchema,
  unauthenticated,
  type ControlPlaneHandler,
} from './control-plane-shared.js';

/**
 * Places administration: the admin-facing composition over LOCATION rows
 * with derived classroom usage and pass-destination summaries. The
 * database tables stay separate; this is information architecture only.
 */
export function registerPlaceRoutes(
  app: FastifyInstance,
  controlPlane: ControlPlaneDependencies,
  auth: AuthDependencies,
  handle: ControlPlaneHandler,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.get(
    '/api/v1/organizations/:organizationId/places',
    {
      schema: {
        operationId: 'listPlaces',
        tags: ['control-plane'],
        description:
          'List school Places (location rows) with derived class usage and pass-destination summaries. Requires destination.manage on the exact school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: PlaceListSchema,
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
        body: await listPlaces(principal, request.params.organizationId, controlPlane.places),
        status: 200,
      }));
    },
  );

  typedApp.get(
    '/api/v1/places/:locationId',
    {
      schema: {
        operationId: 'getPlace',
        tags: ['control-plane'],
        description:
          'Read one Place with its classes and pass destinations. Authorized against the canonical school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: LocationIdParamsSchema,
        response: {
          200: PlaceResponseSchema,
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
        body: await getPlace(principal, request.params.locationId, controlPlane.places),
        status: 200,
      }));
    },
  );

  typedApp.post(
    '/api/v1/organizations/:organizationId/destinations/bulk-create-from-locations',
    {
      schema: {
        operationId: 'bulkCreateDestinationsFromLocations',
        tags: ['control-plane'],
        description:
          'Idempotent classroom-visit setup: one ordinary closed destination per selected Place in the given pass category. Already-covered Places are skipped, never duplicated. Requires Idempotency-Key. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: OrganizationIdParamsSchema,
        body: BulkCreateDestinationsBodySchema,
        headers: CreateHeadersSchema,
        response: { 200: BulkCreateDestinationsResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await bulkCreateDestinationsFromLocations(
          {
            principal,
            organizationId: request.params.organizationId,
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            locationIds: request.body.locationIds,
            categoryId: request.body.categoryId,
            studentSelfRequestable: request.body.studentSelfRequestable,
            checkInMode: request.body.checkInMode,
            capacity: request.body.capacity ?? null,
            defaultDurationSeconds: request.body.defaultDurationSeconds ?? null,
          },
          controlPlane.places,
        );
        return {
          body: { created: result.created, skippedLocationIds: result.skippedLocationIds },
          status: result.status,
        };
      });
    },
  );
}
