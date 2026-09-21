import { InformationCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/** Absolute deadline label, e.g. "September 22 at 9:42 AM". No ticking countdown. */
export function formatSetupDeadline(absoluteExpiresAt: string): string | undefined {
  const time = Date.parse(absoluteExpiresAt);
  if (Number.isNaN(time)) return undefined;
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(time));
  } catch {
    return undefined;
  }
}

export interface SetupAccessBannerProps {
  /** Absolute session deadline for display, e.g. "September 22 at 9:42 AM". */
  deadlineLabel?: string | undefined;
  compact?: boolean;
}

export function SetupAccessBanner({ deadlineLabel, compact = false }: SetupAccessBannerProps) {
  return (
    <Alert className={compact ? 'py-2.5' : undefined}>
      <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} aria-hidden="true" />
      <AlertTitle>Finish setting up school sign-in</AlertTitle>
      <AlertDescription>
        You&apos;re using temporary setup access on this browser. Connect your school&apos;s sign-in
        so you can get back into WayPass normally.
        {deadlineLabel ? ` Temporary access ends ${deadlineLabel}.` : ''}
      </AlertDescription>
      <div className="col-start-2 mt-2">
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link to="/connect-sign-in" />}
        >
          Connect sign-in
        </Button>
      </div>
    </Alert>
  );
}
