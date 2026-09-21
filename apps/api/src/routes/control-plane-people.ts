import {
  searchOrganizationPeople,
  searchOrganizationSections,
  type Principal,
} from '@openhall/application';
import {
  PeopleSearchQuerySchema,
  PeopleSearchResultSchema,
  SectionSearchQuerySchema,
  SectionSearchResultSchema,
} from '@openhall/contracts';
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

export function registerPeopleRoutes(
  app: FastifyInstance,
  controlPlane: ControlPlaneDependencies,
  _auth: AuthDependencies,
  handle: ControlPlaneHandler,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.get(
    '/api/v1/organizations/:organizationId/people',
    {
      schema: {
        operationId: 'searchOrganizationPeople',
        tags: ['control-plane'],
        description:
          'Search school people for administration. Requires people.view on the exact school. Bounded keyset pagination. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        querystring: PeopleSearchQuerySchema,
        response: {
          200: PeopleSearchResultSchema,
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
        body: await searchOrganizationPeople(
          principal,
          request.params.organizationId,
          {
            q: request.query.q ?? null,
            affiliation: request.query.affiliation ?? null,
            limit: pageLimit(request.query.limit),
            cursor: request.query.cursor ?? null,
          },
          controlPlane.people,
        ),
        status: 200,
      }));
    },
  );

  typedApp.get(
    '/api/v1/organizations/:organizationId/sections',
    {
      schema: {
        operationId: 'searchOrganizationSections',
        tags: ['control-plane'],
        description:
          'Read-only section chooser for policy configuration. Requires schedule.view or people.view on the exact school. No membership rosters. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        querystring: SectionSearchQuerySchema,
        response: {
          200: SectionSearchResultSchema,
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
        body: await searchOrganizationSections(
          principal,
          request.params.organizationId,
          {
            q: request.query.q ?? null,
            limit: pageLimit(request.query.limit),
            cursor: request.query.cursor ?? null,
          },
          controlPlane.people,
        ),
        status: 200,
      }));
    },
  );
}
