import { GridIcon } from '@hugeicons/core-free-icons';
import { StudentRoomTile } from './StudentRoomTile.js';
import type { StudentCategory } from './student-room-intents.js';

interface StudentRoomGridProps {
  primary: StudentCategory[];
  hasSecondary: boolean;
  disabled?: boolean;
  onSelectCategory: (category: StudentCategory) => void;
  onSelectMore: () => void;
}

export function StudentRoomGrid({
  primary,
  hasSecondary,
  disabled,
  onSelectCategory,
  onSelectMore,
}: StudentRoomGridProps) {
  return (
    <div
      role="list"
      aria-label="Where do you need to go?"
      className="grid grid-cols-2 gap-3 lg:grid-cols-4"
    >
      {primary.map((category) => (
        <div role="listitem" key={category.id} className="min-w-0">
          <StudentRoomTile
            label={category.name}
            icon={category.icon}
            tone={category.tone}
            disabled={disabled}
            onSelect={() => {
              onSelectCategory(category);
            }}
          />
        </div>
      ))}
      {hasSecondary ? (
        <div role="listitem" key="more" className="min-w-0">
          <StudentRoomTile
            label="More"
            icon={GridIcon}
            tone="neutral"
            disabled={disabled}
            onSelect={onSelectMore}
          />
        </div>
      ) : null}
    </div>
  );
}
