import {
  ControlPlaneError,
  PassApplicationError,
  controlPlaneHttpStatus,
  listMyScheduledAuthorizations,
  passHttpStatus,
  startMyScheduledAuthorization,
  type Principal,
} from '@openhall/application';
import { MyScheduledAuthListSchema, PassResponseSchema, UuidSchema } from '@openhall/contracts';
import { Type } from 'typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { safeRequestPath } from '../http-privacy.js';
import type { AuthDependencies } from '../auth/dependencies.js';
import { requireCsrf, requirePrincipal } from '../auth/session-context.js';
import type { ControlPlaneDependencies } from '../control-plane/dependencies.js';
import {
  CONTROL_PLANE_ERRORS,
  COOKIE_CSRF_SECURITY,
  COOKIE_SECURITY,
  MutationHeadersSchema,
  TITLE_BY_CODE as CONTROL_PLANE_TITLES,
  unauthenticated,
} from './control-plane-shared.js';
import { TITLE_BY_CODE as PASS_TITLES } from './passes.js';

const MyScheduledAuthIdParamsSchema = Type.Object(
  { scheduledAuthorizationId: UuidSchema },
  { additionalProperties: false },
);

async function sendScheduledProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  error: ControlPlaneError | PassApplicationError,
): Promise<void> {
  const status =
    error instanceof ControlPlaneError
      ? controlPlaneHttpStatus(error.code)
      : passHttpStatus(error.code);
  const title =
    error instanceof ControlPlaneError ? CONTROL_PLANE_TITLES[error.code] : PASS_TITLES[error.code];
  await reply
    .status(status)
    .type('application/problem+json')
    .send({
      type: `https://openhall.dev/problems/${error.code}`,
      title,
      status,
      instance: safeRequestPath(request.url),
      code: error.code,
      requestId: request.id,
    });
}

export function registerScheduledStudentRoutes(
  app: FastifyInstance,
  controlPlane: ControlPlaneDependencies,
  auth: AuthDependencies,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.get(
    '/api/v1/me/scheduled-authorizations',
    {
      schema: {
        operationId: 'listMyScheduledAuthorizations',
        tags: ['scheduled'],
        description:
          "The student's own appointments with safe destination/origin projections. Cache-Control: no-store.",
        security: COOKIE_SECURITY,
        response: {
          200: MyScheduledAuthListSchema,
          401: CONTROL_PLANE_ERRORS[401],
          403: CONTROL_PLANE_ERRORS[403],
        },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal: Principal | undefined = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      try {
        const result = await listMyScheduledAuthorizations(principal, controlPlane.scheduled);
        return await reply.header('Cache-Control', 'no-store').send(result);
      } catch (error) {
        if (error instanceof ControlPlaneError || error instanceof PassApplicationError) {
          await sendScheduledProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );

  typedApp.post(
    '/api/v1/me/scheduled-authorizations/:scheduledAuthorizationId/start',
    {
      schema: {
        operationId: 'startMyScheduledAuthorization',
        tags: ['scheduled'],
        description:
          'Start staff-directed movement from a live appointment. Runs the normal pass pipeline in the same transaction that consumes the appointment (live pass) or records the denied attempt (terminal denial). Requires Idempotency-Key and If-Match. Cache-Control: no-store.',
        security: COOKIE_CSRF_SECURITY,
        params: MyScheduledAuthIdParamsSchema,
        headers: MutationHeadersSchema,
        response: {
          201: PassResponseSchema,
          400: CONTROL_PLANE_ERRORS[400],
          401: CONTROL_PLANE_ERRORS[401],
          403: CONTROL_PLANE_ERRORS[403],
          404: CONTROL_PLANE_ERRORS[404],
          409: CONTROL_PLANE_ERRORS[409],
          412: CONTROL_PLANE_ERRORS[412],
          428: CONTROL_PLANE_ERRORS[428],
        },
      },
      preValidation: [
        async (request, reply) => requirePrincipal(request, reply),
        async (request, reply) => requireCsrf(request, reply, auth),
      ],
    },
    async (request, reply) => {
      const principal: Principal | undefined = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      try {
        const result = await startMyScheduledAuthorization(
          {
            principal,
            idempotencyKey: request.headers['idempotency-key'],
            requestId: request.id,
            scheduledAuthorizationId: request.params.scheduledAuthorizationId,
            ifMatch: request.headers['if-match'],
          },
          controlPlane.scheduled,
        );
        return await reply
          .header('ETag', result.etag)
          .header('Cache-Control', 'no-store')
          .status(result.status)
          .send({ pass: result.pass });
      } catch (error) {
        if (error instanceof ControlPlaneError || error instanceof PassApplicationError) {
          await sendScheduledProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );
}
