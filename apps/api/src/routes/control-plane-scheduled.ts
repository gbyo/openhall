import {
  cancelScheduledAuthorization,
  createScheduledAuthorization,
  getScheduledAuthorization,
  listScheduledAuthorizations,
  listScheduledStudents,
  type Principal,
} from '@openhall/application';
import {
  ScheduledAuthCreateBodySchema,
  ScheduledAuthListSchema,
  ScheduledAuthResponseSchema,
  ScheduledStudentListSchema,
  UuidSchema,
} from '@openhall/contracts';
import { Type } from 'typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AuthDependencies } from '../auth/dependencies.js';
import { requireCsrf, requirePrincipal } from '../auth/session-context.js';
import type { ControlPlaneDependencies } from '../control-plane/dependencies.js';
import {
  CONTROL_PLANE_ERRORS,
  COOKIE_CSRF_SECURITY,
  COOKIE_SECURITY,
  CreateHeadersSchema,
  MutationHeadersSchema,
  OrganizationIdParamsSchema,
  unauthenticated,
  type ControlPlaneHandler,
} from './control-plane-shared.js';

const ScheduledAuthIdParamsSchema = Type.Object(
  { scheduledAuthorizationId: UuidSchema },
  { additionalProperties: false },
);

/** Student chooser query: affiliation is fixed to student, never a filter. */
const StudentLookupQuerySchema = Type.Object(
  {
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { additionalProperties: false },
);

const SCHEDULED_ERRORS = {
  400: CONTROL_PLANE_ERRORS[400],
  401: CONTROL_PLANE_ERRORS[401],
  403: CONTROL_PLANE_ERRORS[403],
  404: CONTROL_PLANE_ERRORS[404],
  409: CONTROL_PLANE_ERRORS[409],
  412: CONTROL_PLANE_ERRORS[412],
  428: CONTROL_PLANE_ERRORS[428],
};

const DEFAULT_PAGE_LIMIT = 20;

export function registerScheduledRoutes(
  app: FastifyInstance,
  controlPlane: ControlPlaneDependencies,
  auth: AuthDependencies,
  handle: ControlPlaneHandler,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.get(
    '/api/v1/organizations/:organizationId/scheduled-authorizations',
    {
      schema: {
        operationId: 'listScheduledAuthorizations',
        tags: ['control-plane'],
        description:
          'List staff-directed appointments. Requires scheduled_authorization.manage on the exact school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: ScheduledAuthListSchema,
          401: CONTROL_PLANE_ERRORS[401],
          403: CONTROL_PLANE_ERRORS[403],
          404: CONTROL_PLANE_ERRORS[404],
        },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal: Principal | undefined = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => ({
        body: await listScheduledAuthorizations(
          principal,
          request.params.organizationId,
          controlPlane.scheduled,
        ),
        status: 200,
      }));
    },
  );

  typedApp.post(
    '/api/v1/organizations/:organizationId/scheduled-authorizations',
    {
      schema: {
        operationId: 'createScheduledAuthorization',
        tags: ['control-plane'],
        description:
          'Book a staff-directed appointment window within one school day (max 12h, 366-day horizon). Requires Idempotency-Key. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: OrganizationIdParamsSchema,
        body: ScheduledAuthCreateBodySchema,
        headers: CreateHeadersSchema,
        response: { 201: ScheduledAuthResponseSchema, ...SCHEDULED_ERRORS },
      },
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal: Principal | undefined = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await createScheduledAuthorization(
          {
            principal,
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            organizationId: request.params.organizationId,
            body: {
              studentId: request.body.studentId,
              destinationId: request.body.destinationId,
              validFrom: request.body.validFrom,
              validUntil: request.body.validUntil,
              approvalMode: request.body.approvalMode,
              originStrategy: request.body.origin.strategy,
              originLocationId:
                request.body.origin.strategy === 'specific' ? request.body.origin.locationId : null,
            },
          },
          controlPlane.scheduled,
        );
        return {
          body: { authorization: result.authorization },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.get(
    '/api/v1/scheduled-authorizations/:scheduledAuthorizationId',
    {
      schema: {
        operationId: 'getScheduledAuthorization',
        tags: ['control-plane'],
        description:
          'Staff detail for one appointment with a strong ETag. The persisted status is returned; expiry is derived by readers from the window. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: ScheduledAuthIdParamsSchema,
        response: {
          200: ScheduledAuthResponseSchema,
          401: CONTROL_PLANE_ERRORS[401],
          403: CONTROL_PLANE_ERRORS[403],
          404: CONTROL_PLANE_ERRORS[404],
        },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal: Principal | undefined = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await getScheduledAuthorization(
          principal,
          request.params.scheduledAuthorizationId,
          controlPlane.scheduled,
        );
        return { body: { authorization: result.authorization }, etag: result.etag, status: 200 };
      });
    },
  );

  typedApp.post(
    '/api/v1/scheduled-authorizations/:scheduledAuthorizationId/cancel',
    {
      schema: {
        operationId: 'cancelScheduledAuthorization',
        tags: ['control-plane'],
        description:
          'Cancel a live appointment with staff provenance. Used, cancelled, and expired rows are refused; passes are never touched. Requires Idempotency-Key and If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: ScheduledAuthIdParamsSchema,
        headers: MutationHeadersSchema,
        response: { 200: ScheduledAuthResponseSchema, ...SCHEDULED_ERRORS },
      },
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal: Principal | undefined = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => {
        const result = await cancelScheduledAuthorization(
          {
            principal,
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            scheduledAuthorizationId: request.params.scheduledAuthorizationId,
            ifMatch: request.headers['if-match'],
          },
          controlPlane.scheduled,
        );
        return {
          body: { authorization: result.authorization },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.get(
    '/api/v1/organizations/:organizationId/students',
    {
      schema: {
        operationId: 'listScheduledStudents',
        tags: ['control-plane'],
        description:
          'Narrow student chooser for scheduled movement. Requires scheduled_authorization.manage — no people.view needed. Bounded keyset pagination. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        querystring: StudentLookupQuerySchema,
        response: {
          200: ScheduledStudentListSchema,
          401: CONTROL_PLANE_ERRORS[401],
          403: CONTROL_PLANE_ERRORS[403],
          404: CONTROL_PLANE_ERRORS[404],
        },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal: Principal | undefined = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      await handle(request, reply, async () => ({
        body: await listScheduledStudents(
          principal,
          request.params.organizationId,
          {
            q: request.query.q ?? null,
            limit: request.query.limit ?? DEFAULT_PAGE_LIMIT,
            cursor: request.query.cursor ?? null,
          },
          controlPlane.scheduled,
        ),
        status: 200,
      }));
    },
  );
}
