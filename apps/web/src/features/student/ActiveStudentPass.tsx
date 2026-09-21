import { useEffect, useState, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import type { Pass } from '../../api/types';
import { QueuePosition } from '../../design-system/patterns/QueuePosition';
import { Route, RouteStop } from '../../design-system/patterns/Route';
import type { StudentPassPresentation } from './presentation';
import { iconForCategoryKey } from '../../lib/destination-category-presentation.js';
import { formatSchoolTime } from './student-time.js';

export interface PassAction {
  label: string;
  pendingLabel: string;
  pending: boolean;
  onRun: () => void;
}

function stateBadge(presentation: StudentPassPresentation): string {
  switch (presentation.kind) {
    case 'waiting-approval':
      return 'Waiting';
    case 'staff-review-available':
      return 'Needs review';
    case 'staff-review-pending':
      return 'In review';
    case 'queued':
      return 'In line';
    case 'ready':
      return 'Ready';
    case 'outbound-lightweight':
    case 'outbound-optional':
    case 'outbound-station-required':
      return 'Active';
    case 'at-destination':
      return 'Arrived';
    case 'returning':
      return 'Returning';
    case 'terminal':
      return 'Done';
  }
}

function formatCountdown(totalSeconds: number): string {
  const absolute = Math.abs(totalSeconds);
  const minutes = Math.floor(absolute / 60);
  const seconds = absolute % 60;
  const text = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return totalSeconds < 0 ? `+${text}` : text;
}

/** Prominent countdown from the authoritative expectedReturnAt. Display only. */
function PassTimer({ expectedReturnAt }: { expectedReturnAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, []);
  const targetMs = Date.parse(expectedReturnAt);
  if (!Number.isFinite(targetMs)) return null;
  const remainingSeconds = Math.round((targetMs - nowMs) / 1000);
  const overdue = remainingSeconds < 0;
  return (
    <div
      className="flex flex-col items-center gap-0.5 py-2"
      aria-label={overdue ? 'Time past expected return' : 'Time remaining'}
    >
      <p className="text-4xl font-semibold tracking-tight tabular-nums">
        {formatCountdown(remainingSeconds)}
      </p>
      <p className="text-sm text-muted-foreground">
        {overdue ? 'past expected return' : 'remaining'}
      </p>
    </div>
  );
}

function stateCopy(presentation: StudentPassPresentation, pass: Pass): ReactNode {
  switch (presentation.kind) {
    case 'waiting-approval':
      return (
        <p className="text-sm text-muted-foreground">
          Your teacher has your request. No action needed right now.
        </p>
      );
    case 'staff-review-available':
      return (
        <p className="text-sm text-muted-foreground">
          This pass needs staff review before it can continue.
        </p>
      );
    case 'staff-review-pending':
      return (
        <p className="text-sm text-muted-foreground">
          Staff are reviewing your request. No action needed right now.
        </p>
      );
    case 'queued':
      return <p className="text-sm text-muted-foreground">You&apos;re in line.</p>;
    case 'ready':
      return null;
    case 'outbound-lightweight':
      return (
        <p className="text-sm text-muted-foreground">Head to {pass.destination.displayName}.</p>
      );
    case 'outbound-optional':
      return (
        <p className="text-sm text-muted-foreground">
          On your way to {pass.destination.displayName}.
        </p>
      );
    case 'outbound-station-required':
      return (
        <p className="text-sm text-muted-foreground">
          Check in when you arrive. Station staff will record it.
        </p>
      );
    case 'at-destination':
      return (
        <p className="text-sm text-muted-foreground">
          Check in with staff at {pass.destination.displayName}.
        </p>
      );
    case 'returning':
      return (
        <p className="text-sm text-muted-foreground">
          Head back to {pass.origin.location?.name ?? 'class'}.
        </p>
      );
    case 'terminal':
      return null;
  }
}

interface ActiveStudentPassProps {
  pass: Pass;
  presentation: StudentPassPresentation;
  queueAhead: number | null;
  timeZone: string;
  primary: PassAction | null;
  secondary: PassAction | null;
}

export function ActiveStudentPass({
  pass,
  presentation,
  queueAhead,
  timeZone,
  primary,
  secondary,
}: ActiveStudentPassProps) {
  const category = pass.destination.category;
  const icon = iconForCategoryKey(category?.iconKey ?? 'generic');
  const intentLabel = category?.name ?? pass.destination.displayName;
  return (
    <div className="mx-auto w-full max-w-xl">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" className="size-6" />
            <p className="text-sm font-medium text-muted-foreground">{intentLabel}</p>
            <Badge variant="secondary">{stateBadge(presentation)}</Badge>
          </div>
          <h1 id="pass-title" className="font-heading text-xl font-semibold text-balance">
            {presentation.title}
          </h1>
          <p className="text-base font-medium">{pass.destination.displayName}</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {pass.movement.expectedReturnAt &&
          (presentation.kind === 'outbound-lightweight' ||
            presentation.kind === 'outbound-optional' ||
            presentation.kind === 'outbound-station-required' ||
            presentation.kind === 'at-destination' ||
            presentation.kind === 'returning') ? (
            <PassTimer expectedReturnAt={pass.movement.expectedReturnAt} />
          ) : null}
          {presentation.kind === 'queued' && queueAhead !== null && (
            <QueuePosition ahead={queueAhead} />
          )}
          {presentation.kind === 'ready' && pass.movement.readyUntil && (
            <p className="text-sm">
              Start by <strong>{formatSchoolTime(pass.movement.readyUntil, timeZone)}</strong>
            </p>
          )}
          {stateCopy(presentation, pass)}
          {(presentation.kind === 'at-destination' || presentation.kind === 'returning') && (
            <Route>
              <RouteStop label={pass.destination.displayName} evidence="recorded" />
              <RouteStop
                label={pass.origin.location?.name ?? 'Return location'}
                evidence="intended"
                last
              />
            </Route>
          )}
        </CardContent>
        {primary || secondary ? (
          <>
            <Separator />
            <CardFooter className="flex flex-wrap gap-2">
              {primary && (
                <Button
                  disabled={primary.pending}
                  aria-busy={primary.pending}
                  onClick={primary.onRun}
                >
                  {primary.pending ? <Spinner data-icon="inline-start" /> : null}
                  {primary.pending ? primary.pendingLabel : primary.label}
                </Button>
              )}
              {secondary && (
                <Button variant="outline" disabled={secondary.pending} onClick={secondary.onRun}>
                  {secondary.label}
                </Button>
              )}
            </CardFooter>
          </>
        ) : null}
      </Card>
    </div>
  );
}
