import { describe, expect, it } from 'vitest';
import {
  CATEGORY_ICON_REGISTRY,
  categoryIconGroups,
  iconForCategoryKey,
  isRoomPickerMode,
  matchesRoomSearch,
  normalizeRoomSearch,
  resolveRoomPickerMode,
  ROOM_AUTO_LIST_THRESHOLD,
  searchCategoryIcons,
  surfaceLabel,
  toneForCategoryKey,
} from './room-category-presentation.js';

describe('room-category-presentation', () => {
  it('falls back to generic presentation for unknown keys', () => {
    expect(iconForCategoryKey('not-a-key')).toBeDefined();
    expect(toneForCategoryKey('not-a-tone')).toBe('neutral');
  });

  it('labels the persisted secondary surface as More', () => {
    expect(surfaceLabel('secondary')).toBe('More');
    expect(surfaceLabel('primary')).toBe('Primary');
    expect(surfaceLabel('hidden')).toBe('Hidden');
  });

  it('resolves picker modes without branching on category names', () => {
    expect(resolveRoomPickerMode('list', 100)).toBe('list');
    expect(resolveRoomPickerMode('search', 1)).toBe('search');
    expect(resolveRoomPickerMode('auto', 2)).toBe('list');
    expect(resolveRoomPickerMode('auto', ROOM_AUTO_LIST_THRESHOLD + 40)).toBe('search');
    expect(isRoomPickerMode('auto')).toBe(true);
    expect(isRoomPickerMode('counselor')).toBe(false);
  });

  it('normalizes search across case, whitespace, and punctuation', () => {
    expect(normalizeRoomSearch('  Science-Lab, 214 ')).toBe('science lab 214');
    expect(matchesRoomSearch('Jordan Lee · Physical Science', 'jordan')).toBe(true);
    expect(matchesRoomSearch('Science Lab 214', '214')).toBe(true);
    expect(matchesRoomSearch('Science Lab 214', 'gym')).toBe(false);
    expect(matchesRoomSearch('Science Lab 214', '')).toBe(true);
  });

  it('searches the icon registry over labels, keys, and aliases', () => {
    const keys = (query: string) => searchCategoryIcons(query).map((entry) => entry.key);
    expect(keys('bathroom')).toContain('restroom');
    expect(keys('teacher')).toContain('teacher');
    expect(keys('office')).toContain('building');
    expect(keys('zzzz-no-such-icon')).toEqual([]);
    expect(searchCategoryIcons('')).toHaveLength(CATEGORY_ICON_REGISTRY.length);
  });

  it('keeps registry keys unique and groups them for the picker', () => {
    const keys = CATEGORY_ICON_REGISTRY.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    const groups = categoryIconGroups();
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.flatMap((group) => group.icons)).toHaveLength(keys.length);
  });

  it('matches every search token in any order', () => {
    const haystack = 'Science Lab 214 Jordan Lee Physical Science';
    expect(matchesRoomSearch(haystack, 'Jordan 214')).toBe(true);
    expect(matchesRoomSearch(haystack, '214 jordan')).toBe(true);
    expect(matchesRoomSearch(haystack, 'lee physical')).toBe(true);
    // Every token still has to occur: an unrelated token fails the match.
    expect(matchesRoomSearch(haystack, 'Jordan gym')).toBe(false);
  });
});
