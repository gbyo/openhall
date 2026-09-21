export interface RecoveryBannerProps {
  compact?: boolean;
}

export function RecoveryBanner({ compact = false }: RecoveryBannerProps) {
  return (
    <aside
      className={`wf-recovery-banner${compact ? ' wf-recovery-banner--compact' : ''}`}
      role="alert"
    >
      <span className="wf-recovery-banner__marker" aria-hidden="true">
        !
      </span>
      <div>
        <p className="wf-type-body-strong">Recovery access</p>
        <p>You're using temporary break-glass access. Some actions are unavailable.</p>
      </div>
    </aside>
  );
}
