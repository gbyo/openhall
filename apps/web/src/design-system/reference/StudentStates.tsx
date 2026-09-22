import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ConnectionStatus } from '../patterns/ConnectionStatus';
import { RoomRow } from '../patterns/RoomRow';
import { PassCard } from '../patterns/PassCard';
import { QueuePosition } from '../patterns/QueuePosition';
import { Route, RouteStop } from '../patterns/Route';

function StudentHeader() {
  return (
    <header className="wf-student-header">
      <span className="wf-student-header__brand">WayPass</span>
      <span>Roosevelt Middle School</span>
    </header>
  );
}

function StudentFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <article className="wf-student-state" aria-label={label}>
      <StudentHeader />
      <div className="wf-student-state__body">{children}</div>
    </article>
  );
}

export function NoActivePassState() {
  return (
    <StudentFrame label="No active pass">
      <h3 className="wf-type-page-title">Where do you need to go?</h3>
      <div className="wf-destination-list">
        <RoomRow name="Restroom" />
        <RoomRow name="Nurse" />
        <RoomRow name="Front office" />
        <RoomRow name="Counselor" />
      </div>
      <aside className="wf-upcoming-pass">
        <p className="wf-type-label">Upcoming</p>
        <p>
          <strong>Counselor</strong> · <time className="wf-tabular">10:25 AM</time>
        </p>
      </aside>
    </StudentFrame>
  );
}

export function WaitingState() {
  return (
    <StudentFrame label="Waiting for approval">
      <PassCard
        context="Waiting for approval"
        title="Restroom"
        tone="queued"
        supporting={<p>Mrs. Smith · Algebra II</p>}
      >
        <p>No action needed.</p>
      </PassCard>
    </StudentFrame>
  );
}

export function StaffReviewState() {
  return (
    <StudentFrame label="Needs staff review">
      <PassCard context="This pass needs staff review." title="Restroom" tone="queued">
        <p>No action needed.</p>
      </PassCard>
    </StudentFrame>
  );
}

export function InLineState() {
  return (
    <StudentFrame label="In line">
      <PassCard context="You're in line." title="Restroom" tone="queued">
        <QueuePosition ahead={2} />
        <p>We'll let you know when it's your turn.</p>
      </PassCard>
    </StudentFrame>
  );
}

export function ReadyState({ starting = false }: { starting?: boolean }) {
  return (
    <StudentFrame label={starting ? 'Starting pass' : 'Ready'}>
      <PassCard
        context="You're ready."
        title="Restroom"
        tone="ready"
        supporting={
          <p>
            Start by <time className="wf-tabular">10:42 AM</time>
          </p>
        }
        primaryAction={
          <Button disabled={starting} aria-busy={starting}>
            {starting ? <Spinner data-icon="inline-start" /> : null}
            {starting ? 'Starting…' : 'Start pass'}
          </Button>
        }
      >
        {starting && <p role="status">Checking with WayPass…</p>}
      </PassCard>
    </StudentFrame>
  );
}

export function ActiveRestroomState() {
  return (
    <StudentFrame label="Active restroom pass">
      <PassCard
        context="Pass active"
        title="Restroom"
        tone="active"
        supporting={
          <>
            <p>
              <span className="wf-tabular">Started 4 min ago</span>
            </p>
            <p>
              Expected back around <time className="wf-tabular">10:48</time>
            </p>
          </>
        }
        primaryAction={<Button>I'm back</Button>}
      />
    </StudentFrame>
  );
}

export function TrackedNurseState() {
  return (
    <StudentFrame label="Tracked nurse pass">
      <PassCard context="Pass active" title="Nurse" tone="active">
        <Route label="Nurse pass route">
          <RouteStop label="Room 214" evidence="recorded" detail="Departed" time="10:31" />
          <RouteStop label="Nurse" evidence="recorded" detail="Arrived" time="10:35" />
          <RouteStop label="Return" evidence="intended" last />
        </Route>
      </PassCard>
    </StudentFrame>
  );
}

export function CompletedState() {
  return (
    <StudentFrame label="Completed pass">
      <PassCard
        context="Welcome back."
        title="Restroom"
        tone="complete"
        supporting={
          <p>
            <span className="wf-tabular">7 min</span>
          </p>
        }
      />
    </StudentFrame>
  );
}

export function UpcomingState() {
  return (
    <StudentFrame label="Upcoming scheduled pass">
      <PassCard
        context="Upcoming"
        title="Counselor"
        supporting={
          <>
            <p className="wf-upcoming-time wf-tabular">10:25 AM</p>
            <p>
              Available <span className="wf-tabular">10:20–10:40</span>
            </p>
          </>
        }
        primaryAction={<Button>Start WayPass</Button>}
      />
    </StudentFrame>
  );
}

export function ConnectivityState() {
  return (
    <StudentFrame label="Connectivity interruption">
      <ConnectionStatus state="stale" lastConfirmed="10:42 AM" />
      <PassCard
        context="Pass active"
        title="Restroom"
        tone="active"
        supporting={
          <p>
            <span className="wf-tabular">Started 4 min ago</span>
          </p>
        }
        primaryAction={<Button disabled>I'm back</Button>}
      />
    </StudentFrame>
  );
}

export const canonicalStudentStates = [
  { id: 'no-pass', title: '1 · No active pass', content: <NoActivePassState /> },
  { id: 'waiting', title: '2 · Waiting for approval', content: <WaitingState /> },
  { id: 'staff-review', title: '3 · Needs staff review', content: <StaffReviewState /> },
  { id: 'in-line', title: '4 · In line', content: <InLineState /> },
  { id: 'ready', title: '5 · Ready', content: <ReadyState /> },
  { id: 'starting', title: '6 · Starting', content: <ReadyState starting /> },
  {
    id: 'active-restroom',
    title: '7 · Active lightweight restroom pass',
    content: <ActiveRestroomState />,
  },
  { id: 'tracked-nurse', title: '8 · Tracked nurse pass', content: <TrackedNurseState /> },
  { id: 'completed', title: '9 · Completed', content: <CompletedState /> },
  { id: 'upcoming', title: '10 · Upcoming scheduled pass', content: <UpcomingState /> },
  { id: 'connectivity', title: '11 · Connectivity interruption', content: <ConnectivityState /> },
];
