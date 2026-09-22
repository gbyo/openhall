import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { normalizeRoomSearch } from '../../lib/room-category-presentation.js';
import type { CategoryIcon } from '../../lib/room-category-presentation.js';
import type { StudentCatalogRoom, StudentCategory } from './student-room-intents.js';
import { roomSearchHaystack, roomSecondaryText } from './student-room-intents.js';

interface StudentRoomPickerProps {
  /** Secondary categories for the generated More list. */
  categories?: readonly StudentCategory[] | undefined;
  /** Single category whose rooms need a specific choice. */
  category?: StudentCategory | undefined;
  onPickCategory: (category: StudentCategory) => void;
  onPickRoom: (room: StudentCatalogRoom) => void;
}

function RoomListItem({
  room,
  icon,
  onPick,
}: {
  room: StudentCatalogRoom;
  icon: CategoryIcon;
  onPick: () => void;
}) {
  const secondary = roomSecondaryText(room);
  return (
    <Item
      key={room.id}
      variant="outline"
      render={<button type="button" onClick={onPick} aria-label={room.name} />}
    >
      <ItemMedia variant="icon">
        <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{room.name}</ItemTitle>
        {secondary ? <ItemDescription>{secondary}</ItemDescription> : null}
      </ItemContent>
    </Item>
  );
}

/**
 * Search picker for a category (Room-visits style). Selecting an item only
 * records the choice — typed free text alone can never become a room, and
 * nothing POSTs until the confirmation step.
 */
function RoomSearchPicker({
  category,
  onPickRoom,
}: {
  category: StudentCategory;
  onPickRoom: (room: StudentCatalogRoom) => void;
}) {
  const [value, setValue] = useState<StudentCatalogRoom | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <Combobox
        items={category.rooms}
        value={value}
        onValueChange={(room: StudentCatalogRoom | null) => {
          setValue(room);
          if (room) onPickRoom(room);
        }}
        filter={(room: StudentCatalogRoom, query: string) => {
          const normalized = normalizeRoomSearch(query);
          if (normalized.length === 0) return true;
          return normalizeRoomSearch(roomSearchHaystack(room)).includes(normalized);
        }}
      >
        <ComboboxInput placeholder="Search teacher or room" aria-label="Search teacher or room" />
        <ComboboxContent>
          <ComboboxList>
            {(room: StudentCatalogRoom) => {
              const secondary = roomSecondaryText(room);
              return (
                <ComboboxItem key={room.id} value={room}>
                  <span className="flex min-w-0 flex-col text-left">
                    <span className="truncate font-medium">{room.name}</span>
                    {secondary ? (
                      <span className="truncate text-xs text-muted-foreground">{secondary}</span>
                    ) : null}
                  </span>
                </ComboboxItem>
              );
            }}
          </ComboboxList>
          <ComboboxEmpty>No matching room.</ComboboxEmpty>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}

export function StudentRoomPicker({
  categories,
  category,
  onPickCategory,
  onPickRoom,
}: StudentRoomPickerProps) {
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
  if (category.picker === 'search') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">{`Choose a ${category.name.toLowerCase()}`}</p>
        <RoomSearchPicker category={category} onPickRoom={onPickRoom} />
      </div>
    );
  }
  const icon = category.icon;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">{`Choose a ${category.name.toLowerCase()}`}</p>
      <ItemGroup aria-label="Specific rooms">
        {category.rooms.map((room) => (
          <RoomListItem
            key={room.id}
            room={room}
            icon={icon}
            onPick={() => {
              onPickRoom(room);
            }}
          />
        ))}
      </ItemGroup>
    </div>
  );
}
