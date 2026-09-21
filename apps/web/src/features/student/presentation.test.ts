import { describe, expect, it } from 'vitest';
import type { Pass } from '../../api/types.js';
import { presentStudentPass } from './presentation.js';

function pass(state: string, mode: Pass['movement']['effectiveCheckInMode'] = null): Pass {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000002',
    studentId: '00000000-0000-4000-8000-000000000003',
    policy: null,
    destination: {
      id: '00000000-0000-4000-8000-000000000004',
      displayName: 'Nurse',
      serviceType: 'nurse',
      checkInMode: 'required',
    },
    origin: { placementKind: 'resolved', block: null, section: null, location: null },
    requestSource: 'student_web',
    scheduledAuthorizationId: null,
    requestedAt: '2026-09-21T14:00:00Z',
    lifecycleState: state,
    revision: '1',
    movement: {
      readyUntil: null,
      queueEnteredAt: null,
      queueExpiresAt: null,
      expectedReturnAt: null,
      effectiveCheckInMode: mode,
      reasonCode: null,
    },
  };
}

describe('student pass presentation', () => {
  it('uses the effective departure snapshot for outbound instructions', () => {
    expect(presentStudentPass(pass('outbound', 'required')).kind).toBe('outbound-station-required');
    expect(presentStudentPass(pass('outbound', 'optional')).kind).toBe('outbound-optional');
    expect(presentStudentPass(pass('outbound', 'none')).kind).toBe('outbound-lightweight');
  });
  it('never advances movement from time alone', () => {
    expect(presentStudentPass(pass('ready')).kind).toBe('ready');
  });
});
