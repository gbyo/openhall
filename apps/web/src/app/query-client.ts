import { QueryClient } from '@tanstack/react-query';
import { ApiProblem } from '../api/problems';

function retryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (error instanceof ApiProblem) {
    if ([401, 403, 404, 409, 412, 428].includes(error.status)) return false;
    return error.status >= 500;
  }
  return true;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: retryQuery,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: { retry: false },
  },
});
