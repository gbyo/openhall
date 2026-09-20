import {
  PassApplicationError,
  cancelSelfPass,
  getActiveSelfPass,
  passHttpStatus,
  requestSelfPass,
  requestStudentPass,
  type PassErrorCode,
} from '@openhall/application';
import {
  ActiveSelfPassSchema,
  PassRequestBodySchema,
  PassResponseSchema,
  ProblemDetailsSchema,
  UuidSchema,
} from '@openhall/contracts';
import { Type } from 'typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AuthDependencies } from '../auth/dependencies.js';
import { requireCsrf, requirePrincipal } from '../auth/session-context.js';
import type { PassDependencies } from '../passes/dependencies.js';
import { safeRequestPath } from '../http-privacy.js';

const COOKIE_SECURITY = [{ cookieAuth: [] as string[] }];
const COOKIE_CSRF_SECURITY = [{ cookieAuth: [] as string[] }, { csrfHeader: [] as string[] }];

const StudentIdParamsSchema = Type.Object(
  { studentId: UuidSchema },
  { additionalProperties: false },
);

const PassIdParamsSchema = Type.Object({ passId: UuidSchema }, { additionalProperties: false });

const IdempotencyHeadersSchema = Type.Object({
  'idempotency-key': Type.String({ minLength: 1, maxLength: 255 }),
});

const CancelHeadersSchema = Type.Object({
  'idempotency-key': Type.String({ minLength: 1, maxLength: 255 }),
  'if-match': Type.Optional(Type.String({ minLength: 1 })),
});

const TITLE_BY_CODE: Record<PassErrorCode, string> = {
  destination_not_found: 'Destination not found',
  destination_unavailable: 'Destination unavailable',
  student_not_found: 'Student not found',
  active_pass_exists: 'Active pass already exists',
  pass_not_found: 'Pass not found',
  invalid_pass_transition: 'Invalid pass transition',
  idempotency_key_required: 'Idempotency key required',
  invalid_idempotency_key: 'Invalid idempotency key',
  idempotency_key_reused: 'Idempotency key reused',
  precondition_required: 'Precondition required',
  invalid_precondition: 'Invalid precondition',
  stale_pass_revision: 'Stale pass revision',
  forbidden: 'Forbidden',
  recovery_session_restricted: 'Recovery session restricted',
};

async function sendPassProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  error: PassApplicationError,
): Promise<void> {
  const status = passHttpStatus(error.code);
  await reply
    .status(status)
    .type('application/problem+json')
    .send({
      type: `https://openhall.dev/problems/${error.code}`,
      title: TITLE_BY_CODE[error.code],
      status,
      instance: safeRequestPath(request.url),
      code: error.code,
      requestId: request.id,
    });
}

function unauthenticated(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  return reply.status(401).send({
    type: 'https://openhall.dev/problems/unauthenticated',
    title: 'Unauthenticated',
    status: 401,
    code: 'unauthenticated',
    requestId: request.id,
  });
}

const MUTATION_ERRORS = {
  400: {
    description: 'Malformed input or invalid idempotency key',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
  401: {
    description: 'Unauthenticated',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
  403: {
    description: 'Forbidden or recovery session restricted',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
  404: {
    description: 'Concealed destination, student, or pass resource',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
  409: {
    description: 'Active pass exists, key reused, invalid transition, or destination unavailable',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
};

export interface RegisterPassesOptions {
  readonly passes: PassDependencies;
  readonly auth: AuthDependencies;
}

export function registerPassesRoutes(app: FastifyInstance, options: RegisterPassesOptions): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();
  const { passes, auth } = options;

  typedApp.post(
    '/api/v1/me/passes',
    {
      schema: {
        operationId: 'requestMyPass',
        tags: ['passes'],
        description:
          'Request a pass for the authenticated student. The target student and request source are server-derived. Requires Idempotency-Key (OpenHall API contract, not a finalized IETF RFC). Success returns ETag for the pass revision. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        body: PassRequestBodySchema,
        headers: IdempotencyHeadersSchema,
        response: { 201: PassResponseSchema, ...MUTATION_ERRORS },
      },
      // Authentication and CSRF run before schema validation so anonymous
      // callers always receive 401 rather than a validation artifact.
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      try {
        const result = await requestSelfPass(
          {
            principal,
            destinationId: request.body.destinationId,
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
          },
          passes.request,
        );
        return await reply
          .status(result.status)
          .header('Cache-Control', 'no-store')
          .header('ETag', result.etag)
          .send({ pass: result.pass });
      } catch (error) {
        if (error instanceof PassApplicationError) {
          await sendPassProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/api/v1/students/:studentId/passes',
    {
      schema: {
        operationId: 'requestStudentPass',
        tags: ['passes'],
        description:
          'Staff-created pass request for a student. Organization-level pass.create.student is attempted first; denied teachers fall back to the resolved current section. Requires Idempotency-Key (OpenHall API contract). Success returns ETag. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: StudentIdParamsSchema,
        body: PassRequestBodySchema,
        headers: IdempotencyHeadersSchema,
        response: { 201: PassResponseSchema, ...MUTATION_ERRORS },
      },
      // Authentication and CSRF run before schema validation so anonymous
      // callers always receive 401 rather than a validation artifact.
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      try {
        const result = await requestStudentPass(
          {
            principal,
            studentId: request.params.studentId,
            destinationId: request.body.destinationId,
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
          },
          passes.request,
        );
        return await reply
          .status(result.status)
          .header('Cache-Control', 'no-store')
          .header('ETag', result.etag)
          .send({ pass: result.pass });
      } catch (error) {
        if (error instanceof PassApplicationError) {
          await sendPassProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/api/v1/me/passes/active',
    {
      schema: {
        operationId: 'getMyActivePass',
        tags: ['passes'],
        description:
          'Read the authenticated student\u2019s current active pass, or pass:null. Cookie-authenticated; not CSRF-protected. Success returns ETag when a pass exists. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        response: {
          200: ActiveSelfPassSchema,
          401: {
            description: 'Unauthenticated',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          403: {
            description: 'Recovery session restricted',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
        },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      try {
        const result = await getActiveSelfPass(principal, passes.active);
        void reply.header('Cache-Control', 'no-store');
        if (result.etag !== null) void reply.header('ETag', result.etag);
        return await reply.send({ pass: result.pass });
      } catch (error) {
        if (error instanceof PassApplicationError) {
          await sendPassProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/api/v1/me/passes/:passId/cancel',
    {
      schema: {
        operationId: 'cancelMyPass',
        tags: ['passes'],
        description:
          'Self-cancel an own student_web pass in requested/queued/ready. Requires Idempotency-Key and the exact strong ETag in If-Match; missing If-Match is 428, stale is 412. Idempotent replay returns the stored success. Success returns the new ETag. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: PassIdParamsSchema,
        headers: CancelHeadersSchema,
        response: {
          200: PassResponseSchema,
          ...MUTATION_ERRORS,
          412: {
            description: 'Stale pass revision',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          428: {
            description: 'If-Match required',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
        },
      },
      // Authentication and CSRF run before schema validation so anonymous
      // callers always receive 401 rather than a validation artifact.
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      try {
        const result = await cancelSelfPass(
          {
            principal,
            passId: request.params.passId,
            idempotencyKey: request.headers['idempotency-key'],
            ifMatch: request.headers['if-match'],
            requestId: request.id,
          },
          passes.cancel,
        );
        return await reply
          .status(result.status)
          .header('Cache-Control', 'no-store')
          .header('ETag', result.etag)
          .send({ pass: result.pass });
      } catch (error) {
        if (error instanceof PassApplicationError) {
          await sendPassProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );
}
