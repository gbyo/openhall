/**
 * Canonical destination-category presentation registry.
 *
 * The database stores only safe product keys (`icon_key`, `tone_key`);
 * this module owns the curated set of valid keys. Adding a new icon or
 * tone is a code/config change here — never a migration — per the
 * destination-categories architecture. The web frontend keeps the single
 * centralized key -> component/class mapping; this module is the
 * server-side validation half and must stay in sync with it.
 */
export const DESTINATION_CATEGORY_ICON_KEYS = [
  'restroom',
  'medical',
  'chat',
  'book',
  'building',
  'person',
  'sports',
  'technology',
  'water',
  'food',
  'music',
  'school',
  'briefcase',
  'generic',
] as const;

export type DestinationCategoryIconKey = (typeof DESTINATION_CATEGORY_ICON_KEYS)[number];

export const DESTINATION_CATEGORY_TONE_KEYS = [
  'aqua',
  'rose',
  'violet',
  'amber',
  'blue',
  'green',
  'slate',
  'neutral',
] as const;

export type DestinationCategoryToneKey = (typeof DESTINATION_CATEGORY_TONE_KEYS)[number];

export const DESTINATION_CATEGORY_SURFACES = ['primary', 'secondary', 'hidden'] as const;

export type DestinationCategorySurface = (typeof DESTINATION_CATEGORY_SURFACES)[number];

export const DESTINATION_CATEGORY_STATUSES = ['active', 'archived'] as const;

export type DestinationCategoryStatus = (typeof DESTINATION_CATEGORY_STATUSES)[number];

/** Human-facing labels for admin selects; the wire values stay snake-free keys. */
export const DESTINATION_CATEGORY_ICON_LABELS: Record<DestinationCategoryIconKey, string> = {
  restroom: 'Restroom',
  medical: 'Medical',
  chat: 'Conversation',
  book: 'Book',
  building: 'Building',
  person: 'Person',
  sports: 'Sports',
  technology: 'Technology',
  water: 'Water',
  food: 'Food',
  music: 'Music',
  school: 'School',
  briefcase: 'Briefcase',
  generic: 'More (grid)',
};

export const DESTINATION_CATEGORY_TONE_LABELS: Record<DestinationCategoryToneKey, string> = {
  aqua: 'Aqua',
  rose: 'Rose',
  violet: 'Violet',
  amber: 'Amber',
  blue: 'Blue',
  green: 'Green',
  slate: 'Slate',
  neutral: 'Neutral',
};

export function isDestinationCategoryIconKey(value: string): value is DestinationCategoryIconKey {
  return (DESTINATION_CATEGORY_ICON_KEYS as readonly string[]).includes(value);
}

export function isDestinationCategoryToneKey(value: string): value is DestinationCategoryToneKey {
  return (DESTINATION_CATEGORY_TONE_KEYS as readonly string[]).includes(value);
}

export function isDestinationCategorySurface(value: string): value is DestinationCategorySurface {
  return (DESTINATION_CATEGORY_SURFACES as readonly string[]).includes(value);
}
