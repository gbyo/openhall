import { Navigate, Outlet } from 'react-router';
import { useSchool } from '../../app/school/SchoolShell';
import { firstAdminRoute } from '../../app/school/workspace-nav';

/**
 * Thin outlet for administration resources. Workspace navigation lives in
 * the staff Sidebar (SchoolShell); AdminLayout owns no navigation system.
 */
export function AdminLayout() {
  const school = useSchool();
  return <Outlet context={school} />;
}

export function AdminIndex() {
  const { context } = useSchool();
  const first = firstAdminRoute(context);
  return first ? <Navigate replace to={first} /> : null;
}
