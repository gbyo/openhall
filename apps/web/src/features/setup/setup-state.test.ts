import { describe, expect, it } from 'vitest';
import { resolveTimeZoneDefault } from './setup-state.js';

const SUPPORTED = ['America/Chicago', 'America/Denver', 'Etc/UTC'];

describe('resolveTimeZoneDefault', () => {
  it('keeps a guessed zone that the runtime supports', () => {
    expect(resolveTimeZoneDefault('America/Denver', SUPPORTED)).toBe('America/Denver');
  });

  it('falls back when the runtime reports a zone outside the supported list', () => {
    // Runtimes with TZ=UTC report `UTC`, which `supportedValuesOf('timeZone')`
    // does not include; the question must still have a default.
    expect(resolveTimeZoneDefault('UTC', SUPPORTED)).toBe('America/Chicago');
  });

  it('falls back when no zone was guessed', () => {
    expect(resolveTimeZoneDefault(undefined, SUPPORTED)).toBe('America/Chicago');
  });
});
