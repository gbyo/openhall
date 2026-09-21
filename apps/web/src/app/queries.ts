import { queryOptions } from '@tanstack/react-query';
import { api, confirmed } from '../api/client';
import { queryKeys } from '../api/query-keys';
import { clearSessionMemory, setCsrfToken } from '../api/session';
import type { AuthSession } from '../api/types';

export const bootstrapQuery = queryOptions({
  queryKey: queryKeys.bootstrap,
  queryFn: () => confirmed(api.GET('/api/v1/bootstrap/status')),
  staleTime: Number.POSITIVE_INFINITY,
});

export const sessionQuery = queryOptions({
  queryKey: queryKeys.session,
  queryFn: async (): Promise<AuthSession> => {
    const session = await confirmed(api.GET('/api/v1/auth/session'));
    if (session.authenticated) setCsrfToken(session.csrfToken);
    else clearSessionMemory();
    return session;
  },
  staleTime: 15_000,
  retry: false,
});

export const meQuery = queryOptions({
  queryKey: queryKeys.me,
  queryFn: () => confirmed(api.GET('/api/v1/me')),
  staleTime: 60_000,
});

export const organizationsQuery = queryOptions({
  queryKey: queryKeys.organizations,
  queryFn: () => confirmed(api.GET('/api/v1/me/organizations')),
  staleTime: 60_000,
});

export const organizationContextQuery = (organizationId: string) =>
  queryOptions({
    queryKey: queryKeys.organizationContext(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/me/organizations/{organizationId}/context', {
          params: { path: { organizationId } },
        }),
      ),
    staleTime: 30_000,
  });
