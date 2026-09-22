/**
 * Canonical room-category presentation registry.
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

export type RoomCategoryIconKey = (typeof DESTINATION_CATEGORY_ICON_KEYS)[number];

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

export type RoomCategoryToneKey = (typeof DESTINATION_CATEGORY_TONE_KEYS)[number];

export const DESTINATION_CATEGORY_SURFACES = ['primary', 'secondary', 'hidden'] as const;

export type RoomCategorySurface = (typeof DESTINATION_CATEGORY_SURFACES)[number];

export const DESTINATION_CATEGORY_STATUSES = ['active', 'archived'] as const;

export type RoomCategoryStatus = (typeof DESTINATION_CATEGORY_STATUSES)[number];

/** Human-facing labels for admin selects; the wire values stay snake-free keys. */
export const DESTINATION_CATEGORY_ICON_LABELS: Record<RoomCategoryIconKey, string> = {
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

export const DESTINATION_CATEGORY_TONE_LABELS: Record<RoomCategoryToneKey, string> = {
  aqua: 'Aqua',
  rose: 'Rose',
  violet: 'Violet',
  amber: 'Amber',
  blue: 'Blue',
  green: 'Green',
  slate: 'Slate',
  neutral: 'Neutral',
};

export function isRoomCategoryIconKey(value: string): value is RoomCategoryIconKey {
  return (DESTINATION_CATEGORY_ICON_KEYS as readonly string[]).includes(value);
}

export function isRoomCategoryToneKey(value: string): value is RoomCategoryToneKey {
  return (DESTINATION_CATEGORY_TONE_KEYS as readonly string[]).includes(value);
}

export function isRoomCategorySurface(value: string): value is RoomCategorySurface {
  return (DESTINATION_CATEGORY_SURFACES as readonly string[]).includes(value);
}
