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
  CATEGORY_ICON_OPTIONS,
  iconForCategoryKey,
  normalizeRoomSearch,
} from '../../../lib/room-category-presentation.js';

export interface IconOption {
  value: string;
  label: string;
}

const ICON_ITEMS: IconOption[] = CATEGORY_ICON_OPTIONS.map((option) => ({ ...option }));

/**
 * Searchable icon picker backed by the broad local named-import registry.
 * No wildcard imports, no runtime fetch, no arbitrary SVG — the value is
 * always a persisted icon key from the centralized registry.
 */
export function RoomCategoryIconPicker({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  id: string;
}) {
  const selected = ICON_ITEMS.find((item) => item.value === value) ?? null;
  return (
    <Combobox
      items={ICON_ITEMS}
      value={selected}
      onValueChange={(option: IconOption | null) => {
        if (option) onChange(option.value);
      }}
      filter={(item: IconOption, query: string) =>
        normalizeRoomSearch(`${item.label} ${item.value}`).includes(normalizeRoomSearch(query))
      }
    >
      <ComboboxInput id={id} placeholder="Search icons" />
      <ComboboxContent>
        <ComboboxList>
          {(item: IconOption) => (
            <ComboboxItem key={item.value} value={item}>
              <HugeiconsIcon
                icon={iconForCategoryKey(item.value)}
                strokeWidth={2}
                aria-hidden="true"
                className="size-4"
              />
              {item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>No matching icon.</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  );
}
