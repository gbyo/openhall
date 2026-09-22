import type { OrganizationContext } from '../../api/types.js';

export interface WorkspaceNavChild {
  to: string;
  label: string;
}

export interface WorkspaceNavItem {
  to: string;
  label: string;
  children?: WorkspaceNavChild[];
}

export interface WorkspaceNavGroup {
  id: 'teaching' | 'operations' | 'administration';
  label: string;
  items: WorkspaceNavItem[];
}

type Capability = OrganizationContext['capabilities'][number];

function has(context: OrganizationContext, capability: Capability): boolean {
  return context.capabilities.includes(capability);
}

function sectionLabel(section: { code: string | null; title: string }): string {
  return section.code ?? section.title;
}

/**
 * Staff workspace navigation grouped by user task, not by capability name.
 * Capabilities determine visibility; grouping stays stable (Teaching /
 * Operations / Administration) per OpenHall UI 0.3 issue #16.
 */
export function buildWorkspaceNav(context: OrganizationContext): WorkspaceNavGroup[] {
  const teaching: WorkspaceNavItem[] = [];
  const operations: WorkspaceNavItem[] = [];
  const administration: WorkspaceNavItem[] = [];

  const student = context.affiliations.includes('student') && has(context, 'pass.request.self');
  const staffWorkspace =
    context.teachingSections.length > 0 ||
    context.staffedRooms.length > 0 ||
    has(context, 'pass.override.resolve.school') ||
    has(context, 'pass.view.school_live') ||
    has(context, 'scheduled_authorization.manage') ||
    has(context, 'room.manage') ||
    has(context, 'schedule.manage') ||
    has(context, 'policy.manage') ||
    has(context, 'authorization.manage') ||
    has(context, 'people.view') ||
    has(context, 'audit.view');

  if (student && staffWorkspace) {
    teaching.push({ to: 'pass', label: 'My WayPass' });
  }

  if (context.teachingSections.length > 0 || has(context, 'pass.override.resolve.school')) {
    teaching.push({ to: 'requests', label: 'Requests' });
  }

  if (context.teachingSections.length === 1) {
    const section = context.teachingSections[0];
    if (section) teaching.push({ to: `classes/${section.id}`, label: 'Classes' });
  } else if (context.teachingSections.length > 1) {
    const first = context.teachingSections[0];
    teaching.push({
      to: first ? `classes/${first.id}` : 'requests',
      label: 'Classes',
      children: context.teachingSections.map((section) => ({
        to: `classes/${section.id}`,
        label: sectionLabel(section),
      })),
    });
  }

  if (has(context, 'pass.view.school_live')) {
    operations.push({ to: 'movement', label: 'Live movement' });
  }
  if (has(context, 'scheduled_authorization.manage')) {
    operations.push({ to: 'scheduled-passes', label: 'Scheduled passes' });
  }
  if (context.staffedRooms.length === 1) {
    const room = context.staffedRooms[0];
    if (room) operations.push({ to: `stations/${room.id}`, label: 'Station' });
  } else if (context.staffedRooms.length > 1) {
    const first = context.staffedRooms[0];
    operations.push({
      to: first ? `stations/${first.id}` : 'movement',
      label: 'Station',
      children: context.staffedRooms.map((room) => ({
        to: `stations/${room.id}`,
        label: room.name,
      })),
    });
  }

  if (has(context, 'room.manage')) {
    administration.push({ to: 'admin/rooms', label: 'Rooms' });
  }
  if (has(context, 'schedule.manage')) {
    administration.push({ to: 'admin/schedules', label: 'Schedules' });
  }
  if (has(context, 'policy.manage')) {
    administration.push({ to: 'admin/policies', label: 'Policies' });
  }
  if (has(context, 'authorization.manage')) {
    administration.push({ to: 'admin/staff-access', label: 'Staff access' });
  }
  if (has(context, 'people.view')) {
    administration.push({ to: 'admin/people', label: 'People' });
  }
  if (has(context, 'audit.view')) {
    administration.push({ to: 'admin/audit', label: 'Audit' });
  }

  return [
    { id: 'teaching', label: 'Teaching', items: teaching },
    { id: 'operations', label: 'Operations', items: operations },
    { id: 'administration', label: 'Administration', items: administration },
  ];
}

/** Student-only users keep the focused no-sidebar WayPass experience. */
export function isStudentOnly(context: OrganizationContext): boolean {
  const student = context.affiliations.includes('student') && has(context, 'pass.request.self');
  if (!student) return false;
  if (context.affiliations.some((affiliation) => affiliation !== 'student')) return false;
  return buildWorkspaceNav(context).every((group) => group.items.length === 0);
}

/** First admin-only resource for the /admin index redirect. */
export function firstAdminRoute(context: OrganizationContext): string | null {
  const admin = buildWorkspaceNav(context).find((group) => group.id === 'administration');
  const first = admin?.items[0];
  return first ? first.to.replace(/^admin\//, '') : null;
}
