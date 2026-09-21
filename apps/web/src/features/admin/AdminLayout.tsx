import { Navigate, NavLink, Outlet } from 'react-router';
import { useSchool } from '../../app/school/SchoolShell';

export function AdminLayout() {
  const school = useSchool();
  const { context } = school;
  const has = (capability: (typeof context.capabilities)[number]) =>
    context.capabilities.includes(capability);
  const links = [
    has('pass.view.school_live') && ['live', 'Live movement'],
    has('destination.manage') && ['destinations', 'Destinations'],
    has('destination.manage') && ['locations', 'Locations'],
    has('schedule.manage') && ['schedules', 'Schedules'],
    has('policy.manage') && ['policies', 'Policies'],
    has('authorization.manage') && ['staff-access', 'Staff access'],
    has('scheduled_authorization.manage') && ['scheduled-passes', 'Scheduled passes'],
    has('people.view') && ['people', 'People'],
    has('audit.view') && ['audit', 'Audit'],
  ].filter((item): item is string[] => Boolean(item));
  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <p className="admin-sidebar__title">School administration</p>
        <nav aria-label="Administration">
          <ul>
            {links.map(([to, label]) => (
              <li key={to}>
                <NavLink to={to ?? ''}>{label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="admin-content">
        <Outlet context={school} />
      </div>
    </div>
  );
}

export function AdminIndex() {
  const { context } = useSchool();
  const has = (capability: (typeof context.capabilities)[number]) =>
    context.capabilities.includes(capability);
  const first = [
    has('pass.view.school_live') && 'live',
    has('destination.manage') && 'destinations',
    has('schedule.manage') && 'schedules',
    has('policy.manage') && 'policies',
    has('authorization.manage') && 'staff-access',
    has('scheduled_authorization.manage') && 'scheduled-passes',
    has('people.view') && 'people',
    has('audit.view') && 'audit',
  ].find((route): route is string => Boolean(route));
  return first ? <Navigate replace to={first} /> : null;
}
