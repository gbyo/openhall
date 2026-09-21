export interface StatusAnnouncerProps {
  message: string;
  priority?: 'polite' | 'assertive';
}

export function StatusAnnouncer({ message, priority = 'polite' }: StatusAnnouncerProps) {
  return (
    <div className="wf-visually-hidden" aria-live={priority} aria-atomic="true">
      {message}
    </div>
  );
}
