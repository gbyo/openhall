import createClient from 'openapi-fetch';
import type { paths } from './generated/openapi';
import { ApiProblem, toProblem, UncertainCommandError } from './problems';
import { signalSessionExpired } from './session';

export const api = createClient<paths>({
  baseUrl: window.location.origin,
  credentials: 'same-origin',
});

export interface ApiResult<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response: Response;
}

export function requireData<T>(result: ApiResult<T>): T {
  if (result.data !== undefined && result.response.ok) return result.data;
  const problem = toProblem(result.response.status, result.error);
  if (problem.status === 401) signalSessionExpired();
  throw problem;
}

export async function confirmed<T>(request: Promise<ApiResult<T>>): Promise<T> {
  try {
    return requireData(await request);
  } catch (error) {
    if (error instanceof ApiProblem) throw error;
    throw new UncertainCommandError(error);
  }
}

/** Preserve response headers while applying the same Problem Details and lost-response semantics. */
export async function confirmedResult<T>(request: Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    const result = await request;
    requireData(result);
    return result;
  } catch (error) {
    if (error instanceof ApiProblem) throw error;
    throw new UncertainCommandError(error);
  }
}
