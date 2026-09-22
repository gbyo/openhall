import { describe, expect, it } from 'vitest';
import { pickerForCategory, splitStudentCatalog, toStudentCategory } from './student-intents.js';
import type { StudentCatalogCategory } from './student-intents.js';

function category(
  id: string,
  overrides: Partial<StudentCatalogCategory> = {},
): StudentCatalogCategory {
  return {
    id,
    name: id,
    iconKey: 'generic',
    toneKey: 'neutral',
    studentSurface: 'primary',
    pickerMode: 'auto',
    sortOrder: 0,
    destinations: [],
    ...overrides,
  };
}

describe('server-defined student catalog', () => {
  it('splits primary and secondary surfaces without a persisted More', () => {
    const { primary, secondary } = splitStudentCatalog([
      category('restroom', { name: 'Restroom', iconKey: 'restroom', toneKey: 'aqua' }),
      category('principal', {
        name: 'Principal',
        studentSurface: 'secondary',
        iconKey: 'building',
        toneKey: 'blue',
      }),
    ]);
    expect(primary.map((entry) => entry.name)).toEqual(['Restroom']);
    expect(secondary.map((entry) => entry.name)).toEqual(['Principal']);
    expect(primary[0]?.icon).toBeDefined();
    expect(primary[0]?.tone).toBe('aqua');
  });

  it('renders whatever the server returns without service-type branching', () => {
    const custom = category('services', {
      name: 'Student Services',
      studentSurface: 'secondary',
      destinations: [
        {
          id: 'd1',
          displayName: 'Guidance',
          location: { id: 'l1', name: 'Room 101' },
          checkInMode: 'none',
        },
      ],
    });
    const converted = toStudentCategory(custom);
    expect(converted.name).toBe('Student Services');
    expect(converted.surface).toBe('secondary');
    expect(converted.destinations).toHaveLength(1);
  });

  it('falls back to generic presentation for unknown keys', () => {
    const converted = toStudentCategory(
      category('x', { iconKey: 'not-a-key', toneKey: 'not-a-tone' }),
    );
    expect(converted.icon).toBeDefined();
    expect(converted.tone).toBe('neutral');
  });

  it('returns empty lists for an empty catalog', () => {
    expect(splitStudentCatalog([])).toEqual({ primary: [], secondary: [] });
  });
});

describe('generic destination picker mode', () => {
  function destinations(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      id: `d${String(index)}`,
      displayName: `Room ${String(index)}`,
      location: { id: `l${String(index)}`, name: `Room ${String(index)}` },
      checkInMode: 'none' as const,
    }));
  }

  it('forces list and search modes regardless of destination count', () => {
    const base = category('x', { destinations: destinations(20) });
    expect(pickerForCategory(toStudentCategory({ ...base, pickerMode: 'list' }))).toBe('list');
    expect(pickerForCategory(toStudentCategory({ ...base, pickerMode: 'search' }))).toBe('search');
  });

  it('resolves auto to list for a few choices and search for larger sets', () => {
    const small = toStudentCategory(category('s', { destinations: destinations(7) }));
    const large = toStudentCategory(category('l', { destinations: destinations(8) }));
    expect(pickerForCategory(small)).toBe('list');
    expect(pickerForCategory(large)).toBe('search');
  });

  it('defaults unknown picker values to auto without name branching', () => {
    const converted = toStudentCategory(category('Room visits', { destinations: destinations(2) }));
    expect(converted.pickerMode).toBe('auto');
    expect(pickerForCategory(converted)).toBe('list');
  });
});
