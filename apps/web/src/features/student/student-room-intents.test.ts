import { describe, expect, it } from 'vitest';
import {
  roomSearchHaystack,
  splitStudentCatalog,
  toStudentCategory,
} from './student-room-intents.js';
import type { StudentCatalogCategory } from './student-room-intents.js';
import { matchesRoomSearch } from '../../lib/room-category-presentation.js';

function category(
  id: string,
  overrides: Partial<StudentCatalogCategory> = {},
): StudentCatalogCategory {
  return {
    id,
    name: id,
    iconKey: 'generic',
    toneKey: 'neutral',
    pickerMode: 'auto',
    sortOrder: 0,
    rooms: [],
    ...overrides,
  };
}

function room(id: string, name: string) {
  return {
    id,
    name,
    code: null,
    floorLabel: null,
    checkInMode: 'none' as const,
    searchContext: { teacherNames: [], sectionLabels: [], roomStaffNames: [] },
  };
}

describe('server-defined student room catalog', () => {
  it('splits secondary surfaces into More when the contract carries them', () => {
    const { primary, secondary } = splitStudentCatalog([
      category('restroom', { name: 'Restroom' }),
      {
        ...category('planetarium', { name: 'Planetarium' }),
        studentSurface: 'secondary',
      } as StudentCatalogCategory,
    ]);
    expect(primary.map((entry) => entry.name)).toEqual(['Restroom']);
    expect(secondary.map((entry) => entry.name)).toEqual(['Planetarium']);
  });

  it('renders whatever the server returns without name-based branching', () => {
    const custom = category('services', {
      name: 'Student Services',
      pickerMode: 'search',
      rooms: [
        {
          id: 'r1',
          name: 'Guidance',
          code: '101',
          floorLabel: null,
          checkInMode: 'none',
          searchContext: {
            teacherNames: ['Mrs Carter'],
            sectionLabels: ['Counseling (CNS-1)'],
            roomStaffNames: [],
          },
        },
      ],
    });
    const converted = toStudentCategory(custom);
    expect(converted.name).toBe('Student Services');
    expect(converted.picker).toBe('search');
    expect(converted.rooms).toHaveLength(1);
  });

  it('resolves auto picker by room count', () => {
    const small = toStudentCategory(category('s', { rooms: [room('r1', 'A'), room('r2', 'B')] }));
    expect(small.picker).toBe('list');
    const big = toStudentCategory(
      category('b', {
        rooms: Array.from({ length: 30 }, (_, index) =>
          room(`r${String(index)}`, `Room ${String(index)}`),
        ),
      }),
    );
    expect(big.picker).toBe('search');
  });

  it('falls back to generic presentation for unknown keys', () => {
    const converted = toStudentCategory(
      category('x', { iconKey: 'not-a-key', toneKey: 'not-a-tone' }),
    );
    expect(converted.icon).toBeDefined();
    expect(converted.tone).toBe('neutral');
  });

  it('matches Room-visits-style teacher/name/number/class search', () => {
    const target = {
      id: 'r1',
      name: 'Science Lab 214',
      code: '214',
      floorLabel: 'Floor 2',
      checkInMode: 'none' as const,
      searchContext: {
        teacherNames: ['Jordan Lee'],
        sectionLabels: ['Physical Science (SCI-8A)'],
        roomStaffNames: [],
      },
    };
    const haystack = roomSearchHaystack(target);
    for (const query of ['214', 'Jordan', 'Lee', 'Science', 'Physical Science']) {
      expect(matchesRoomSearch(haystack, query)).toBe(true);
    }
    expect(matchesRoomSearch(haystack, 'gym')).toBe(false);
  });

  it('returns empty lists for an empty catalog', () => {
    expect(splitStudentCatalog([])).toEqual({ primary: [], secondary: [] });
  });
});
