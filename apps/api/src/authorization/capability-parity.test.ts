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

  it('invalid capability/resource combinations fail compilation', () => {
    function accepts<C extends Capability>(
      capability: C,
      resource: ResourceByCapability[C],
    ): [C, ResourceByCapability[C]] {
      return [capability, resource];
    }
    accepts('self.read', { kind: 'self' });
    accepts('pass.approve.section', { kind: 'student_in_section', sectionId: 's', studentId: 'p' });
    // @ts-expect-error schedule.manage is not applicable to self resources.
    accepts('schedule.manage', { kind: 'self' });
    // @ts-expect-error pass.approve.section requires a student_in_section resource.
    accepts('pass.approve.section', { kind: 'tenant' });
  });
});
