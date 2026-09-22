import { UserContextError } from '@openhall/application';
import { ProblemDetailsSchema, UuidSchema } from '@openhall/contracts';
import { Type } from 'typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AuthorizationDependencies } from '../authorization/dependencies.js';
import { requirePrincipal } from '../auth/session-context.js';
import type { RealtimeHub, RealtimeMessage } from '../realtime/hub.js';
import { safeRequestPath } from '../http-privacy.js';

const COOKIE_SECURITY = [{ cookieAuth: [] as string[] }];
const OrganizationParamsSchema = Type.Object(
  { organizationId: UuidSchema },
  { additionalProperties: false },
);

function frame(message: RealtimeMessage): string {
  return `event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
}

export function registerRealtimeRoutes(
  app: FastifyInstance,
  authorization: AuthorizationDependencies,
  hub: RealtimeHub,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();
  typedApp.get(
    '/api/v1/organizations/:organizationId/events',
    {
      schema: {
        operationId: 'streamOrganizationEvents',
        tags: ['realtime'],
        description:
          'Same-origin, cookie-authenticated SSE invalidation stream. Events contain topics only; REST remains authoritative and no durable replay is promised.',
        security: COOKIE_SECURITY,
        params: OrganizationParamsSchema,
        response: {
          401: {
            description: 'Unauthenticated',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          403: {
            description: 'Recovery session restricted',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          404: {
            description: 'Unknown or inaccessible school',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
        },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return;
      let context;
      try {
        context = await authorization.userContext.getMyOrganizationContext(
          principal,
          request.params.organizationId,
        );
      } catch (error) {
        if (!(error instanceof UserContextError)) throw error;
        const recovery = error.code === 'recovery_session_restricted';
        await reply
          .status(recovery ? 403 : 404)
          .type('application/problem+json')
          .send({
            type: `https://openhall.dev/problems/${recovery ? error.code : 'not_found'}`,
            title: recovery ? 'Recovery sessions cannot access realtime' : 'Not found',
            status: recovery ? 403 : 404,
            instance: safeRequestPath(request.url),
            code: recovery ? error.code : 'not_found',
            requestId: request.id,
          });
        return;
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (message: RealtimeMessage): void => {
        if (!reply.raw.destroyed) reply.raw.write(frame(message));
      };
      const unsubscribe = hub.subscribe(
        {
          tenantId: principal.tenantId,
          personId: principal.personId,
          organizationId: context.organization.id,
          affiliations: context.affiliations,
          capabilities: context.capabilities,
          teachingSectionIds: context.teachingSections.map((section) => section.id),
          staffedDestinationIds: context.staffedDestinations.map((destination) => destination.id),
          teachingLocationIds: [...context.teachingMeetingLocationIds],
        },
        send,
      );
      send({ event: 'resync', data: {} });
      if (!hub.healthy) send({ event: 'realtime-unavailable', data: {} });
      const heartbeat = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
      }, 20_000);
      heartbeat.unref();
      request.raw.once('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    },
  );
}
