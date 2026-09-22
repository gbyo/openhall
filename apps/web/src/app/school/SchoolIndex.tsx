import { Navigate } from 'react-router';
import type { OrganizationContext } from '../../api/types';
import { useSchool } from './SchoolShell';

export function SchoolIndex() {
  const { context } = useSchool();
  const adminCapabilities = [
    'room.manage',
    'schedule.manage',
    'policy.manage',
    'authorization.manage',
    'people.view',
    'audit.view',
  ] as const satisfies readonly OrganizationContext['capabilities'][number][];
  if (
    context.affiliations.includes('student') &&
    context.capabilities.includes('pass.request.self')
  )
    return <Navigate replace to="pass" />;
  if (context.teachingSections.length > 0) return <Navigate replace to="requests" />;
  if (context.capabilities.includes('pass.override.resolve.school'))
    return <Navigate replace to="requests" />;
  if (context.capabilities.includes('pass.view.school_live'))
    return <Navigate replace to="movement" />;
  if (context.staffedRooms.length > 0)
    return <Navigate replace to={`stations/${context.staffedRooms[0]?.id ?? ''}`} />;
  if (context.capabilities.includes('scheduled_authorization.manage'))
    return <Navigate replace to="scheduled-passes" />;
  if (adminCapabilities.some((capability) => context.capabilities.includes(capability)))
    return <Navigate replace to="admin" />;
  return (
    <section className="empty-state">
      <h1>No WayPass tools assigned</h1>
      <p>Ask a school administrator to review your access.</p>
    </section>
  );
}
