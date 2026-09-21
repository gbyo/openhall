import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { HugeiconsIcon } from '@hugeicons/react';
import { toast } from 'sonner';
import { Logout01Icon, UnfoldMoreIcon } from '@hugeicons/core-free-icons';
import { clearSessionMemory, getCsrfToken } from '../../api/session';
import { queryClient } from '../query-client';
import { meQuery } from '../queries';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';

async function signOut(all: boolean): Promise<void> {
  const path = all ? '/api/v1/auth/logout-all' : '/api/v1/auth/logout';
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'X-CSRF-Token': getCsrfToken() },
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error('Sign out was not confirmed.');
  clearSessionMemory();
  queryClient.clear();
  window.location.assign('/login');
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.slice(0, 1) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.slice(0, 1) ?? '') : '';
  return (first + last).toUpperCase() || 'W';
}

/**
 * Account menu in SidebarFooter: Avatar + person name with a DropdownMenu
 * for school switching and sign-out. Composes shadcn primitives only.
 */
export function UserMenu({ variant = 'sidebar' }: { variant?: 'sidebar' | 'header' }) {
  const { data: me } = useQuery(meQuery);
  const [signingOut, setSigningOut] = useState(false);
  const displayName = me?.person.displayName ?? 'Account';

  function handleSignOut(all: boolean) {
    setSigningOut(true);
    void signOut(all).catch(() => {
      toast.error('Couldn’t sign out. Try again.');
      setSigningOut(false);
    });
  }

  const menuContent = (
    <DropdownMenuContent align="end" side={variant === 'header' ? 'bottom' : 'top'} className="w-56">
      <DropdownMenuLabel>{displayName}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem render={<Link to="/schools" />}>View all schools</DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem
          disabled={signingOut}
          onClick={() => {
            handleSignOut(false);
          }}
        >
          <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={signingOut}
          onClick={() => {
            handleSignOut(true);
          }}
        >
          <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} />
          Sign out everywhere
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  );

  if (variant === 'header') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="sm" />}
          aria-label={`Account, signed in as ${displayName}`}
        >
          <span className="max-w-40 truncate">{displayName}</span>
          <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        {menuContent}
      </DropdownMenu>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<SidebarMenuButton size="lg" />}
            aria-label={`Account, signed in as ${displayName}`}
          >
            <Avatar className="size-8 rounded-lg">
              <AvatarFallback className="rounded-lg">{initials(displayName)}</AvatarFallback>
            </Avatar>
            <span className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{displayName}</span>
              <span className="truncate text-xs text-muted-foreground">Account</span>
            </span>
            <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={2} className="ml-auto" />
          </DropdownMenuTrigger>
          {menuContent}
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
