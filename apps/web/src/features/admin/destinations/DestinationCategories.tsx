import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HugeiconsIcon } from '@hugeicons/react';
import { MoreHorizontalIcon } from '@hugeicons/core-free-icons';
import { api, confirmed, requireData } from '../../../api/client';
import { productMessage, UncertainCommandError } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import type { DestinationCategory } from '../../../api/types.js';
import { Link } from 'react-router';
import { useSchool } from '../../../app/school/SchoolShell';
import { PageHeader } from '../../../components/workspace/PageHeader';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  iconForCategoryKey,
  surfaceLabel,
} from '../../../lib/destination-category-presentation.js';
import { DestinationCategoryDialog, type CategoryFormValue } from './DestinationCategoryDialog.js';

function destinationCountLabel(count: number): string {
  return count === 1 ? '1 destination' : `${String(count)} destinations`;
}

export function DestinationCategories() {
  const { organizationId } = useSchool();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<{ category: DestinationCategory | null } | null>(null);
  const [confirmingArchive, setConfirmingArchive] = useState<DestinationCategory | null>(null);
  const categories = useQuery({
    queryKey: queryKeys.destinationCategories(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/destination-categories', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const destinations = useQuery({
    queryKey: queryKeys.destinations(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/destinations', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const counts = new Map<string, number>();
  for (const destination of destinations.data?.destinations ?? []) {
    if (destination.status === 'archived') continue;
    counts.set(destination.categoryId, (counts.get(destination.categoryId) ?? 0) + 1);
  }
  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.destinationCategories(organizationId),
    });
    void queryClient.invalidateQueries({ queryKey: queryKeys.destinations(organizationId) });
  };
  const save = useMutation({
    mutationFn: async ({ value, key }: { value: CategoryFormValue; key: string }) => {
      const headers = {
        'X-CSRF-Token': getCsrfToken(),
        'Idempotency-Key': key,
      };
      const editing = dialog?.category ?? null;
      if (!editing) {
        return confirmed(
          api.POST('/api/v1/organizations/{organizationId}/destination-categories', {
            params: { path: { organizationId }, header: { 'idempotency-key': key } },
            headers,
            body: { ...value, sortOrder: value.sortOrder },
          }),
        );
      }
      const detail = await api.GET('/api/v1/destination-categories/{categoryId}', {
        params: { path: { categoryId: editing.id } },
      });
      requireData(detail);
      const etag = detail.response.headers.get('etag') ?? '';
      return confirmed(
        api.PUT('/api/v1/destination-categories/{categoryId}', {
          params: {
            path: { categoryId: editing.id },
            header: { 'idempotency-key': key, 'if-match': etag },
          },
          headers: { ...headers, 'If-Match': etag },
          body: { ...value, sortOrder: value.sortOrder },
        }),
      );
    },
    onSuccess: () => {
      setDialog(null);
      refresh();
    },
  });
  const archive = useMutation({
    mutationFn: async ({ id, key }: { id: string; key: string }) => {
      const detail = await api.GET('/api/v1/destination-categories/{categoryId}', {
        params: { path: { categoryId: id } },
      });
      requireData(detail);
      const etag = detail.response.headers.get('etag') ?? '';
      return confirmed(
        api.POST('/api/v1/destination-categories/{categoryId}/archive', {
          params: {
            path: { categoryId: id },
            header: { 'idempotency-key': key, 'if-match': etag },
          },
          headers: {
            'X-CSRF-Token': getCsrfToken(),
            'Idempotency-Key': key,
            'If-Match': etag,
          },
        }),
      );
    },
    onSuccess: () => {
      setConfirmingArchive(null);
      refresh();
    },
  });
  const error = save.error ?? archive.error;
  const archiveInUse =
    archive.error && productMessage(archive.error).toLowerCase().includes('destination');

  return (
    <section aria-labelledby="categories-title" className="flex flex-col gap-4">
      <PageHeader
        title="Pass categories"
        breadcrumb={
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink render={<Link to=".." />}>Places</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>Pass categories</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        }
        description="School-defined groupings shown on the student WayPass home."
        actions={
          <Button
            onClick={() => {
              save.reset();
              setDialog({ category: null });
            }}
          >
            New pass category
          </Button>
        }
      />
      {error && !(archive.error && archiveInUse) && (
        <Alert variant="destructive">
          <AlertTitle>Category change not confirmed</AlertTitle>
          <AlertDescription>{productMessage(error)}</AlertDescription>
          {error instanceof UncertainCommandError && (
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (save.error) save.mutate(save.variables);
                  else if (archive.error) archive.mutate(archive.variables);
                }}
              >
                Check again
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      {archive.error && archiveInUse && (
        <Alert>
          <AlertTitle>Category still in use</AlertTitle>
          <AlertDescription>
            This category still contains destinations. Move or archive those destinations first.
          </AlertDescription>
        </Alert>
      )}
      {categories.isPending ? (
        <div role="status" aria-label="Loading categories" className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <span className="sr-only">Loading categories…</span>
        </div>
      ) : (categories.data?.categories ?? []).length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No pass categories yet.</EmptyTitle>
            <EmptyDescription>
              Create the first pass category with New category, then assign destinations to it.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup aria-label="Pass categories">
          {(categories.data?.categories ?? []).map((category) => (
            <Item key={category.id} variant="outline">
              <ItemMedia variant="icon">
                <HugeiconsIcon
                  icon={iconForCategoryKey(category.iconKey)}
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{category.name}</ItemTitle>
                <ItemDescription>
                  {surfaceLabel(category.studentSurface)} ·{' '}
                  {destinationCountLabel(counts.get(category.id) ?? 0)}
                </ItemDescription>
              </ItemContent>
              <Badge variant="secondary">{surfaceLabel(category.studentSurface)}</Badge>
              {category.status === 'archived' ? <Badge variant="outline">Archived</Badge> : null}
              <ItemActions>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="icon-sm" />}
                    aria-label={`Actions for ${category.name}`}
                  >
                    <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => {
                        save.reset();
                        setDialog({ category });
                      }}
                    >
                      Edit
                    </DropdownMenuItem>
                    {category.status !== 'archived' ? (
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => {
                          archive.reset();
                          setConfirmingArchive(category);
                        }}
                      >
                        Archive
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
      {dialog && (
        <DestinationCategoryDialog
          key={dialog.category?.id ?? 'new'}
          open
          category={dialog.category}
          pending={save.isPending}
          error={save.error ? productMessage(save.error) : null}
          onClose={() => {
            if (!save.isPending) setDialog(null);
          }}
          onSubmit={(value) => {
            save.mutate({ value, key: crypto.randomUUID() });
          }}
        />
      )}
      <AlertDialog
        open={confirmingArchive !== null}
        onOpenChange={(open) => {
          if (!open && !archive.isPending) setConfirmingArchive(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmingArchive ? `Archive ${confirmingArchive.name}?` : 'Archive category?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Destinations in this category keep working, but students will no longer see this
              grouping. Archive or move its destinations first if the server reports it is still in
              use.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep category</AlertDialogCancel>
            <AlertDialogAction
              disabled={archive.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (confirmingArchive && !archive.isPending)
                  archive.mutate({ id: confirmingArchive.id, key: crypto.randomUUID() });
              }}
            >
              {archive.isPending ? <Spinner data-icon="inline-start" /> : null}
              {archive.isPending ? 'Archiving…' : 'Archive category'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
