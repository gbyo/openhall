import { useEffect, useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Temporal } from '@js-temporal/polyfill';
import { useParams } from 'react-router';
import { api, confirmed, requireData } from '../../../api/client';
import { ApiProblem, productMessage, UncertainCommandError } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import type { PolicyRule } from '../../../api/types';
import { Alert } from '../../../design-system/primitives/Alert';
import { Button } from '../../../design-system/primitives/Button';
import { ConflictNotice } from '../../../design-system/patterns/ConflictNotice';
import { useSchool } from '../../../app/school/SchoolShell';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';

interface PolicyBody {
  name: string;
  ruleType: 'schedule_boundary' | 'approval_requirement';
  scope: {
    kind: 'organization' | 'section' | 'destination';
    organizationId: string | null;
    sectionId: string | null;
    destinationId: string | null;
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
  validFrom: string;
  validUntil: string;
}

interface PolicyCommand {
  kind: 'save' | 'activate' | 'deactivate' | 'archive';
  key: string;
  etag: string;
  body?: PolicyBody;
}

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
    scopeId: rule.scope.sectionId ?? rule.scope.destinationId ?? '',
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
    validFrom: localDateTime(rule.validFrom, timeZone),
    validUntil: localDateTime(rule.validUntil, timeZone),
  };
}

export function Component() {
  const policyRuleId = useParams().policyRuleId ?? '';
  const { organizationId, context } = useSchool();
  const queryClient = useQueryClient();
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

  const destinations = useQuery({
    queryKey: queryKeys.destinations(organizationId),
    enabled: draft?.scopeKind === 'destination',
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/destinations', {
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
    onSuccess: () => {
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
      destinationId: draft.scopeKind === 'destination' ? draft.scopeId : null,
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
            approver: 'current_section_teacher',
          },
    overrideMode: draft.overrideMode,
    validFrom: instant(draft.validFrom, context.organization.timeZone),
    validUntil: instant(draft.validUntil, context.organization.timeZone),
  });
  const run = (kind: PolicyCommand['kind']) => {
    if (
      (kind === 'deactivate' || kind === 'archive') &&
      !window.confirm(
        kind === 'archive'
          ? `Archive ${rule.name}? It cannot be activated again.`
          : `Deactivate ${rule.name}? It will stop applying to new requests.`,
      )
    )
      return;
    mutate.mutate({ kind, key: crypto.randomUUID(), etag });
  };
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
    <section className="workspace">
      <header className="workspace__header">
        <p className="auth-kicker">
          {rule.archivedAt ? 'Archived' : rule.enabled ? 'Active' : 'Inactive'}
        </p>
        <h1 className="wf-type-page-title">{rule.name}</h1>
      </header>
      {conflict && (
        <>
          <ConflictNotice resourceName="policy" onReview={() => void detail.refetch()} />
          <div className="conflict-comparison">
            <p>
              <strong>Your edit</strong> {draft.name}
            </p>
            <p>
              <strong>Latest</strong> {rule.name}
            </p>
          </div>
        </>
      )}
      {mutate.isError && !conflict && (
        <Alert tone="danger" title="Policy change not confirmed">
          <p>{productMessage(mutate.error)}</p>
          {mutate.error instanceof UncertainCommandError && (
            <Button
              variant="secondary"
              onClick={() => {
                mutate.mutate(mutate.variables);
              }}
            >
              Check again
            </Button>
          )}
        </Alert>
      )}
      <form className="editor" onSubmit={submit}>
        <fieldset>
          <legend>Policy behavior</legend>
          <label>
            Name
            <input
              className="wf-input"
              value={draft.name}
              onChange={(event) => {
                setDraft({ ...draft, name: event.target.value });
              }}
              required
            />
          </label>
          <label>
            Applies to
            <select
              className="wf-input"
              value={draft.scopeKind}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  scopeKind: event.target.value as PolicyDraft['scopeKind'],
                  scopeId: '',
                });
              }}
            >
              <option value="organization">Whole school</option>
              <option value="section">One class</option>
              <option value="destination">One destination</option>
            </select>
          </label>
          {draft.scopeKind !== 'organization' && (
            <label>
              {draft.scopeKind === 'section' ? 'Class' : 'Destination'}
              <select
                className="wf-input"
                value={draft.scopeId}
                onChange={(event) => {
                  setDraft({ ...draft, scopeId: event.target.value });
                }}
                required
              >
                <option value="">Choose…</option>
                {draft.scopeKind === 'section'
                  ? sections.data?.sections.map((section) => (
                      <option key={section.id} value={section.id}>
                        {section.title}
                      </option>
                    ))
                  : destinations.data?.destinations.map((destination) => (
                      <option key={destination.id} value={destination.id}>
                        {destination.displayName ?? destination.serviceType}
                      </option>
                    ))}
              </select>
            </label>
          )}
          {rule.ruleType === 'schedule_boundary' ? (
            <>
              <p>Don't allow selected pass requests during the protected part of class.</p>
              <label>
                First minutes
                <input
                  className="wf-input"
                  type="number"
                  min="0"
                  value={draft.firstMinutes}
                  onChange={(event) => {
                    setDraft({ ...draft, firstMinutes: Number(event.target.value) });
                  }}
                />
              </label>
              <label>
                Last minutes
                <input
                  className="wf-input"
                  type="number"
                  min="0"
                  value={draft.lastMinutes}
                  onChange={(event) => {
                    setDraft({ ...draft, lastMinutes: Number(event.target.value) });
                  }}
                />
              </label>
              <ChoiceGroup
                legend="Block types"
                values={draft.blockKinds}
                choices={[
                  ['instructional', 'Class'],
                  ['lunch', 'Lunch'],
                  ['advisory', 'Advisory'],
                  ['transition', 'Transition'],
                  ['other', 'Other'],
                ]}
                onChange={(value, checked) => {
                  toggle('blockKinds', value, checked);
                }}
              />
            </>
          ) : (
            <p>Require the student's current classroom teacher to approve these requests.</p>
          )}
          <ChoiceGroup
            legend="Requests this policy affects"
            values={draft.requestSources}
            choices={[
              ['student_web', 'Student requests'],
              ['staff_web', 'Staff-created passes'],
            ]}
            onChange={(value, checked) => {
              toggle('requestSources', value, checked);
            }}
          />
          <label>
            Exceptions
            <select
              className="wf-input"
              value={draft.overrideMode}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  overrideMode: event.target.value as PolicyDraft['overrideMode'],
                });
              }}
            >
              <option value="never">No exception</option>
              <option value="authorized">Authorized staff may override</option>
              <option value="approval_required">
                Another authorized staff member must approve
              </option>
            </select>
          </label>
          <label>
            Priority
            <input
              className="wf-input"
              type="number"
              value={draft.priority}
              onChange={(event) => {
                setDraft({ ...draft, priority: Number(event.target.value) });
              }}
            />
          </label>
          <label>
            Starts (optional)
            <input
              className="wf-input"
              type="datetime-local"
              value={draft.validFrom}
              onChange={(event) => {
                setDraft({ ...draft, validFrom: event.target.value });
              }}
            />
          </label>
          <label>
            Ends (optional)
            <input
              className="wf-input"
              type="datetime-local"
              value={draft.validUntil}
              onChange={(event) => {
                setDraft({ ...draft, validUntil: event.target.value });
              }}
            />
          </label>
        </fieldset>
        <div className="editor__actions">
          <Button type="submit" pending={mutate.isPending}>
            Save changes
          </Button>
          <Button
            type="button"
            variant="quiet"
            onClick={() => {
              setDraft(draftFor(rule, context.organization.timeZone));
              mutate.reset();
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
      <div className="semantic-actions">
        {!rule.archivedAt && !rule.enabled && (
          <Button
            onClick={() => {
              run('activate');
            }}
          >
            Activate policy
          </Button>
        )}
        {rule.enabled && (
          <Button
            variant="secondary"
            onClick={() => {
              run('deactivate');
            }}
          >
            Deactivate policy
          </Button>
        )}
        {!rule.archivedAt && (
          <Button
            variant="danger"
            onClick={() => {
              run('archive');
            }}
          >
            Archive policy
          </Button>
        )}
      </div>
    </section>
  );
}

function ChoiceGroup({
  legend,
  values,
  choices,
  onChange,
}: {
  legend: string;
  values: readonly string[];
  choices: readonly (readonly [string, string])[];
  onChange: (value: string, checked: boolean) => void;
}) {
  return (
    <fieldset className="choice-group">
      <legend>{legend}</legend>
      {choices.map(([value, label]) => (
        <label key={value}>
          <input
            type="checkbox"
            checked={values.includes(value)}
            onChange={(event) => {
              onChange(value, event.target.checked);
            }}
          />{' '}
          {label}
        </label>
      ))}
    </fieldset>
  );
}
