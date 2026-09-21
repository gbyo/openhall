import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';
import type { ExpectedPlacementResult } from '../scheduling/index.js';
import { combinePolicyDecision } from './decisions.js';
import { evaluatePolicy } from './engine.js';
import type { PolicyEvaluationContext, PolicyRuleInput } from './context.js';

const SCHOOL = 'org-school';
const STUDENT = 'person-student';
const DESTINATION = 'dest-1';
const SECTION_P3 = 'section-p3';
const SECTION_P4 = 'section-p4';

function rule(overrides: Partial<PolicyRuleInput> = {}): PolicyRuleInput {
  return {
    id: 'rule-1',
    organizationId: SCHOOL,
    name: 'Test rule',
    ruleType: 'schedule_boundary',
    scopeKind: 'organization',
    scopeOrganizationId: SCHOOL,
    scopeSectionId: null,
    scopeDestinationId: null,
    priority: 0,
    configuration: {
      schemaVersion: 1,
      firstMinutes: 10,
      lastMinutes: 10,
      blockKinds: ['instructional'],
      requestSources: ['student_web', 'staff_web'],
    },
    overrideMode: 'never',
    enabled: true,
    validFrom: null,
    validUntil: null,
    revision: 1,
    ...overrides,
  };
}

function resolvedPlacement(at: Temporal.Instant, sectionId = SECTION_P3): ExpectedPlacementResult {
  const beginsAt = Temporal.Instant.from('2026-09-21T12:00:00Z');
  const endsAt = Temporal.Instant.from('2026-09-21T13:00:00Z');
  return {
    kind: 'resolved',
    school: { id: SCHOOL, name: 'School', kind: 'school', timeZone: 'America/New_York' },
    schoolDate: Temporal.PlainDate.from('2026-09-21'),
    schoolTime: at.toZonedDateTimeISO('America/New_York').toPlainTime(),
    calendarDay: {
      id: 'day-1',
      date: Temporal.PlainDate.from('2026-09-21'),
      dayKind: 'instructional',
      cycleCode: null,
      operationalNote: null,
      template: { id: 'tpl-1', name: 'Daily' },
    },
    slot: {
      id: 'slot-1',
      startsAt: Temporal.PlainTime.from('08:00'),
      endsAt: Temporal.PlainTime.from('09:00'),
      ordinal: 0,
      block: { id: 'block-1', code: 'P3', displayName: 'P3', kind: 'instructional' },
    },
    block: { id: 'block-1', code: 'P3', displayName: 'P3', kind: 'instructional' },
    beginsAt,
    endsAt,
    elapsedSeconds: 0,
    remainingSeconds: 3600,
    section: { id: sectionId, code: 'HIST-3', title: 'US History' },
    expectedLocation: null,
    teachers: [],
  };
}

function contextAt(
  instant: string,
  rules: readonly PolicyRuleInput[] = [rule()],
  placement?: ExpectedPlacementResult,
): PolicyEvaluationContext {
  const at = Temporal.Instant.from(instant);
  return {
    pass: {
      id: 'pass-1',
      revision: 1n,
      organizationId: SCHOOL,
      studentId: STUDENT,
      destinationId: DESTINATION,
      requestSource: 'student_web',
      originBlockId: 'block-1',
      originSectionId: SECTION_P3,
      originLocationId: null,
    },
    at,
    currentPlacement: placement ?? resolvedPlacement(at),
    rules,
    approvals: [],
    overrides: [],
  };
}

describe('schedule boundary evaluation', () => {
  it.each([
    ['08:00:00 window start blocks', '2026-09-21T12:00:00Z', 'deny'],
    ['08:09:59 blocks', '2026-09-21T12:09:59Z', 'deny'],
    ['08:10:00 passes', '2026-09-21T12:10:00Z', 'allow'],
    ['08:49:59 passes', '2026-09-21T12:49:59Z', 'allow'],
    ['08:50:00 blocks', '2026-09-21T12:50:00Z', 'deny'],
    ['08:59:59 blocks', '2026-09-21T12:59:59Z', 'deny'],
  ])('%s', (_label, instant, expected) => {
    const outcome = evaluatePolicy(contextAt(instant));
    expect(outcome.decision).toBe(expected);
  });

  it('blocks the entire slot when first+last windows overlap', () => {
    const wide = rule({
      configuration: {
        schemaVersion: 1,
        firstMinutes: 40,
        lastMinutes: 40,
        blockKinds: ['instructional'],
        requestSources: ['student_web'],
      },
    });
    expect(evaluatePolicy(contextAt('2026-09-21T12:30:00Z', [wide])).decision).toBe('deny');
    expect(evaluatePolicy(contextAt('2026-09-21T12:00:00Z', [wide])).decision).toBe('deny');
  });

  it('is not applicable on block-kind or request-source mismatch', () => {
    const lunch = rule({
      configuration: {
        schemaVersion: 1,
        firstMinutes: 60,
        lastMinutes: 60,
        blockKinds: ['lunch'],
        requestSources: ['student_web'],
      },
    });
    const staffOnly = rule({
      configuration: {
        schemaVersion: 1,
        firstMinutes: 60,
        lastMinutes: 60,
        blockKinds: ['instructional'],
        requestSources: ['staff_web'],
      },
    });
    for (const rules of [[lunch], [staffOnly]]) {
      const outcome = evaluatePolicy(contextAt('2026-09-21T12:00:00Z', rules));
      expect(outcome.decision).toBe('allow');
      expect(outcome.results[0]?.outcome).toBe('not_applicable');
    }
  });

  it('is deterministic for identical inputs', () => {
    const first = evaluatePolicy(contextAt('2026-09-21T12:05:00Z'));
    const second = evaluatePolicy(contextAt('2026-09-21T12:05:00Z'));
    expect(second).toEqual(first);
  });
});

describe('policy combination', () => {
  const approvalRule = (id: string, priority: number): PolicyRuleInput =>
    rule({
      id,
      priority,
      ruleType: 'approval_requirement',
      overrideMode: 'never',
      configuration: {
        schemaVersion: 1,
        requestSources: ['student_web'],
        approver: 'current_section_teacher',
      },
    });

  it('allows with zero rules', () => {
    expect(evaluatePolicy(contextAt('2026-09-21T12:30:00Z', [])).decision).toBe('allow');
  });

  it('requires approval for an approval rule alone', () => {
    const outcome = evaluatePolicy(contextAt('2026-09-21T12:30:00Z', [approvalRule('a', 0)]));
    expect(outcome.decision).toBe('approval_required');
    expect(outcome.approvalRequirements).toEqual([
      { ruleId: 'a', ruleRevision: 1, requiredSectionId: SECTION_P3 },
    ]);
  });

  it('requires override for an overrideable blackout', () => {
    const outcome = evaluatePolicy(
      contextAt('2026-09-21T12:00:00Z', [rule({ overrideMode: 'authorized' })]),
    );
    expect(outcome.decision).toBe('override_required');
    expect(outcome.overrideRequirements).toHaveLength(1);
  });

  it('prefers deny over override and approval regardless of priority order', () => {
    const deny = rule({ id: 'deny', priority: -10 });
    const approval = approvalRule('approval', 100);
    const overrideable = rule({
      id: 'over',
      priority: 50,
      overrideMode: 'authorized',
      configuration: {
        schemaVersion: 1,
        firstMinutes: 60,
        lastMinutes: 0,
        blockKinds: ['instructional'],
        requestSources: ['student_web'],
      },
    });
    const at = '2026-09-21T12:00:00Z';
    expect(evaluatePolicy(contextAt(at, [approval, overrideable, deny])).decision).toBe('deny');
    expect(evaluatePolicy(contextAt(at, [approval, overrideable])).decision).toBe(
      'override_required',
    );
  });
});

describe('malformed enabled policy', () => {
  it('fails closed and nonoverrideable even when authorized', () => {
    const bad = rule({ overrideMode: 'authorized', configuration: { schemaVersion: 999 } });
    const outcome = evaluatePolicy(contextAt('2026-09-21T12:30:00Z', [bad]));
    expect(outcome.decision).toBe('deny');
    expect(outcome.results[0]).toMatchObject({
      outcome: 'fail',
      contribution: 'deny',
      reasonCode: 'policy_configuration_error',
    });
  });
});

describe('validity and scope', () => {
  it.each([
    ['disabled rule is not applicable', { enabled: false }, '2026-09-21T12:00:00Z', 'allow'],
    [
      'before valid_from is not applicable',
      { validFrom: Temporal.Instant.from('2026-09-22T00:00:00Z') },
      '2026-09-21T12:00:00Z',
      'allow',
    ],
    [
      'exact valid_from is active',
      { validFrom: Temporal.Instant.from('2026-09-21T12:00:00Z') },
      '2026-09-21T12:00:00Z',
      'deny',
    ],
    [
      'exact valid_until is inactive',
      { validUntil: Temporal.Instant.from('2026-09-21T12:00:00Z') },
      '2026-09-21T12:00:00Z',
      'allow',
    ],
  ])('%s', (_label, patch, instant, expected) => {
    const outcome = evaluatePolicy(contextAt(instant, [rule(patch)]));
    expect(outcome.decision).toBe(expected);
  });

  it('applies section scope to the current resolved section only', () => {
    const sectionRule = rule({
      scopeKind: 'section',
      scopeOrganizationId: null,
      scopeSectionId: SECTION_P4,
    });
    const outcome = evaluatePolicy(contextAt('2026-09-21T12:00:00Z', [sectionRule]));
    expect(outcome.decision).toBe('allow');
    expect(outcome.results[0]?.outcome).toBe('not_applicable');
  });
});

describe('approval evidence binding', () => {
  const approval = rule({
    id: 'appr',
    ruleType: 'approval_requirement',
    overrideMode: 'never',
    configuration: {
      schemaVersion: 1,
      requestSources: ['student_web'],
      approver: 'current_section_teacher',
    },
  });

  function withApprovals(
    approvals: PolicyEvaluationContext['approvals'],
    sectionId = SECTION_P3,
  ): PolicyEvaluationContext {
    const base = contextAt('2026-09-21T12:30:00Z', [approval]);
    const at = base.at;
    return { ...base, approvals, currentPlacement: resolvedPlacement(at, sectionId) };
  }

  it('satisfies only the exact rule, revision, and section', () => {
    const good = {
      passId: 'pass-1',
      policyRuleId: 'appr',
      policyRuleRevision: 1,
      requiredSectionId: SECTION_P3,
      decision: 'approved' as const,
    };
    expect(evaluatePolicy(withApprovals([good])).decision).toBe('allow');

    const otherSection = { ...good, requiredSectionId: SECTION_P4 };
    expect(evaluatePolicy(withApprovals([otherSection])).decision).toBe('approval_required');

    const otherRevision = { ...good, policyRuleRevision: 2 };
    expect(evaluatePolicy(withApprovals([otherRevision])).decision).toBe('approval_required');
  });

  it('treats a denied approval as deny', () => {
    const denied = {
      passId: 'pass-1',
      policyRuleId: 'appr',
      policyRuleRevision: 1,
      requiredSectionId: SECTION_P3,
      decision: 'denied' as const,
    };
    const outcome = evaluatePolicy(withApprovals([denied]));
    expect(outcome.decision).toBe('deny');
    expect(outcome.results[0]?.reasonCode).toBe('approval_denied');
  });
});

describe('override evidence binding', () => {
  const blackout = rule({ id: 'bl', overrideMode: 'authorized' });

  it('ignores overrides bound to another revision', () => {
    const base = contextAt('2026-09-21T12:00:00Z', [blackout]);
    const stale = {
      passId: 'pass-1',
      policyRuleId: 'bl',
      policyRuleRevision: 7,
      decision: 'approved' as const,
    };
    expect(evaluatePolicy({ ...base, overrides: [stale] }).decision).toBe('override_required');
    const current = { ...stale, policyRuleRevision: 1 };
    expect(evaluatePolicy({ ...base, overrides: [current] }).decision).toBe('allow');
  });

  it('treats a denied override as deny', () => {
    const base = contextAt('2026-09-21T12:00:00Z', [blackout]);
    const denied = {
      passId: 'pass-1',
      policyRuleId: 'bl',
      policyRuleRevision: 1,
      decision: 'denied' as const,
    };
    const outcome = evaluatePolicy({ ...base, overrides: [denied] });
    expect(outcome.decision).toBe('deny');
    expect(outcome.results[0]?.reasonCode).toBe('override_denied');
  });
});

describe('combinePolicyDecision', () => {
  it('orders safety above priority input order', () => {
    const approval = {
      ruleId: 'a',
      ruleRevision: 1,
      ruleType: 'approval_requirement',
      overrideMode: 'never',
      outcome: 'fail' as const,
      contribution: 'approval_required' as const,
      reasonCode: 'current_section_teacher_approval_required' as const,
      requiredSectionId: SECTION_P3,
    };
    expect(combinePolicyDecision([])).toBe('allow');
    expect(combinePolicyDecision([approval])).toBe('approval_required');
  });
});
