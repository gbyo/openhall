export const SETUP_STEPS = ['School', 'Administrator', 'Sign-in', 'Review'] as const;

export interface SetupProgressProps {
  current: number;
  total: number;
}

/** WayPass setup-progress presentation: ordered list, current step exposed via
 * aria-current, distinguishable without color alone. Fed by Questionnaire's
 * progress state through its render prop; never rendered standalone. */
export function SetupProgress({ current, total }: SetupProgressProps) {
  const safe = Math.min(Math.max(current, 0), SETUP_STEPS.length - 1);
  return (
    <nav className="setup-progress" aria-label="Setup progress">
      <p className="setup-progress__status" aria-live="polite">
        Step {safe + 1} of {total} — {SETUP_STEPS[safe]}
      </p>
      <ol>
        {SETUP_STEPS.map((label, index) => {
          const state = index < safe ? 'completed' : index === safe ? 'current' : 'future';
          return (
            <li
              key={label}
              className={`setup-progress__step setup-progress__step--${state}`}
              {...(index === safe ? { 'aria-current': 'step' } : {})}
            >
              <span className="setup-progress__marker" aria-hidden="true" />
              <span className="setup-progress__label">{label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
