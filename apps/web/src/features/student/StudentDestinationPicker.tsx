import { HugeiconsIcon } from '@hugeicons/react';
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import type { DestinationCatalogEntry, StudentIntent } from './student-intents.js';

interface StudentDestinationPickerProps {
  intent: StudentIntent;
  onPick: (destination: DestinationCatalogEntry) => void;
}

export function StudentDestinationPicker({ intent, onPick }: StudentDestinationPickerProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">
        {intent.key === 'more'
          ? 'Where do you need to go?'
          : `Choose a ${intent.label.toLowerCase()}`}
      </p>
      <ItemGroup aria-label="Specific destinations">
        {intent.destinations.map((destination) => (
          <Item
            key={destination.id}
            variant="outline"
            render={
              <button
                type="button"
                onClick={() => {
                  onPick(destination);
                }}
                aria-label={destination.displayName}
              />
            }
          >
            <ItemMedia variant="icon">
              <HugeiconsIcon icon={intent.icon} strokeWidth={2} aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{destination.displayName}</ItemTitle>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </div>
  );
}
