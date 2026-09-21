import { Button } from '../primitives/Button';

export interface ConflictNoticeProps {
  onReview?: () => void;
}

export function ConflictNotice({ onReview }: ConflictNoticeProps) {
  return (
    <aside className="wf-conflict-notice" aria-labelledby="conflict-title">
      <span className="wf-conflict-notice__marker" aria-hidden="true">
        ↻
      </span>
      <div>
        <h3 className="wf-type-heading" id="conflict-title">
          This destination changed while you were editing.
        </h3>
        <p>Someone else saved a newer version. Your unsaved changes are still here.</p>
        <Button variant="secondary" onClick={onReview}>
          Review latest version
        </Button>
      </div>
    </aside>
  );
}
