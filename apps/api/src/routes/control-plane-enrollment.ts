import {
  getIdentityEnrollmentStatus,
  issueIdentityEnrollment,
  revokeIdentityEnrollment,
  type Principal,
} from '@openhall/application';
import {
  IdentityEnrollmentIssueBodySchema,
  IdentityEnrollmentIssueResponseSchema,
  IdentityEnrollmentResponseSchema,
  IdentityEnrollmentStatusResponseSchema,
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
  COOKIE_SECURITY,
  COOKIE_CSRF_SECURITY,
  CreateHeadersSchema,
  MutationHeadersSchema,
  unauthenticated,
  type ControlPlaneHandler,
} from './control-plane-shared.js';

const EnrollmentPersonParamsSchema = Type.Object(
  { organizationId: UuidSchema, personId: UuidSchema },
  { additionalProperties: false },
);

const EnrollmentIdParamsSchema = Type.Object(
  { enrollmentId: UuidSchema },
  { additionalProperties: false },
);

const ENROLLMENT_ERRORS = {
  400: CONTROL_PLANE_ERRORS[400],
  401: CONTROL_PLANE_ERRORS[401],
  403: CONTROL_PLANE_ERRORS[403],
  404: CONTROL_PLANE_ERRORS[404],
  409: CONTROL_PLANE_ERRORS[409],
  412: CONTROL_PLANE_ERRORS[412],
  428: CONTROL_PLANE_ERRORS[428],
};

export function registerEnrollmentRoutes(
  app: FastifyInstance,
  controlPlane: ControlPlaneDependencies,
  auth: AuthDependencies,
  handle: ControlPlaneHandler,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.get(
    '/api/v1/organizations/:organizationId/people/:personId/enrollment',
    {
      schema: {
        operationId: 'getIdentityEnrollmentStatus',
        tags: ['control-plane'],
        description:
          'Read the live sign-in invitation for one person, if present. Returns no token, digest, identity, or provider internals. Requires identity.enroll. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: EnrollmentPersonParamsSchema,
        response: {
          200: IdentityEnrollmentStatusResponseSchema,
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
        const result = await getIdentityEnrollmentStatus(
          principal,
          request.params.organizationId,
          request.params.personId,
          controlPlane.enrollment,
        );
        return {
          body: { enrollment: result.enrollment },
          ...(result.etag === undefined ? {} : { etag: result.etag }),
          status: 200,
        };
      });
    },
  );

  typedApp.post(
    '/api/v1/organizations/:organizationId/people/:personId/enrollments',
    {
      schema: {
        operationId: 'issueIdentityEnrollment',
        tags: ['control-plane'],
        description:
          'Issue a one-time OIDC invitation for a canonical person. The raw token is returned exactly once; a replayed response carries an empty token. Requires Idempotency-Key. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: EnrollmentPersonParamsSchema,
        body: IdentityEnrollmentIssueBodySchema,
        headers: CreateHeadersSchema,
        response: { 201: IdentityEnrollmentIssueResponseSchema, ...ENROLLMENT_ERRORS },
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
        const result = await issueIdentityEnrollment(
          {
            principal,
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            organizationId: request.params.organizationId,
            personId: request.params.personId,
            providerKey: request.body.providerKey,
          },
          controlPlane.enrollment,
        );
        return {
          body: {
            enrollmentId: result.enrollment.id,
            enrollmentToken: result.enrollmentToken,
            expiresAt: result.enrollment.expiresAt,
            provider: result.provider,
          },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.post(
    '/api/v1/identity-enrollments/:enrollmentId/revoke',
    {
      schema: {
        operationId: 'revokeIdentityEnrollment',
        tags: ['control-plane'],
        description:
          'Revoke a live OIDC invitation (consumed, expired, and revoked invitations are refused). Requires Idempotency-Key and If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: EnrollmentIdParamsSchema,
        headers: MutationHeadersSchema,
        response: { 200: IdentityEnrollmentResponseSchema, ...ENROLLMENT_ERRORS },
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
        const result = await revokeIdentityEnrollment(
          {
            principal,
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            enrollmentId: request.params.enrollmentId,
            ifMatch: request.headers['if-match'],
          },
          controlPlane.enrollment,
        );
        return {
          body: { enrollment: result.enrollment },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );
}
