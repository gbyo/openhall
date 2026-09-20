import type {} from '@fastify/cookie';
import {
  AuthenticationError,
  GOOGLE_WORKSPACE_PRESET,
  prepareBootstrap,
  toBase64Url,
} from '@openhall/application';
import {
  BootstrapPrepareResponseSchema,
  BootstrapPrepareSchema,
  BootstrapStatusSchema,
  ProblemDetailsSchema,
} from '@openhall/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { bindingTokenFrom, decodeCookieToken, setLoginBindingCookie } from '../auth/cookies.js';
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
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
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
}
