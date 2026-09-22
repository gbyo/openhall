import { controlPlaneHttpStatus, type ControlPlaneErrorCode } from '@openhall/application';
import { ControlPlaneError } from '@openhall/application';
import { ProblemDetailsSchema, UuidSchema } from '@openhall/contracts';
import { Type } from 'typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthDependencies } from '../auth/dependencies.js';
import type { ControlPlaneDependencies } from '../control-plane/dependencies.js';
import { safeRequestPath } from '../http-privacy.js';

export const COOKIE_SECURITY = [{ cookieAuth: [] as string[] }];
export const COOKIE_CSRF_SECURITY = [{ cookieAuth: [] as string[], csrfHeader: [] as string[] }];

export const TITLE_BY_CODE: Record<ControlPlaneErrorCode, string> = {
  room_not_found: 'Room not found',
  room_in_use: 'Room in use',
  room_already_open: 'Room already open',
  room_already_closed: 'Room already closed',
  invalid_room_state: 'Invalid room state',
  room_category_not_found: 'Room category not found',
  room_category_in_use: 'Room category in use',
  room_category_exists: 'Room category exists',
  schedule_block_not_found: 'Schedule block not found',
  schedule_block_in_use: 'Schedule block in use',
  schedule_block_exists: 'Schedule block exists',
  schedule_template_not_found: 'Schedule template not found',
  schedule_template_in_use: 'Schedule template in use',
  schedule_slots_overlap: 'Schedule slots overlap',
  schedule_day_not_found: 'Calendar day not found',
  schedule_not_found: 'Schedule not found',
  invalid_schedule_state: 'Invalid schedule state',
  policy_rule_not_found: 'Policy rule not found',
  policy_rule_archived: 'Policy rule archived',
  policy_rule_invalid: 'Invalid policy rule',
  authorization_grant_not_found: 'Authorization grant not found',
  authorization_grant_exists: 'Authorization grant exists',
  invalid_authorization_grant_state: 'Invalid authorization grant state',
  target_not_active_staff: 'Target is not active staff',
  identity_enrollment_not_found: 'Identity enrollment not found',
  identity_already_enrolled: 'Identity already enrolled',
  identity_enrollment_invalid: 'Invalid identity enrollment',
  identity_enrollment_expired: 'Identity enrollment expired',
  identity_link_conflict: 'Identity link conflict',
  scheduled_authorization_not_found: 'Scheduled authorization not found',
  scheduled_authorization_not_yet_valid: 'Scheduled authorization not yet valid',
  scheduled_authorization_expired: 'Scheduled authorization expired',
  invalid_scheduled_authorization_state: 'Invalid scheduled authorization state',
  person_not_found: 'Person not found',
  section_not_found: 'Section not found',
  invalid_search_cursor: 'Invalid search cursor',
  forbidden: 'Forbidden',
  recovery_session_restricted: 'Recovery session restricted',
  idempotency_key_required: 'Idempotency key required',
  invalid_idempotency_key: 'Invalid idempotency key',
  idempotency_key_reused: 'Idempotency key reused',
  precondition_required: 'Precondition required',
  invalid_precondition: 'Invalid precondition',
  stale_resource_revision: 'Stale resource revision',
};

async function sendControlPlaneProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  error: ControlPlaneError,
): Promise<void> {
  const status = controlPlaneHttpStatus(error.code);
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

export function unauthenticated(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  return reply.status(401).send({
    type: 'https://openhall.dev/problems/unauthenticated',
    title: 'Unauthenticated',
    status: 401,
    code: 'unauthenticated',
    requestId: request.id,
  });
}

export const OrganizationIdParamsSchema = Type.Object(
  { organizationId: UuidSchema },
  { additionalProperties: false },
);
export const RoomIdParamsSchema = Type.Object(
  { roomId: UuidSchema },
  { additionalProperties: false },
);

export const RoomCategoryIdParamsSchema = Type.Object(
  { categoryId: UuidSchema },
  { additionalProperties: false },
);

export const CreateHeadersSchema = Type.Object({
  'idempotency-key': Type.String({ minLength: 1, maxLength: 255 }),
});

export const MutationHeadersSchema = Type.Object({
  'idempotency-key': Type.String({ minLength: 1, maxLength: 255 }),
  // Optional at the HTTP layer so a missing If-Match reaches the use case,
  // which answers 428 precondition_required instead of a generic 400.
  'if-match': Type.Optional(Type.String({ minLength: 1 })),
});

export const CONTROL_PLANE_ERRORS = {
  400: {
    description: 'Malformed input, invalid precondition, or invalid idempotency key',
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
    description: 'Concealed or missing school resource',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
  409: {
    description: 'Resource in use, duplicate, or invalid state',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
  412: {
    description: 'Stale resource revision',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
  428: {
    description: 'If-Match required',
    content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
  },
};

export type ControlPlaneHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
  execute: () => Promise<{
    readonly body: unknown;
    readonly etag?: string;
    readonly status: number;
  }>,
) => Promise<void>;

export async function handleControlPlane(
  request: FastifyRequest,
  reply: FastifyReply,
  execute: () => Promise<{
    readonly body: unknown;
    readonly etag?: string;
    readonly status: number;
  }>,
): Promise<void> {
  try {
    const result = await execute();
    const withHeaders = reply.status(result.status).header('Cache-Control', 'no-store');
    if (result.etag !== undefined) withHeaders.header('ETag', result.etag);
    await withHeaders.send(result.body);
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      await sendControlPlaneProblem(reply, request, error);
      return;
    }
    throw error;
  }
}

export interface RegisterControlPlaneOptions {
  readonly controlPlane: ControlPlaneDependencies;
  readonly auth: AuthDependencies;
}
