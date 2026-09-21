import { Temporal } from '@js-temporal/polyfill';
import { Type } from 'typebox';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AuthDependencies } from '../auth/dependencies.js';
import { setSessionCookie } from '../auth/cookies.js';

export const DEMO_IDENTITIES = {
  administrator: '10000000-0000-4000-8000-000000000101',
  teacher: '10000000-0000-4000-8000-000000000102',
  student: '10000000-0000-4000-8000-000000000103',
} as const;

export const DEMO_TENANT_ID = '10000000-0000-4000-8000-000000000001';
export const DEMO_ORGANIZATION_ID = '10000000-0000-4000-8000-000000000002';

const PersonaSchema = Type.Union([
  Type.Literal('administrator'),
  Type.Literal('teacher'),
  Type.Literal('student'),
]);

/** Registered only by the explicitly enabled local-demo composition root. */
export function registerDemoRoutes(app: FastifyInstance, auth: AuthDependencies): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.get('/api/v1/demo', () => ({
    enabled: true as const,
    organizationId: DEMO_ORGANIZATION_ID,
    personas: [
      { id: 'administrator' as const, name: 'Avery Morgan', description: 'School administrator' },
      { id: 'teacher' as const, name: 'Jordan Lee', description: '8th grade science teacher' },
      { id: 'student' as const, name: 'Maya Patel', description: '8th grade student' },
    ],
  }));

  typedApp.post(
    '/api/v1/demo/session',
    { schema: { body: Type.Object({ persona: PersonaSchema }, { additionalProperties: false }) } },
    async (request, reply) => {
      const accountId = DEMO_IDENTITIES[request.body.persona];
      const rawToken = auth.random.randomBytes(32);
      const now = Temporal.Now.instant();
      const absoluteExpiresAt = now.add({ hours: 12 });
      await auth.tenantRunner.run(DEMO_TENANT_ID, async (context) => {
        await auth.sessions.create(context, {
          tenantId: DEMO_TENANT_ID,
          accountId,
          identityProviderId: null,
          tokenDigest: auth.digester.digestSessionToken(rawToken),
          csrfTokenDigest: auth.digester.digest(auth.digester.deriveCsrfToken(rawToken)),
          accountSessionRevision: 0n,
          authenticationMethod: 'setup',
          authenticatedAt: now,
          idleExpiresAt: absoluteExpiresAt,
          absoluteExpiresAt,
        });
      });
      setSessionCookie(reply, false, Buffer.from(rawToken).toString('base64url'), 12 * 60 * 60);
      return reply.header('Cache-Control', 'no-store').send({
        authenticated: true as const,
        organizationId: DEMO_ORGANIZATION_ID,
      });
    },
  );
}
