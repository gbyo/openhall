import { Button } from '@/components/ui/button';

export interface ConflictNoticeProps {
  onReview?: () => void;
  resourceName?: string;
}

export function ConflictNotice({ onReview, resourceName = 'destination' }: ConflictNoticeProps) {
  return (
    <aside className="wf-conflict-notice" aria-labelledby="conflict-title">
      <span className="wf-conflict-notice__marker" aria-hidden="true">
        ↻
      </span>
      <div>
        <h3 className="wf-type-heading" id="conflict-title">
          This {resourceName} changed while you were editing.
        </h3>
        <p>Someone else saved a newer version. Your unsaved changes are still here.</p>
        {onReview && (
          <Button variant="secondary" onClick={onReview}>
            Review latest version
          </Button>
        )}
      </div>
    </aside>
  );
}
