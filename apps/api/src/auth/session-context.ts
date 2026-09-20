import type {} from '@fastify/cookie';
import {
  AuthenticationError,
  fromBase64Url,
  resolveSession,
  type Principal,
  type ResolvedSession,
  type SessionRecord,
} from '@openhall/application';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clearSessionCookie, decodeCookieToken, sessionTokenFrom } from './cookies.js';
import type { AuthDependencies } from './dependencies.js';
import { problemFor, statusFor } from './problems.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    authSession?: SessionRecord;
    resolvedSession?: ResolvedSession;
  }
}

export interface SessionContextOptions {
  readonly dependencies: AuthDependencies;
}

/**
 * Resolves the opaque session cookie into request.principal on every
 * request that presents one. An invalid credential is cleared
 * opportunistically and the request continues anonymously; protected
 * routes turn that into 401 via requirePrincipal.
 */
export function registerSessionContext(app: FastifyInstance, options: SessionContextOptions): void {
  const { dependencies } = options;
  app.addHook('onRequest', async (request, reply) => {
    const raw = sessionTokenFrom(request, dependencies.isProduction);
    if (raw === undefined) {
      return;
    }
    const token = decodeCookieToken(raw);
    if (token === undefined) {
      clearSessionCookie(reply, dependencies.isProduction);
      return;
    }
    try {
      const resolved = await resolveSession(token, {
        lookup: dependencies.lookup,
        directory: dependencies.directory,
        sessions: dependencies.sessions,
        digester: dependencies.digester,
        clock: dependencies.clock,
        runTenantTransaction: (tenantId, operation) =>
          dependencies.tenantRunner.run(tenantId, operation),
      });
      request.principal = resolved.principal;
      request.authSession = resolved.session;
      request.resolvedSession = resolved;
    } catch (error) {
      if (error instanceof AuthenticationError) {
        clearSessionCookie(reply, dependencies.isProduction);
        return;
      }
      throw error;
    }
  });
}

/**
 * Reusable boundary for protected routes. Anonymous requests receive a
 * generic 401 without revealing security-state details. Returns the reply
 * to halt the request when authentication fails.
 */
export async function requirePrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  if (request.principal === undefined || request.authSession === undefined) {
    return sendProblem(reply, new AuthenticationError('unauthenticated'), request);
  }
  return undefined;
}

/**
 * Stateful synchronizer-token CSRF plus same-origin enforcement for unsafe
 * cookie-authenticated requests. An authenticated mutation requires a valid
 * session, the session's CSRF token, and a provable same-origin request.
 * Returns the reply to halt the request when validation fails.
 */
export async function requireCsrf(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: AuthDependencies,
): Promise<FastifyReply | undefined> {
  const session = request.authSession;
  if (session === undefined) {
    return sendProblem(reply, new AuthenticationError('unauthenticated'), request);
  }
  const header = request.headers['x-csrf-token'];
  if (typeof header !== 'string' || header.length === 0 || header.length > 256) {
    return sendProblem(reply, new AuthenticationError('invalid_csrf_token'), request);
  }
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(header);
  } catch {
    return sendProblem(reply, new AuthenticationError('invalid_csrf_token'), request);
  }
  if (!dependencies.digester.matches(raw, session.csrfTokenDigest)) {
    return sendProblem(reply, new AuthenticationError('invalid_csrf_token'), request);
  }
  const expected = dependencies.origin;
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    if (origin !== expected) {
      return sendProblem(reply, new AuthenticationError('invalid_request_origin'), request);
    }
    return undefined;
  }
  const referer = request.headers.referer;
  if (typeof referer === 'string' && referer.length > 0) {
    try {
      if (new URL(referer).origin === expected) {
        return undefined;
      }
    } catch {
      // Fall through to rejection below.
    }
  }
  return sendProblem(reply, new AuthenticationError('invalid_request_origin'), request);
}

async function sendProblem(
  reply: FastifyReply,
  error: AuthenticationError,
  request: FastifyRequest,
): Promise<FastifyReply> {
  await reply
    .status(statusFor(error.code))
    .type('application/problem+json')
    .send(problemFor(error, request));
  return reply;
}
