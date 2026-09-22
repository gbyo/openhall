import { useQuery } from '@tanstack/react-query';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Activity01Icon,
  BookOpen01Icon,
  Calendar01Icon,
  DashboardSquare01Icon,
  File01Icon,
  InboxIcon,
  Key01Icon,
  Location01Icon,
  PinLocation01Icon,
  Shield01Icon,
  Ticket01Icon,
  UserGroupIcon,
} from '@hugeicons/core-free-icons';
import {
  Link,
  NavLink,
  Outlet,
  useLoaderData,
  useLocation,
  useOutletContext,
  useParams,
} from 'react-router';
import type { OrganizationContext } from '../../api/types';
import { sessionQuery } from '../queries';
import { RealtimeProvider } from '../realtime/RealtimeProvider';
import {
  SetupAccessBanner,
  formatSetupDeadline,
} from '../../design-system/patterns/SetupAccessBanner';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { SchoolSwitcher } from './SchoolSwitcher';
import { UserMenu } from './UserMenu';
import { buildWorkspaceNav, isStudentOnly } from './workspace-nav';

export interface SchoolOutletContext {
  context: OrganizationContext;
  organizationId: string;
}

const ITEM_ICONS: Record<string, typeof InboxIcon> = {
  'My WayPass': Ticket01Icon,
  Requests: InboxIcon,
  Classes: BookOpen01Icon,
  'Live movement': Activity01Icon,
  'Scheduled passes': Calendar01Icon,
  Station: Location01Icon,
  Rooms: PinLocation01Icon,
  Schedules: DashboardSquare01Icon,
  Policies: Shield01Icon,
  'Staff access': Key01Icon,
  People: UserGroupIcon,
  Audit: File01Icon,
};

function resolveCurrentLabel(
  pathname: string,
  organizationId: string,
  groups: ReturnType<typeof buildWorkspaceNav>,
): string | null {
  let best: string | null = null;
  let bestLength = -1;
  const consider = (to: string, label: string) => {
    const absolute = `/schools/${organizationId}/${to}`;
    if (pathname === absolute || pathname.startsWith(`${absolute}/`)) {
      if (absolute.length >= bestLength) {
        best = label;
        bestLength = absolute.length;
      }
    }
  };
  for (const group of groups) {
    for (const item of group.items) {
      consider(item.to, item.label);
      for (const child of item.children ?? []) {
        consider(child.to, child.label);
      }
    }
  }
  return best;
}

function WorkspaceSidebar({
  context,
  organizationId,
}: {
  context: OrganizationContext;
  organizationId: string;
}) {
  const location = useLocation();
  const groups = buildWorkspaceNav(context);

  function isActive(to: string): boolean {
    const absolute = `/schools/${organizationId}/${to}`;
    return location.pathname === absolute || location.pathname.startsWith(`${absolute}/`);
  }

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SchoolSwitcher schoolName={context.organization.name} />
      </SidebarHeader>
      <SidebarContent>
        {groups
          .filter((group) => group.items.length > 0)
          .map((group) => (
            <SidebarGroup key={group.id}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const Icon = ITEM_ICONS[item.label];
                    const active =
                      isActive(item.to) ||
                      (item.children?.some((child) => isActive(child.to)) ?? false);
                    return (
                      <SidebarMenuItem key={item.to}>
                        <SidebarMenuButton
                          isActive={active}
                          tooltip={item.label}
                          render={<NavLink to={item.to} />}
                        >
                          {Icon ? (
                            <HugeiconsIcon icon={Icon} strokeWidth={2} aria-hidden="true" />
                          ) : null}
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                        {item.children && item.children.length > 0 ? (
                          <SidebarMenuSub>
                            {item.children.map((child) => (
                              <SidebarMenuSubItem key={child.to}>
                                <SidebarMenuSubButton
                                  isActive={isActive(child.to)}
                                  render={<NavLink to={child.to} />}
                                >
                                  <span>{child.label}</span>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            ))}
                          </SidebarMenuSub>
                        ) : null}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
      </SidebarContent>
      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function FocusedStudentShell({
  context,
  organizationId,
}: {
  context: OrganizationContext;
  organizationId: string;
}) {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b px-4">
        <Link
          to={`/schools/${organizationId}`}
          aria-label="WayPass home"
          className="text-sm font-semibold"
        >
          WayPass
        </Link>
        <SchoolSwitcher schoolName={context.organization.name} variant="header" />
        <div className="ml-auto min-w-0">
          <UserMenu variant="header" />
        </div>
      </header>
      <main className="mx-auto w-full max-w-[66rem] flex-1 px-4 py-6 sm:px-8">
        <Outlet context={{ context, organizationId } satisfies SchoolOutletContext} />
      </main>
    </div>
  );
}

export function SchoolShell() {
  const { context } = useLoaderData<{ context: OrganizationContext }>();
  const organizationId = useParams().organizationId ?? context.organization.id;
  const location = useLocation();
  const { data: session } = useQuery(sessionQuery);
  const setupSession =
    session?.authenticated === true && session.authenticationMethod === 'setup' ? session : null;

  const outlet = { context, organizationId } satisfies SchoolOutletContext;

  if (isStudentOnly(context)) {
    return (
      <RealtimeProvider organizationId={organizationId}>
        {setupSession ? (
          <div className="px-4 py-2">
            <SetupAccessBanner
              compact
              deadlineLabel={formatSetupDeadline(setupSession.absoluteExpiresAt)}
            />
          </div>
        ) : null}
        <FocusedStudentShell context={context} organizationId={organizationId} />
      </RealtimeProvider>
    );
  }

  const groups = buildWorkspaceNav(context);
  const currentLabel = resolveCurrentLabel(location.pathname, organizationId, groups);

  return (
    <RealtimeProvider organizationId={organizationId}>
      <SidebarProvider>
        <WorkspaceSidebar context={context} organizationId={organizationId} />
        <SidebarInset>
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink render={<Link to={`/schools/${organizationId}`} />}>
                    {context.organization.name}
                  </BreadcrumbLink>
                </BreadcrumbItem>
                {currentLabel ? (
                  <>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{currentLabel}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </>
                ) : null}
              </BreadcrumbList>
            </Breadcrumb>
          </header>
          {setupSession ? (
            <div className="px-4 py-2">
              <SetupAccessBanner
                compact
                deadlineLabel={formatSetupDeadline(setupSession.absoluteExpiresAt)}
              />
            </div>
          ) : null}
          <main className="flex flex-1 flex-col gap-4 p-4">
            <Outlet context={outlet} />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </RealtimeProvider>
  );
}

export function useSchool(): SchoolOutletContext {
  return useOutletContext<SchoolOutletContext>();
}
