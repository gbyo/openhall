import {
  issueAuthorizationGrant,
  listAuthorizationGrants,
  revokeAuthorizationGrant,
  type Principal,
} from '@openhall/application';
import {
  AuthorizationGrantIssueBodySchema,
  AuthorizationGrantListSchema,
  AuthorizationGrantResponseSchema,
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
  CreateHeadersSchema,
  MutationHeadersSchema,
  OrganizationIdParamsSchema,
  unauthenticated,
  type ControlPlaneHandler,
} from './control-plane-shared.js';

const GrantIdParamsSchema = Type.Object({ grantId: UuidSchema }, { additionalProperties: false });

const GRANT_ERRORS = {
  400: CONTROL_PLANE_ERRORS[400],
  401: CONTROL_PLANE_ERRORS[401],
  403: CONTROL_PLANE_ERRORS[403],
  404: CONTROL_PLANE_ERRORS[404],
  409: CONTROL_PLANE_ERRORS[409],
  412: CONTROL_PLANE_ERRORS[412],
  428: CONTROL_PLANE_ERRORS[428],
};

export function registerGrantRoutes(
  app: FastifyInstance,
  controlPlane: ControlPlaneDependencies,
  auth: AuthDependencies,
  handle: ControlPlaneHandler,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  function grantInput(request: FastifyRequest, principal: Principal) {
    return {
      principal,
      ifMatch: request.headers['if-match'],
      idempotencyKey: request.headers['idempotency-key'],
      requestId: request.id,
    };
  }

  typedApp.get(
    '/api/v1/organizations/:organizationId/authorization-grants',
    {
      schema: {
        operationId: 'listAuthorizationGrants',
        tags: ['control-plane'],
        description:
          'List explicit staff duties for administration. Requires authorization.manage on the exact school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: AuthorizationGrantListSchema,
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
        body: await listAuthorizationGrants(
          principal,
          request.params.organizationId,
          controlPlane.grants,
        ),
        status: 200,
      }));
    },
  );

  typedApp.post(
    '/api/v1/organizations/:organizationId/authorization-grants',
    {
      schema: {
        operationId: 'issueAuthorizationGrant',
        tags: ['control-plane'],
        description:
          'Issue an explicit staff duty to an active staff member. Scope derives from role; a missing account is created login-less. Duplicate active duties report authorization_grant_exists. Requires Idempotency-Key. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: OrganizationIdParamsSchema,
        body: AuthorizationGrantIssueBodySchema,
        headers: CreateHeadersSchema,
        response: { 201: AuthorizationGrantResponseSchema, ...GRANT_ERRORS },
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
        const result = await issueAuthorizationGrant(
          {
            ...grantInput(request, principal),
            organizationId: request.params.organizationId,
            body: {
              personId: request.body.personId,
              role: request.body.role,
              destinationId: request.body.destinationId,
              validFrom: request.body.validFrom,
              validUntil: request.body.validUntil,
            },
          },
          controlPlane.grants,
        );
        return {
          body: { grant: result.grant },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );

  typedApp.post(
    '/api/v1/authorization-grants/:grantId/revoke',
    {
      schema: {
        operationId: 'revokeAuthorizationGrant',
        tags: ['control-plane'],
        description:
          'Revoke an explicit staff duty (semantic revoke; rows are never deleted). Requires Idempotency-Key and If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: GrantIdParamsSchema,
        headers: MutationHeadersSchema,
        response: { 200: AuthorizationGrantResponseSchema, ...GRANT_ERRORS },
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
        const result = await revokeAuthorizationGrant(
          {
            ...grantInput(request, principal),
            grantId: request.params.grantId,
          },
          controlPlane.grants,
        );
        return {
          body: { grant: result.grant },
          etag: result.etag,
          status: result.status,
        };
      });
    },
  );
}
