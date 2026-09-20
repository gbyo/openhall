import type {} from '@fastify/cookie';
import {
  AuthenticationError,
  beginOidcLogin,
  completeOidcLogin,
  consumeRecoveryGrant,
  logoutAllSessions,
  logoutSession,
  toBase64Url,
} from '@openhall/application';
import {
  AuthDiscoverySchema,
  AuthSessionSchema,
  MeSchema,
  OkSchema,
  ProblemDetailsSchema,
  RecoveryResponseSchema,
} from '@openhall/contracts';
import { Type } from 'typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  bindingTokenFrom,
  clearSessionCookie,
  decodeCookieToken,
  setLoginBindingCookie,
  setSessionCookie,
} from '../auth/cookies.js';
import type { AuthDependencies } from '../auth/dependencies.js';
import { problemFor, statusFor } from '../auth/problems.js';
import { requireCsrf, requirePrincipal } from '../auth/session-context.js';

const StartParamsSchema = Type.Object({
  tenantSlug: Type.String({ minLength: 1, maxLength: 63 }),
  providerKey: Type.String({ minLength: 1, maxLength: 63 }),
});

const StartQuerySchema = Type.Object(
  {
    return_path: Type.Optional(Type.String({ maxLength: 2048 })),
  },
  { additionalProperties: true },
);

const CallbackQuerySchema = Type.Object(
  {
    state: Type.Optional(Type.String({ maxLength: 512 })),
    code: Type.Optional(Type.String({ maxLength: 4096 })),
    error: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: true },
);

const DiscoveryQuerySchema = Type.Object(
  {
    tenant: Type.Optional(Type.String({ minLength: 1, maxLength: 63 })),
  },
  { additionalProperties: true },
);

const CsrfHeaderSchema = Type.Object(
  { 'x-csrf-token': Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);

const COOKIE_SECURITY = [{ cookieAuth: [] as string[] }];
const CSRF_SECURITY = [{ cookieAuth: [] as string[] }, { csrfHeader: [] as string[] }];

function bearerToken(header: string | undefined, scheme: string): string | undefined {
  if (typeof header !== 'string') {
    return undefined;
  }
  const prefix = `${scheme} `;
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

export function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: AuthDependencies,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();
  const id = () => dependencies;

  typedApp.get(
    '/api/v1/auth/session',
    {
      schema: {
        operationId: 'getAuthSession',
        tags: ['auth'],
        description: 'Returns the current session. Anonymous callers receive authenticated:false.',
        security: COOKIE_SECURITY,
        response: {
          200: AuthSessionSchema,
        },
      },
    },
    async (request, reply) => {
      const resolved = request.resolvedSession;
      if (resolved === undefined) {
        return reply
          .header('Cache-Control', 'no-store')
          .send({ authenticated: false as const });
      }
      // A refresh obtains a new CSRF value: rotate the digest and return the
      // fresh raw token for SPA runtime memory. Never stored raw server-side.
      const csrfToken = toBase64Url(dependencies.random.randomBytes(32));
      await dependencies.tenantRunner.run(resolved.session.tenantId, async (context) => {
        await dependencies.sessions.rotateCsrfToken(
          context,
          resolved.session.id,
          dependencies.digester.digest(new TextEncoder().encode(csrfToken)),
        );
      });
      return reply.header('Cache-Control', 'no-store').send({
        authenticated: true as const,
        csrfToken,
        absoluteExpiresAt: resolved.session.absoluteExpiresAt.toString(),
        authenticationMethod: resolved.session.authenticationMethod,
      });
    },
  );

  typedApp.get(
    '/api/v1/me',
    {
      schema: {
        operationId: 'getMe',
        tags: ['auth'],
        description: 'Minimal canonical identity for the authenticated person (self-only).',
        security: COOKIE_SECURITY,
        response: {
          200: MeSchema,
          401: {
            description: 'Unauthenticated',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
        },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const resolved = request.resolvedSession;
      if (resolved === undefined) {
        await sendAuthProblem(reply, request, new AuthenticationError('unauthenticated'));
        return;
      }
      return reply.header('Cache-Control', 'no-store').send({
        person: {
          id: resolved.person.id,
          givenName: resolved.person.givenName,
          familyName: resolved.person.familyName,
          displayName: resolved.person.displayName,
        },
        tenant: {
          id: resolved.tenant.id,
          name: resolved.tenant.name,
          slug: resolved.tenant.slug,
        },
      });
    },
  );

  typedApp.get(
    '/api/v1/auth/discovery',
    {
      schema: {
        operationId: 'getAuthDiscovery',
        tags: ['auth'],
        description:
          'Public login metadata. Returns tenant/provider display info for a single-tenant installation or a known slug; otherwise requires tenant selection without enumerating slugs.',
        querystring: DiscoveryQuerySchema,
        response: { 200: AuthDiscoverySchema },
      },
    },
    async (request) => {
      const d = id();
      const slug = request.query.tenant?.trim().toLowerCase();
      if (slug !== undefined && slug.length > 0) {
        const tenant = await d.tenants.findBySlug(slug);
        if (tenant !== undefined && tenant.status === 'active') {
          return discoveryFor(d, tenant.id);
        }
      }
      const count = await d.tenants.countCanonical();
      if (count === 1) {
        const [only] = await d.tenants.listForDiscovery();
        if (only !== undefined) {
          return discoveryFor(d, only.id);
        }
      }
      return { tenantSelectionRequired: true as const };
    },
  );

  typedApp.get(
    '/api/v1/auth/oidc/:tenantSlug/:providerKey/start',
    {
      schema: {
        operationId: 'startOidcLogin',
        tags: ['auth'],
        description:
          'Starts an OIDC Authorization Code + PKCE (S256) login. Responds 302 to the provider authorization URL. Status documented: 302 success; 400/502 problem on failure.',
        params: StartParamsSchema,
        querystring: StartQuerySchema,
        response: {
          400: {
            description: 'Login cannot start',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          502: {
            description: 'Provider unavailable',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
        },
      },
      config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const d = id();
      let binding = bindingTokenFrom(request, d.isProduction);
      if (typeof binding !== 'string' || decodeCookieToken(binding) === undefined) {
        binding = toBase64Url(d.random.randomBytes(32));
        setLoginBindingCookie(reply, d.isProduction, binding);
      }
      try {
        const begun = await beginOidcLogin(
          {
            tenantSlug: request.params.tenantSlug,
            providerKey: request.params.providerKey,
            returnPath: request.query.return_path,
            browserBinding: binding,
          },
          {
            tenants: d.tenants,
            directory: d.directory,
            transactions: d.transactions,
            sessions: d.sessions,
            audit: d.audit,
            adapter: d.adapter,
            random: d.random,
            digester: d.digester,
            hasher: d.hasher,
            protector: d.protector,
            clock: d.clock,
            runner: d.tenantRunner,
            redirectUri: d.redirectUri,
            allowInsecureHttp: d.allowInsecureHttp,
          },
        );
        return reply.header('Cache-Control', 'no-store').redirect(begun.authorizationUrl);
      } catch (error) {
        if (error instanceof AuthenticationError) {
          await sendAuthProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/api/v1/auth/oidc/callback',
    {
      schema: {
        operationId: 'completeOidcLogin',
        tags: ['auth'],
        description:
          'OIDC callback. Always responds 302: success redirects to the safe local return path with a fresh HttpOnly session cookie; failure redirects to /?error=<code> with a safe machine-readable code. OIDC protections (state/browser binding/nonce/PKCE/replay) apply instead of the SPA CSRF header.',
        querystring: CallbackQuerySchema,
      },
      config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const d = id();
      const rawUrl = request.raw.url ?? '/api/v1/auth/oidc/callback';
      const queryIndex = rawUrl.indexOf('?');
      const callbackUrl =
        queryIndex === -1 ? d.redirectUri : `${d.redirectUri}${rawUrl.slice(queryIndex)}`;
      const state = request.query.state;
      const binding = bindingTokenFrom(request, d.isProduction);
      if (typeof state !== 'string' || state.length === 0 || binding === undefined) {
        return reply.header('Cache-Control', 'no-store').redirect('/?error=auth_transaction_invalid');
      }
      try {
        const completed = await completeOidcLogin(
          {
            state,
            browserBinding: binding,
            callbackUrl,
            requestId: request.id,
            supersededSession: request.authSession,
          },
          {
            tenants: d.tenants,
            directory: d.directory,
            transactions: d.transactions,
            sessions: d.sessions,
            audit: d.audit,
            adapter: d.adapter,
            random: d.random,
            digester: d.digester,
            hasher: d.hasher,
            protector: d.protector,
            clock: d.clock,
            runner: d.tenantRunner,
            redirectUri: d.redirectUri,
            allowInsecureHttp: d.allowInsecureHttp,
          },
        );
        const maxAge = Math.max(
          60,
          Math.floor(
            (completed.session.absoluteExpiresAt.epochMilliseconds - d.clock.now().epochMilliseconds) /
              1000,
          ),
        );
        setSessionCookie(reply, d.isProduction, completed.sessionToken, maxAge);
        return reply.header('Cache-Control', 'no-store').redirect(completed.returnPath);
      } catch (error) {
        if (error instanceof AuthenticationError) {
          return reply
            .header('Cache-Control', 'no-store')
            .redirect(`/?error=${error.code}`);
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/api/v1/auth/logout',
    {
      schema: {
        operationId: 'logout',
        tags: ['auth'],
        description: 'Revokes the current session. Requires session, CSRF token, and same origin.',
        security: CSRF_SECURITY,
        headers: CsrfHeaderSchema,
        response: {
          200: OkSchema,
          401: {
            description: 'Unauthenticated',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          403: {
            description: 'CSRF or origin rejected',
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
      const d = id();
      const session = request.authSession;
      if (session === undefined) {
        await sendAuthProblem(reply, request, new AuthenticationError('unauthenticated'));
        return;
      }
      await d.tenantRunner.run(session.tenantId, async (context) => {
        await logoutSession(context, session, request.id, {
          sessions: d.sessions,
          audit: d.audit,
          clock: d.clock,
        });
      });
      clearSessionCookie(reply, d.isProduction);
      return reply.header('Cache-Control', 'no-store').send({ ok: true as const });
    },
  );

  typedApp.post(
    '/api/v1/auth/logout-all',
    {
      schema: {
        operationId: 'logoutAll',
        tags: ['auth'],
        description:
          'Revokes every session for the account by bumping session_revision. Requires session, CSRF token, and same origin.',
        security: CSRF_SECURITY,
        headers: CsrfHeaderSchema,
        response: {
          200: OkSchema,
          401: {
            description: 'Unauthenticated',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          403: {
            description: 'CSRF or origin rejected',
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
      const d = id();
      const session = request.authSession;
      if (session === undefined) {
        await sendAuthProblem(reply, request, new AuthenticationError('unauthenticated'));
        return;
      }
      await d.tenantRunner.run(session.tenantId, async (context) => {
        await logoutAllSessions(context, session, request.id, {
          sessions: d.sessions,
          audit: d.audit,
          clock: d.clock,
          directory: d.directory,
        });
      });
      clearSessionCookie(reply, d.isProduction);
      return reply.header('Cache-Control', 'no-store').send({ ok: true as const });
    },
  );

  typedApp.post(
    '/api/v1/auth/recovery',
    {
      schema: {
        operationId: 'consumeRecoveryGrant',
        tags: ['auth'],
        description:
          'Consumes a one-time recovery grant from the Authorization header (never query) and creates a short-lived recovery session.',
        response: {
          200: RecoveryResponseSchema,
          401: {
            description: 'Invalid or expired recovery token',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
        },
      },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const d = id();
      const token = bearerToken(request.headers.authorization, 'Recovery');
      if (token === undefined) {
        await sendAuthProblem(reply, request, new AuthenticationError('recovery_token_invalid'));
        return;
      }
      try {
        const consumed = await consumeRecoveryGrant(
          { recoveryToken: token, requestId: request.id },
          {
            tenants: d.tenants,
            directory: d.directory,
            sessions: d.sessions,
            audit: d.audit,
            grants: d.grants,
            random: d.random,
            digester: d.digester,
            clock: d.clock,
            tenantRunner: d.tenantRunner,
          },
        );
        setSessionCookie(reply, d.isProduction, consumed.sessionToken, 30 * 60);
        return reply.header('Cache-Control', 'no-store').send({
          authenticated: true as const,
          authenticationMethod: 'recovery' as const,
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

async function discoveryFor(
  dependencies: AuthDependencies,
  tenantId: string,
): Promise<
  | { readonly tenantSelectionRequired: true }
  | {
      readonly tenantSelectionRequired: false;
      readonly tenant: { readonly id: string; readonly name: string; readonly slug: string };
      readonly providers: { readonly key: string; readonly displayName: string }[];
    }
> {
  const tenant = await dependencies.tenants.findById(tenantId);
  if (tenant === undefined || tenant.status !== 'active') {
    return { tenantSelectionRequired: true as const };
  }
  const providers = await dependencies.tenantRunner.run(tenantId, async (context) =>
    dependencies.directory.listActiveProviders(context),
  );
  return {
    tenantSelectionRequired: false as const,
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    providers: providers.map((provider) => ({
      key: provider.key,
      displayName: provider.displayName,
    })),
  };
}
