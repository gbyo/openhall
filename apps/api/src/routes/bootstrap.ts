import type {} from '@fastify/cookie';
import {
  AuthenticationError,
  GOOGLE_WORKSPACE_PRESET,
  initializeBootstrapBase,
  prepareBootstrap,
  toBase64Url,
  validateBootstrapToken,
} from '@openhall/application';
import {
  BootstrapInitializeResponseSchema,
  BootstrapInitializeSchema,
  BootstrapPrepareResponseSchema,
  BootstrapPrepareSchema,
  BootstrapStatusSchema,
  BootstrapValidateResponseSchema,
  ProblemDetailsSchema,
} from '@openhall/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  bindingTokenFrom,
  decodeCookieToken,
  setLoginBindingCookie,
  setSessionCookie,
} from '../auth/cookies.js';
import type { AuthDependencies } from '../auth/dependencies.js';
import { problemFor, statusFor } from '../auth/problems.js';

function bootstrapToken(header: string | undefined): string | undefined {
  if (typeof header !== 'string') {
    return undefined;
  }
  const prefix = 'Bootstrap ';
  if (!header.startsWith(prefix)) {
    return undefined;
  }
  const token = header.slice(prefix.length).trim();
  return token.length > 0 && token.length <= 256 ? token : undefined;
}

async function sendAuthProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  error: AuthenticationError,
): Promise<void> {
  await reply
    .status(statusFor(error.code))
    .type('application/problem+json')
    .send(problemFor(error, request));
}

export function registerBootstrapRoutes(
  app: FastifyInstance,
  dependencies: AuthDependencies,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.get(
    '/api/v1/bootstrap/status',
    {
      schema: {
        operationId: 'getBootstrapStatus',
        tags: ['bootstrap'],
        description:
          'Reports whether initialization is required. Reveals nothing about active bootstrap tokens.',
        response: { 200: BootstrapStatusSchema },
      },
    },
    async (_request, reply) => {
      const count = await dependencies.tenants.countCanonical();
      return await reply.header('Cache-Control', 'no-store').send({ initialized: count > 0 });
    },
  );

  typedApp.post(
    '/api/v1/bootstrap/prepare',
    {
      schema: {
        operationId: 'prepareBootstrap',
        tags: ['bootstrap'],
        description:
          'Validates tenant/school/admin details plus the OIDC provider (live discovery), stores the encrypted draft, and starts the bootstrap OIDC flow. The operator credential travels in the Authorization header, never query or ambient cookies.',
        // Operator endpoints take the one-time credential in the
        // Authorization header (`Bootstrap <token>` here), never query.
        security: [{ operatorCredential: [] as string[] }],
        body: BootstrapPrepareSchema,
        response: {
          200: BootstrapPrepareResponseSchema,
          400: {
            description: 'Invalid setup details or provider configuration',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          401: {
            description: 'Invalid bootstrap token',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          409: {
            description: 'Installation already exists',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          429: {
            description: 'Operator-token endpoint rate limit exceeded',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
        },
      },
      // The limiter keeps per-route counters, so each operator-token route
      // allows half of the combined 10-attempts-per-minute shared budget.
      config: { rateLimit: { max: 5, timeWindow: '1 minute', groupId: 'operator-token' } },
    },
    async (request, reply) => {
      const token = bootstrapToken(request.headers.authorization);
      if (token === undefined) {
        await sendAuthProblem(reply, request, new AuthenticationError('bootstrap_token_invalid'));
        return;
      }
      let binding = bindingTokenFrom(request, dependencies.isProduction);
      if (typeof binding !== 'string' || decodeCookieToken(binding) === undefined) {
        binding = toBase64Url(dependencies.random.randomBytes(32));
        setLoginBindingCookie(reply, dependencies.isProduction, binding);
      }
      const body = request.body;
      if (
        body.providerPreset === 'google' &&
        body.providerIssuer !== GOOGLE_WORKSPACE_PRESET.issuer
      ) {
        await sendAuthProblem(
          reply,
          request,
          new AuthenticationError(
            'invalid_bootstrap_draft',
            'Google preset requires the Google issuer',
          ),
        );
        return;
      }
      try {
        const prepared = await prepareBootstrap(
          {
            operatorToken: token,
            tenantName: body.tenantName,
            tenantSlug: body.tenantSlug,
            schoolName: body.schoolName,
            schoolSlug: body.schoolSlug,
            schoolTimeZone: body.schoolTimeZone,
            adminGivenName: body.adminGivenName,
            adminFamilyName: body.adminFamilyName,
            adminDisplayName: body.adminDisplayName,
            providerKey: body.providerKey,
            providerDisplayName: body.providerDisplayName,
            providerIssuer: body.providerIssuer,
            providerClientId: body.providerClientId,
            providerClientSecret: body.providerClientSecret,
            providerAuthMethod: body.providerAuthMethod,
            providerScopes: body.providerScopes,
            browserBinding: binding,
          },
          {
            grants: dependencies.grants,
            drafts: dependencies.drafts,
            transactions: dependencies.transactions,
            tenants: dependencies.tenants,
            adapter: dependencies.adapter,
            protector: dependencies.protector,
            hasher: dependencies.hasher,
            random: dependencies.random,
            digester: dependencies.digester,
            clock: dependencies.clock,
            runner: dependencies.systemRunner,
            redirectUri: dependencies.redirectUri,
            allowInsecureHttp: dependencies.allowInsecureHttp,
          },
        );
        return await reply
          .header('Cache-Control', 'no-store')
          .send({ authorizationUrl: prepared.authorizationUrl });
      } catch (error) {
        if (error instanceof AuthenticationError) {
          await sendAuthProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/api/v1/bootstrap/validate',
    {
      schema: {
        operationId: 'validateBootstrap',
        tags: ['bootstrap'],
        description:
          'Verifies the one-time setup code without consuming it and without creating anything. The token travels in the Authorization header, never query, body, or cookies.',
        security: [{ operatorCredential: [] as string[] }],
        response: {
          200: BootstrapValidateResponseSchema,
          401: {
            description: 'Invalid setup code',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          409: {
            description: 'Installation already exists',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          429: {
            description: 'Operator-token endpoint rate limit exceeded',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
        },
      },
      config: { rateLimit: { max: 5, timeWindow: '1 minute', groupId: 'operator-token' } },
    },
    async (request, reply) => {
      const token = bootstrapToken(request.headers.authorization);
      if (token === undefined) {
        await sendAuthProblem(reply, request, new AuthenticationError('bootstrap_token_invalid'));
        return;
      }
      try {
        const result = await validateBootstrapToken(token, {
          grants: dependencies.grants,
          tenants: dependencies.tenants,
          random: dependencies.random,
          digester: dependencies.digester,
          clock: dependencies.clock,
          runner: dependencies.systemRunner,
        });
        return await reply.header('Cache-Control', 'no-store').send(result);
      } catch (error) {
        if (error instanceof AuthenticationError) {
          await sendAuthProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/api/v1/bootstrap/initialize',
    {
      schema: {
        operationId: 'initializeBootstrap',
        tags: ['bootstrap'],
        description:
          'Creates the canonical school installation without an external identity provider and returns a temporary setup session. Consumes the one-time setup code exactly once. The token travels in the Authorization header, never query, body, or cookies.',
        security: [{ operatorCredential: [] as string[] }],
        body: BootstrapInitializeSchema,
        response: {
          200: BootstrapInitializeResponseSchema,
          400: {
            description: 'Invalid school or administrator details',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          401: {
            description: 'Invalid setup code',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          409: {
            description: 'Installation already exists',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          429: {
            description: 'Operator-token endpoint rate limit exceeded',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
        },
      },
      config: { rateLimit: { max: 5, timeWindow: '1 minute', groupId: 'operator-token' } },
    },
    async (request, reply) => {
      const token = bootstrapToken(request.headers.authorization);
      if (token === undefined) {
        await sendAuthProblem(reply, request, new AuthenticationError('bootstrap_token_invalid'));
        return;
      }
      try {
        const body = request.body;
        const initialized = await initializeBootstrapBase(
          {
            operatorToken: token,
            tenantName: body.tenantName,
            tenantSlug: body.tenantSlug,
            schoolName: body.schoolName,
            schoolSlug: body.schoolSlug,
            schoolTimeZone: body.schoolTimeZone,
            adminGivenName: body.adminGivenName,
            adminFamilyName: body.adminFamilyName,
            adminDisplayName: body.adminDisplayName,
            requestId: request.id,
          },
          {
            grants: dependencies.grants,
            tenants: dependencies.tenants,
            random: dependencies.random,
            digester: dependencies.digester,
            clock: dependencies.clock,
            finalizer: dependencies.finalizer,
            runner: dependencies.systemRunner,
          },
        );
        const maxAge = Math.max(
          60,
          Math.floor(
            (initialized.installation.session.absoluteExpiresAt.epochMilliseconds -
              dependencies.clock.now().epochMilliseconds) /
              1000,
          ),
        );
        setSessionCookie(reply, dependencies.isProduction, initialized.sessionToken, maxAge);
        return await reply.header('Cache-Control', 'no-store').send({
          authenticated: true as const,
          authenticationMethod: 'setup' as const,
          absoluteExpiresAt: initialized.installation.session.absoluteExpiresAt.toString(),
        });
      } catch (error) {
        if (error instanceof AuthenticationError) {
          await sendAuthProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );
}
