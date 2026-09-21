import { describe, expect, it } from 'vitest';
import { groupDestinationsIntoIntents, intentKeyForServiceType } from './student-intents.js';
import type { DestinationCatalogEntry } from './student-intents.js';

function entry(
  id: string,
  serviceType: string,
  displayName = serviceType,
): DestinationCatalogEntry {
  return { id, displayName, serviceType, checkInMode: 'none' };
}

describe('student intent registry', () => {
  it('maps canonical service types to intents', () => {
    expect(intentKeyForServiceType('restroom')).toBe('restroom');
    expect(intentKeyForServiceType('nurse')).toBe('nurse');
    expect(intentKeyForServiceType('health')).toBe('nurse');
    expect(intentKeyForServiceType('counseling')).toBe('counselor');
    expect(intentKeyForServiceType('library')).toBe('library');
    expect(intentKeyForServiceType('office')).toBe('office');
  });

  it('groups known destinations and keeps unknown ones under More', () => {
    const intents = groupDestinationsIntoIntents([
      entry('a', 'restroom', 'First floor restroom'),
      entry('b', 'restroom', 'Second floor restroom'),
      entry('c', 'health', 'Health Office'),
      entry('d', 'planetarium', 'Planetarium'),
    ]);
    expect(intents.map((intent) => intent.key)).toEqual(['restroom', 'nurse', 'more']);
    expect(intents[0]?.destinations).toHaveLength(2);
    expect(intents[2]?.destinations.map((entry) => entry.id)).toEqual(['d']);
  });

  it('omits More when every destination is known', () => {
    const intents = groupDestinationsIntoIntents([entry('a', 'library', 'Library')]);
    expect(intents.map((intent) => intent.key)).toEqual(['library']);
  });

  it('never matches on display names', () => {
    expect(intentKeyForServiceType('planetarium')).toBe('more');
    const intents = groupDestinationsIntoIntents([entry('a', 'planetarium', 'Restroom Annex')]);
    expect(intents.map((intent) => intent.key)).toEqual(['more']);
  });
});
