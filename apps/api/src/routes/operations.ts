import {
  PassApplicationError,
  listSchoolLivePasses,
  listSectionLivePasses,
  listSectionStudents,
  passHttpStatus,
} from '@openhall/application';
import {
  LivePassListSchema,
  ProblemDetailsSchema,
  SectionStudentListSchema,
  UuidSchema,
} from '@openhall/contracts';
import { Type } from 'typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { requirePrincipal } from '../auth/session-context.js';
import type { PassDependencies } from '../passes/dependencies.js';
import { safeRequestPath } from '../http-privacy.js';
import { TITLE_BY_CODE } from './passes.js';

const COOKIE_SECURITY = [{ cookieAuth: [] as string[] }];
const SectionParamsSchema = Type.Object({ sectionId: UuidSchema }, { additionalProperties: false });
const OrganizationParamsSchema = Type.Object(
  { organizationId: UuidSchema },
  { additionalProperties: false },
);

const READ_ERRORS = {
  401: {
    description: 'Unauthenticated',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
  403: {
    description: 'Recovery session restricted',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
  404: {
    description: 'Unknown, inaccessible, or cross-school resource',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
};

async function sendProblem(
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

export function registerOperationalRoutes(app: FastifyInstance, passes: PassDependencies): void {
  const typedApp = app.withTypeProvider<TypeBoxTypeProvider>();

  typedApp.get(
    '/api/v1/sections/:sectionId/passes/live',
    {
      schema: {
        operationId: 'listSectionLivePasses',
        tags: ['operations'],
        description:
          'Minimized active movement for a section, authorized only through the canonical teaching relationship or existing administrator capability. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: SectionParamsSchema,
        response: { 200: LivePassListSchema, ...READ_ERRORS },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      try {
        const result = await listSectionLivePasses(
          principal,
          request.params.sectionId,
          passes.operations,
        );
        return await reply.send({ passes: [...result.passes] });
      } catch (error) {
        if (error instanceof PassApplicationError) return sendProblem(reply, request, error);
        throw error;
      }
    },
  );

  typedApp.get(
    '/api/v1/sections/:sectionId/students',
    {
      schema: {
        operationId: 'listSectionStudents',
        tags: ['operations'],
        description:
          'Current active students in an authorized teaching section. Returns names only; people.view is not required. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: SectionParamsSchema,
        response: { 200: SectionStudentListSchema, ...READ_ERRORS },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      try {
        const result = await listSectionStudents(
          principal,
          request.params.sectionId,
          passes.operations,
        );
        return await reply.send({ students: [...result.students] });
      } catch (error) {
        if (error instanceof PassApplicationError) return sendProblem(reply, request, error);
        throw error;
      }
    },
  );

  typedApp.get(
    '/api/v1/organizations/:organizationId/passes/live',
    {
      schema: {
        operationId: 'listSchoolLivePasses',
        tags: ['operations'],
        description:
          'Minimized active movement across one school. Requires pass.view.school_live for that exact school. Cache-Control: no-store.',
        security: COOKIE_SECURITY,
        params: OrganizationParamsSchema,
        response: { 200: LivePassListSchema, ...READ_ERRORS },
      },
      preHandler: async (request, reply) => requirePrincipal(request, reply),
    },
    async (request, reply) => {
      const principal = request.principal;
      if (principal === undefined) return unauthenticated(reply, request);
      try {
        const result = await listSchoolLivePasses(
          principal,
          request.params.organizationId,
          passes.operations,
        );
        return await reply.send({ passes: [...result.passes] });
      } catch (error) {
        if (error instanceof PassApplicationError) return sendProblem(reply, request, error);
        throw error;
      }
    },
  );
}
