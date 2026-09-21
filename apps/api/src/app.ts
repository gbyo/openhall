import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import fastifyStatic from '@fastify/static';
import { TypeBoxValidatorCompiler } from '@fastify/type-provider-typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppConfig } from '@openhall/config';
import type { DB as Database, ReadinessProbe } from '@openhall/db';
import type { Kysely } from 'kysely';
import { createAuthDependencies } from './auth/dependencies.js';
import { createAuthorizationDependencies } from './authorization/dependencies.js';
import { registerSessionContext } from './auth/session-context.js';
import { startDestinationFlowWorker } from './destination-flow/reconciler-runner.js';
import { carriedStatus, safeRequestPath, scrubForLog } from './http-privacy.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBootstrapRoutes } from './routes/bootstrap.js';
import { registerControlPlaneRoutes } from './routes/control-plane.js';
import { registerMeRoutes } from './routes/me.js';
import { registerMovementRoutes } from './routes/movement.js';
import { registerPassesRoutes } from './routes/passes.js';
import { registerPolicyRoutes } from './routes/policy.js';
import { createControlPlaneDependencies } from './control-plane/dependencies.js';
import { createPassDependencies } from './passes/dependencies.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSystemRoutes } from './routes/system.js';

export interface CreateAppOptions {
  readonly config: AppConfig;
  readonly database: Kysely<Database>;
  readonly readinessProbe: ReadinessProbe;
  readonly logger?: boolean;
  /** Test hook: captures the production logger output, config unchanged. */
  readonly loggerStream?: NodeJS.WritableStream;
  readonly webRoot?: string;
  /**
   * Test hook: skips registering the in-memory rate limiter so suites that
   * legitimately exercise sensitive endpoints stay deterministic. Production
   * always registers it; limiter behavior itself is covered by a dedicated
   * suite with limits enabled.
   */
  readonly rateLimitDisabled?: boolean;
  /**
   * Destination-flow worker control. Defaults to enabled outside tests so
   * production and development run the reconciler; integration suites pass
   * false explicitly (or rely on the test default) and drive runOne/runBatch
   * directly for deterministic wall-clock control.
   */
  readonly destinationFlowWorkerEnabled?: boolean;
}

/**
 * Sensitive paths always carry Cache-Control: no-store: auth session
 * payloads, identity, bootstrap/recovery exchanges, and OIDC callbacks.
 */
const NO_STORE_PREFIXES = [
  '/api/v1/auth/',
  '/api/v1/me',
  '/api/v1/bootstrap/',
  '/api/v1/organizations/',
  '/api/v1/locations',
  '/api/v1/destinations',
  '/api/v1/policy-rules',
  '/api/v1/authorization-grants',
  '/api/v1/identity-enrollments',
  '/api/v1/scheduled-authorizations',
] as const;

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const isProduction = options.config.nodeEnv === 'production';
  const app = Fastify({
    trustProxy: options.config.trustProxy,
    genReqId: () => randomUUID(),
    logger:
      options.logger === false
        ? false
        : {
            level: options.config.nodeEnv === 'development' ? 'debug' : 'info',
            // Request logs carry method, sanitized pathname, request ID, and
            // safe remote metadata only. Query strings are never logged, and
            // headers (Cookie, Authorization, X-CSRF-Token, ...) are never
            // logged, so OIDC codes/state, session material, and operator
            // credentials cannot enter logs through raw URLs or headers.
            serializers: {
              req(request) {
                return {
                  id: request.id,
                  method: request.method,
                  url: safeRequestPath(request.url),
                  hostname: request.hostname,
                  remoteAddress: request.ip,
                };
              },
            },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers.x-csrf-token',
                'res.headers.set-cookie',
                '*.password',
                '*.token',
                '*.client_secret',
                '*.clientSecret',
                '*.integration_secret',
                '*.code',
                '*.state',
                '*.nonce',
              ],
              censor: '[REDACTED]',
            },
            ...(options.loggerStream !== undefined ? { stream: options.loggerStream } : {}),
          },
  }).setValidatorCompiler(TypeBoxValidatorCompiler);

  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  // Security headers first. Production enables HSTS; plain-HTTP localhost
  // development never forces it. OIDC is top-level navigation, so IdPs stay
  // out of connect-src.
  await typedApp.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    ...(isProduction ? {} : { hsts: false }),
  });

  // Cookie parsing before any hook that reads cookies. Cookies are opaque
  // random bearers and are never signed: modified values simply miss lookup.
  await typedApp.register(cookie);

  // Abuse resistance for sensitive endpoints only. Limits are per process,
  // not the security boundary; a school behind one NAT IP must still sign
  // in, so ordinary login traffic gets generous limits while operator-token
  // endpoints stay strict.
  if (!options.rateLimitDisabled) {
    await typedApp.register(rateLimit, { global: false });
  }

  await typedApp.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'OpenHall API',
        description: 'Self-hosted school presence and movement platform API.',
        version: '0.1.0',
      },
      servers: [{ url: options.config.appBaseUrl.origin }],
      components: {
        securitySchemes: {
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: '__Host-openhall_session',
            description: 'Opaque server-side session bearer (development: openhall_session_dev).',
          },
          csrfHeader: {
            type: 'apiKey',
            in: 'header',
            name: 'X-CSRF-Token',
            description: 'Per-session CSRF token from GET /api/v1/auth/session.',
          },
          operatorCredential: {
            type: 'apiKey',
            in: 'header',
            name: 'Authorization',
            description:
              'One-time operator credential: `Bootstrap <token>` on bootstrap prepare, `Recovery <token>` on recovery consume. Never sent in query or cookies.',
          },
        },
      },
    },
  });

  // Normalize authentication errors to safe codes before logging: raw
  // provider/OAuth payloads can carry protocol secrets. Status codes
  // carried by the error (notably the rate limiter's 429) are preserved so
  // abuse resistance stays distinguishable from internal failures.
  typedApp.setErrorHandler((error, request, reply) => {
    const isValidationError = typeof error === 'object' && error !== null && 'validation' in error;
    const status = isValidationError ? 400 : carriedStatus(error);
    const code = isValidationError
      ? 'invalid_request'
      : status === 429
        ? 'rate_limited'
        : 'internal_error';
    if (status === 500) {
      // Backstop: unexpected failures are logged for diagnosis, but any
      // protocol-secret fragments in the message or stack are redacted first.
      const entry =
        error instanceof Error
          ? {
              name: error.name,
              message: scrubForLog(error.message),
              stack: error.stack ? scrubForLog(error.stack) : undefined,
            }
          : { message: scrubForLog(String(error)) };
      request.log.error({ err: entry, action: 'http_request_failed' }, 'Request failed');
    }
    void reply
      .status(status)
      .type('application/problem+json')
      .send({
        type: `https://openhall.dev/problems/${code}`,
        title:
          status === 429
            ? 'Too many requests'
            : status === 400
              ? 'Invalid request'
              : 'Internal server error',
        status,
        detail:
          status === 429
            ? 'The request rate limit was exceeded. Retry later.'
            : isValidationError
              ? 'The request did not match the required contract.'
              : undefined,
        instance: safeRequestPath(request.url),
        code,
        requestId: request.id,
      });
  });

  typedApp.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .type('application/problem+json')
      .send({
        type: 'https://openhall.dev/problems/not_found',
        title: 'Not found',
        status: 404,
        instance: safeRequestPath(request.url),
        code: 'not_found',
        requestId: request.id,
      });
  });

  typedApp.addHook('onSend', async (request, reply) => {
    const pathname = safeRequestPath(request.url);
    if (NO_STORE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) {
      void reply.header('Cache-Control', 'no-store');
    }
  });

  const dependencies = createAuthDependencies(options.config, options.database);
  registerSessionContext(typedApp, { dependencies });
  registerHealthRoutes(typedApp, options.readinessProbe);
  registerSystemRoutes(typedApp);
  registerAuthRoutes(typedApp, dependencies);
  registerBootstrapRoutes(typedApp, dependencies);
  registerMeRoutes(
    typedApp,
    createAuthorizationDependencies(options.database, dependencies.tenantRunner),
  );
  const passDependencies = createPassDependencies(options.database);
  registerPassesRoutes(typedApp, {
    passes: passDependencies,
    auth: dependencies,
  });
  registerPolicyRoutes(typedApp, {
    passes: passDependencies,
    auth: dependencies,
  });
  registerMovementRoutes(typedApp, {
    passes: passDependencies,
    auth: dependencies,
  });
  registerControlPlaneRoutes(typedApp, {
    controlPlane: createControlPlaneDependencies(options.database, {
      directory: dependencies.directory,
      random: dependencies.random,
      digester: dependencies.digester,
      requestPass: passDependencies.request,
    }),
    auth: dependencies,
  });

  // The reconciler worker is a poll loop over durable database state. It
  // starts with the app and stops cleanly on shutdown; tests drive the
  // reconciler directly instead of sleeping for wall-clock ticks.
  const workerEnabled = options.destinationFlowWorkerEnabled ?? options.config.nodeEnv !== 'test';
  const destinationFlowWorker = workerEnabled
    ? startDestinationFlowWorker(
        passDependencies.reconciler,
        options.config.destinationFlowPollMs,
        (error) => {
          app.log.error({ err: error }, 'Destination flow reconciler tick failed');
        },
      )
    : null;
  typedApp.addHook('onClose', () => {
    destinationFlowWorker?.stop();
  });

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
