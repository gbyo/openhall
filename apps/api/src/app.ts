import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import { TypeBoxValidatorCompiler } from '@fastify/type-provider-typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppConfig } from '@openhall/config';
import type { ReadinessProbe } from '@openhall/db';
import { registerHealthRoutes } from './routes/health.js';
import { registerSystemRoutes } from './routes/system.js';

export interface CreateAppOptions {
  readonly config: AppConfig;
  readonly readinessProbe: ReadinessProbe;
  readonly logger?: boolean;
  readonly webRoot?: string;
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: options.config.trustProxy,
    genReqId: () => randomUUID(),
    logger:
      options.logger === false
        ? false
        : {
            level: options.config.nodeEnv === 'development' ? 'debug' : 'info',
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers.set-cookie',
                '*.password',
                '*.token',
                '*.client_secret',
                '*.integration_secret',
              ],
              censor: '[REDACTED]',
            },
          },
  }).setValidatorCompiler(TypeBoxValidatorCompiler);

  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  await typedApp.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'OpenHall API',
        description: 'Self-hosted school presence and movement platform API.',
        version: '0.1.0',
      },
      servers: [{ url: options.config.appBaseUrl.origin }],
    },
  });

  typedApp.setErrorHandler((error, request, reply) => {
    const isValidationError = typeof error === 'object' && error !== null && 'validation' in error;
    const status = isValidationError ? 400 : 500;
    if (status === 500) {
      request.log.error({ err: error, action: 'http_request_failed' }, 'Request failed');
    }
    void reply
      .status(status)
      .type('application/problem+json')
      .send({
        type: `https://openhall.dev/problems/${isValidationError ? 'invalid_request' : 'internal_error'}`,
        title: isValidationError ? 'Invalid request' : 'Internal server error',
        status,
        detail: isValidationError ? 'The request did not match the required contract.' : undefined,
        instance: request.url,
        code: isValidationError ? 'invalid_request' : 'internal_error',
        requestId: request.id,
      });
  });

  typedApp.setNotFoundHandler((request, reply) => {
    void reply.status(404).type('application/problem+json').send({
      type: 'https://openhall.dev/problems/not_found',
      title: 'Not found',
      status: 404,
      instance: request.url,
      code: 'not_found',
      requestId: request.id,
    });
  });

  registerHealthRoutes(typedApp, options.readinessProbe);
  registerSystemRoutes(typedApp);

  typedApp.get(
    '/api/openapi.json',
    {
      schema: {
        operationId: 'getOpenApiDocument',
        tags: ['system'],
        hide: true,
      },
    },
    () => typedApp.swagger(),
  );

  if (options.webRoot && existsSync(options.webRoot)) {
    await typedApp.register(fastifyStatic, {
      root: options.webRoot,
      prefix: '/',
      wildcard: true,
    });
  }

  return typedApp;
}
