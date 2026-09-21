import { describe, expect, it } from 'vitest';
import {
  msUntilScheduledBoundary,
  presentScheduledAuthorization,
} from './scheduled-presentation.js';
import type { ScheduledAuthorization } from './scheduled-presentation.js';

function authorization(overrides: Partial<ScheduledAuthorization> = {}): ScheduledAuthorization {
  return {
    id: '00000000-0000-4000-8000-000000000030',
    organizationId: '00000000-0000-4000-8000-000000000010',
    validFrom: '2026-09-21T14:00:00Z',
    validUntil: '2026-09-21T16:00:00Z',
    status: 'active',
    approvalMode: 'preapproved',
    originStrategy: 'expected',
    revision: '1',
    authorizationEtag: '"auth:test:1"',
    destination: {
      id: '00000000-0000-4000-8000-000000000012',
      displayName: 'Nurse',
      serviceType: 'nurse',
    },
    originLocation: null,
    ...overrides,
  };
}

const NOW = Date.parse('2026-09-21T15:00:00Z');

describe('scheduled student presentation', () => {
  it('is future before validFrom and never startable', () => {
    const presented = presentScheduledAuthorization(
      authorization({ validFrom: '2026-09-21T16:00:00Z', validUntil: '2026-09-21T18:00:00Z' }),
      NOW,
    );
    expect(presented).toEqual({ state: 'future', startable: false });
  });

  it('is ready inside the window and startable', () => {
    expect(presentScheduledAuthorization(authorization(), NOW)).toEqual({
      state: 'ready',
      startable: true,
    });
  });

  it('is expired at validUntil and never startable', () => {
    const presented = presentScheduledAuthorization(
      authorization({ validFrom: '2026-09-21T12:00:00Z', validUntil: '2026-09-21T15:00:00Z' }),
      NOW,
    );
    expect(presented).toEqual({ state: 'expired', startable: false });
  });

  it('is inactive for non-active statuses even inside the window', () => {
    for (const status of ['used', 'cancelled', 'expired'] as const) {
      expect(presentScheduledAuthorization(authorization({ status }), NOW)).toEqual({
        state: 'inactive',
        startable: false,
      });
    }
  });

  it('reports the nearest upcoming boundary', () => {
    const boundary = msUntilScheduledBoundary(
      [authorization({ validFrom: '2026-09-21T16:00:00Z', validUntil: '2026-09-21T18:00:00Z' })],
      NOW,
    );
    expect(boundary).toBe(3_600_000);
  });

  it('reports no boundary when everything already passed', () => {
    expect(
      msUntilScheduledBoundary(
        [authorization({ validFrom: '2026-09-21T12:00:00Z', validUntil: '2026-09-21T13:00:00Z' })],
        NOW,
      ),
    ).toBeNull();
  });
});
