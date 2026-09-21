export interface ProblemDetails {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly title?: string;
}

export class ApiProblem extends Error implements ProblemDetails {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string,
    title?: string,
  ) {
    super(title ?? 'WayPass could not complete that request.');
    this.name = 'ApiProblem';
  }
}

export class UncertainCommandError extends Error {
  constructor(override readonly cause: unknown) {
    super("We couldn't confirm that yet.");
    this.name = 'UncertainCommandError';
  }
}

export function toProblem(status: number, value: unknown): ApiProblem {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return new ApiProblem(
      status,
      typeof record.code === 'string' ? record.code : 'request_failed',
      typeof record.requestId === 'string' ? record.requestId : 'unavailable',
      typeof record.title === 'string' ? record.title : undefined,
    );
  }
  return new ApiProblem(status, 'request_failed', 'unavailable');
}

export function productMessage(error: unknown): string {
  if (!(error instanceof ApiProblem)) {
    return error instanceof UncertainCommandError
      ? "We couldn't confirm that yet. Check your connection and try again."
      : 'WayPass could not connect. Try again.';
  }
  switch (error.code) {
    case 'destination_capacity_full':
    case 'destination_unavailable':
      return "That destination isn't available right now.";
    case 'approval_denied':
      return "This request wasn't approved.";
    case 'ready_offer_expired':
      return 'This pass expired before it was started.';
    case 'stale_pass_revision':
    case 'stale_resource_revision':
      return 'This changed somewhere else. The latest information is loading.';
    case 'session_expired':
    case 'unauthenticated':
      return 'Your session ended. Sign in again to continue.';
    default:
      return 'WayPass could not confirm the request.';
  }
}
