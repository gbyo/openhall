import {
  PassApplicationError,
  listPendingApprovals,
  listPendingOverrides,
  parseOverrideCategory,
  passHttpStatus,
  requestPassOverride,
  resolvePassApproval,
  resolvePassOverride,
} from '@openhall/application';
import {
  OverrideRequestBodySchema,
  PassResponseSchema,
  PendingApprovalListSchema,
  PendingOverrideListSchema,
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
import { TITLE_BY_CODE } from './passes.js';

const COOKIE_SECURITY = [{ cookieAuth: [] as string[] }];
const COOKIE_CSRF_SECURITY = [{ cookieAuth: [] as string[], csrfHeader: [] as string[] }];

const PassIdParamsSchema = Type.Object({ passId: UuidSchema }, { additionalProperties: false });
const ApprovalIdParamsSchema = Type.Object(
  { approvalId: UuidSchema },
  { additionalProperties: false },
);
const OverrideIdParamsSchema = Type.Object(
  { overrideId: UuidSchema },
  { additionalProperties: false },
);

const WorkflowHeadersSchema = Type.Object({
  'idempotency-key': Type.String({ minLength: 1, maxLength: 255 }),
  'if-match': Type.Optional(Type.String({ minLength: 1 })),
});

async function sendWorkflowProblem(
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

const WORKFLOW_ERRORS = {
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
    description: 'Concealed approval, override, or pass resource',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
  409: {
    description: 'Invalid workflow state or no overrideable blocker',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
  412: {
    description: 'Stale pass revision',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
  428: {
    description: 'If-Match required',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
};

export interface RegisterPolicyOptions {
  readonly passes: PassDependencies;
  readonly auth: AuthDependencies;
}

export function registerPolicyRoutes(app: FastifyInstance, options: RegisterPolicyOptions): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();
  const { passes, auth } = options;

  typedApp.get(
    '/api/v1/me/pass-approvals/pending',
    {
      schema: {
        operationId: 'listMyPendingPassApprovals',
        tags: ['policy'],
        description:
          'Pending standard approvals the authenticated principal may resolve. Cookie-authenticated; not CSRF-protected. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        response: {
          200: PendingApprovalListSchema,
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
        const approvals = await listPendingApprovals(principal, passes.approvals);
        return await reply.header('Cache-Control', 'no-store').send({ approvals: [...approvals] });
      } catch (error) {
        if (error instanceof PassApplicationError) {
          await sendWorkflowProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );

  for (const decision of ['approve', 'deny'] as const) {
    typedApp.post(
      `/api/v1/pass-approvals/:approvalId/${decision}`,
      {
        schema: {
          operationId: decision === 'approve' ? 'approvePassApproval' : 'denyPassApproval',
          tags: ['policy'],
          description: `Resolve one exact standard approval requirement (${decision}). Requires Idempotency-Key and the exact strong pass ETag in If-Match. Success returns the new pass ETag. Cache-Control: no-store.`,
          security: COOKIE_CSRF_SECURITY,
          params: ApprovalIdParamsSchema,
          headers: WorkflowHeadersSchema,
          response: { 200: PassResponseSchema, ...WORKFLOW_ERRORS },
        },
        preValidation: [
          async (request, reply) => requirePrincipal(request, reply),
          async (request, reply) => requireCsrf(request, reply, auth),
        ],
      },
      async (request, reply) => {
        const principal = request.principal;
        if (principal === undefined) return unauthenticated(reply, request);
        try {
          const result = await resolvePassApproval(
            {
              principal,
              approvalId: request.params.approvalId,
              decision: decision === 'approve' ? 'approved' : 'denied',
              idempotencyKey: request.headers['idempotency-key'],
              ifMatch: request.headers['if-match'],
              requestId: request.id,
            },
            passes.approvals,
          );
          return await reply
            .status(result.status)
            .header('Cache-Control', 'no-store')
            .header('ETag', result.etag)
            .send({ pass: result.pass });
        } catch (error) {
          if (error instanceof PassApplicationError) {
            await sendWorkflowProblem(reply, request, error);
            return;
          }
          throw error;
        }
      },
    );
  }

  typedApp.post(
    '/api/v1/me/passes/:passId/overrides',
    {
      schema: {
        operationId: 'requestMyPassOverride',
        tags: ['policy'],
        description:
          'Request rule-specific overrides for the authenticated student\u2019s own pass. Body carries only a category; blockers are server-derived. Requires Idempotency-Key and If-Match. Success returns the pass ETag. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: PassIdParamsSchema,
        body: OverrideRequestBodySchema,
        headers: WorkflowHeadersSchema,
        response: { 200: PassResponseSchema, ...WORKFLOW_ERRORS },
      },
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      try {
        const result = await requestPassOverride(
          {
            principal,
            passId: request.params.passId,
            category: parseOverrideCategory(request.body.category),
            idempotencyKey: request.headers['idempotency-key'],
            ifMatch: request.headers['if-match'],
            requestId: request.id,
            surface: 'self',
          },
          passes.overrides,
        );
        return await reply
          .status(result.status)
          .header('Cache-Control', 'no-store')
          .header('ETag', result.etag)
          .send({ pass: result.pass });
      } catch (error) {
        if (error instanceof PassApplicationError) {
          await sendWorkflowProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/api/v1/passes/:passId/overrides',
    {
      schema: {
        operationId: 'requestStudentPassOverride',
        tags: ['policy'],
        description:
          'Staff override request for a student pass. Authorized resolvers collapse authorized-mode request+approval atomically; approval_required blockers stay pending. Body carries only a category. Requires Idempotency-Key and If-Match. Success returns the pass ETag. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: PassIdParamsSchema,
        body: OverrideRequestBodySchema,
        headers: WorkflowHeadersSchema,
        response: { 200: PassResponseSchema, ...WORKFLOW_ERRORS },
      },
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      try {
        const result = await requestPassOverride(
          {
            principal,
            passId: request.params.passId,
            category: parseOverrideCategory(request.body.category),
            idempotencyKey: request.headers['idempotency-key'],
            ifMatch: request.headers['if-match'],
            requestId: request.id,
            surface: 'student',
          },
          passes.overrides,
        );
        return await reply
          .status(result.status)
          .header('Cache-Control', 'no-store')
          .header('ETag', result.etag)
          .send({ pass: result.pass });
      } catch (error) {
        if (error instanceof PassApplicationError) {
          await sendWorkflowProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/api/v1/me/pass-overrides/pending',
    {
      schema: {
        operationId: 'listMyPendingPassOverrides',
        tags: ['policy'],
        description:
          'Pending rule-specific overrides the authenticated principal may resolve, honoring each override\u2019s escalation tier. Cookie-authenticated; not CSRF-protected. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        response: {
          200: PendingOverrideListSchema,
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
        const overrides = await listPendingOverrides(principal, passes.overrides);
        return await reply.header('Cache-Control', 'no-store').send({ overrides: [...overrides] });
      } catch (error) {
        if (error instanceof PassApplicationError) {
          await sendWorkflowProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );

  for (const decision of ['approve', 'deny'] as const) {
    typedApp.post(
      `/api/v1/pass-overrides/:overrideId/${decision}`,
      {
        schema: {
          operationId: decision === 'approve' ? 'approvePassOverride' : 'denyPassOverride',
          tags: ['policy'],
          description: `Resolve one exact rule-specific override (${decision}). Approval_required overrides need an independent school-tier approver. Requires Idempotency-Key and If-Match. Success returns the new pass ETag. Cache-Control: no-store.`,
          security: COOKIE_CSRF_SECURITY,
          params: OverrideIdParamsSchema,
          headers: WorkflowHeadersSchema,
          response: { 200: PassResponseSchema, ...WORKFLOW_ERRORS },
        },
        preValidation: [
          async (request, reply) => requirePrincipal(request, reply),
          async (request, reply) => requireCsrf(request, reply, auth),
        ],
      },
      async (request, reply) => {
        const principal = request.principal;
        if (principal === undefined) return unauthenticated(reply, request);
        try {
          const result = await resolvePassOverride(
            {
              principal,
              overrideId: request.params.overrideId,
              decision: decision === 'approve' ? 'approved' : 'denied',
              idempotencyKey: request.headers['idempotency-key'],
              ifMatch: request.headers['if-match'],
              requestId: request.id,
            },
            passes.overrides,
          );
          return await reply
            .status(result.status)
            .header('Cache-Control', 'no-store')
            .header('ETag', result.etag)
            .send({ pass: result.pass });
        } catch (error) {
          if (error instanceof PassApplicationError) {
            await sendWorkflowProblem(reply, request, error);
            return;
          }
          throw error;
        }
      },
    );
  }
}
