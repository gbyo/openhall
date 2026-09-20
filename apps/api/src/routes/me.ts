import {
  UserContextError,
  type Capability,
  type ExpectedPlacementResult,
  type OrganizationContext,
} from '@openhall/application';
import {
  MyOrganizationContextSchema,
  MyOrganizationsSchema,
  ProblemDetailsSchema,
  UuidSchema,
} from '@openhall/contracts';
import { Type } from 'typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AuthorizationDependencies } from '../authorization/dependencies.js';
import { requirePrincipal } from '../auth/session-context.js';

const COOKIE_SECURITY = [{ cookieAuth: [] as string[] }];

const OrganizationIdParamsSchema = Type.Object(
  { organizationId: UuidSchema },
  { additionalProperties: false },
);

interface PlacementBlockBody {
  id: string;
  code: string;
  displayName: string;
  kind: string;
}

type PublicExpectedPlacement =
  | {
      kind: 'resolved';
      block: PlacementBlockBody;
      section: { id: string; code: string | null; title: string };
      expectedLocation: {
        id: string;
        name: string;
        code: string | null;
        kind: string;
      } | null;
      beginsAt: string;
      endsAt: string;
      elapsedSeconds: number;
      remainingSeconds: number;
    }
  | {
      kind: 'block_only';
      block: PlacementBlockBody;
      beginsAt: string;
      endsAt: string;
      elapsedSeconds: number;
      remainingSeconds: number;
    }
  | { kind: 'outside_schedule' }
  | { kind: 'non_instructional_day'; dayKind: 'non_instructional' | 'closed' }
  | { kind: 'calendar_not_configured' }
  | { kind: 'not_member' }
  | {
      kind: 'ambiguous';
      reason: 'multiple_placements' | 'overlapping_unassigned_slots';
    }
  | {
      kind: 'configuration_error';
      code:
        | 'school_not_found'
        | 'organization_not_school'
        | 'invalid_school_time_zone'
        | 'instructional_day_missing_template'
        | 'invalid_slot_wall_time';
    }
  | null;

/**
 * Minimized public projection of the Phase 2 resolver result. Internal
 * diagnostics (candidate IDs, configuration messages, teacher lists) never
 * reach the wire; configuration errors expose code only.
 */
export function toPublicExpectedPlacement(
  result: ExpectedPlacementResult | null,
): PublicExpectedPlacement {
  if (result === null) return null;
  switch (result.kind) {
    case 'resolved':
      return {
        kind: 'resolved',
        block: {
          id: result.block.id,
          code: result.block.code,
          displayName: result.block.displayName,
          kind: result.block.kind,
        },
        section: { id: result.section.id, code: result.section.code, title: result.section.title },
        expectedLocation:
          result.expectedLocation === null
            ? null
            : {
                id: result.expectedLocation.id,
                name: result.expectedLocation.name,
                code: result.expectedLocation.code,
                kind: result.expectedLocation.kind,
              },
        beginsAt: result.beginsAt.toString(),
        endsAt: result.endsAt.toString(),
        elapsedSeconds: result.elapsedSeconds,
        remainingSeconds: result.remainingSeconds,
      };
    case 'block_only':
      return {
        kind: 'block_only',
        block: {
          id: result.block.id,
          code: result.block.code,
          displayName: result.block.displayName,
          kind: result.block.kind,
        },
        beginsAt: result.beginsAt.toString(),
        endsAt: result.endsAt.toString(),
        elapsedSeconds: result.elapsedSeconds,
        remainingSeconds: result.remainingSeconds,
      };
    case 'outside_schedule':
      return { kind: 'outside_schedule' };
    case 'non_instructional_day':
      return { kind: 'non_instructional_day', dayKind: result.dayKind };
    case 'calendar_not_configured':
      return { kind: 'calendar_not_configured' };
    case 'not_member':
      return { kind: 'not_member' };
    case 'ambiguous':
      return { kind: 'ambiguous', reason: result.reason };
    case 'configuration_error':
      return { kind: 'configuration_error', code: result.code };
    default:
      return null;
  }
}

function toContextBody(context: OrganizationContext): {
  organization: { id: string; name: string; slug: string; timeZone: string };
  affiliations: ('student' | 'staff' | 'other')[];
  capabilities: Capability[];
  expectedPlacement: PublicExpectedPlacement;
  teachingSections: {
    id: string;
    code: string | null;
    title: string;
    capabilities: Capability[];
  }[];
  staffedDestinations: {
    id: string;
    displayName: string;
    serviceType: string;
    capabilities: Capability[];
  }[];
} {
  return {
    organization: { ...context.organization },
    affiliations: [...context.affiliations],
    capabilities: [...context.capabilities],
    expectedPlacement: toPublicExpectedPlacement(context.expectedPlacement),
    teachingSections: context.teachingSections.map((section) => ({
      id: section.id,
      code: section.code,
      title: section.title,
      capabilities: [...section.capabilities],
    })),
    staffedDestinations: context.staffedDestinations.map((destination) => ({
      id: destination.id,
      displayName: destination.displayName,
      serviceType: destination.serviceType,
      capabilities: [...destination.capabilities],
    })),
  };
}

async function sendContextProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  error: UserContextError,
): Promise<void> {
  if (error.code === 'recovery_session_restricted') {
    await reply
      .status(403)
      .type('application/problem+json')
      .send({
        type: 'https://openhall.dev/problems/recovery_session_restricted',
        title: 'Recovery sessions cannot access operational contexts',
        status: 403,
        instance: request.url.split('?')[0],
        code: 'recovery_session_restricted',
        requestId: request.id,
      });
    return;
  }
  await reply
    .status(404)
    .type('application/problem+json')
    .send({
      type: 'https://openhall.dev/problems/not_found',
      title: 'Not found',
      status: 404,
      instance: request.url.split('?')[0],
      code: 'not_found',
      requestId: request.id,
    });
}

export function registerMeRoutes(
  app: FastifyInstance,
  dependencies: AuthorizationDependencies,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.get(
    '/api/v1/me/organizations',
    {
      schema: {
        operationId: 'listMyOrganizations',
        tags: ['me'],
        description:
          'Schools the authenticated person may legitimately enter right now. Recovery sessions are rejected.',
        security: COOKIE_SECURITY,
        response: {
          200: MyOrganizationsSchema,
          401: {
            description: 'Unauthenticated',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          403: {
            description: 'Recovery session restricted',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
        },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        return reply.status(401).send({
          type: 'https://openhall.dev/problems/unauthenticated',
          title: 'Unauthenticated',
          status: 401,
          code: 'unauthenticated',
          requestId: request.id,
        });
      }
      try {
        const organizations = await dependencies.userContext.listMyOrganizations(principal);
        return await reply.header('Cache-Control', 'no-store').send({
          organizations: organizations.map((organization) => ({
            ...organization,
            affiliations: [...organization.affiliations],
          })),
        });
      } catch (error) {
        if (error instanceof UserContextError) {
          await sendContextProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/api/v1/me/organizations/:organizationId/context',
    {
      schema: {
        operationId: 'getMyOrganizationContext',
        tags: ['me'],
        description:
          'What the authenticated person may do in one exact school, plus their own schedule context. Unknown or inaccessible schools return 404 without revealing existence.',
        security: COOKIE_SECURITY,
        params: OrganizationIdParamsSchema,
        response: {
          200: MyOrganizationContextSchema,
          401: {
            description: 'Unauthenticated',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          403: {
            description: 'Recovery session restricted',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          404: {
            description: 'Unknown or inaccessible organization',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
        },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) {
        return reply.status(401).send({
          type: 'https://openhall.dev/problems/unauthenticated',
          title: 'Unauthenticated',
          status: 401,
          code: 'unauthenticated',
          requestId: request.id,
        });
      }
      try {
        const context = await dependencies.userContext.getMyOrganizationContext(
          principal,
          request.params.organizationId,
        );
        return await reply.header('Cache-Control', 'no-store').send(toContextBody(context));
      } catch (error) {
        if (error instanceof UserContextError) {
          await sendContextProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );
}
