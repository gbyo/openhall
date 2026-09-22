import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ConnectionStatus } from '../../design-system/patterns/ConnectionStatus';
import { queryKeys } from '../../api/query-keys';
import type { OrganizationContext } from '../../api/types';

function contextRevisionOf(context: OrganizationContext | undefined): string | null {
  if (!context) return null;
  return [
    [...context.affiliations].sort().join(','),
    [...context.capabilities].sort().join(','),
    context.teachingSections
      .map((section) => section.id)
      .sort()
      .join(','),
    context.staffedRooms
      .map((room) => room.id)
      .sort()
      .join(','),
  ].join('|');
}

type Status = 'connecting' | 'live' | 'reconnecting' | 'stale' | 'unreachable';

function invalidateTopic(
  topic: string,
  organizationId: string,
  queryClient: ReturnType<typeof useQueryClient>,
) {
  if (topic === 'self-pass')
    void queryClient.invalidateQueries({ queryKey: queryKeys.activeSelfPass });
  else if (topic === 'self-scheduled')
    void queryClient.invalidateQueries({ queryKey: queryKeys.selfScheduled });
  else if (topic === 'rooms') {
    void queryClient.invalidateQueries({ queryKey: queryKeys.rooms(organizationId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.roomCategories(organizationId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.studentRoomCatalog(organizationId) });
  } else if (topic === 'organization-context')
    void queryClient.invalidateQueries({ queryKey: queryKeys.organizationContext(organizationId) });
  else if (topic === 'requests') {
    void queryClient.invalidateQueries({ queryKey: queryKeys.pendingApprovals });
    void queryClient.invalidateQueries({ queryKey: queryKeys.pendingOverrides });
  } else if (topic === 'school-live')
    void queryClient.invalidateQueries({ queryKey: queryKeys.schoolLive(organizationId) });
  else if (topic.startsWith('section-live:'))
    void queryClient.invalidateQueries({ queryKey: queryKeys.sectionLive(topic.slice(13)) });
  else if (topic.startsWith('station:'))
    void queryClient.invalidateQueries({ queryKey: queryKeys.station(topic.slice(8)) });
  else if (topic === 'schedule') {
    void queryClient.invalidateQueries({ queryKey: ['schedule-blocks', organizationId] });
    void queryClient.invalidateQueries({ queryKey: ['schedule-templates', organizationId] });
    void queryClient.invalidateQueries({ queryKey: ['schedule-calendar', organizationId] });
  } else if (topic === 'policies')
    void queryClient.invalidateQueries({ queryKey: queryKeys.policies(organizationId) });
  else if (topic === 'staff-access')
    void queryClient.invalidateQueries({ queryKey: queryKeys.grants(organizationId) });
  else if (topic === 'scheduled-passes')
    void queryClient.invalidateQueries({ queryKey: queryKeys.scheduledAdmin(organizationId) });
  else if (topic === 'people')
    void queryClient.invalidateQueries({ queryKey: ['people', organizationId] });
  else if (topic === 'enrollment')
    void queryClient.invalidateQueries({ queryKey: ['enrollment', organizationId] });
  else if (topic === 'audit')
    void queryClient.invalidateQueries({ queryKey: queryKeys.audit(organizationId) });
}

export function RealtimeProvider({
  organizationId,
  children,
}: {
  organizationId: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('connecting');
  const [lastConfirmedAt, setLastConfirmedAt] = useState<Date | null>(null);
  // Track the organization context without mounting a query observer: the
  // loader already caches it, and reading it from the cache avoids disturbing
  // in-flight route transitions. When the cached affiliations, capabilities,
  // teaching sections, or staffed rooms change, the revision below
  // changes and the EventSource subscription below reconnects so the hub
  // authorizes with the current context.
  const [contextRevision, setContextRevision] = useState<string | null>(() =>
    contextRevisionOf(
      queryClient.getQueryData<OrganizationContext>(queryKeys.organizationContext(organizationId)),
    ),
  );
  // Query-cache notifications can fire while another component is rendering
  // (e.g. a route loader populating the cache during mount). Defer the state
  // updates past the current render so this provider never sets state during
  // another component's render pass.
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.query.state.status === 'success' && event.query.state.dataUpdatedAt > 0) {
          const at = new Date(event.query.state.dataUpdatedAt);
          queueMicrotask(() => {
            setLastConfirmedAt((prev) => (prev?.getTime() === at.getTime() ? prev : at));
          });
        }
      }),
    [queryClient],
  );
  useEffect(() => {
    const readRevision = () =>
      contextRevisionOf(
        queryClient.getQueryData<OrganizationContext>(
          queryKeys.organizationContext(organizationId),
        ),
      );
    const scheduleSyncRevision = () => {
      const next = readRevision();
      queueMicrotask(() => {
        setContextRevision((prev) => (prev === next ? prev : next));
      });
    };
    scheduleSyncRevision();
    return queryClient.getQueryCache().subscribe(scheduleSyncRevision);
  }, [organizationId, queryClient]);
  useEffect(() => {
    const source = new EventSource(`/api/v1/organizations/${organizationId}/events`);
    let staleTimer: number | null = null;
    const clearStaleTimer = () => {
      if (staleTimer !== null) window.clearTimeout(staleTimer);
      staleTimer = null;
    };
    source.onopen = () => {
      clearStaleTimer();
      setStatus('live');
    };
    source.onerror = () => {
      setStatus('reconnecting');
      staleTimer ??= window.setTimeout(() => {
        setStatus('stale');
      }, 10_000);
    };
    source.addEventListener('resync', () => {
      clearStaleTimer();
      setStatus('live');
      // Recover everything mounted, not just organization-scoped keys:
      // staff views (requests, rosters, stations) and student scheduling
      // keys carry no organization id and would otherwise stay stale after
      // a dropped connection. Inactive queries only revalidate on remount.
      void queryClient.invalidateQueries();
    });
    source.addEventListener('realtime-unavailable', () => {
      setStatus('unreachable');
    });
    source.addEventListener('invalidate', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as { topics?: string[] };
        for (const topic of data.topics ?? []) invalidateTopic(topic, organizationId, queryClient);
      } catch {
        setStatus('reconnecting');
      }
    });
    return () => {
      clearStaleTimer();
      source.close();
    };
  }, [organizationId, queryClient, contextRevision]);
  const lastConfirmed = lastConfirmedAt?.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <>
      {status !== 'live' && (
        <ConnectionStatus
          state={
            status === 'connecting' || status === 'reconnecting'
              ? 'reconnecting'
              : status === 'unreachable'
                ? 'unreachable'
                : 'stale'
          }
          {...(lastConfirmed ? { lastConfirmed } : {})}
        />
      )}
      {children}
    </>
  );
}
