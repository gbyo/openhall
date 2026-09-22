import { describe, expect, it } from 'vitest';
import { parsePolicyRuleConfiguration } from './configurations.js';

const boundaryBase = {
  schemaVersion: 1,
  firstMinutes: 10,
  lastMinutes: 10,
  blockKinds: ['instructional'],
  requestSources: ['student_web', 'staff_web'],
};

const approvalBase = {
  schemaVersion: 1,
  requestSources: ['student_web'],
  approver: 'current_section_teacher',
};

describe('parsePolicyRuleConfiguration', () => {
  it('accepts a valid schedule_boundary configuration', () => {
    const parsed = parsePolicyRuleConfiguration('schedule_boundary', { ...boundaryBase });
    expect(parsed.valid).toBe(true);
    if (parsed.valid) {
      expect(parsed.configuration.type).toBe('schedule_boundary');
    }
  });

  it('accepts a valid approval_requirement configuration', () => {
    const parsed = parsePolicyRuleConfiguration('approval_requirement', { ...approvalBase });
    expect(parsed.valid).toBe(true);
  });

  it.each(['current_section_teacher', 'room_responsible_staff'] as const)(
    'round-trips the %s approver instead of deriving it from scope',
    (approver) => {
      const parsed = parsePolicyRuleConfiguration('approval_requirement', {
        ...approvalBase,
        approver,
      });
      expect(parsed).toMatchObject({
        valid: true,
        configuration: { type: 'approval_requirement', config: { approver } },
      });
    },
  );

  it.each([
    ['missing schemaVersion', 'schedule_boundary', { ...boundaryBase, schemaVersion: undefined }],
    ['unsupported schemaVersion', 'schedule_boundary', { ...boundaryBase, schemaVersion: 2 }],
    ['unknown property', 'schedule_boundary', { ...boundaryBase, extra: true }],
    ['wrong type', 'schedule_boundary', { ...boundaryBase, firstMinutes: '10' }],
    ['negative minutes', 'schedule_boundary', { ...boundaryBase, firstMinutes: -1 }],
    ['fractional minutes', 'schedule_boundary', { ...boundaryBase, lastMinutes: 2.5 }],
    ['empty window', 'schedule_boundary', { ...boundaryBase, firstMinutes: 0, lastMinutes: 0 }],
    ['empty blockKinds', 'schedule_boundary', { ...boundaryBase, blockKinds: [] }],
    ['unknown block kind', 'schedule_boundary', { ...boundaryBase, blockKinds: ['nap'] }],
    ['empty requestSources', 'schedule_boundary', { ...boundaryBase, requestSources: [] }],
    [
      'unknown request source',
      'schedule_boundary',
      { ...boundaryBase, requestSources: ['carrier_pigeon'] },
    ],
    ['unknown approver', 'approval_requirement', { ...approvalBase, approver: 'principal' }],
    ['approval unknown property', 'approval_requirement', { ...approvalBase, extra: 1 }],
    ['unknown rule type', 'daily_limit', { schemaVersion: 1 }],
    ['non-object configuration', 'schedule_boundary', null],
  ])('rejects %s', (_label, ruleType, configuration) => {
    expect(parsePolicyRuleConfiguration(ruleType, configuration).valid).toBe(false);
  });
});
