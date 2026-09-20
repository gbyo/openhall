import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { LivenessSchema, ProblemDetailsSchema, ReadinessSchema } from '@openhall/contracts';
import type { ReadinessProbe } from '@openhall/db';
import { safeRequestPath } from '../http-privacy.js';

export function registerHealthRoutes(app: FastifyInstance, readinessProbe: ReadinessProbe): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.get(
    '/health/live',
    {
      schema: {
        operationId: 'getLiveness',
        tags: ['health'],
        response: { 200: LivenessSchema },
      },
    },
    () => ({ status: 'ok' as const }),
  );

  typedApp.get(
    '/health/ready',
    {
      schema: {
        operationId: 'getReadiness',
        tags: ['health'],
        response: {
          200: ReadinessSchema,
          503: {
            description: 'A required dependency is unavailable or not current.',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const status = await readinessProbe.check();
        return {
          status: 'ready' as const,
          database: 'ready' as const,
          migration: status.migration,
        };
      } catch (error) {
        request.log.warn({ err: error, action: 'readiness_failed' }, 'Readiness check failed');
        return reply.status(503).type('application/problem+json').send({
          type: 'https://openhall.dev/problems/not_ready',
          title: 'Service unavailable',
          status: 503,
          detail: 'A required dependency is unavailable or not current.',
          instance: safeRequestPath(request.url),
          code: 'not_ready',
          requestId: request.id,
        });
      }
    },
  );
}
