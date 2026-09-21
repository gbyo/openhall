import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useLoaderData, useOutletContext, useParams } from 'react-router';
import type { OrganizationContext } from '../../api/types';
import { meQuery, sessionQuery } from '../queries';
import { RealtimeProvider } from '../realtime/RealtimeProvider';
import {
  SetupAccessBanner,
  formatSetupDeadline,
} from '../../design-system/patterns/SetupAccessBanner';

export interface SchoolOutletContext {
  context: OrganizationContext;
  organizationId: string;
}

const ADMIN_CAPABILITIES = [
  'destination.manage',
  'schedule.manage',
  'policy.manage',
  'authorization.manage',
  'people.view',
  'audit.view',
] as const satisfies readonly OrganizationContext['capabilities'][number][];

function has(
  context: OrganizationContext,
  capability: OrganizationContext['capabilities'][number],
): boolean {
  return context.capabilities.includes(capability);
}

export function SchoolShell() {
  const { context } = useLoaderData<{ context: OrganizationContext }>();
  const organizationId = useParams().organizationId ?? context.organization.id;
  const { data: me } = useQuery(meQuery);
  const { data: session } = useQuery(sessionQuery);
  const setupSession =
    session?.authenticated === true && session.authenticationMethod === 'setup' ? session : null;
  const student = context.affiliations.includes('student') && has(context, 'pass.request.self');
  const links: { to: string; label: string }[] = [];
  if (student) links.push({ to: 'pass', label: 'My WayPass' });
  if (context.teachingSections.length > 0 || has(context, 'pass.override.resolve.school'))
    links.push({ to: 'requests', label: 'Requests' });
  if (context.teachingSections.length > 0) {
    links.push({ to: `classes/${context.teachingSections[0]?.id ?? ''}`, label: 'Classes' });
  }
  if (has(context, 'pass.view.school_live')) links.push({ to: 'movement', label: 'Live movement' });
  if (has(context, 'scheduled_authorization.manage'))
    links.push({ to: 'scheduled-passes', label: 'Scheduled passes' });
  if (context.staffedDestinations.length > 0)
    links.push({ to: `stations/${context.staffedDestinations[0]?.id ?? ''}`, label: 'Station' });
  if (ADMIN_CAPABILITIES.some((capability) => has(context, capability)))
    links.push({ to: 'admin', label: 'Admin' });
  return (
    <RealtimeProvider organizationId={organizationId}>
      <div className={`product-shell ${links.length <= 2 ? 'product-shell--focused' : ''}`}>
        <header className="product-header">
          <Link className="app-wordmark" to={`/schools/${organizationId}`}>
            <span className="app-wordmark__route" aria-hidden="true">
              <i />
              <i />
            </span>
            <span>WayPass</span>
          </Link>
          <div className="product-header__school">
            <strong>{context.organization.name}</strong>
            <Link to="/schools">Switch school</Link>
          </div>
          <span className="product-header__person">{me?.person.displayName}</span>
        </header>
        {links.length > 1 && (
          <nav className="product-nav" aria-label="WayPass">
            <ul>
              {links.map((link) => (
                <li key={link.to}>
                  <NavLink to={link.to}>{link.label}</NavLink>
                </li>
              ))}
            </ul>
          </nav>
        )}
        {setupSession ? (
          <div className="product-notice">
            <SetupAccessBanner
              compact
              deadlineLabel={formatSetupDeadline(setupSession.absoluteExpiresAt)}
            />
          </div>
        ) : null}
        <main className="product-main">
          <Outlet context={{ context, organizationId } satisfies SchoolOutletContext} />
        </main>
      </div>
    </RealtimeProvider>
  );
}

export function useSchool(): SchoolOutletContext {
  return useOutletContext<SchoolOutletContext>();
}
