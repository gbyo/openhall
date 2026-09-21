import { describe, expect, it } from 'vitest';
import type { OrganizationContext } from '../../api/types.js';
import {
  buildWorkspaceNav,
  firstAdminRoute,
  isStudentOnly,
  type WorkspaceNavGroup,
} from './workspace-nav.js';

function context(overrides: Partial<OrganizationContext>): OrganizationContext {
  return {
    organization: {
      id: '00000000-0000-4000-8000-000000000010',
      name: 'Roosevelt Middle School',
      slug: 'roosevelt-middle',
      timeZone: 'America/New_York',
    },
    affiliations: [],
    capabilities: [],
    expectedPlacement: null,
    teachingSections: [],
    staffedDestinations: [],
    ...overrides,
  };
}

function labels(groups: WorkspaceNavGroup[], id: string): string[] {
  return groups.find((group) => group.id === id)?.items.map((item) => item.label) ?? [];
}

describe('buildWorkspaceNav', () => {
  it('keeps student-only users out of the staff workspace', () => {
    const ctx = context({ affiliations: ['student'], capabilities: ['pass.request.self'] });
    expect(isStudentOnly(ctx)).toBe(true);
    const groups = buildWorkspaceNav(ctx);
    expect(groups.every((group) => group.items.length === 0)).toBe(true);
  });

  it('does not classify mixed student/staff affiliations as student-only without mapped staff resources', () => {
    const ctx = context({
      affiliations: ['student', 'staff'],
      capabilities: ['pass.request.self'],
    });
    expect(buildWorkspaceNav(ctx).every((group) => group.items.length === 0)).toBe(true);
    expect(isStudentOnly(ctx)).toBe(false);
  });

  it('exposes My WayPass inside the staff shell for mixed student/staff roles', () => {
    const ctx = context({
      affiliations: ['student', 'staff'],
      capabilities: ['pass.request.self', 'pass.view.school_live'],
    });
    expect(isStudentOnly(ctx)).toBe(false);
    expect(labels(buildWorkspaceNav(ctx), 'teaching')).toContain('My WayPass');
    expect(labels(buildWorkspaceNav(ctx), 'operations')).toContain('Live movement');
  });

  it('groups teacher work under Teaching with section sub-navigation', () => {
    const ctx = context({
      affiliations: ['staff'],
      capabilities: ['pass.approve.section'],
      teachingSections: [
        { id: 'section-1', code: 'SCI-7', title: 'Science 7', capabilities: [] },
        { id: 'section-2', code: null, title: 'Homeroom', capabilities: [] },
      ],
    });
    const groups = buildWorkspaceNav(ctx);
    expect(labels(groups, 'teaching')).toEqual(['Requests', 'Classes']);
    const classes = groups
      .find((group) => group.id === 'teaching')
      ?.items.find((item) => item.label === 'Classes');
    expect(classes?.children?.map((child) => child.label)).toEqual(['SCI-7', 'Homeroom']);
  });

  it('keeps one canonical entry each for movement, scheduled passes, and station', () => {
    const ctx = context({
      affiliations: ['staff'],
      capabilities: ['pass.view.school_live', 'scheduled_authorization.manage'],
      staffedDestinations: [
        { id: 'dest-1', displayName: 'Nurse', serviceType: 'nurse', capabilities: [] },
      ],
    });
    const groups = buildWorkspaceNav(ctx);
    expect(labels(groups, 'operations')).toEqual(['Live movement', 'Scheduled passes', 'Station']);
  });

  it('lists administration resources without live/scheduled duplicates', () => {
    const ctx = context({
      affiliations: ['staff'],
      capabilities: [
        'destination.manage',
        'schedule.manage',
        'policy.manage',
        'authorization.manage',
        'people.view',
        'audit.view',
      ],
    });
    const groups = buildWorkspaceNav(ctx);
    expect(labels(groups, 'administration')).toEqual([
      'Destinations',
      'Locations',
      'Schedules',
      'Policies',
      'Staff access',
      'People',
      'Audit',
    ]);
    expect(labels(groups, 'operations')).not.toContain('Live movement');
  });

  it('resolves the admin index redirect to the first admin resource', () => {
    const ctx = context({ affiliations: ['staff'], capabilities: ['audit.view'] });
    expect(firstAdminRoute(ctx)).toBe('audit');
    const none = context({ affiliations: ['staff'], capabilities: [] });
    expect(firstAdminRoute(none)).toBeNull();
  });
});
