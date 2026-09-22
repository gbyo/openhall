import { describe, expect, it } from 'vitest';
import {
  iconForCategoryKey,
  isRoomPickerMode,
  matchesRoomSearch,
  normalizeRoomSearch,
  resolveRoomPickerMode,
  ROOM_AUTO_LIST_THRESHOLD,
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
});
