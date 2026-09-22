import { describe, expect, it } from 'vitest';
import {
  CATEGORY_ICON_REGISTRY,
  categoryIconGroups,
  iconForCategoryKey,
  matchDestinationSearch,
  normalizeDestinationQuery,
  normalizeIconQuery,
  resolveCategoryPicker,
  searchCategoryIcons,
  type DestinationSearchEntry,
} from './destination-category-presentation.js';

describe('destination category icon registry', () => {
  it('keeps a broad school-relevant registry with unique keys', () => {
    expect(CATEGORY_ICON_REGISTRY.length).toBeGreaterThanOrEqual(100);
    expect(CATEGORY_ICON_REGISTRY.length).toBeLessThanOrEqual(250);
    const keys = CATEGORY_ICON_REGISTRY.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of [
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
    ]) {
      expect(keys).toContain(key);
    }
  });

  it('searches labels and aliases case-insensitively', () => {
    const restroom = searchCategoryIcons('bathroom');
    expect(restroom.map((entry) => entry.key)).toContain('restroom');
    const teacher = searchCategoryIcons('STAFF');
    expect(teacher.map((entry) => entry.key)).toContain('teacher');
    expect(searchCategoryIcons('toilet')).toEqual(searchCategoryIcons('  Toilet! '));
  });

  it('returns everything for empty queries and nothing for nonsense', () => {
    expect(searchCategoryIcons('')).toHaveLength(CATEGORY_ICON_REGISTRY.length);
    expect(searchCategoryIcons('zzz-no-such-icon')).toHaveLength(0);
  });

  it('groups entries for ComboboxGroup rendering', () => {
    const groups = categoryIconGroups(searchCategoryIcons('nurse'));
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.group.length).toBeGreaterThan(0);
      expect(group.icons.length).toBeGreaterThan(0);
    }
  });

  it('falls back to generic for unknown keys', () => {
    expect(iconForCategoryKey('nope')).toBe(iconForCategoryKey('generic'));
    expect(iconForCategoryKey('teacher')).toBeDefined();
  });
});

describe('generic picker resolution', () => {
  it('forces explicit modes and thresholds auto at eight', () => {
    expect(resolveCategoryPicker('list', 200)).toBe('list');
    expect(resolveCategoryPicker('search', 1)).toBe('search');
    expect(resolveCategoryPicker('auto', 7)).toBe('list');
    expect(resolveCategoryPicker('auto', 8)).toBe('search');
    expect(resolveCategoryPicker('unknown', 2)).toBe('list');
  });

  it('normalizes destination search text', () => {
    expect(normalizeDestinationQuery('  Ms. Smith! ')).toBe('ms smith');
    expect(normalizeDestinationQuery('Room_214')).toBe('room 214');
  });

  it('normalizes icon search text', () => {
    expect(normalizeIconQuery('Main-Office')).toBe('main office');
  });
});

describe('destination search matching', () => {
  const entry: DestinationSearchEntry = {
    displayName: 'Room 214',
    locationName: 'Room 214',
    locationCode: '214',
    floorLabel: '2nd floor',
    staffDisplayNames: ['Ms. Smith'],
    sectionLabels: ['Algebra II', 'ALG-2'],
  };

  it.each<[string, boolean]>([
    ['214', true],
    ['smith', true],
    ['SMITH', true],
    ['Ms. Smith', true],
    ['algebra', true],
    ['ALG-2', true],
    ['alg 2', true],
    ['room 214', true],
    ['smith 214', true],
    ['2nd floor', true],
    ['', true],
    ['zzz', false],
    ['smith 999', false],
  ])('matches %s -> %s', (query, expected) => {
    expect(matchDestinationSearch(entry, query)).toBe(expected);
  });

  it('never requires a category name to match', () => {
    expect(matchDestinationSearch({ ...entry, displayName: 'Visit' }, 'room visits')).toBe(false);
    expect(matchDestinationSearch({ ...entry, displayName: 'Visit' }, '214')).toBe(true);
  });
});
