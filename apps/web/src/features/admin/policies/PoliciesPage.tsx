import { useState, type SubmitEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Temporal } from '@js-temporal/polyfill';
import { Link } from 'react-router';
import { api, confirmed } from '../../../api/client';
import { productMessage, UncertainCommandError } from '../../../api/problems';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import { formString, formStrings } from '../../../api/forms';
import { Button } from '../../../design-system/primitives/Button';
import { Alert } from '../../../design-system/primitives/Alert';
import { useSchool } from '../../../app/school/SchoolShell';

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
  const policies = useQuery({
    queryKey: queryKeys.policies(organizationId),
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/policy-rules', {
          params: { path: { organizationId } },
        }),
      ),
  });
  const destinations = useQuery({
    queryKey: queryKeys.destinations(organizationId),
    enabled: creating && scopeKind === 'destination',
    queryFn: () =>
      confirmed(
        api.GET('/api/v1/organizations/{organizationId}/destinations', {
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
          destinationId: scopeKind === 'destination' ? scopeId : null,
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
            : {
                schemaVersion: 1,
                requestSources: sources,
                approver: 'current_section_teacher',
              },
        overrideMode: formString(data, 'overrideMode') as PolicyBody['overrideMode'],
        validFrom: optionalInstant(formString(data, 'validFrom'), context.organization.timeZone),
        validUntil: optionalInstant(formString(data, 'validUntil'), context.organization.timeZone),
      },
    });
  }
  return (
    <section className="workspace">
      <header className="workspace__header workspace__header--actions">
        <div>
          <p className="auth-kicker">Configuration</p>
          <h1 className="wf-type-page-title">Policies</h1>
          <p>Rules start inactive, so you can review them before students are affected.</p>
        </div>
        <Button
          onClick={() => {
            setCreating((value) => !value);
          }}
        >
          New policy
        </Button>
      </header>
      {create.isError && (
        <Alert tone="danger" title="Policy not created">
          <p>{productMessage(create.error)}</p>
          {create.error instanceof UncertainCommandError && (
            <Button
              variant="secondary"
              onClick={() => {
                create.mutate(create.variables);
              }}
            >
              Check again
            </Button>
          )}
        </Alert>
      )}
      {creating && (
        <form className="editor editor--compact" onSubmit={submit}>
          <fieldset>
            <legend>Policy behavior</legend>
            <label>
              Name
              <input className="wf-input" name="name" required />
            </label>
            <label>
              Rule type
              <select
                className="wf-input"
                name="ruleType"
                value={ruleType}
                onChange={(event) => {
                  setRuleType(event.target.value as PolicyBody['ruleType']);
                }}
              >
                <option value="schedule_boundary">Protect the beginning and end of class</option>
                <option value="approval_requirement">Require classroom teacher approval</option>
              </select>
            </label>
            <label>
              Applies to
              <select
                className="wf-input"
                name="scopeKind"
                value={scopeKind}
                onChange={(event) => {
                  setScopeKind(event.target.value as PolicyBody['scope']['kind']);
                }}
              >
                <option value="organization">Whole school</option>
                <option value="section">One class</option>
                <option value="destination">One destination</option>
              </select>
            </label>
            {scopeKind !== 'organization' && (
              <label>
                {scopeKind === 'section' ? 'Class' : 'Destination'}
                <select className="wf-input" name="scopeId" required>
                  {scopeKind === 'section'
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
            {ruleType === 'schedule_boundary' && (
              <>
                <label>
                  First minutes
                  <input
                    className="wf-input"
                    name="firstMinutes"
                    type="number"
                    min="0"
                    defaultValue="5"
                  />
                </label>
                <label>
                  Last minutes
                  <input
                    className="wf-input"
                    name="lastMinutes"
                    type="number"
                    min="0"
                    defaultValue="5"
                  />
                </label>
                <fieldset className="choice-group">
                  <legend>Block types</legend>
                  {[
                    ['instructional', 'Class'],
                    ['lunch', 'Lunch'],
                    ['advisory', 'Advisory'],
                    ['transition', 'Transition'],
                    ['other', 'Other'],
                  ].map(([value, label]) => (
                    <label key={value}>
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
              </>
            )}
            <fieldset className="choice-group">
              <legend>Requests this policy affects</legend>
              <label>
                <input type="checkbox" name="requestSources" value="student_web" defaultChecked />{' '}
                Student requests
              </label>
              <label>
                <input type="checkbox" name="requestSources" value="staff_web" /> Staff-created
                passes
              </label>
            </fieldset>
            <label>
              Exceptions
              <select className="wf-input" name="overrideMode">
                <option value="never">No exception</option>
                <option value="authorized">Authorized staff may make an exception</option>
                <option value="approval_required">Exception requires staff approval</option>
              </select>
            </label>
            <label>
              Priority
              <input className="wf-input" name="priority" type="number" defaultValue="100" />
            </label>
            <label>
              Starts (optional)
              <input className="wf-input" name="validFrom" type="datetime-local" />
            </label>
            <label>
              Ends (optional)
              <input className="wf-input" name="validUntil" type="datetime-local" />
            </label>
          </fieldset>
          <Button type="submit" pending={create.isPending}>
            Create inactive policy
          </Button>
        </form>
      )}
      <ul className="plain-list">
        {policies.data?.rules.map((rule) => (
          <li key={rule.id}>
            <div>
              <Link to={rule.id}>
                <strong>{rule.name}</strong>
              </Link>
              <span>
                {rule.ruleType === 'schedule_boundary' ? 'Schedule boundary' : 'Teacher approval'}
              </span>
            </div>
            <span>{rule.archivedAt ? 'Archived' : rule.enabled ? 'Active' : 'Inactive'}</span>
            <span>
              {rule.scope.kind === 'organization'
                ? 'Whole school'
                : rule.scope.kind === 'section'
                  ? 'One class'
                  : 'One destination'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
