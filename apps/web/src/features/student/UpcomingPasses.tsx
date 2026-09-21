import { useEffect, useState } from 'react';
import { ItemGroup } from '@/components/ui/item';
import type { ScheduledAuthorization } from './scheduled-presentation.js';
import {
  msUntilScheduledBoundary,
  presentScheduledAuthorization,
} from './scheduled-presentation.js';
import { ScheduledPassItem } from './ScheduledPassItem.js';

function useScheduledTick(authorizations: ScheduledAuthorization[]): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const delay = msUntilScheduledBoundary(authorizations, Date.now());
    if (delay === null) return;
    // Wake just after the next boundary so ready/future presentation flips
    // without reload and without polling the API every second.
    const timeout = window.setTimeout(
      () => {
        setNowMs(Date.now());
      },
      Math.min(delay + 250, 3_600_000),
    );
    return () => {
      window.clearTimeout(timeout);
    };
  }, [authorizations]);
  return nowMs;
}

interface ScheduledSectionsProps {
  authorizations: ScheduledAuthorization[];
  timeZone: string;
  startingId: string | null;
  startPending: boolean;
  onStart: (authorization: ScheduledAuthorization) => void;
}

export function ReadyNowPasses({
  authorizations,
  timeZone,
  startingId,
  startPending,
  onStart,
}: ScheduledSectionsProps) {
  const nowMs = useScheduledTick(authorizations);
  const ready = authorizations.filter(
    (item) => presentScheduledAuthorization(item, nowMs).state === 'ready',
  );
  if (ready.length === 0) return null;
  return (
    <section aria-labelledby="ready-now-title" className="flex flex-col gap-3">
      <h2 id="ready-now-title" className="text-base font-semibold tracking-tight">
        Ready now
      </h2>
      <ItemGroup aria-label="Ready scheduled passes">
        {ready.map((item) => (
          <ScheduledPassItem
            key={item.id}
            authorization={item}
            timeZone={timeZone}
            ready
            starting={startingId === item.id}
            startDisabled={startPending}
            onStart={() => {
              onStart(item);
            }}
          />
        ))}
      </ItemGroup>
    </section>
  );
}

export function UpcomingPasses({
  authorizations,
  timeZone,
}: Pick<ScheduledSectionsProps, 'authorizations' | 'timeZone'>) {
  const nowMs = useScheduledTick(authorizations);
  const future = authorizations.filter(
    (item) => presentScheduledAuthorization(item, nowMs).state === 'future',
  );
  if (future.length === 0) return null;
  return (
    <section aria-labelledby="upcoming-title" className="flex flex-col gap-3">
      <h2 id="upcoming-title" className="text-base font-semibold tracking-tight">
        Upcoming
      </h2>
      <ItemGroup aria-label="Upcoming scheduled passes">
        {future.map((item) => (
          <ScheduledPassItem
            key={item.id}
            authorization={item}
            timeZone={timeZone}
            ready={false}
            starting={false}
            startDisabled
            onStart={() => undefined}
          />
        ))}
      </ItemGroup>
    </section>
  );
}
