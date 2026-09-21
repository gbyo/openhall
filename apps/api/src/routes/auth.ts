import type {} from '@fastify/cookie';
import {
  AuthenticationError,
  beginOidcLogin,
  completeBootstrap,
  completeIdentityEnrollment,
  completeOidcLogin,
  consumeRecoveryGrant,
  logoutAllSessions,
  logoutSession,
  startIdentityEnrollment,
  toBase64Url,
} from '@openhall/application';
import {
  AuthDiscoverySchema,
  AuthSessionSchema,
  EnrollmentStartResponseSchema,
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
  sessionTokenFrom,
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
    // Providers may append the RFC 9207 iss parameter. It is documented
    // here but never trusted: the login transaction binds the exact
    // provider, and the adapter enforces the iss binding on exchange.
    iss: Type.Optional(Type.String({ maxLength: 2048 })),
  },
  { additionalProperties: true },
);

/**
 * Redirect-only success contract. Description and headers document the 302
 * without a body schema, so runtime response validation is unaffected while
 * the generated OpenAPI names the status and headers deliberately. Header
 * entries are plain schemas: @fastify/swagger wraps each entry in `schema`
 * itself, so a pre-wrapped entry would render a doubled schema wrapper.
 */
const RedirectFoundSchema = (description: string, setCookie: string) => ({
  description,
  headers: {
    Location: { description: 'Redirect target', type: 'string' },
    'Set-Cookie': { description: setCookie, type: 'string' },
  },
});

const DiscoveryQuerySchema = Type.Object(
  {
    tenant: Type.Optional(Type.String({ minLength: 1, maxLength: 63 })),
  },
  { additionalProperties: true },
);

const COOKIE_SECURITY = [{ cookieAuth: [] as string[] }];
// OpenAPI AND semantics: one Security Requirement Object requiring both the
// session cookie AND the CSRF header. Separate objects would mean OR.
const CSRF_SECURITY = [{ cookieAuth: [] as string[], csrfHeader: [] as string[] }];
// GET /auth/session is anonymously callable: anonymous callers receive
// {authenticated:false}. The empty requirement documents that alternative.
const OPTIONAL_SESSION_SECURITY = [{}, { cookieAuth: [] as string[] }];
// Operator endpoints take the one-time credential in the Authorization
// header (`Recovery <token>` here), never query or ambient cookies.
const OPERATOR_SECURITY = [{ operatorCredential: [] as string[] }];

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

export function registerAuthRoutes(app: FastifyInstance, dependencies: AuthDependencies): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();
  const id = () => dependencies;

  typedApp.get(
    '/api/v1/auth/session',
    {
      schema: {
        operationId: 'getAuthSession',
        tags: ['auth'],
        description:
          'Returns the current session. Anonymous callers receive authenticated:false. Authenticated callers receive a stable per-session CSRF token derived from the session credential; reading never mutates authentication state.',
        security: OPTIONAL_SESSION_SECURITY,
        response: {
          200: AuthSessionSchema,
        },
      },
    },
    async (request, reply) => {
      const resolved = request.resolvedSession;
      if (resolved === undefined) {
        return reply.header('Cache-Control', 'no-store').send({ authenticated: false as const });
      }
      // Read-only: derive the stable per-session CSRF token from the raw
      // opaque session credential (domain "csrf-token:v1"). Same session
      // always yields the same token, so concurrent reads and multiple tabs
      // never invalidate one another. No digest is rotated here.
      const rawCookie = sessionTokenFrom(request, dependencies.isProduction);
      const rawBytes = decodeCookieToken(rawCookie);
      if (rawBytes === undefined) {
        return reply.header('Cache-Control', 'no-store').send({ authenticated: false as const });
      }
      const csrfToken = toBase64Url(dependencies.digester.deriveCsrfToken(rawBytes));
      return await reply.header('Cache-Control', 'no-store').send({
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
      return await reply.header('Cache-Control', 'no-store').send({
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
        if (tenant?.status === 'active') {
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
          302: RedirectFoundSchema(
            'Redirect to the provider authorization URL',
            'Fresh login-transaction binding cookie (HttpOnly, SameSite=Lax)',
          ),
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
      config: { rateLimit: { max: 5, timeWindow: '1 minute', groupId: 'operator-token' } },
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
        return await reply.header('Cache-Control', 'no-store').redirect(begun.authorizationUrl);
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
    '/api/v1/auth/enrollment/start',
    {
      schema: {
        operationId: 'startIdentityEnrollment',
        tags: ['auth'],
        description:
          'Starts an OIDC enrollment from a one-time invitation. The raw enrollment token travels in the Authorization header (`Enrollment <token>`), never the query string. Responds 200 with the provider authorization URL; the invitation is consumed only at callback. Status documented: 200 success; 400/401/502 problem on failure.',
        security: OPERATOR_SECURITY,
        response: {
          200: EnrollmentStartResponseSchema,
          400: {
            description: 'Enrollment cannot start',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          401: {
            description: 'Missing enrollment credential',
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
      const token = bearerToken(request.headers.authorization, 'Enrollment');
      if (token === undefined) {
        await sendAuthProblem(reply, request, new AuthenticationError('unauthenticated'));
        return;
      }
      let binding = bindingTokenFrom(request, d.isProduction);
      if (typeof binding !== 'string' || decodeCookieToken(binding) === undefined) {
        binding = toBase64Url(d.random.randomBytes(32));
        setLoginBindingCookie(reply, d.isProduction, binding);
      }
      try {
        const begun = await startIdentityEnrollment(
          { enrollmentToken: token, browserBinding: binding },
          {
            directory: d.directory,
            transactions: d.transactions,
            sessions: d.sessions,
            enrollments: d.enrollments,
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
        await reply.header('Cache-Control', 'no-store').send({
          authorizationUrl: begun.authorizationUrl,
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

  typedApp.get(
    '/api/v1/auth/oidc/callback',
    {
      schema: {
        operationId: 'completeOidcLogin',
        tags: ['auth'],
        description:
          'OIDC callback. Always responds 302: success redirects to the safe local return path with a fresh HttpOnly session cookie; failure redirects to /?error=<code> with a safe machine-readable code. OIDC protections (state/browser binding/nonce/PKCE/replay) apply instead of the SPA CSRF header.',
        querystring: CallbackQuerySchema,
        response: {
          302: RedirectFoundSchema(
            'Redirect to the return path (success) or /?error=<code> (failure)',
            'Fresh session cookie on success (HttpOnly, SameSite=Lax)',
          ),
        },
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
        return await reply
          .header('Cache-Control', 'no-store')
          .redirect('/?error=auth_transaction_invalid');
      }
      try {
        // The OIDC redirect URI is shared: peek at the transaction purpose
        // (non-consuming) and dispatch to the bootstrap, enrollment, or
        // login completion. The completing use case still enforces the
        // atomic claim, so a raced or replayed callback fails closed either
        // way.
        const pending = await d.transactions.peekByStateDigest(
          d.digester.digest(new TextEncoder().encode(state)),
        );
        if (pending?.purpose === 'enrollment') {
          const enrolled = await completeIdentityEnrollment(
            {
              state,
              browserBinding: binding,
              callbackUrl,
              requestId: request.id,
            },
            {
              directory: d.directory,
              transactions: d.transactions,
              sessions: d.sessions,
              enrollments: d.enrollments,
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
          const enrollmentMaxAge = Math.max(
            60,
            Math.floor(
              (enrolled.session.absoluteExpiresAt.epochMilliseconds -
                d.clock.now().epochMilliseconds) /
                1000,
            ),
          );
          setSessionCookie(reply, d.isProduction, enrolled.sessionToken, enrollmentMaxAge);
          return await reply.header('Cache-Control', 'no-store').redirect(enrolled.returnPath);
        }
        if (pending?.purpose === 'bootstrap') {
          const installed = await completeBootstrap(
            {
              state,
              browserBinding: binding,
              callbackUrl,
              requestId: request.id,
            },
            {
              grants: d.grants,
              drafts: d.drafts,
              tenants: d.tenants,
              transactions: d.transactions,
              adapter: d.adapter,
              protector: d.protector,
              random: d.random,
              digester: d.digester,
              clock: d.clock,
              finalizer: d.finalizer,
              sessionRunner: d.systemRunner,
              redirectUri: d.redirectUri,
              allowInsecureHttp: d.allowInsecureHttp,
            },
          );
          const bootstrapMaxAge = Math.max(
            60,
            Math.floor(
              (installed.installation.session.absoluteExpiresAt.epochMilliseconds -
                d.clock.now().epochMilliseconds) /
                1000,
            ),
          );
          setSessionCookie(reply, d.isProduction, installed.sessionToken, bootstrapMaxAge);
          return await reply.header('Cache-Control', 'no-store').redirect('/');
        }
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
            (completed.session.absoluteExpiresAt.epochMilliseconds -
              d.clock.now().epochMilliseconds) /
              1000,
          ),
        );
        setSessionCookie(reply, d.isProduction, completed.sessionToken, maxAge);
        return await reply.header('Cache-Control', 'no-store').redirect(completed.returnPath);
      } catch (error) {
        if (error instanceof AuthenticationError) {
          return reply.header('Cache-Control', 'no-store').redirect(`/?error=${error.code}`);
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
        description:
          'Revokes the current session. Requires the session cookie, the X-CSRF-Token header, and a same-origin request.',
        security: CSRF_SECURITY,
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
      return await reply.header('Cache-Control', 'no-store').send({ ok: true as const });
    },
  );

  typedApp.post(
    '/api/v1/auth/logout-all',
    {
      schema: {
        operationId: 'logoutAll',
        tags: ['auth'],
        description:
          'Revokes every session for the account by bumping session_revision. Requires the session cookie, the X-CSRF-Token header, and a same-origin request.',
        security: CSRF_SECURITY,
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
      return await reply.header('Cache-Control', 'no-store').send({ ok: true as const });
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
        security: OPERATOR_SECURITY,
        response: {
          200: RecoveryResponseSchema,
          401: {
            description: 'Invalid or expired recovery token',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          429: {
            description: 'Recovery endpoint rate limit exceeded',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
        },
      },
      // The limiter keeps per-route counters, so each operator-token route
      // allows half of the combined 10-attempts-per-minute shared budget.
      config: { rateLimit: { max: 5, timeWindow: '1 minute', groupId: 'operator-token' } },
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
        return await reply.header('Cache-Control', 'no-store').send({
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
  if (tenant?.status !== 'active') {
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
