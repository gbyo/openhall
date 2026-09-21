export interface StatusAnnouncerProps {
  message: string;
  priority?: 'polite' | 'assertive';
}

export function StatusAnnouncer({ message, priority = 'polite' }: StatusAnnouncerProps) {
  return (
    <div className="sr-only" aria-live={priority} aria-atomic="true">
      {message}
    </div>
  );
}
