import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { Tick02Icon, UnfoldMoreIcon } from '@hugeicons/core-free-icons';
import { queryClient } from '../query-client';
import { organizationsQuery } from '../queries';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/components/ui/sidebar';

function SchoolMark({ name }: { name: string }) {
  const initial = name.trim().slice(0, 1).toUpperCase() || 'S';
  return (
    <span
      aria-hidden="true"
      className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"
    >
      <span className="text-sm font-semibold">{initial}</span>
    </span>
  );
}

/**
 * School/workspace switcher following the official shadcn Sidebar
 * team-switcher pattern: SidebarMenu + DropdownMenu in SidebarHeader.
 * One school renders the current school with no switch action.
 */
export function SchoolSwitcher({
  schoolName,
  variant = 'sidebar',
}: {
  schoolName: string;
  variant?: 'sidebar' | 'header';
}) {
  const { data, isPending, isError, refetch } = useQuery(organizationsQuery);
  const organizationId = useParams().organizationId;
  const navigate = useNavigate();

  if (isError) {
    if (variant === 'header') {
      return (
        <div className="flex items-center gap-2">
          <span role="alert" className="sr-only">
            Couldn’t load schools.
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void refetch();
            }}
          >
            Try schools again
          </Button>
        </div>
      );
    }

    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <div role="alert" className="px-2 py-1.5 text-xs text-destructive">
            Couldn’t load schools.
          </div>
          <SidebarMenuButton
            onClick={() => {
              void refetch();
            }}
          >
            Try again
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  if (isPending) {
    if (variant === 'header') {
      return (
        <Button variant="ghost" size="sm" disabled>
          <span className="max-w-48 truncate">{schoolName}</span>
        </Button>
      );
    }

    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const schools = data.organizations;

  async function switchSchool(nextId: string) {
    if (!nextId || nextId === organizationId) return;
    await queryClient.invalidateQueries();
    await navigate(`/schools/${nextId}`);
  }

  if (variant === 'header') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="sm" />}
          aria-label={`Switch school, current school ${schoolName}`}
        >
          <span className="max-w-48 truncate">{schoolName}</span>
          <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="bottom" className="w-56">
          <DropdownMenuLabel>Schools</DropdownMenuLabel>
          {schools.map((school) => (
            <DropdownMenuItem
              key={school.id}
              disabled={school.id === organizationId}
              onClick={() => void switchSchool(school.id)}
            >
              <span className="truncate">{school.name}</span>
              {school.id === organizationId ? (
                <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="ml-auto" />
              ) : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<Link to="/schools" />}>View all schools</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (schools.length <= 1) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" render={<span />}>
            <SchoolMark name={schoolName} />
            <span className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{schoolName}</span>
              <span className="truncate text-xs text-muted-foreground">WayPass</span>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" />}
            aria-label={`Switch school, current school ${schoolName}`}
          >
            <SchoolMark name={schoolName} />
            <span className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{schoolName}</span>
              <span className="truncate text-xs text-muted-foreground">WayPass</span>
            </span>
            <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={2} className="ml-auto" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom" className="w-56">
            <DropdownMenuLabel>Schools</DropdownMenuLabel>
            {schools.map((school) => (
              <DropdownMenuItem
                key={school.id}
                disabled={school.id === organizationId}
                onClick={() => void switchSchool(school.id)}
              >
                <span className="truncate">{school.name}</span>
                {school.id === organizationId ? (
                  <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="ml-auto" />
                ) : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link to="/schools" />}>View all schools</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
