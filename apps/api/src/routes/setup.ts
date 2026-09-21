import {
  AuthenticationError,
  prepareProviderSetup,
  toBase64Url,
  type Principal,
} from '@openhall/application';
import {
  ProblemDetailsSchema,
  SetupIdentityProviderPrepareResponseSchema,
  SetupIdentityProviderPrepareSchema,
} from '@openhall/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { bindingTokenFrom, decodeCookieToken, setLoginBindingCookie } from '../auth/cookies.js';
import type { AuthDependencies } from '../auth/dependencies.js';
import { problemFor, statusFor } from '../auth/problems.js';
import { requireCsrf, requirePrincipal } from '../auth/session-context.js';

const CSRF_SECURITY = [{ cookieAuth: [] as string[], csrfHeader: [] as string[] }];

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

export function registerSetupRoutes(app: FastifyInstance, dependencies: AuthDependencies): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.post(
    '/api/v1/setup/identity-provider/prepare',
    {
      schema: {
        operationId: 'prepareSetupIdentityProvider',
        tags: ['setup'],
        description:
          'Starts the first school sign-in connection for an initialized school. Cookie-authenticated with CSRF and same-origin protection; the caller must hold tenant system-admin authority. Setup sessions may prepare; authorized recovery sessions may complete setup. Rejects with a 409 conflict when a provider is already connected. Never creates a canonical provider before OIDC succeeds.',
        security: CSRF_SECURITY,
        body: SetupIdentityProviderPrepareSchema,
        response: {
          200: SetupIdentityProviderPrepareResponseSchema,
          400: {
            description: 'Invalid provider configuration',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          401: {
            description: 'Unauthenticated or ineligible account',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          409: {
            description: 'School sign-in is already connected',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
        },
      },
      preHandler: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, dependencies),
      ],
    },
    async (request, reply) => {
      const principal: Principal | undefined = request.principal;
      if (principal === undefined) {
        await sendAuthProblem(reply, request, new AuthenticationError('unauthenticated'));
        return;
      }
      let binding = bindingTokenFrom(request, dependencies.isProduction);
      if (typeof binding !== 'string' || decodeCookieToken(binding) === undefined) {
        binding = toBase64Url(dependencies.random.randomBytes(32));
        setLoginBindingCookie(reply, dependencies.isProduction, binding);
      }
      try {
        const body = request.body;
        const prepared = await prepareProviderSetup(
          {
            principal,
            providerPreset: body.providerPreset,
            clientId: body.clientId,
            clientSecret: body.clientSecret,
            providerName: body.providerName,
            issuerUrl: body.issuerUrl,
            providerKey: body.providerKey,
            authMethod: body.authMethod,
            scopes: body.scopes,
            browserBinding: binding,
          },
          {
            directory: dependencies.directory,
            transactions: dependencies.transactions,
            audit: dependencies.audit,
            adapter: dependencies.adapter,
            random: dependencies.random,
            digester: dependencies.digester,
            hasher: dependencies.hasher,
            protector: dependencies.protector,
            clock: dependencies.clock,
            runner: dependencies.tenantRunner,
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
}
