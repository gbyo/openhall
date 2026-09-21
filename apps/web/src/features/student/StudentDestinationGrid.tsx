import { StudentDestinationTile } from './StudentDestinationTile.js';
import type { StudentIntent } from './student-intents.js';

interface StudentDestinationGridProps {
  intents: StudentIntent[];
  disabled?: boolean;
  onSelect: (intent: StudentIntent) => void;
}

export function StudentDestinationGrid({
  intents,
  disabled,
  onSelect,
}: StudentDestinationGridProps) {
  return (
    <div
      role="list"
      aria-label="Where do you need to go?"
      className="grid grid-cols-2 gap-3 lg:grid-cols-4"
    >
      {intents.map((intent) => (
        <div role="listitem" key={intent.key} className="min-w-0">
          <StudentDestinationTile intent={intent} disabled={disabled} onSelect={onSelect} />
        </div>
      ))}
    </div>
  );
}
