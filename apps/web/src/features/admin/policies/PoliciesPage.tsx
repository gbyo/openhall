import { useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Temporal } from '@js-temporal/polyfill';
import { Link } from 'react-router';
import { api, confirmed } from '../../../api/client';
import { productMessage, UncertainCommandError } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import { formString, formStrings } from '../../../api/forms';
import { useSchool } from '../../../app/school/SchoolShell';
import type { PolicyApprover } from './policy-approvers.js';
import { PageHeader } from '../../../components/workspace/PageHeader';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
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

interface PolicyBody {
  name: string;
  ruleType: 'schedule_boundary' | 'approval_requirement';
  scope: {
    kind: 'organization' | 'section' | 'room' | 'room_category';
    organizationId: string | null;
    sectionId: string | null;
    roomId: string | null;
    roomCategoryId: string | null;
  };
  priority: number;
  configuration: Record<string, unknown>;
  overrideMode: 'never' | 'authorized' | 'approval_required';
  validFrom: string | null;
  validUntil: string | null;
}

const BLOCK_KIND_CHOICES = [
  ['instructional', 'Class'],
  ['lunch', 'Lunch'],
  ['advisory', 'Advisory'],
  ['transition', 'Transition'],
  ['other', 'Other'],
] as const;

function ruleTypeLabel(ruleType: string): string {
  return ruleType === 'schedule_boundary' ? 'Schedule boundary' : 'Teacher approval';
}

function scopeLabel(kind: string): string {
  switch (kind) {
    case 'section':
      return 'One class';
    case 'room':
      return 'One room';
    case 'room_category':
      return 'One room category';
    default:
      return 'Whole school';
  }
}

function optionalInstant(local: string, timeZone: string): string | null {
  return local
    ? Temporal.PlainDateTime.from(local).toZonedDateTime(timeZone).toInstant().toString()
    : null;
}

export function Component() {
  const { organizationId, context } = useSchool();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [ruleType, setRuleType] = useState<PolicyBody['ruleType']>('schedule_boundary');
  const [scopeKind, setScopeKind] = useState<PolicyBody['scope']['kind']>('organization');
  const [approver, setApprover] = useState<PolicyApprover>('current_section_teacher');
  const policies = useQuery({
    queryKey: queryKeys.policies(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/policy-rules', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const rooms = useQuery({
    queryKey: queryKeys.rooms(organizationId),
    enabled: creating && scopeKind === 'room',
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/rooms', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const roomCategories = useQuery({
    queryKey: queryKeys.roomCategories(organizationId),
    enabled: creating && scopeKind === 'room_category',
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/room-categories', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const sections = useQuery({
    queryKey: ['policy-sections', organizationId],
    enabled: creating && scopeKind === 'section',
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/sections', {
          params: { path: { organizationId }, query: { limit: 100 } },
        }),
      ),
  });
  const create = useMutation({
    mutationFn: (input: { key: string; body: PolicyBody }) => {
      return confirmed(
        api.POST('/api/v1/organizations/{organizationId}/policy-rules', {
          params: { path: { organizationId }, header: { 'idempotency-key': input.key } },
          headers: { 'X-CSRF-Token': getCsrfToken(), 'Idempotency-Key': input.key },
          body: input.body,
        }),
      );
    },
    onSuccess: () => {
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.policies(organizationId) });
    },
  });
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const sources = formStrings(data, 'requestSources');
    const scopeId = formString(data, 'scopeId');
    create.mutate({
      key: crypto.randomUUID(),
      body: {
        name: formString(data, 'name'),
        ruleType,
        scope: {
          kind: scopeKind,
          organizationId: scopeKind === 'organization' ? organizationId : null,
          sectionId: scopeKind === 'section' ? scopeId : null,
          roomId: scopeKind === 'room' ? scopeId : null,
          roomCategoryId: scopeKind === 'room_category' ? scopeId : null,
        },
        priority: Number(data.get('priority')),
        configuration:
          ruleType === 'schedule_boundary'
            ? {
                schemaVersion: 1,
                firstMinutes: Number(data.get('firstMinutes')),
                lastMinutes: Number(data.get('lastMinutes')),
                blockKinds: formStrings(data, 'blockKinds'),
                requestSources: sources,
              }
            : { schemaVersion: 1, requestSources: sources, approver },
        overrideMode: formString(data, 'overrideMode') as PolicyBody['overrideMode'],
        validFrom: optionalInstant(formString(data, 'validFrom'), context.organization.timeZone),
        validUntil: optionalInstant(formString(data, 'validUntil'), context.organization.timeZone),
      },
    });
  }
  const rules = policies.data?.rules ?? [];
  return (
    <section className="grid gap-6">
      <PageHeader
        title="Policies"
        description="Rules start inactive, so you can review them before students are affected."
        actions={
          <Button
            onClick={() => {
              create.reset();
              setCreating(true);
            }}
          >
            New policy
          </Button>
        }
      />
      {create.isError && (
        <Alert variant="destructive">
          <AlertTitle>Policy not created</AlertTitle>
          <AlertDescription>{productMessage(create.error)}</AlertDescription>
          {create.error instanceof UncertainCommandError && (
            <AlertAction>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  create.mutate(create.variables);
                }}
              >
                Check again
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      {policies.isPending ? (
        <div className="grid gap-2" role="status" aria-label="Loading policies">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : rules.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No policies yet</EmptyTitle>
            <EmptyDescription>
              Create a rule to shape when passes need extra protection or approval.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table aria-label="Policies">
            <TableHeader>
              <TableRow>
                <TableHead>Policy</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <Link to={rule.id} className="font-medium underline-offset-4 hover:underline">
                      {rule.name}
                    </Link>
                  </TableCell>
                  <TableCell>{ruleTypeLabel(rule.ruleType)}</TableCell>
                  <TableCell>{scopeLabel(rule.scope.kind)}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {rule.archivedAt ? 'Archived' : rule.enabled ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!create.isPending) setCreating(open);
        }}
      >
        <DialogContent aria-label="New policy" className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New policy</DialogTitle>
            <DialogDescription>
              The rule starts inactive so you can review it before students are affected.
            </DialogDescription>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={submit}>
            <Field>
              <FieldLabel htmlFor="policy-name">Name</FieldLabel>
              <Input id="policy-name" name="name" required autoComplete="off" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="policy-rule-type">Rule type</FieldLabel>
                <NativeSelect
                  id="policy-rule-type"
                  name="ruleType"
                  value={ruleType}
                  onChange={(event) => {
                    setRuleType(event.target.value as PolicyBody['ruleType']);
                  }}
                >
                  <NativeSelectOption value="schedule_boundary">
                    Protect the beginning and end of class
                  </NativeSelectOption>
                  <NativeSelectOption value="approval_requirement">
                    Require approval before the pass starts
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="policy-scope">Applies to</FieldLabel>
                <NativeSelect
                  id="policy-scope"
                  name="scopeKind"
                  value={scopeKind}
                  onChange={(event) => {
                    setScopeKind(event.target.value as PolicyBody['scope']['kind']);
                  }}
                >
                  <NativeSelectOption value="organization">Whole school</NativeSelectOption>
                  <NativeSelectOption value="section">One class</NativeSelectOption>
                  <NativeSelectOption value="room">One room</NativeSelectOption>
                  <NativeSelectOption value="room_category">One room category</NativeSelectOption>
                </NativeSelect>
              </Field>
            </div>
            {scopeKind !== 'organization' && (
              <Field>
                <FieldLabel htmlFor="policy-scope-id">
                  {scopeKind === 'section'
                    ? 'Class'
                    : scopeKind === 'room_category'
                      ? 'Room category'
                      : 'Room'}
                </FieldLabel>
                <NativeSelect id="policy-scope-id" name="scopeId" required>
                  {scopeKind === 'section'
                    ? sections.data?.sections.map((section) => (
                        <NativeSelectOption key={section.id} value={section.id}>
                          {section.title}
                        </NativeSelectOption>
                      ))
                    : scopeKind === 'room_category'
                      ? roomCategories.data?.categories.map((category) => (
                          <NativeSelectOption key={category.id} value={category.id}>
                            {category.name}
                          </NativeSelectOption>
                        ))
                      : rooms.data?.rooms.map((room) => (
                          <NativeSelectOption key={room.id} value={room.id}>
                            {room.name}
                          </NativeSelectOption>
                        ))}
                </NativeSelect>
              </Field>
            )}
            {ruleType === 'approval_requirement' && (
              <Field>
                <FieldLabel htmlFor="policy-approver">Who approves</FieldLabel>
                <NativeSelect
                  id="policy-approver"
                  name="approver"
                  value={approver}
                  onChange={(event) => {
                    setApprover(event.target.value as PolicyApprover);
                  }}
                >
                  <NativeSelectOption value="current_section_teacher">
                    The student&apos;s current class teacher
                  </NativeSelectOption>
                  <NativeSelectOption value="room_responsible_staff">
                    Staff responsible for the destination room
                  </NativeSelectOption>
                </NativeSelect>
                <FieldDescription>
                  Independent of where the rule applies: a room rule can still ask the class
                  teacher.
                </FieldDescription>
              </Field>
            )}
            {ruleType === 'schedule_boundary' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="policy-first-minutes">First minutes</FieldLabel>
                  <Input
                    id="policy-first-minutes"
                    name="firstMinutes"
                    type="number"
                    min="0"
                    defaultValue="5"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="policy-last-minutes">Last minutes</FieldLabel>
                  <Input
                    id="policy-last-minutes"
                    name="lastMinutes"
                    type="number"
                    min="0"
                    defaultValue="5"
                  />
                </Field>
                <fieldset className="grid gap-2 sm:col-span-2">
                  <legend className="text-sm font-medium">Block types</legend>
                  {BLOCK_KIND_CHOICES.map(([value, label]) => (
                    <label key={value} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="blockKinds"
                        value={value}
                        defaultChecked={value === 'instructional'}
                      />{' '}
                      {label}
                    </label>
                  ))}
                </fieldset>
              </div>
            )}
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Requests this policy affects</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="requestSources" value="student_web" defaultChecked />{' '}
                Student requests
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="requestSources" value="staff_web" /> Staff-created
                passes
              </label>
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="policy-override">Exceptions</FieldLabel>
                <NativeSelect id="policy-override" name="overrideMode">
                  <NativeSelectOption value="never">No exception</NativeSelectOption>
                  <NativeSelectOption value="authorized">
                    Authorized staff may make an exception
                  </NativeSelectOption>
                  <NativeSelectOption value="approval_required">
                    Exception requires staff approval
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="policy-priority">Priority</FieldLabel>
                <Input id="policy-priority" name="priority" type="number" defaultValue="100" />
              </Field>
              <Field>
                <FieldLabel htmlFor="policy-valid-from">Starts (optional)</FieldLabel>
                <Input id="policy-valid-from" name="validFrom" type="datetime-local" />
              </Field>
              <Field>
                <FieldLabel htmlFor="policy-valid-until">Ends (optional)</FieldLabel>
                <Input id="policy-valid-until" name="validUntil" type="datetime-local" />
              </Field>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? <Spinner data-icon="inline-start" /> : null}
                {create.isPending ? 'Creating…' : 'Create inactive policy'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
