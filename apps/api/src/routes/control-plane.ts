import {
  archiveDestination,
  archiveLocation,
  closeDestination,
  createDestination,
  createLocation,
  getDestination,
  getLocation,
  listDestinations,
  listLocations,
  listMyDestinations,
  openDestination,
  updateDestination,
  updateLocation,
} from '@openhall/application';
import {
  DestinationCatalogSchema,
  DestinationListSchema,
  DestinationResponseSchema,
  DestinationWriteBodySchema,
  LocationListSchema,
  LocationResponseSchema,
  LocationWriteBodySchema,
} from '@openhall/contracts';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { requireCsrf, requirePrincipal } from '../auth/session-context.js';
import { registerAuditRoutes } from './control-plane-audit.js';
import { registerDestinationCategoryRoutes } from './control-plane-destination-categories.js';
import { registerPlaceRoutes } from './control-plane-places.js';
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
  DestinationIdParamsSchema,
  LocationIdParamsSchema,
  MutationHeadersSchema,
  OrganizationIdParamsSchema,
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

  // ---- Locations ----

  typedApp.get(
    '/api/v1/organizations/:organizationId/locations',
    {
      schema: {
        operationId: 'listLocations',
        tags: ['control-plane'],
        description:
          'List school locations for administration. Requires destination.manage on the exact school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: LocationListSchema,
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
        body: await listLocations(principal, request.params.organizationId, controlPlane.locations),
        status: 200,
      }));
    },
  );

  typedApp.post(
    '/api/v1/organizations/:organizationId/locations',
    {
      schema: {
        operationId: 'createLocation',
        tags: ['control-plane'],
        description:
          'Create a school location (status active, revision 1). Requires Idempotency-Key. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: OrganizationIdParamsSchema,
        body: LocationWriteBodySchema,
        headers: CreateHeadersSchema,
        response: { 201: LocationResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await createLocation(
          {
            principal,
            organizationId: request.params.organizationId,
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            parentLocationId: request.body.parentLocationId,
            kind: request.body.kind,
            name: request.body.name,
            code: request.body.code,
            floorLabel: request.body.floorLabel,
          },
          controlPlane.locations,
        );
        return {
          body: { location: result.location },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.get(
    '/api/v1/locations/:locationId',
    {
      schema: {
        operationId: 'getLocation',
        tags: ['control-plane'],
        description:
          'Read one location with its strong ETag. Authorized against the canonical school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: LocationIdParamsSchema,
        response: {
          200: LocationResponseSchema,
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
        const result = await getLocation(
          principal,
          request.params.locationId,
          controlPlane.locations,
        );
        return { body: { location: result.location }, etag: result.etag, status: 200 };
      });
    },
  );

  typedApp.put(
    '/api/v1/locations/:locationId',
    {
      schema: {
        operationId: 'updateLocation',
        tags: ['control-plane'],
        description:
          'Replace location metadata (full replacement, revision + 1). Requires Idempotency-Key and If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: LocationIdParamsSchema,
        body: LocationWriteBodySchema,
        headers: MutationHeadersSchema,
        response: { 200: LocationResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await updateLocation(
          {
            principal,
            locationId: request.params.locationId,
            ifMatch: request.headers['if-match'],
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            parentLocationId: request.body.parentLocationId,
            kind: request.body.kind,
            name: request.body.name,
            code: request.body.code,
            floorLabel: request.body.floorLabel,
          },
          controlPlane.locations,
        );
        return {
          body: { location: result.location },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.post(
    '/api/v1/locations/:locationId/archive',
    {
      schema: {
        operationId: 'archiveLocation',
        tags: ['control-plane'],
        description:
          'Archive a location (never delete). Rejects with location_in_use while still required. Requires Idempotency-Key and If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: LocationIdParamsSchema,
        headers: MutationHeadersSchema,
        response: { 200: LocationResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await archiveLocation(
          {
            principal,
            locationId: request.params.locationId,
            ifMatch: request.headers['if-match'],
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
          },
          controlPlane.locations,
        );
        return {
          body: { location: result.location },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  // ---- Destinations ----

  typedApp.get(
    '/api/v1/organizations/:organizationId/destinations',
    {
      schema: {
        operationId: 'listDestinations',
        tags: ['control-plane'],
        description:
          'List school destinations with full admin DTO. Requires destination.manage on the exact school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: DestinationListSchema,
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
        body: await listDestinations(
          principal,
          request.params.organizationId,
          controlPlane.destinations,
        ),
        status: 200,
      }));
    },
  );

  typedApp.post(
    '/api/v1/organizations/:organizationId/destinations',
    {
      schema: {
        operationId: 'createDestination',
        tags: ['control-plane'],
        description:
          'Create a destination starting closed (never active) for post-configuration review. Requires Idempotency-Key. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: OrganizationIdParamsSchema,
        body: DestinationWriteBodySchema,
        headers: CreateHeadersSchema,
        response: { 201: DestinationResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await createDestination(
          {
            principal,
            organizationId: request.params.organizationId,
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            config: {
              locationId: request.body.locationId,
              categoryId: request.body.categoryId,
              studentSelfRequestable: request.body.studentSelfRequestable,
              serviceType: request.body.serviceType,
              displayName: request.body.displayName,
              capacity: request.body.capacity,
              queueEnabled: request.body.queueEnabled,
              checkInMode: request.body.checkInMode,
              defaultDurationSeconds: request.body.defaultDurationSeconds,
              maxDurationSeconds: request.body.maxDurationSeconds,
              readyClaimTimeoutSeconds: request.body.readyClaimTimeoutSeconds,
              queueTimeoutSeconds: request.body.queueTimeoutSeconds,
            },
          },
          controlPlane.destinations,
        );
        return {
          body: { destination: result.destination },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.get(
    '/api/v1/destinations/:destinationId',
    {
      schema: {
        operationId: 'getDestination',
        tags: ['control-plane'],
        description:
          'Read one destination with its strong ETag. Authorized against the canonical school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: DestinationIdParamsSchema,
        response: {
          200: DestinationResponseSchema,
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
        const result = await getDestination(
          principal,
          request.params.destinationId,
          controlPlane.destinations,
        );
        return { body: { destination: result.destination }, etag: result.etag, status: 200 };
      });
    },
  );

  typedApp.put(
    '/api/v1/destinations/:destinationId',
    {
      schema: {
        operationId: 'updateDestination',
        tags: ['control-plane'],
        description:
          'Replace destination configuration (never status; revision + 1). Edits are prospective and never rewrite active movement. Requires Idempotency-Key and If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: DestinationIdParamsSchema,
        body: DestinationWriteBodySchema,
        headers: MutationHeadersSchema,
        response: { 200: DestinationResponseSchema, ...CONTROL_PLANE_ERRORS },
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
        const result = await updateDestination(
          {
            principal,
            destinationId: request.params.destinationId,
            ifMatch: request.headers['if-match'],
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            config: {
              locationId: request.body.locationId,
              categoryId: request.body.categoryId,
              studentSelfRequestable: request.body.studentSelfRequestable,
              serviceType: request.body.serviceType,
              displayName: request.body.displayName,
              capacity: request.body.capacity,
              queueEnabled: request.body.queueEnabled,
              checkInMode: request.body.checkInMode,
              defaultDurationSeconds: request.body.defaultDurationSeconds,
              maxDurationSeconds: request.body.maxDurationSeconds,
              readyClaimTimeoutSeconds: request.body.readyClaimTimeoutSeconds,
              queueTimeoutSeconds: request.body.queueTimeoutSeconds,
            },
          },
          controlPlane.destinations,
        );
        return {
          body: { destination: result.destination },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  for (const verb of ['open', 'close', 'archive'] as const) {
    typedApp.post(
      `/api/v1/destinations/:destinationId/${verb}`,
      {
        schema: {
          operationId:
            verb === 'open'
              ? 'openDestination'
              : verb === 'close'
                ? 'closeDestination'
                : 'archiveDestination',
          tags: ['control-plane'],
          description:
            verb === 'archive'
              ? 'Archive a destination (terminal). Rejects with destination_in_use while live references remain. Requires Idempotency-Key and If-Match. Cache-Control: no-store.'
              : `Semantic destination ${verb} (revision + 1). Requires Idempotency-Key and If-Match. Cache-Control: no-store.`,
          security: COOKIE_CSRF_SECURITY,
          params: DestinationIdParamsSchema,
          headers: MutationHeadersSchema,
          response: { 200: DestinationResponseSchema, ...CONTROL_PLANE_ERRORS },
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
            destinationId: request.params.destinationId,
            ifMatch: request.headers['if-match'],
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
          };
          const result =
            verb === 'open'
              ? await openDestination(input, controlPlane.destinations)
              : verb === 'close'
                ? await closeDestination(input, controlPlane.destinations)
                : await archiveDestination(input, controlPlane.destinations);
          return {
            body: { destination: result.destination },
            etag: result.etag,
            status: result.status,
          };
        });
      },
    );
  }

  typedApp.get(
    '/api/v1/me/organizations/:organizationId/destinations',
    {
      schema: {
        operationId: 'listMyDestinations',
        tags: ['control-plane'],
        description:
          'Stable safe destination catalog for organization members (active destinations, picker-safe fields only). Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: DestinationCatalogSchema,
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
        body: await listMyDestinations(
          principal,
          request.params.organizationId,
          controlPlane.destinations,
        ),
        status: 200,
      }));
    },
  );

  registerDestinationCategoryRoutes(typedApp, controlPlane, auth, handle);
  registerPlaceRoutes(typedApp, controlPlane, auth, handle);
  registerAuditRoutes(typedApp, controlPlane, auth, handle);
  registerScheduleRoutes(typedApp, controlPlane, auth, handle);
  registerPolicyRoutes(typedApp, controlPlane, auth, handle);
  registerGrantRoutes(typedApp, controlPlane, auth, handle);
  registerPeopleRoutes(typedApp, controlPlane, auth, handle);
  registerEnrollmentRoutes(typedApp, controlPlane, auth, handle);
  registerScheduledRoutes(typedApp, controlPlane, auth, handle);
  registerScheduledStudentRoutes(typedApp, controlPlane, auth);
}
