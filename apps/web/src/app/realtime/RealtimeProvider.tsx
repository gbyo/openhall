import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ConnectionStatus } from '../../design-system/patterns/ConnectionStatus';
import { queryKeys } from '../../api/query-keys';

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
  else if (topic === 'destinations')
    void queryClient.invalidateQueries({ queryKey: queryKeys.destinations(organizationId) });
  else if (topic === 'organization-context')
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
  else if (topic === 'locations')
    void queryClient.invalidateQueries({ queryKey: queryKeys.locations(organizationId) });
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
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.query.state.status === 'success' && event.query.state.dataUpdatedAt > 0)
          setLastConfirmedAt(new Date(event.query.state.dataUpdatedAt));
      }),
    [queryClient],
  );
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
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey.includes(organizationId) || query.queryKey[0] === 'active-self-pass',
      });
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
  }, [organizationId, queryClient]);
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
