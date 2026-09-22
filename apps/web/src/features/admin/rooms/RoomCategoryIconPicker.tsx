import { useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from '@/components/ui/combobox';
import {
  CATEGORY_ICON_REGISTRY,
  categoryIconGroups,
  searchCategoryIcons,
  type CategoryIconDefinition,
} from '../../../lib/room-category-presentation.js';

const ICON_BY_KEY: ReadonlyMap<string, CategoryIconDefinition> = new Map(
  CATEGORY_ICON_REGISTRY.map((entry) => [entry.key, entry]),
);

/**
 * Searchable room-category icon picker over the centralized registry.
 * Search is local and instant across icon labels, keys, and aliases (so
 * "bathroom" finds Restroom), and results keep their registry groups. No
 * wildcard imports, no runtime fetch, no arbitrary SVG — the persisted
 * value is always a safe registry key.
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
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => searchCategoryIcons(query), [query]);
  const grouped = useMemo(() => categoryIconGroups(filtered), [filtered]);
  const selected = ICON_BY_KEY.get(value) ?? null;
  return (
    <Combobox
      items={filtered}
      value={selected}
      onValueChange={(option: CategoryIconDefinition | null) => {
        if (option) onChange(option.key);
      }}
      onInputValueChange={setQuery}
      // Filtering already happened in `searchCategoryIcons` over aliases.
      filter={() => true}
    >
      <ComboboxInput id={id} placeholder="Search icons" />
      <ComboboxContent>
        <ComboboxList>
          {grouped.map((entry) => (
            <ComboboxGroup key={entry.group} aria-label={entry.group}>
              <ComboboxLabel>{entry.group}</ComboboxLabel>
              {entry.icons.map((icon) => (
                <ComboboxItem key={icon.key} value={icon}>
                  <HugeiconsIcon
                    icon={icon.icon}
                    strokeWidth={2}
                    aria-hidden="true"
                    className="size-4"
                  />
                  {icon.label}
                </ComboboxItem>
              ))}
            </ComboboxGroup>
          ))}
        </ComboboxList>
        <ComboboxEmpty>No matching icon.</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  );
}
