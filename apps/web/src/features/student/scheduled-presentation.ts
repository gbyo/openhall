import type { ScheduledStudentList } from '../../api/types.js';

export type ScheduledAuthorization = ScheduledStudentList['authorizations'][number];

export type ScheduledStudentState = 'future' | 'ready' | 'expired' | 'inactive';

export interface ScheduledStudentPresentation {
  state: ScheduledStudentState;
  /** True only inside the valid window; the backend stays authoritative on races. */
  startable: boolean;
}

export function presentScheduledAuthorization(
  authorization: ScheduledAuthorization,
  nowMs: number = Date.now(),
): ScheduledStudentPresentation {
  if (authorization.status !== 'active') return { state: 'inactive', startable: false };
  const fromMs = Date.parse(authorization.validFrom);
  const untilMs = Date.parse(authorization.validUntil);
  if (Number.isFinite(fromMs) && nowMs < fromMs) return { state: 'future', startable: false };
  if (Number.isFinite(untilMs) && nowMs >= untilMs) return { state: 'expired', startable: false };
  return { state: 'ready', startable: true };
}

/** Milliseconds until the next local presentation boundary, or null when none. */
export function msUntilScheduledBoundary(
  authorizations: ScheduledAuthorization[],
  nowMs: number = Date.now(),
): number | null {
  let soonest: number | null = null;
  for (const authorization of authorizations) {
    if (authorization.status !== 'active') continue;
    for (const boundary of [
      Date.parse(authorization.validFrom),
      Date.parse(authorization.validUntil),
    ]) {
      if (!Number.isFinite(boundary) || boundary <= nowMs) continue;
      const delta = boundary - nowMs;
      if (soonest === null || delta < soonest) soonest = delta;
    }
  }
  return soonest;
}
