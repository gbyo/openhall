import { Link } from 'react-router';

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
    <aside
      className={`wf-setup-access-banner${compact ? ' wf-setup-access-banner--compact' : ''}`}
      aria-label="Temporary setup access"
    >
      <span className="wf-setup-access-banner__marker" aria-hidden="true">
        <i />
        <i />
      </span>
      <div>
        <p className="wf-type-body-strong">Finish setting up school sign-in</p>
        <p>
          You&apos;re using temporary setup access on this browser. Connect your school&apos;s
          sign-in so you can get back into WayPass normally.
          {deadlineLabel ? ` Temporary access ends ${deadlineLabel}.` : ''}
        </p>
        <p className="wf-setup-access-banner__action">
          <Link className="wf-button wf-button--secondary wf-button--compact" to="/connect-sign-in">
            Connect sign-in
          </Link>
        </p>
      </div>
    </aside>
  );
}
