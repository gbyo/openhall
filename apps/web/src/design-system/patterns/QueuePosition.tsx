export interface QueuePositionProps {
  ahead: number;
}

export function QueuePosition({ ahead }: QueuePositionProps) {
  if (ahead === 0) {
    return <p className="wf-queue-position wf-queue-position--next">You're next.</p>;
  }
  return (
    <div className="wf-queue-position">
      <strong className="wf-queue-position__number wf-tabular">{ahead}</strong>
      <span>{ahead === 1 ? 'person' : 'people'} ahead of you</span>
    </div>
  );
}
