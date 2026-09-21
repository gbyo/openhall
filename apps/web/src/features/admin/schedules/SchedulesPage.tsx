import { useState, type SubmitEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Temporal } from '@js-temporal/polyfill';
import { api, confirmed, requireData } from '../../../api/client';
import { productMessage } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import { formString } from '../../../api/forms';
import { useSchool } from '../../../app/school/SchoolShell';
import { PageHeader } from '../../../components/workspace/PageHeader';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type Tab = 'blocks' | 'templates' | 'calendar';

const BLOCK_KINDS = [
  ['instructional', 'Class'],
  ['lunch', 'Lunch'],
  ['advisory', 'Advisory'],
  ['transition', 'Transition'],
  ['other', 'Other'],
] as const;

type BlockKind = (typeof BLOCK_KINDS)[number][0];

function blockKindLabel(kind: string): string {
  return BLOCK_KINDS.find(([value]) => value === kind)?.[1] ?? kind;
}

function dayKindLabel(dayKind: string): string {
  switch (dayKind) {
    case 'instructional':
      return 'Instructional';
    case 'closed':
      return 'Closed';
    default:
      return 'Non-instructional';
  }
}

function command(etag: string) {
  const key = crypto.randomUUID();
  return {
    headers: { 'X-CSRF-Token': getCsrfToken(), 'Idempotency-Key': key, 'If-Match': etag },
    header: { 'idempotency-key': key, 'if-match': etag },
  };
}

export function Component() {
  const { organizationId, context } = useSchool();
  const [tab, setTab] = useState<Tab>('blocks');
  const [addingBlock, setAddingBlock] = useState(false);
  const today = Temporal.Now.zonedDateTimeISO(context.organization.timeZone).toPlainDate();
  const [from, setFrom] = useState(today.toString());
  const [through, setThrough] = useState(today.add({ days: 13 }).toString());
  const blocks = useQuery({
    queryKey: queryKeys.scheduleBlocks(organizationId),
    queryFn: async () => {
      const result = await api.GET('/api/v1/organizations/{organizationId}/schedule/blocks', {
        params: { path: { organizationId } },
      });
      return { ...requireData(result), etag: result.response.headers.get('etag') ?? '' };
    },
  });
  const templates = useQuery({
    queryKey: queryKeys.scheduleTemplates(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/schedule/templates', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const calendar = useQuery({
    queryKey: queryKeys.scheduleCalendar(organizationId, from, through),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/schedule/calendar', {
          params: { path: { organizationId }, query: { from, through } },
        }),
      ),
  });
  const blockMutation = useMutation({
    mutationFn: (body: { code: string; displayName: string; kind: BlockKind }) => {
      const request = command(blocks.data?.etag ?? '');
      return confirmed(
        api.POST('/api/v1/organizations/{organizationId}/schedule/blocks', {
          params: { path: { organizationId }, header: request.header },
          headers: request.headers,
          body,
        }),
      );
    },
    onSuccess: () => {
      setAddingBlock(false);
      void blocks.refetch();
    },
  });
  const templateMutation = useMutation({
    mutationFn: (body: {
      name: string;
      slots: { blockId: string; startsAt: string; endsAt: string }[];
    }) => {
      const request = command(blocks.data?.etag ?? '');
      return confirmed(
        api.POST('/api/v1/organizations/{organizationId}/schedule/templates', {
          params: { path: { organizationId }, header: request.header },
          headers: request.headers,
          body,
        }),
      );
    },
    onSuccess: () => {
      void blocks.refetch();
      void templates.refetch();
    },
  });
  const calendarMutation = useMutation({
    mutationFn: (body: {
      days: {
        date: string;
        dayKind: 'instructional' | 'non_instructional' | 'closed';
        templateId: string | null;
        cycleCode: string | null;
        operationalNote: string | null;
      }[];
    }) => {
      const request = command(blocks.data?.etag ?? '');
      return confirmed(
        api.PUT('/api/v1/organizations/{organizationId}/schedule/calendar', {
          params: { path: { organizationId }, header: request.header },
          headers: request.headers,
          body,
        }),
      );
    },
    onSuccess: () => {
      void blocks.refetch();
      void calendar.refetch();
    },
  });
  const mutationError = blockMutation.error ?? templateMutation.error ?? calendarMutation.error;
  function addBlock(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    blockMutation.mutate({
      code: formString(data, 'code'),
      displayName: formString(data, 'displayName'),
      kind: formString(data, 'kind') as BlockKind,
    });
  }
  function addTemplate(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    templateMutation.mutate({
      name: formString(data, 'name'),
      slots: [
        {
          blockId: formString(data, 'blockId'),
          startsAt: formString(data, 'startsAt'),
          endsAt: formString(data, 'endsAt'),
        },
      ],
    });
    event.currentTarget.reset();
  }
  function applyCalendar(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const dayKind = formString(data, 'dayKind') as 'instructional' | 'non_instructional' | 'closed';
    const start = Temporal.PlainDate.from(formString(data, 'rangeFrom'));
    const end = Temporal.PlainDate.from(formString(data, 'rangeThrough'));
    const days = [];
    for (let date = start; Temporal.PlainDate.compare(date, end) <= 0; date = date.add({ days: 1 }))
      days.push({
        date: date.toString(),
        dayKind,
        templateId: dayKind === 'instructional' ? formString(data, 'templateId') || null : null,
        cycleCode: formString(data, 'cycleCode') || null,
        operationalNote: formString(data, 'operationalNote') || null,
      });
    calendarMutation.mutate({ days });
  }
  const activeBlocks = (blocks.data?.blocks ?? []).filter((block) => block.status === 'active');
  const activeTemplates = (templates.data?.templates ?? []).filter(
    (template) => template.status === 'active',
  );
  return (
    <section className="grid gap-6">
      <PageHeader
        title="Schedules"
        description={`Blocks, day templates, and calendar assignments share one protected school schedule. Times use ${context.organization.timeZone}.`}
        actions={
          tab === 'blocks' ? (
            <Button
              onClick={() => {
                setAddingBlock(true);
              }}
            >
              New block
            </Button>
          ) : undefined
        }
      />
      {mutationError && (
        <Alert variant="destructive">
          <AlertTitle>Schedule not changed</AlertTitle>
          <AlertDescription>
            Review the latest schedule and try again. Your entries are still visible.{' '}
            {productMessage(mutationError)}
          </AlertDescription>
        </Alert>
      )}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value as Tab);
        }}
      >
        <TabsList aria-label="Schedule areas">
          <TabsTrigger value="blocks">Blocks</TabsTrigger>
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="calendar">Calendar</TabsTrigger>
        </TabsList>
        <TabsContent value="blocks" className="grid gap-4">
          {blocks.isPending ? (
            <div className="grid gap-2" role="status" aria-label="Loading blocks">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (blocks.data?.blocks ?? []).length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No blocks yet</EmptyTitle>
                <EmptyDescription>
                  Add the named parts of the school day before building templates.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table aria-label="Schedule blocks">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Code and type</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {blocks.data?.blocks.map((block) => (
                    <TableRow key={block.id}>
                      <TableCell className="font-medium">{block.displayName}</TableCell>
                      <TableCell>
                        {block.code} · {blockKindLabel(block.kind)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {block.status === 'active' ? 'Active' : 'Archived'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
        <TabsContent value="templates" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle>New template</CardTitle>
              <CardDescription>
                Start a day template with its first block. Open a template to extend its timetable
                with additional block rows.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4 sm:grid-cols-2" onSubmit={addTemplate}>
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="template-name">Template name</FieldLabel>
                  <Input id="template-name" name="name" required autoComplete="off" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="template-block">Block</FieldLabel>
                  <NativeSelect id="template-block" name="blockId">
                    {activeBlocks.map((block) => (
                      <NativeSelectOption key={block.id} value={block.id}>
                        {block.displayName}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel htmlFor="template-start">Start</FieldLabel>
                    <Input id="template-start" name="startsAt" type="time" required />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="template-end">End</FieldLabel>
                    <Input id="template-end" name="endsAt" type="time" required />
                  </Field>
                </div>
                <div className="sm:col-span-2">
                  <Button type="submit" disabled={templateMutation.isPending}>
                    {templateMutation.isPending ? <Spinner data-icon="inline-start" /> : null}
                    {templateMutation.isPending ? 'Creating…' : 'Create template'}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
          {templates.isPending ? (
            <div className="grid gap-2" role="status" aria-label="Loading templates">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (templates.data?.templates ?? []).length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No templates yet</EmptyTitle>
                <EmptyDescription>
                  Templates arrange blocks into reusable school days.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table aria-label="Day templates">
                <TableHeader>
                  <TableRow>
                    <TableHead>Template</TableHead>
                    <TableHead>Blocks</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {templates.data?.templates.map((template) => (
                    <TableRow key={template.id}>
                      <TableCell className="font-medium">{template.name}</TableCell>
                      <TableCell>
                        {template.slots.length} {template.slots.length === 1 ? 'block' : 'blocks'}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {template.status === 'active' ? 'Active' : 'Archived'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
        <TabsContent value="calendar" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Calendar range</CardTitle>
              <CardDescription>
                Choose the dates you want to review, then assign them in one protected change.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="calendar-from">View from</FieldLabel>
                <Input
                  id="calendar-from"
                  type="date"
                  value={from}
                  onChange={(event) => {
                    setFrom(event.target.value);
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="calendar-through">Through</FieldLabel>
                <Input
                  id="calendar-through"
                  type="date"
                  value={through}
                  onChange={(event) => {
                    setThrough(event.target.value);
                  }}
                />
              </Field>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Assign a date range</CardTitle>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4 sm:grid-cols-2" onSubmit={applyCalendar}>
                <Field>
                  <FieldLabel htmlFor="calendar-range-from">From</FieldLabel>
                  <Input
                    id="calendar-range-from"
                    name="rangeFrom"
                    type="date"
                    defaultValue={from}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="calendar-range-through">Through</FieldLabel>
                  <Input
                    id="calendar-range-through"
                    name="rangeThrough"
                    type="date"
                    defaultValue={through}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="calendar-day-kind">Day type</FieldLabel>
                  <NativeSelect id="calendar-day-kind" name="dayKind">
                    <NativeSelectOption value="instructional">Instructional</NativeSelectOption>
                    <NativeSelectOption value="non_instructional">
                      Non-instructional
                    </NativeSelectOption>
                    <NativeSelectOption value="closed">Closed</NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="calendar-template">Template</FieldLabel>
                  <NativeSelect id="calendar-template" name="templateId">
                    <NativeSelectOption value="">None</NativeSelectOption>
                    {activeTemplates.map((template) => (
                      <NativeSelectOption key={template.id} value={template.id}>
                        {template.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="calendar-cycle">Cycle code</FieldLabel>
                  <Input id="calendar-cycle" name="cycleCode" autoComplete="off" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="calendar-note">Operational note</FieldLabel>
                  <Input id="calendar-note" name="operationalNote" autoComplete="off" />
                </Field>
                <div className="sm:col-span-2">
                  <Button type="submit" disabled={calendarMutation.isPending}>
                    {calendarMutation.isPending ? <Spinner data-icon="inline-start" /> : null}
                    {calendarMutation.isPending ? 'Applying…' : 'Review and apply range'}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
          {calendar.isPending ? (
            <div className="grid gap-2" role="status" aria-label="Loading calendar">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (calendar.data?.days ?? []).length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No days in this range</EmptyTitle>
                <EmptyDescription>
                  Assign a date range above to build the school calendar.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table aria-label="Assigned calendar days">
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Day</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {calendar.data?.days.map((day) => (
                    <TableRow key={day.date}>
                      <TableCell>
                        <time>{day.date}</time>
                      </TableCell>
                      <TableCell className="font-medium">
                        {day.dayKind === 'instructional'
                          ? (day.templateName ?? 'Instructional')
                          : dayKindLabel(day.dayKind)}
                      </TableCell>
                      <TableCell>{day.cycleCode ?? day.operationalNote ?? ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>
      <Dialog
        open={addingBlock}
        onOpenChange={(open) => {
          if (!blockMutation.isPending) setAddingBlock(open);
        }}
      >
        <DialogContent aria-label="New block">
          <DialogHeader>
            <DialogTitle>New block</DialogTitle>
            <DialogDescription>
              Name a part of the school day. Templates arrange blocks into school days.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={addBlock}>
            <Field>
              <FieldLabel htmlFor="block-code">Code</FieldLabel>
              <Input id="block-code" name="code" required autoComplete="off" />
            </Field>
            <Field>
              <FieldLabel htmlFor="block-name">Name</FieldLabel>
              <Input id="block-name" name="displayName" required autoComplete="off" />
            </Field>
            <Field>
              <FieldLabel htmlFor="block-kind">Type</FieldLabel>
              <NativeSelect id="block-kind" name="kind">
                {BLOCK_KINDS.map(([value, label]) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={blockMutation.isPending}>
                {blockMutation.isPending ? <Spinner data-icon="inline-start" /> : null}
                {blockMutation.isPending ? 'Adding…' : 'Add block'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
