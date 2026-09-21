import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { SystemInfoSchema, schemaRef } from '@openhall/contracts';

export function registerSystemRoutes(app: FastifyInstance): void {
  app.withTypeProvider<TypeBoxTypeProvider>().get(
    '/api/v1/system/info',
    {
      schema: {
        operationId: 'getSystemInfo',
        tags: ['system'],
        response: { 200: schemaRef(SystemInfoSchema) },
      },
    },
    () => ({
      name: 'OpenHall' as const,
      version: '0.1.0',
      apiVersion: 'v1' as const,
      status: 'foundation' as const,
    }),
  );
}
