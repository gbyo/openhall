import {
  CAPABILITIES,
  isCapability,
  type Capability,
  type ResourceByCapability,
} from '@openhall/application';
import { CapabilitySchema } from '@openhall/contracts';
import { describe, expect, it } from 'vitest';

function contractLiterals(): string[] {
  const options = (CapabilitySchema as unknown as { anyOf: { const: string }[] }).anyOf;
  return options.map((option) => option.const);
}

describe('capability vocabulary parity', () => {
  it('application and public contract capability sets are identical', () => {
    expect([...contractLiterals()].sort()).toEqual([...CAPABILITIES].sort());
    expect(new Set(contractLiterals()).size).toBe(CAPABILITIES.length);
  });

  it('arbitrary permission strings are not capabilities', () => {
    expect(isCapability('teacher')).toBe(false);
    expect(isCapability('admin')).toBe(false);
    expect(isCapability('pass.approve.section ')).toBe(false);
    expect(contractLiterals()).not.toContain('teacher');
  });

  it('capability/resource compatibility holds at compile time', () => {
    function accepts<C extends Capability>(
      capability: C,
      resource: ResourceByCapability[C],
    ): [C, ResourceByCapability[C]] {
      return [capability, resource];
    }
    // Valid mappings compile without casts.
    accepts('schedule.manage', { kind: 'organization', organizationId: 'org-1' });
    accepts('pass.request.self', {
      kind: 'student',
      organizationId: 'org-1',
      studentId: 'person-1',
    });
    accepts('pass.create.student', {
      kind: 'student',
      organizationId: 'org-1',
      studentId: 'person-1',
    });
    accepts('pass.create.student', {
      kind: 'student_in_section',
      sectionId: 'sec-1',
      studentId: 'person-1',
    });
    accepts('pass.approve.section', {
      kind: 'student_in_section',
      sectionId: 'sec-1',
      studentId: 'person-1',
    });
    accepts('destination.station.manage', { kind: 'destination', destinationId: 'dest-1' });
    accepts('identity.manage', { kind: 'tenant' });
    // Invalid mappings fail for the capability/resource mismatch, using
    // well-formed resources of the wrong kind.
    // @ts-expect-error schedule.manage is not applicable to self resources.
    accepts('schedule.manage', { kind: 'self' });
    // @ts-expect-error pass.request.self requires a student resource.
    accepts('pass.request.self', { kind: 'organization', organizationId: 'org-1' });
    accepts('pass.approve.section', {
      // @ts-expect-error pass.approve.section requires a student_in_section resource.
      kind: 'student',
      organizationId: 'org-1',
      studentId: 'person-1',
    });
    // @ts-expect-error destination.station.manage requires a destination resource.
    accepts('destination.station.manage', { kind: 'organization', organizationId: 'org-1' });
    // @ts-expect-error identity.manage requires a tenant resource.
    accepts('identity.manage', { kind: 'organization', organizationId: 'org-1' });
  });
});
