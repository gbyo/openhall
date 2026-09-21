import { useState, type SubmitEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Temporal } from '@js-temporal/polyfill';
import { api, confirmed, requireData } from '../../../api/client';
import { queryKeys } from '../../../api/query-keys';
import { getCsrfToken } from '../../../api/session';
import { formString } from '../../../api/forms';
import { Button } from '../../../design-system/primitives/Button';
import { Alert } from '../../../design-system/primitives/Alert';
import { useSchool } from '../../../app/school/SchoolShell';

type Tab = 'blocks' | 'templates' | 'calendar';
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
    mutationFn: (body: {
      code: string;
      displayName: string;
      kind: 'instructional' | 'lunch' | 'advisory' | 'transition' | 'other';
    }) => {
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
      kind: formString(data, 'kind') as 'instructional',
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
  return (
    <section className="workspace">
      <header className="workspace__header">
        <p className="auth-kicker">{context.organization.timeZone}</p>
        <h1 className="wf-type-page-title">Schedules</h1>
        <p>Blocks, day templates, and calendar assignments share one protected school schedule.</p>
      </header>
      <div className="segmented" role="tablist" aria-label="Schedule areas">
        {(['blocks', 'templates', 'calendar'] as const).map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => {
              setTab(value);
            }}
          >
            {value[0]?.toUpperCase()}
            {value.slice(1)}
          </button>
        ))}
      </div>
      {mutationError && (
        <Alert tone="danger" title="Schedule not changed">
          <p>Review the latest schedule and try again. Your entries are still visible.</p>
        </Alert>
      )}
      {tab === 'blocks' && (
        <div className="workspace__section">
          <form className="inline-form" onSubmit={addBlock}>
            <label>
              Code
              <input className="wf-input" name="code" required />
            </label>
            <label>
              Name
              <input className="wf-input" name="displayName" required />
            </label>
            <label>
              Type
              <select className="wf-input" name="kind">
                <option value="instructional">Class</option>
                <option value="lunch">Lunch</option>
                <option value="advisory">Advisory</option>
                <option value="transition">Transition</option>
                <option value="other">Other</option>
              </select>
            </label>
            <Button type="submit" pending={blockMutation.isPending}>
              Add block
            </Button>
          </form>
          <ul className="plain-list">
            {blocks.data?.blocks.map((block) => (
              <li key={block.id}>
                <strong>{block.displayName}</strong>
                <span>
                  {block.code} · {block.kind === 'instructional' ? 'Class' : block.kind}
                </span>
                <span>{block.status === 'active' ? 'Active' : 'Archived'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {tab === 'templates' && (
        <div className="workspace__section">
          <form className="inline-form" onSubmit={addTemplate}>
            <label>
              Template name
              <input className="wf-input" name="name" required />
            </label>
            <label>
              Block
              <select className="wf-input" name="blockId">
                {blocks.data?.blocks
                  .filter((block) => block.status === 'active')
                  .map((block) => (
                    <option key={block.id} value={block.id}>
                      {block.displayName}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Start
              <input className="wf-input" name="startsAt" type="time" required />
            </label>
            <label>
              End
              <input className="wf-input" name="endsAt" type="time" required />
            </label>
            <Button type="submit" pending={templateMutation.isPending}>
              Create template
            </Button>
          </form>
          <p className="form-help">
            Open a template to extend its timetable with additional block rows.
          </p>
          <ul className="plain-list">
            {templates.data?.templates.map((template) => (
              <li key={template.id}>
                <strong>{template.name}</strong>
                <span>
                  {template.slots.length} {template.slots.length === 1 ? 'block' : 'blocks'}
                </span>
                <span>{template.status === 'active' ? 'Active' : 'Archived'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {tab === 'calendar' && (
        <div className="workspace__section">
          <div className="range-controls">
            <label>
              View from
              <input
                className="wf-input"
                type="date"
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value);
                }}
              />
            </label>
            <label>
              Through
              <input
                className="wf-input"
                type="date"
                value={through}
                onChange={(event) => {
                  setThrough(event.target.value);
                }}
              />
            </label>
          </div>
          <form className="editor editor--compact" onSubmit={applyCalendar}>
            <fieldset>
              <legend>Assign a date range</legend>
              <label>
                From
                <input
                  className="wf-input"
                  name="rangeFrom"
                  type="date"
                  defaultValue={from}
                  required
                />
              </label>
              <label>
                Through
                <input
                  className="wf-input"
                  name="rangeThrough"
                  type="date"
                  defaultValue={through}
                  required
                />
              </label>
              <label>
                Day type
                <select className="wf-input" name="dayKind">
                  <option value="instructional">Instructional</option>
                  <option value="non_instructional">Non-instructional</option>
                  <option value="closed">Closed</option>
                </select>
              </label>
              <label>
                Template
                <select className="wf-input" name="templateId">
                  <option value="">None</option>
                  {templates.data?.templates
                    .filter((template) => template.status === 'active')
                    .map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Cycle code
                <input className="wf-input" name="cycleCode" />
              </label>
              <label>
                Operational note
                <input className="wf-input" name="operationalNote" />
              </label>
            </fieldset>
            <Button type="submit" pending={calendarMutation.isPending}>
              Review and apply range
            </Button>
          </form>
          <ul className="calendar-list">
            {calendar.data?.days.map((day) => (
              <li key={day.date}>
                <time>{day.date}</time>
                <strong>
                  {day.dayKind === 'instructional'
                    ? (day.templateName ?? 'Instructional')
                    : day.dayKind === 'closed'
                      ? 'Closed'
                      : 'Non-instructional'}
                </strong>
                <span>{day.cycleCode ?? day.operationalNote ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
