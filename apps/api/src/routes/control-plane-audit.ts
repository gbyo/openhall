import { listAuditEvents, type Principal } from '@openhall/application';
import { AuditEventListQuerySchema, AuditEventListResultSchema } from '@openhall/contracts';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AuthDependencies } from '../auth/dependencies.js';
import { requirePrincipal } from '../auth/session-context.js';
import type { ControlPlaneDependencies } from '../control-plane/dependencies.js';
import {
  CONTROL_PLANE_ERRORS,
  COOKIE_SECURITY,
  OrganizationIdParamsSchema,
  unauthenticated,
  type ControlPlaneHandler,
} from './control-plane-shared.js';

const DEFAULT_PAGE_LIMIT = 20;

function pageLimit(value: number | undefined): number {
  return value ?? DEFAULT_PAGE_LIMIT;
}

export function registerAuditRoutes(
  app: FastifyInstance,
  controlPlane: ControlPlaneDependencies,
  _auth: AuthDependencies,
  handle: ControlPlaneHandler,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.get(
    '/api/v1/organizations/:organizationId/audit-events',
    {
      schema: {
        operationId: 'listAuditEvents',
        tags: ['control-plane'],
        description:
          'School audit feed for administration. Requires audit.view on the exact school. Keyset pagination over (occurred_at DESC, id DESC); metadata is never projected. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        querystring: AuditEventListQuerySchema,
        response: {
          200: AuditEventListResultSchema,
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
        body: await listAuditEvents(
          principal,
          request.params.organizationId,
          {
            limit: pageLimit(request.query.limit),
            cursor: request.query.cursor ?? null,
          },
          controlPlane.audit,
        ),
        status: 200,
      }));
    },
  );
}
