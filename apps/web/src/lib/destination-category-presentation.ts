import type { ComponentProps } from 'react';
import type { HugeiconsIcon } from '@hugeicons/react';
import {
  Briefcase01Icon,
  BubbleChatIcon,
  DropletIcon,
  Dumbbell01Icon,
  GridIcon,
  LaptopIcon,
  LibraryIcon,
  MusicNote01Icon,
  OfficeIcon,
  RestaurantIcon,
  SchoolIcon,
  StethoscopeIcon,
  Toilet02Icon,
  UserIcon,
} from '@hugeicons/core-free-icons';
import { cva } from 'class-variance-authority';

/**
 * Single centralized destination-category presentation registry.
 *
 * The server persists only safe product keys (`iconKey`, `toneKey`); this
 * module is the one place that maps those keys to Hugeicons and
 * Maia-compatible classes. Admin and student code must both use it — never
 * a second copy of the map. Unknown keys fall back to the generic
 * presentation so a future server key never breaks the launcher.
 */
export type CategoryIcon = ComponentProps<typeof HugeiconsIcon>['icon'];

export const CATEGORY_ICONS = {
  restroom: Toilet02Icon,
  medical: StethoscopeIcon,
  chat: BubbleChatIcon,
  book: LibraryIcon,
  building: OfficeIcon,
  person: UserIcon,
  sports: Dumbbell01Icon,
  technology: LaptopIcon,
  water: DropletIcon,
  food: RestaurantIcon,
  music: MusicNote01Icon,
  school: SchoolIcon,
  briefcase: Briefcase01Icon,
  generic: GridIcon,
} as const satisfies Record<string, CategoryIcon>;

export type CategoryIconKey = keyof typeof CATEGORY_ICONS;

export function iconForCategoryKey(iconKey: string): CategoryIcon {
  return (CATEGORY_ICONS as Record<string, CategoryIcon>)[iconKey] ?? GridIcon;
}

export const CATEGORY_TONES = [
  'aqua',
  'rose',
  'violet',
  'amber',
  'blue',
  'green',
  'slate',
  'neutral',
] as const;

export type CategoryToneKey = (typeof CATEGORY_TONES)[number];

export function isCategoryToneKey(value: string): value is CategoryToneKey {
  return (CATEGORY_TONES as readonly string[]).includes(value);
}

// Centralized tile tones. Low saturation, generous radius, clear interactive
// states. Icon + text stay authoritative; color is supplemental only and the
// border keeps tiles distinct under forced-colors.
export const tileTone = cva(
  'h-auto min-h-28 flex-col gap-2 rounded-3xl border-2 p-4 text-base font-semibold wrap-break-word whitespace-normal forced-colors:border-[ButtonText]',
  {
    variants: {
      tone: {
        aqua: 'border-cyan-700/20 bg-cyan-100 text-cyan-950 hover:bg-cyan-200/70 dark:border-cyan-300/20 dark:bg-cyan-950 dark:text-cyan-50 dark:hover:bg-cyan-900',
        rose: 'border-rose-700/20 bg-rose-100 text-rose-950 hover:bg-rose-200/70 dark:border-rose-300/20 dark:bg-rose-950 dark:text-rose-50 dark:hover:bg-rose-900',
        violet:
          'border-violet-700/20 bg-violet-100 text-violet-950 hover:bg-violet-200/70 dark:border-violet-300/20 dark:bg-violet-950 dark:text-violet-50 dark:hover:bg-violet-900',
        amber:
          'border-amber-700/20 bg-amber-100 text-amber-950 hover:bg-amber-200/70 dark:border-amber-300/20 dark:bg-amber-950 dark:text-amber-50 dark:hover:bg-amber-900',
        blue: 'border-blue-700/20 bg-blue-100 text-blue-950 hover:bg-blue-200/70 dark:border-blue-300/20 dark:bg-blue-950 dark:text-blue-50 dark:hover:bg-blue-900',
        green:
          'border-green-700/20 bg-green-100 text-green-950 hover:bg-green-200/70 dark:border-green-300/20 dark:bg-green-950 dark:text-green-50 dark:hover:bg-green-900',
        slate:
          'border-slate-700/20 bg-slate-200 text-slate-900 hover:bg-slate-300/70 dark:border-slate-300/20 dark:bg-slate-800 dark:text-slate-50 dark:hover:bg-slate-700',
        neutral: 'border-border bg-muted text-foreground hover:bg-muted/60 dark:hover:bg-muted/40',
      },
    },
  },
);

export function toneForCategoryKey(toneKey: string): CategoryToneKey {
  return isCategoryToneKey(toneKey) ? toneKey : 'neutral';
}

/** Human-facing student-surface labels. The DB persists `secondary`; the UI says "More". */
export function surfaceLabel(surface: string): string {
  switch (surface) {
    case 'primary':
      return 'Primary';
    case 'hidden':
      return 'Hidden';
    default:
      return 'More';
  }
}

export const CATEGORY_ICON_OPTIONS: { value: string; label: string }[] = [
  { value: 'restroom', label: 'Restroom' },
  { value: 'medical', label: 'Medical' },
  { value: 'chat', label: 'Conversation' },
  { value: 'book', label: 'Book' },
  { value: 'building', label: 'Building' },
  { value: 'person', label: 'Person' },
  { value: 'sports', label: 'Sports' },
  { value: 'technology', label: 'Technology' },
  { value: 'water', label: 'Water' },
  { value: 'food', label: 'Food' },
  { value: 'music', label: 'Music' },
  { value: 'school', label: 'School' },
  { value: 'briefcase', label: 'Briefcase' },
  { value: 'generic', label: 'More (grid)' },
];

export const CATEGORY_TONE_OPTIONS: { value: CategoryToneKey; label: string }[] = [
  { value: 'aqua', label: 'Aqua' },
  { value: 'rose', label: 'Rose' },
  { value: 'violet', label: 'Violet' },
  { value: 'amber', label: 'Amber' },
  { value: 'blue', label: 'Blue' },
  { value: 'green', label: 'Green' },
  { value: 'slate', label: 'Slate' },
  { value: 'neutral', label: 'Neutral' },
];
