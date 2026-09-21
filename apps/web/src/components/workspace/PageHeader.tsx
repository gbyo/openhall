import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}

/**
 * Workspace page heading composition (issue #17 PageHeader/PageActions).
 * Title plus a short description and an optional primary action slot.
 * No eyebrow/kicker: production screens must not read like the reference
 * gallery.
 */
export function PageHeader({ title, description, actions, breadcrumb }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="grid gap-1">
        {breadcrumb}
        <h1 className="text-lg font-semibold tracking-tight text-balance">{title}</h1>
        {description ? (
          <p className="text-sm text-muted-foreground text-pretty">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
