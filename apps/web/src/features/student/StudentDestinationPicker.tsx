import { HugeiconsIcon } from '@hugeicons/react';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import type { CategoryIcon } from '../../lib/destination-category-presentation.js';
import type { StudentCatalogDestination, StudentCategory } from './student-intents.js';

interface StudentDestinationPickerProps {
  /** Secondary categories for the generated More list. */
  categories?: readonly StudentCategory[] | undefined;
  /** Single category whose destinations need a specific choice. */
  category?: StudentCategory | undefined;
  onPickCategory: (category: StudentCategory) => void;
  onPickDestination: (destination: StudentCatalogDestination) => void;
}

function DestinationItem({
  destination,
  icon,
  showLocation,
  onPick,
}: {
  destination: StudentCatalogDestination;
  icon: CategoryIcon;
  showLocation: boolean;
  onPick: () => void;
}) {
  return (
    <Item
      key={destination.id}
      variant="outline"
      render={<button type="button" onClick={onPick} aria-label={destination.displayName} />}
    >
      <ItemMedia variant="icon">
        <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{destination.displayName}</ItemTitle>
        {showLocation && destination.location.name ? (
          <ItemDescription>{destination.location.name}</ItemDescription>
        ) : null}
      </ItemContent>
    </Item>
  );
}

export function StudentDestinationPicker({
  categories,
  category,
  onPickCategory,
  onPickDestination,
}: StudentDestinationPickerProps) {
  if (categories) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">More places</p>
        <ItemGroup aria-label="More places">
          {categories.map((entry) => (
            <Item
              key={entry.id}
              variant="outline"
              render={
                <button
                  type="button"
                  onClick={() => {
                    onPickCategory(entry);
                  }}
                  aria-label={entry.name}
                />
              }
            >
              <ItemMedia variant="icon">
                <HugeiconsIcon icon={entry.icon} strokeWidth={2} aria-hidden="true" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{entry.name}</ItemTitle>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </div>
    );
  }
  if (!category) return null;
  // Show the physical location only when it adds useful distinction between
  // same-category destinations (e.g. three restrooms in different wings).
  const locations = new Set(category.destinations.map((entry) => entry.location.name));
  const showLocation = locations.size > 1;
  const icon = category.icon;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">{`Choose a ${category.name.toLowerCase()}`}</p>
      <ItemGroup aria-label="Specific destinations">
        {category.destinations.map((destination) => (
          <DestinationItem
            key={destination.id}
            destination={destination}
            icon={icon}
            showLocation={showLocation}
            onPick={() => {
              onPickDestination(destination);
            }}
          />
        ))}
      </ItemGroup>
    </div>
  );
}
