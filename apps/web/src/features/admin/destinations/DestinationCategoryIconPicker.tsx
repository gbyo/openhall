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
  categoryIconGroups,
  searchCategoryIcons,
  type CategoryIconDefinition,
} from '../../../lib/destination-category-presentation.js';

interface DestinationCategoryIconPickerProps {
  value: string;
  onValueChange: (iconKey: string) => void;
  id?: string | undefined;
  ariaLabel?: string | undefined;
}

/**
 * Searchable destination-category icon picker built from the actual shadcn
 * Base UI Combobox primitives. Search is local and instant over icon
 * labels, keys, and aliases; only safe registry keys can be selected, and
 * the persisted value stays a plain icon key.
 */
export function DestinationCategoryIconPicker({
  value,
  onValueChange,
  id,
  ariaLabel,
}: DestinationCategoryIconPickerProps) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => searchCategoryIcons(query), [query]);
  const grouped = useMemo(() => categoryIconGroups(filtered), [filtered]);
  const selected: CategoryIconDefinition | null = CATEGORY_ICON_REGISTRY_LOOKUP.get(value) ?? null;

  return (
    <Combobox
      items={filtered}
      value={selected}
      onValueChange={(option: CategoryIconDefinition | null) => {
        if (option) onValueChange(option.key);
      }}
      onInputValueChange={setQuery}
      filter={() => true}
    >
      <ComboboxInput id={id} aria-label={ariaLabel ?? 'Icon'} placeholder="Search icons" />
      <ComboboxContent>
        <ComboboxList>
          {grouped.map((entry) => (
            <ComboboxGroup key={entry.group} aria-label={entry.group}>
              <ComboboxLabel>{entry.group}</ComboboxLabel>
              {entry.icons.map((icon) => (
                <ComboboxItem key={icon.key} value={icon}>
                  <HugeiconsIcon icon={icon.icon} strokeWidth={2} aria-hidden="true" />
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

const CATEGORY_ICON_REGISTRY_LOOKUP: ReadonlyMap<string, CategoryIconDefinition> = new Map(
  searchCategoryIcons('').map((entry) => [entry.key, entry]),
);
