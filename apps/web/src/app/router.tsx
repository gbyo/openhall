import { createBrowserRouter, Navigate, Outlet, useLoaderData, useParams } from 'react-router';
import { ErrorPage } from './ErrorPage';
import {
  connectSignInLoader,
  indexLoader,
  loginLoader,
  protectedLoader,
  recoveryAccessLoader,
  recoveryLoader,
  schoolLoader,
  setupLoader,
} from './loaders';
import { LoginPage, RecoveryPage, EnrollPage } from './auth/AuthPages';
import { ConnectSignInPage } from '../features/auth/ConnectSignInPage';
import { RecoveryAccessPage } from '../features/auth/RecoveryAccessPage';
import { RequireSetupToken } from '../features/setup/RequireSetupToken';
import { SetupProvider } from '../features/setup/setup-state';
import { SetupWelcome } from '../features/setup/SetupWelcome';
import { GuidedSetupFlow } from '../features/setup/GuidedSetupFlow';

function SetupShell() {
  return (
    <SetupProvider>
      <Outlet />
    </SetupProvider>
  );
}
import { SchoolChooser } from './school/SchoolChooser';
import { SchoolIndex } from './school/SchoolIndex';
import { SchoolShell } from './school/SchoolShell';
import { StudentPage } from '../features/student/StudentPage';
import { RequestsPage } from '../features/requests/RequestsPage';
import { ClassPage } from '../features/teacher/ClassPage';
import { LiveMovementPage } from '../features/movement/LiveMovementPage';
import { StationPage } from '../features/station/StationPage';
import { AdminIndex, AdminLayout } from '../features/admin/AdminLayout';
import { RoomsPage } from '../features/admin/rooms/RoomsPage';
import { RoomDetailPage } from '../features/admin/rooms/RoomDetailPage';
import { DemoPage, demoLoader, type DemoInfo } from '../features/demo/DemoPage';

function DemoRoute() {
  return <DemoPage info={useLoaderData<DemoInfo>()} />;
}

/**
 * Old `/admin/destinations/:destinationId` bookmarks still resolve: migration
 * 011 preserved destination UUIDs as room UUIDs, so the id names the room.
 */
function DestinationRedirect() {
  const { destinationId } = useParams();
  // Two segments up: this route's own path is `destinations/:destinationId`.
  return <Navigate replace to={destinationId ? `../../rooms/${destinationId}` : '../../rooms'} />;
}

async function protectedSchoolLoader(args: Parameters<typeof schoolLoader>[0]) {
  await protectedLoader(args);
  return schoolLoader(args);
}

export const router = createBrowserRouter([
  { path: '/demo', loader: demoLoader, element: <DemoRoute />, errorElement: <ErrorPage /> },
  {
    path: '/',
    loader: indexLoader,
    element: <p role="status">Opening WayPass…</p>,
    errorElement: <ErrorPage />,
  },
  {
    path: '/setup',
    loader: setupLoader,
    element: <SetupShell />,
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <SetupWelcome /> },
      {
        path: 'flow',
        element: (
          <RequireSetupToken>
            <GuidedSetupFlow />
          </RequireSetupToken>
        ),
      },
    ],
  },
  {
    path: '/connect-sign-in',
    loader: connectSignInLoader,
    element: <ConnectSignInPage />,
    errorElement: <ErrorPage />,
  },
  {
    path: '/recovery/access',
    loader: recoveryAccessLoader,
    element: <RecoveryAccessPage />,
    errorElement: <ErrorPage />,
  },
  { path: '/login', loader: loginLoader, element: <LoginPage />, errorElement: <ErrorPage /> },
  { path: '/enroll', element: <EnrollPage />, errorElement: <ErrorPage /> },
  {
    path: '/recovery',
    loader: recoveryLoader,
    element: <RecoveryPage />,
    errorElement: <ErrorPage />,
  },
  {
    path: '/schools',
    loader: protectedLoader,
    element: <SchoolChooser />,
    errorElement: <ErrorPage />,
  },
  {
    path: '/schools/:organizationId',
    loader: protectedSchoolLoader,
    element: <SchoolShell />,
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <SchoolIndex /> },
      { path: 'pass', element: <StudentPage /> },
      { path: 'requests', element: <RequestsPage /> },
      { path: 'classes/:sectionId', element: <ClassPage /> },
      { path: 'movement', element: <LiveMovementPage /> },
      {
        path: 'scheduled-passes',
        lazy: () => import('../features/admin/scheduled-passes/ScheduledPassesPage'),
      },
      { path: 'stations/:roomId', element: <StationPage /> },
      {
        path: 'admin',
        element: <AdminLayout />,
        children: [
          { index: true, element: <AdminIndex /> },
          { path: 'live', element: <Navigate replace to="../../movement" /> },
          { path: 'rooms', element: <RoomsPage /> },
          { path: 'rooms/:roomId', element: <RoomDetailPage /> },
          { path: 'destinations', element: <Navigate replace to="../rooms" /> },
          // Migration 011 keeps old destination UUIDs as room UUIDs, so an
          // old deep link still names a real room.
          { path: 'destinations/:destinationId', element: <DestinationRedirect /> },
          { path: 'locations', element: <Navigate replace to="../rooms" /> },
          { path: 'schedules', lazy: () => import('../features/admin/schedules/SchedulesPage') },
          { path: 'policies', lazy: () => import('../features/admin/policies/PoliciesPage') },
          {
            path: 'policies/:policyRuleId',
            lazy: () => import('../features/admin/policies/PolicyDetailPage'),
          },
          {
            path: 'staff-access',
            lazy: () => import('../features/admin/staff-access/StaffAccessPage'),
          },
          {
            path: 'scheduled-passes',
            element: <Navigate replace to="../../scheduled-passes" />,
          },
          { path: 'people', lazy: () => import('../features/admin/people/PeoplePage') },
          { path: 'audit', lazy: () => import('../features/admin/audit/AuditPage') },
        ],
      },
    ],
  },
  { path: '*', element: <ErrorPage /> },
]);
