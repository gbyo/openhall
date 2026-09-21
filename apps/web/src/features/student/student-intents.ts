import type { ComponentProps } from 'react';
import type { HugeiconsIcon } from '@hugeicons/react';
import {
  BubbleChatIcon,
  GridIcon,
  LibraryIcon,
  OfficeIcon,
  StethoscopeIcon,
  Toilet02Icon,
} from '@hugeicons/core-free-icons';
import type { DestinationCatalog } from '../../api/types.js';

export type DestinationCatalogEntry = DestinationCatalog['destinations'][number];

export type StudentIntentKey = 'restroom' | 'nurse' | 'counselor' | 'library' | 'office' | 'more';

export type StudentIntentTone = 'aqua' | 'rose' | 'violet' | 'amber' | 'slate' | 'neutral';

export interface StudentIntent {
  key: StudentIntentKey;
  label: string;
  icon: ComponentProps<typeof HugeiconsIcon>['icon'];
  tone: StudentIntentTone;
  destinations: DestinationCatalogEntry[];
}

function normalizeServiceType(value: string): string {
  return value.trim().toLowerCase();
}

// Deterministic registry from canonical destination service types to
// student-facing intents. Matches on serviceType only; display names are
// never fuzzy-matched. Unmatched destinations fall through to "more".
const SERVICE_TYPE_INTENTS: Readonly<Record<string, Exclude<StudentIntentKey, 'more'>>> = {
  restroom: 'restroom',
  nurse: 'nurse',
  health: 'nurse',
  counseling: 'counselor',
  counselor: 'counselor',
  library: 'library',
  office: 'office',
  main_office: 'office',
  front_office: 'office',
};

const INTENT_META: Readonly<
  Record<
    Exclude<StudentIntentKey, 'more'>,
    { label: string; icon: StudentIntent['icon']; tone: StudentIntentTone }
  >
> = {
  restroom: { label: 'Restroom', icon: Toilet02Icon, tone: 'aqua' },
  nurse: { label: 'Nurse', icon: StethoscopeIcon, tone: 'rose' },
  counselor: { label: 'Counselor', icon: BubbleChatIcon, tone: 'violet' },
  library: { label: 'Library', icon: LibraryIcon, tone: 'amber' },
  office: { label: 'Main office', icon: OfficeIcon, tone: 'slate' },
};

const INTENT_ORDER: Exclude<StudentIntentKey, 'more'>[] = [
  'restroom',
  'nurse',
  'counselor',
  'library',
  'office',
];

export function intentKeyForServiceType(serviceType: string): StudentIntentKey {
  return SERVICE_TYPE_INTENTS[normalizeServiceType(serviceType)] ?? 'more';
}

export function groupDestinationsIntoIntents(
  destinations: DestinationCatalogEntry[],
): StudentIntent[] {
  const grouped = new Map<Exclude<StudentIntentKey, 'more'>, DestinationCatalogEntry[]>();
  const unmatched: DestinationCatalogEntry[] = [];
  for (const destination of destinations) {
    const key = intentKeyForServiceType(destination.serviceType);
    if (key === 'more') unmatched.push(destination);
    else {
      const existing = grouped.get(key);
      if (existing) existing.push(destination);
      else grouped.set(key, [destination]);
    }
  }
  const intents: StudentIntent[] = [];
  for (const key of INTENT_ORDER) {
    const entries = grouped.get(key);
    if (entries && entries.length > 0) {
      const meta = INTENT_META[key];
      intents.push({
        key,
        label: meta.label,
        icon: meta.icon,
        tone: meta.tone,
        destinations: entries,
      });
    }
  }
  if (unmatched.length > 0) {
    intents.push({
      key: 'more',
      label: 'More',
      icon: GridIcon,
      tone: 'neutral',
      destinations: unmatched,
    });
  }
  return intents;
}
