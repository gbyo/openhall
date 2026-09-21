import {
  PassApplicationError,
  arriveSelfPass,
  completeSelfPass,
  departSelfPass,
  departStudentPass,
  getOwnQueueStatus,
  getStationView,
  passHttpStatus,
  returnSelfPass,
  stationBeginReturnPass,
  stationCheckInPass,
  stationCompletePass,
  type Principal,
} from '@openhall/application';
import {
  DestinationStationViewSchema,
  PassResponseSchema,
  ProblemDetailsSchema,
  QueueStatusSchema,
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

const StationParamsSchema = Type.Object(
  { destinationId: UuidSchema, passId: UuidSchema },
  { additionalProperties: false },
);

const DestinationParamsSchema = Type.Object(
  { destinationId: UuidSchema },
  { additionalProperties: false },
);

const MovementHeadersSchema = Type.Object({
  'idempotency-key': Type.String({ minLength: 1, maxLength: 255 }),
  'if-match': Type.Optional(Type.String({ minLength: 1 })),
});

async function sendMovementProblem(
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

const MOVEMENT_ERRORS = {
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
    description: 'Concealed pass, destination, or station resource',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
  409: {
    description: 'Invalid movement state, expired offer, or destination conflict',
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

export interface RegisterMovementOptions {
  readonly passes: PassDependencies;
  readonly auth: AuthDependencies;
}

interface PassMutationInput {
  readonly principal: Principal;
  readonly passId: string;
  readonly idempotencyKey: unknown;
  readonly ifMatch: unknown;
  readonly requestId: string;
}

interface PassMutationResult {
  readonly pass: unknown;
  readonly etag: string;
  readonly status: 200;
  readonly replayed: boolean;
}

type PassMutationCommand<TDependencies> = (
  input: PassMutationInput,
  dependencies: TDependencies,
) => Promise<PassMutationResult>;

export function registerMovementRoutes(
  app: FastifyInstance,
  options: RegisterMovementOptions,
): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();
  const { passes, auth } = options;

  async function runMutation<TDependencies>(
    request: FastifyRequest,
    reply: FastifyReply,
    params: { passId: string },
    command: PassMutationCommand<TDependencies>,
    dependencies: TDependencies,
  ): Promise<void> {
    const principal = request.principal;
    if (principal === undefined) {
      unauthenticated(reply, request);
      return;
    }
    try {
      const result = await command(
        {
          principal,
          passId: params.passId,
          idempotencyKey: request.headers['idempotency-key'],
          ifMatch: request.headers['if-match'],
          requestId: request.id,
        },
        dependencies,
      );
      await reply
        .status(result.status)
        .header('Cache-Control', 'no-store')
        .header('ETag', result.etag)
        .send({ pass: result.pass });
    } catch (error) {
      if (error instanceof PassApplicationError) {
        await sendMovementProblem(reply, request, error);
        return;
      }
      throw error;
    }
  }

  function mutationRoute<TDependencies>(
    method: 'post',
    url: string,
    operationId: string,
    description: string,
    command: PassMutationCommand<TDependencies>,
    dependencies: TDependencies,
  ): void {
    typedApp[method](
      url,
      {
        schema: {
          operationId,
          tags: ['movement'],
          description,
          security: COOKIE_CSRF_SECURITY,
          params: PassIdParamsSchema,
          headers: MovementHeadersSchema,
          response: { 200: PassResponseSchema, ...MOVEMENT_ERRORS },
        },
        preValidation: [
          async (request, reply) => requirePrincipal(request, reply),
          async (request, reply) => requireCsrf(request, reply, auth),
        ],
      },
      async (request, reply) => {
        await runMutation(request, reply, request.params, command, dependencies);
      },
    );
  }

  mutationRoute(
    'post',
    '/api/v1/me/passes/:passId/depart',
    'departMyPass',
    'Start the authenticated student\u2019s own ready pass. Requires Idempotency-Key and the exact strong ETag in If-Match. Only an explicit departure establishes that the student left. Success returns the new ETag. Cache-Control: no-store.',
    departSelfPass,
    passes.depart,
  );

  mutationRoute(
    'post',
    '/api/v1/passes/:passId/depart',
    'departStudentPass',
    'Staff starts a student\u2019s ready pass, for example when the student carries no device. Organization-level staff authority first, teacher fallback against the current section. Requires Idempotency-Key and the exact strong ETag in If-Match. Success returns the new ETag. Cache-Control: no-store.',
    departStudentPass,
    passes.depart,
  );

  mutationRoute(
    'post',
    '/api/v1/me/passes/:passId/arrive',
    'arriveMyPass',
    'Self arrival for check_in_mode = optional destinations only. Required destinations need station check-in; none destinations take no arrival checkpoint. Requires Idempotency-Key and the exact strong ETag in If-Match. Success returns the new ETag. Cache-Control: no-store.',
    arriveSelfPass,
    passes.progress,
  );

  mutationRoute(
    'post',
    '/api/v1/me/passes/:passId/return',
    'returnMyPass',
    'Begin the return from at_destination. Releases destination capacity. Requires Idempotency-Key and the exact strong ETag in If-Match. Success returns the new ETag. Cache-Control: no-store.',
    returnSelfPass,
    passes.progress,
  );

  mutationRoute(
    'post',
    '/api/v1/me/passes/:passId/complete',
    'completeMyPass',
    'Complete the student\u2019s own active movement. The normal lightweight path is outbound -> completed with no fabricated arrival or return checkpoints. Requires Idempotency-Key and the exact strong ETag in If-Match. Success returns the new ETag. Cache-Control: no-store.',
    completeSelfPass,
    passes.progress,
  );

  interface StationMutationInput extends PassMutationInput {
    readonly destinationId: string;
  }

  async function runStationMutation(
    request: FastifyRequest,
    reply: FastifyReply,
    params: { destinationId: string; passId: string },
    command: (
      input: StationMutationInput,
      dependencies: PassDependencies['progress'],
    ) => Promise<PassMutationResult>,
  ): Promise<void> {
    const principal = request.principal;
    if (principal === undefined) {
      unauthenticated(reply, request);
      return;
    }
    try {
      const result = await command(
        {
          principal,
          destinationId: params.destinationId,
          passId: params.passId,
          idempotencyKey: request.headers['idempotency-key'],
          ifMatch: request.headers['if-match'],
          requestId: request.id,
        },
        passes.progress,
      );
      await reply
        .status(result.status)
        .header('Cache-Control', 'no-store')
        .header('ETag', result.etag)
        .send({ pass: result.pass });
    } catch (error) {
      if (error instanceof PassApplicationError) {
        await sendMovementProblem(reply, request, error);
        return;
      }
      throw error;
    }
  }

  function stationMutationRoute(
    url: string,
    operationId: string,
    description: string,
    command: Parameters<typeof runStationMutation>[3],
  ): void {
    typedApp.post(
      url,
      {
        schema: {
          operationId,
          tags: ['movement'],
          description,
          security: COOKIE_CSRF_SECURITY,
          params: StationParamsSchema,
          headers: MovementHeadersSchema,
          response: { 200: PassResponseSchema, ...MOVEMENT_ERRORS },
        },
        preValidation: [
          async (request, reply) => requirePrincipal(request, reply),
          async (request, reply) => requireCsrf(request, reply, auth),
        ],
      },
      async (request, reply) => {
        await runStationMutation(request, reply, request.params, command);
      },
    );
  }

  stationMutationRoute(
    '/api/v1/destinations/:destinationId/passes/:passId/check-in',
    'stationCheckInPass',
    'Destination station records arrival for optional/required destinations. The pass destination must equal the route destination. Requires Idempotency-Key and the exact strong ETag in If-Match. Success returns the new ETag. Cache-Control: no-store.',
    stationCheckInPass,
  );

  stationMutationRoute(
    '/api/v1/destinations/:destinationId/passes/:passId/begin-return',
    'stationBeginReturnPass',
    'Destination station records that the student left the destination. Releases capacity. The pass destination must equal the route destination. Requires Idempotency-Key and the exact strong ETag in If-Match. Success returns the new ETag. Cache-Control: no-store.',
    stationBeginReturnPass,
  );

  stationMutationRoute(
    '/api/v1/destinations/:destinationId/passes/:passId/complete',
    'stationCompletePass',
    'Destination staff explicitly ends a movement at the destination (one-way workflows). Requires a prior explicit arrival. Requires Idempotency-Key and the exact strong ETag in If-Match. Success returns the new ETag. Cache-Control: no-store.',
    stationCompletePass,
  );

  typedApp.get(
    '/api/v1/me/passes/:passId/queue-status',
    {
      schema: {
        operationId: 'getMyPassQueueStatus',
        tags: ['movement'],
        description:
          'Read the authenticated student\u2019s own derived queue position. Position is computed on every read and never stored, so this dynamic resource carries no pass ETag. Other students\u2019 passes are concealed as 404; a non-queued owned pass is 409. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: PassIdParamsSchema,
        response: {
          200: QueueStatusSchema,
          401: {
            description: 'Unauthenticated',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          403: {
            description: 'Recovery session restricted',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          404: {
            description: 'Concealed pass resource',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          409: {
            description: 'Pass is not currently queued',
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
        const status = await getOwnQueueStatus(principal, request.params.passId, passes.reads);
        return await reply.header('Cache-Control', 'no-store').send(status);
      } catch (error) {
        if (error instanceof PassApplicationError) {
          await sendMovementProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );

  typedApp.get(
    '/api/v1/destinations/:destinationId/station',
    {
      schema: {
        operationId: 'getDestinationStation',
        tags: ['movement'],
        description:
          'Minimized operational station view for authorized destination staff. No grants, rule JSON, or student schedule history. Dynamic aggregates carry no ETag. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: DestinationParamsSchema,
        response: {
          200: DestinationStationViewSchema,
          401: {
            description: 'Unauthenticated',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          403: {
            description: 'Recovery session restricted',
            content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
          },
          404: {
            description: 'Concealed destination or station resource',
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
        const view = await getStationView(principal, request.params.destinationId, passes.reads);
        return await reply.header('Cache-Control', 'no-store').send(view);
      } catch (error) {
        if (error instanceof PassApplicationError) {
          await sendMovementProblem(reply, request, error);
          return;
        }
        throw error;
      }
    },
  );
}
