import { useEffect, useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Temporal } from '@js-temporal/polyfill';
import { Link, useParams } from 'react-router';
import { api, confirmed, requireData } from '../../../api/client';
import { ApiProblem, productMessage, UncertainCommandError } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import type { PolicyRule } from '../../../api/types';
import { ConflictNotice } from '../../../design-system/patterns/ConflictNotice';
import { useSchool } from '../../../app/school/SchoolShell';
import { readPolicyApprover, type PolicyApprover } from './policy-approvers.js';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { PageHeader } from '../../../components/workspace/PageHeader';
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
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';

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

interface PolicyDraft {
  name: string;
  scopeKind: PolicyBody['scope']['kind'];
  scopeId: string;
  priority: number;
  overrideMode: PolicyBody['overrideMode'];
  firstMinutes: number;
  lastMinutes: number;
  blockKinds: string[];
  requestSources: string[];
  approver: PolicyApprover;
  validFrom: string;
  validUntil: string;
}

interface PolicyCommand {
  kind: 'save' | 'activate' | 'deactivate' | 'archive';
  key: string;
  etag: string;
  body?: PolicyBody;
}

const BLOCK_KIND_CHOICES = [
  ['instructional', 'Class'],
  ['lunch', 'Lunch'],
  ['advisory', 'Advisory'],
  ['transition', 'Transition'],
  ['other', 'Other'],
] as const;

const SOURCE_CHOICES = [
  ['student_web', 'Student requests'],
  ['staff_web', 'Staff-created passes'],
] as const;

function localDateTime(value: string | null, timeZone: string): string {
  return value
    ? Temporal.Instant.from(value)
        .toZonedDateTimeISO(timeZone)
        .toPlainDateTime()
        .toString({ smallestUnit: 'minute' })
    : '';
}

function instant(value: string, timeZone: string): string | null {
  return value
    ? Temporal.PlainDateTime.from(value).toZonedDateTime(timeZone).toInstant().toString()
    : null;
}

function draftFor(rule: PolicyRule, timeZone: string): PolicyDraft {
  const configuration = rule.configuration;
  return {
    name: rule.name,
    scopeKind: rule.scope.kind,
    scopeId: rule.scope.sectionId ?? rule.scope.roomId ?? rule.scope.roomCategoryId ?? '',
    priority: rule.priority,
    overrideMode: rule.overrideMode,
    firstMinutes: typeof configuration.firstMinutes === 'number' ? configuration.firstMinutes : 5,
    lastMinutes: typeof configuration.lastMinutes === 'number' ? configuration.lastMinutes : 5,
    blockKinds: Array.isArray(configuration.blockKinds)
      ? configuration.blockKinds.filter((value): value is string => typeof value === 'string')
      : ['instructional'],
    requestSources: Array.isArray(configuration.requestSources)
      ? configuration.requestSources.filter((value): value is string => typeof value === 'string')
      : ['student_web'],
    approver: readPolicyApprover(configuration),
    validFrom: localDateTime(rule.validFrom, timeZone),
    validUntil: localDateTime(rule.validUntil, timeZone),
  };
}

function statusLabel(rule: PolicyRule): string {
  if (rule.archivedAt) return 'Archived';
  return rule.enabled ? 'Active' : 'Inactive';
}

export function Component() {
  const policyRuleId = useParams().policyRuleId ?? '';
  const { organizationId, context } = useSchool();
  const queryClient = useQueryClient();
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const detail = useQuery({
    queryKey: queryKeys.policy(policyRuleId),
    queryFn: async () => {
      const result = await api.GET('/api/v1/policy-rules/{policyRuleId}', {
        params: { path: { policyRuleId } },
      });
      return { rule: requireData(result).rule, etag: result.response.headers.get('etag') ?? '' };
    },
  });
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  useEffect(() => {
    if (detail.data && draft === null)
      setDraft(draftFor(detail.data.rule, context.organization.timeZone));
  }, [context.organization.timeZone, detail.data, draft]);
  const dirty = Boolean(
    detail.data &&
    draft &&
    JSON.stringify(draft) !==
      JSON.stringify(draftFor(detail.data.rule, context.organization.timeZone)),
  );
  useUnsavedChanges(dirty);

  const rooms = useQuery({
    queryKey: queryKeys.rooms(organizationId),
    enabled: draft?.scopeKind === 'room',
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/rooms', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const roomCategories = useQuery({
    queryKey: queryKeys.roomCategories(organizationId),
    enabled: draft?.scopeKind === 'room_category',
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/room-categories', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const sections = useQuery({
    queryKey: ['policy-sections', organizationId],
    enabled: draft?.scopeKind === 'section',
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/sections', {
          params: { path: { organizationId }, query: { limit: 100 } },
        }),
      ),
  });
  const mutate = useMutation({
    mutationFn: (command: PolicyCommand) => {
      const params = {
        path: { policyRuleId },
        header: { 'idempotency-key': command.key, 'if-match': command.etag },
      };
      const headers = {
        'X-CSRF-Token': getCsrfToken(),
        'Idempotency-Key': command.key,
        'If-Match': command.etag,
      };
      if (command.kind === 'save') {
        if (!command.body) throw new Error('Policy draft unavailable');
        return confirmed(
          api.PUT('/api/v1/policy-rules/{policyRuleId}', { params, headers, body: command.body }),
        );
      }
      if (command.kind === 'activate')
        return confirmed(
          api.POST('/api/v1/policy-rules/{policyRuleId}/activate', { params, headers }),
        );
      if (command.kind === 'deactivate')
        return confirmed(
          api.POST('/api/v1/policy-rules/{policyRuleId}/deactivate', { params, headers }),
        );
      return confirmed(
        api.POST('/api/v1/policy-rules/{policyRuleId}/archive', { params, headers }),
      );
    },
    onSuccess: (_, command) => {
      if (command.kind === 'archive') setConfirmingArchive(false);
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.policy(policyRuleId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.policies(organizationId) });
    },
  });

  if (!detail.data || !draft) return <p role="status">Loading policy…</p>;
  const rule = detail.data.rule;
  const etag = detail.data.etag;
  const toggle = (field: 'blockKinds' | 'requestSources', value: string, checked: boolean) => {
    setDraft({
      ...draft,
      [field]: checked
        ? [...new Set([...draft[field], value])]
        : draft[field].filter((item) => item !== value),
    });
  };
  const body = (): PolicyBody => ({
    name: draft.name,
    ruleType: rule.ruleType,
    scope: {
      kind: draft.scopeKind,
      organizationId: draft.scopeKind === 'organization' ? organizationId : null,
      sectionId: draft.scopeKind === 'section' ? draft.scopeId : null,
      roomId: draft.scopeKind === 'room' ? draft.scopeId : null,
      roomCategoryId: draft.scopeKind === 'room_category' ? draft.scopeId : null,
    },
    priority: draft.priority,
    configuration:
      rule.ruleType === 'schedule_boundary'
        ? {
            schemaVersion: 1,
            firstMinutes: draft.firstMinutes,
            lastMinutes: draft.lastMinutes,
            blockKinds: draft.blockKinds,
            requestSources: draft.requestSources,
          }
        : {
            schemaVersion: 1,
            requestSources: draft.requestSources,
            approver: draft.approver,
          },
    overrideMode: draft.overrideMode,
    validFrom: instant(draft.validFrom, context.organization.timeZone),
    validUntil: instant(draft.validUntil, context.organization.timeZone),
  });
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    mutate.mutate({
      kind: 'save',
      key: crypto.randomUUID(),
      etag,
      body: body(),
    });
  }
  const conflict = mutate.error instanceof ApiProblem && mutate.error.status === 412;
  return (
    <section className="grid gap-6">
      <PageHeader
        title={rule.name}
        description={
          rule.ruleType === 'schedule_boundary'
            ? "Don't allow selected pass requests during the protected part of class."
            : "Require the student's current classroom teacher to approve these requests."
        }
        breadcrumb={
          <Link
            to=".."
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Policies
          </Link>
        }
        actions={<Badge variant="secondary">{statusLabel(rule)}</Badge>}
      />
      {conflict && (
        <div className="grid gap-2">
          <ConflictNotice resourceName="policy" onReview={() => void detail.refetch()} />
          <div className="grid gap-1 text-sm">
            <p>
              <strong>Your edit</strong> {draft.name}
            </p>
            <p>
              <strong>Latest</strong> {rule.name}
            </p>
          </div>
        </div>
      )}
      {mutate.isError && !conflict && (
        <Alert variant="destructive">
          <AlertTitle>Policy change not confirmed</AlertTitle>
          <AlertDescription>{productMessage(mutate.error)}</AlertDescription>
          {mutate.error instanceof UncertainCommandError && (
            <AlertAction>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  mutate.mutate(mutate.variables);
                }}
              >
                Check again
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Policy behavior</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="policy-detail-name">Name</FieldLabel>
              <Input
                id="policy-detail-name"
                value={draft.name}
                onChange={(event) => {
                  setDraft({ ...draft, name: event.target.value });
                }}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="policy-detail-scope">Applies to</FieldLabel>
              <NativeSelect
                id="policy-detail-scope"
                value={draft.scopeKind}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    scopeKind: event.target.value as PolicyDraft['scopeKind'],
                    scopeId: '',
                  });
                }}
              >
                <NativeSelectOption value="organization">Whole school</NativeSelectOption>
                <NativeSelectOption value="section">One class</NativeSelectOption>
                <NativeSelectOption value="room">One room</NativeSelectOption>
                <NativeSelectOption value="room_category">One room category</NativeSelectOption>
              </NativeSelect>
            </Field>
            {draft.scopeKind !== 'organization' && (
              <Field>
                <FieldLabel htmlFor="policy-detail-scope-id">
                  {draft.scopeKind === 'section'
                    ? 'Class'
                    : draft.scopeKind === 'room_category'
                      ? 'Room category'
                      : 'Room'}
                </FieldLabel>
                <NativeSelect
                  id="policy-detail-scope-id"
                  value={draft.scopeId}
                  onChange={(event) => {
                    setDraft({ ...draft, scopeId: event.target.value });
                  }}
                  required
                >
                  <NativeSelectOption value="">Choose…</NativeSelectOption>
                  {draft.scopeKind === 'section'
                    ? sections.data?.sections.map((section) => (
                        <NativeSelectOption key={section.id} value={section.id}>
                          {section.title}
                        </NativeSelectOption>
                      ))
                    : draft.scopeKind === 'room_category'
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
            {rule.ruleType === 'approval_requirement' && (
              <Field>
                <FieldLabel htmlFor="policy-detail-approver">Who approves</FieldLabel>
                <NativeSelect
                  id="policy-detail-approver"
                  value={draft.approver}
                  onChange={(event) => {
                    setDraft({ ...draft, approver: event.target.value as PolicyApprover });
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
            {rule.ruleType === 'schedule_boundary' && (
              <>
                <Field>
                  <FieldLabel htmlFor="policy-detail-first">First minutes</FieldLabel>
                  <Input
                    id="policy-detail-first"
                    type="number"
                    min="0"
                    value={draft.firstMinutes}
                    onChange={(event) => {
                      setDraft({ ...draft, firstMinutes: Number(event.target.value) });
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="policy-detail-last">Last minutes</FieldLabel>
                  <Input
                    id="policy-detail-last"
                    type="number"
                    min="0"
                    value={draft.lastMinutes}
                    onChange={(event) => {
                      setDraft({ ...draft, lastMinutes: Number(event.target.value) });
                    }}
                  />
                </Field>
                <fieldset className="grid gap-2 sm:col-span-2">
                  <legend className="text-sm font-medium">Block types</legend>
                  {BLOCK_KIND_CHOICES.map(([value, label]) => (
                    <label key={value} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.blockKinds.includes(value)}
                        onChange={(event) => {
                          toggle('blockKinds', value, event.target.checked);
                        }}
                      />{' '}
                      {label}
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            <fieldset className="grid gap-2 sm:col-span-2">
              <legend className="text-sm font-medium">Requests this policy affects</legend>
              {SOURCE_CHOICES.map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.requestSources.includes(value)}
                    onChange={(event) => {
                      toggle('requestSources', value, event.target.checked);
                    }}
                  />{' '}
                  {label}
                </label>
              ))}
            </fieldset>
            <Field>
              <FieldLabel htmlFor="policy-detail-override">Exceptions</FieldLabel>
              <NativeSelect
                id="policy-detail-override"
                value={draft.overrideMode}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    overrideMode: event.target.value as PolicyDraft['overrideMode'],
                  });
                }}
              >
                <NativeSelectOption value="never">No exception</NativeSelectOption>
                <NativeSelectOption value="authorized">
                  Authorized staff may override
                </NativeSelectOption>
                <NativeSelectOption value="approval_required">
                  Another authorized staff member must approve
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="policy-detail-priority">Priority</FieldLabel>
              <Input
                id="policy-detail-priority"
                type="number"
                value={draft.priority}
                onChange={(event) => {
                  setDraft({ ...draft, priority: Number(event.target.value) });
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="policy-detail-from">Starts (optional)</FieldLabel>
              <Input
                id="policy-detail-from"
                type="datetime-local"
                value={draft.validFrom}
                onChange={(event) => {
                  setDraft({ ...draft, validFrom: event.target.value });
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="policy-detail-until">Ends (optional)</FieldLabel>
              <Input
                id="policy-detail-until"
                type="datetime-local"
                value={draft.validUntil}
                onChange={(event) => {
                  setDraft({ ...draft, validUntil: event.target.value });
                }}
              />
            </Field>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button type="submit" disabled={mutate.isPending}>
                {mutate.isPending ? <Spinner data-icon="inline-start" /> : null}
                {mutate.isPending ? 'Saving…' : 'Save changes'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDraft(draftFor(rule, context.organization.timeZone));
                  mutate.reset();
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <div className="flex flex-wrap gap-2">
        {!rule.archivedAt && !rule.enabled && (
          <Button
            onClick={() => {
              mutate.mutate({ kind: 'activate', key: crypto.randomUUID(), etag });
            }}
          >
            Activate policy
          </Button>
        )}
        {rule.enabled && (
          <Button
            variant="secondary"
            onClick={() => {
              setConfirmingDeactivate(true);
            }}
          >
            Deactivate policy
          </Button>
        )}
        {!rule.archivedAt && (
          <Button
            variant="destructive"
            onClick={() => {
              setConfirmingArchive(true);
            }}
          >
            Archive policy
          </Button>
        )}
      </div>
      <AlertDialog open={confirmingDeactivate} onOpenChange={setConfirmingDeactivate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {rule.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It will stop applying to new requests. You can activate it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep active</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmingDeactivate(false);
                mutate.mutate({ kind: 'deactivate', key: crypto.randomUUID(), etag });
              }}
            >
              Deactivate policy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmingArchive} onOpenChange={setConfirmingArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {rule.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It cannot be activated again. Existing history is preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep policy</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                mutate.mutate({ kind: 'archive', key: crypto.randomUUID(), etag });
              }}
            >
              Archive policy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
