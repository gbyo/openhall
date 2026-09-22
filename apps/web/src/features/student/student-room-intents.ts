import type { CategoryIcon } from '../../lib/room-category-presentation.js';
import {
  iconForCategoryKey,
  resolveRoomPickerMode,
  toneForCategoryKey,
} from '../../lib/room-category-presentation.js';
import type { StudentRoomCatalog } from '../../api/types.js';

export type StudentCatalogCategory = StudentRoomCatalog['categories'][number];
export type StudentCatalogRoom = StudentCatalogCategory['rooms'][number];

/**
 * Server-defined student room category. The frontend never branches on what
 * a category *is* (restroom, counselor, …) — it renders whatever the
 * catalog returns using the centralized icon/tone registry and the
 * persisted picker mode.
 */
export interface StudentCategory {
  id: string;
  name: string;
  icon: CategoryIcon;
  tone: 'aqua' | 'rose' | 'violet' | 'amber' | 'blue' | 'green' | 'slate' | 'neutral';
  surface: 'primary' | 'secondary';
  picker: 'list' | 'search';
  rooms: StudentCatalogRoom[];
}

export function toStudentCategory(category: StudentCatalogCategory): StudentCategory {
  return {
    id: category.id,
    name: category.name,
    icon: iconForCategoryKey(category.iconKey),
    tone: toneForCategoryKey(category.toneKey),
    // The catalog carries the configured placement; hidden categories never
    // reach it, so the launcher only splits Primary from More.
    surface: category.studentSurface,
    picker: resolveRoomPickerMode(category.pickerMode, category.rooms.length),
    rooms: [...category.rooms],
  };
}

/**
 * Splits the server catalog into primary home tiles and the generated More
 * flow. "More" is never persisted — it is synthesized here only when the
 * response contains eligible secondary categories.
 */
export function splitStudentCatalog(categories: StudentCatalogCategory[]): {
  primary: StudentCategory[];
  secondary: StudentCategory[];
} {
  const primary: StudentCategory[] = [];
  const secondary: StudentCategory[] = [];
  for (const category of categories.map(toStudentCategory)) {
    if (category.surface === 'primary') primary.push(category);
    else secondary.push(category);
  }
  return { primary, secondary };
}

/** One-line secondary text for a room: number/floor plus teacher context. */
export function roomSecondaryText(room: StudentCatalogRoom): string | null {
  const place = [room.code, room.floorLabel]
    .filter((part) => part !== null && part.length > 0)
    .join(' · ');
  const teachers = room.searchContext.teacherNames.slice(0, 2).join(' · ');
  const sections = room.searchContext.sectionLabels.slice(0, 1).join('');
  const context = [teachers, sections].filter((part) => part.length > 0).join(' · ');
  const text = [place, context].filter((part) => part.length > 0).join(' — ');
  return text.length > 0 ? text : null;
}

/** Normalized haystack for Room-visits-style teacher/name/number/class search. */
export function roomSearchHaystack(room: StudentCatalogRoom): string {
  return [
    room.name,
    room.code ?? '',
    room.floorLabel ?? '',
    ...room.searchContext.teacherNames,
    ...room.searchContext.sectionLabels,
    ...room.searchContext.roomStaffNames,
  ].join(' ');
}
