import type { CategoryIcon } from '../../lib/destination-category-presentation.js';
import {
  iconForCategoryKey,
  resolveCategoryPicker,
  toneForCategoryKey,
  type CategoryPickerMode,
} from '../../lib/destination-category-presentation.js';
import type { StudentDestinationCatalog } from '../../api/types.js';

export type StudentCatalogCategory = StudentDestinationCatalog['categories'][number];
export type StudentCatalogDestination = StudentCatalogCategory['destinations'][number];

/**
 * Server-defined student destination category. The frontend never branches
 * on what a category *is* (restroom, counselor, …) — it renders whatever
 * the catalog returns using the centralized icon/tone registry.
 */
export interface StudentCategory {
  id: string;
  name: string;
  icon: CategoryIcon;
  tone: 'aqua' | 'rose' | 'violet' | 'amber' | 'blue' | 'green' | 'slate' | 'neutral';
  surface: 'primary' | 'secondary';
  pickerMode: CategoryPickerMode;
  destinations: StudentCatalogDestination[];
}

export function toStudentCategory(category: StudentCatalogCategory): StudentCategory {
  return {
    id: category.id,
    name: category.name,
    icon: iconForCategoryKey(category.iconKey),
    tone: toneForCategoryKey(category.toneKey),
    surface: category.studentSurface,
    pickerMode:
      category.pickerMode === 'list' || category.pickerMode === 'search'
        ? category.pickerMode
        : 'auto',
    destinations: [...category.destinations],
  };
}

/**
 * Resolves how a category's destinations are presented once a choice is
 * required (2+ destinations; a single destination skips the picker
 * entirely regardless of mode). Never branches on category names.
 */
export function pickerForCategory(category: StudentCategory): 'list' | 'search' {
  return resolveCategoryPicker(category.pickerMode, category.destinations.length);
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
