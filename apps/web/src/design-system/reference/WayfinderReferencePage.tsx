import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Alert } from '../primitives/Alert';
import { Button } from '../primitives/Button';
import { Checkbox, Switch } from '../primitives/ChoiceControls';
import { ComboBox } from '../primitives/ComboBox';
import { Dialog } from '../primitives/Dialog';
import { IconButton } from '../primitives/IconButton';
import { Menu } from '../primitives/Menu';
import { Popover } from '../primitives/Popover';
import { SearchField } from '../primitives/SearchField';
import { Select } from '../primitives/Select';
import { Skeleton } from '../primitives/Skeleton';
import { StatusAnnouncer } from '../primitives/StatusAnnouncer';
import { Tabs } from '../primitives/Tabs';
import { TextField } from '../primitives/TextField';
import { Tooltip } from '../primitives/Tooltip';
import { ConflictNotice } from '../patterns/ConflictNotice';
import { ConnectionStatus } from '../patterns/ConnectionStatus';
import { DestinationRow } from '../patterns/DestinationRow';
import { PassCard } from '../patterns/PassCard';
import { QueuePosition } from '../patterns/QueuePosition';
import { RecoveryBanner } from '../patterns/RecoveryBanner';
import { Route, RouteStop } from '../patterns/Route';
import { ActiveRestroomState, canonicalStudentStates } from './StudentStates';
import './reference.css';

type Density = 'comfortable' | 'standard' | 'compact';
type ExampleMode = 'normal' | 'pending' | 'error';

const destinations = [
  { id: 'restroom', label: 'Restroom', description: 'Nearest available restroom' },
  { id: 'nurse', label: 'Nurse', description: 'Health office' },
  { id: 'front-office', label: 'Front office' },
  { id: 'counselor', label: 'Counselor' },
];

const frameWidths = [
  { label: '320', value: '320px' },
  { label: '390', value: '390px' },
  { label: '768', value: '768px' },
  { label: 'Wide', value: '100%' },
];

function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <section className="wf-reference-section" id={id} aria-labelledby={`${id}-title`}>
      <header className="wf-reference-section__header">
        <p className="wf-reference-section__number" aria-hidden="true">
          {String(
            ['foundations', 'primitives', 'patterns', 'student-states', 'resilience'].indexOf(id) +
              1,
          ).padStart(2, '0')}
        </p>
        <div>
          <h2 className="wf-type-page-title" id={`${id}-title`}>
            {title}
          </h2>
          {intro && <p>{intro}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

function Example({
  title,
  children,
  className = '',
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <article className={`wf-example ${className}`.trim()}>
      <h3 className="wf-example__title">{title}</h3>
      <div className="wf-example__body">{children}</div>
    </article>
  );
}

export function WayfinderReferencePage() {
  const [density, setDensity] = useState<Density>('standard');
  const [exampleMode, setExampleMode] = useState<ExampleMode>('normal');
  const [frameWidth, setFrameWidth] = useState('390px');
  const [announcement, setAnnouncement] = useState('');

  return (
    <div className={`wf-reference wf-reference--${density}`}>
      <header className="wf-reference-hero">
        <div className="wf-reference-hero__topline">
          <span>Wayfinder</span>
          <span>Development reference · v0.2</span>
        </div>
        <div className="wf-reference-hero__content">
          <div className="wf-reference-route-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <div>
            <p className="wf-reference-kicker">WayPass design system</p>
            <h1 className="wf-type-display">
              Clear movement.
              <br />
              Honest evidence.
            </h1>
            <p>
              Foundations, accessible controls, and student states for a school day that should feel
              understandable—not administrative.
            </p>
          </div>
        </div>
      </header>

      <nav className="wf-reference-nav" aria-label="Wayfinder reference sections">
        <a href="#foundations">Foundations</a>
        <a href="#primitives">Primitives</a>
        <a href="#patterns">WayPass patterns</a>
        <a href="#student-states">Student states</a>
        <a href="#resilience">Accessibility</a>
      </nav>

      <aside className="wf-reference-controls" aria-label="Reference controls">
        <fieldset>
          <legend>Density</legend>
          {(['comfortable', 'standard', 'compact'] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="density"
                checked={density === value}
                onChange={() => {
                  setDensity(value);
                }}
              />
              {value}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Examples</legend>
          {(['normal', 'pending', 'error'] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="examples"
                checked={exampleMode === value}
                onChange={() => {
                  setExampleMode(value);
                }}
              />
              {value}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Student frame</legend>
          {frameWidths.map((width) => (
            <label key={width.value}>
              <input
                type="radio"
                name="frame"
                checked={frameWidth === width.value}
                onChange={() => {
                  setFrameWidth(width.value);
                }}
              />
              {width.label}
            </label>
          ))}
        </fieldset>
      </aside>

      <main className="wf-reference-main">
        <Section
          id="foundations"
          title="Foundations"
          intro="A warm canvas, Way blue, restrained signal color, and hierarchy that works before decoration."
        >
          <div className="wf-foundation-grid">
            <Example title="Color" className="wf-example--wide">
              <div className="wf-color-grid">
                {[
                  ['Text', 'var(--wf-color-text)'],
                  ['Canvas', 'var(--wf-surface-canvas)'],
                  ['Surface', 'var(--wf-surface-default)'],
                  ['Selected', 'var(--wf-surface-selected)'],
                  ['Way blue', 'var(--wf-action-primary)'],
                  ['Ready', 'var(--wf-status-ready)'],
                  ['Waiting', 'var(--wf-status-queued)'],
                  ['Danger', 'var(--wf-status-danger)'],
                  ['Signal', 'var(--wf-accent-signal)'],
                ].map(([name, color]) => (
                  <div className="wf-color-swatch" key={name}>
                    <span style={{ background: color }} />
                    <small>{name}</small>
                  </div>
                ))}
              </div>
            </Example>
            <Example title="Typography">
              <div className="wf-type-specimens">
                <p className="wf-type-display">Display</p>
                <p className="wf-type-page-title">Page title</p>
                <p className="wf-type-heading">Heading</p>
                <p className="wf-type-body">Body keeps instructions plain and readable.</p>
                <p className="wf-type-label">Persistent label</p>
              </div>
            </Example>
            <Example title="Spacing & radius">
              <div className="wf-spacing-specimens">
                {[2, 4, 8, 12, 16, 24, 32, 48, 64].map((space) => (
                  <div key={space}>
                    <span style={{ width: `${String(space)}px` }} />
                    {space}
                  </div>
                ))}
              </div>
              <div className="wf-radius-specimens">
                <span>4</span>
                <span>8</span>
                <span>10</span>
                <span>12</span>
                <span>16</span>
              </div>
            </Example>
            <Example title="Borders, elevation & focus">
              <div className="wf-foundation-surfaces">
                <button type="button" className="wf-demo-focus">
                  Focused control
                </button>
                <div>Ordinary surface</div>
                <div className="wf-foundation-floating">Floating surface</div>
              </div>
            </Example>
            <Example title="Motion">
              <p className="wf-muted">
                Short state transitions clarify interaction. Reduced-motion preferences make them
                effectively immediate.
              </p>
              <div className="wf-motion-demo" aria-hidden="true">
                <span />
              </div>
            </Example>
          </div>
        </Section>

        <Section
          id="primitives"
          title="Accessible primitives"
          intro="Native HTML where it is enough; React Aria where interaction gets difficult."
        >
          <div className="wf-example-grid">
            <Example title="Buttons">
              <div className="wf-cluster">
                <Button pending={exampleMode === 'pending'}>Start pass</Button>
                <Button variant="secondary">Review</Button>
                <Button variant="quiet">Cancel</Button>
                <Button variant="danger">Close destination</Button>
                <Button disabled>Unavailable</Button>
                <IconButton aria-label="More information">
                  <span aria-hidden="true">i</span>
                </IconButton>
              </div>
            </Example>
            <Example title="Fields">
              <div className="wf-stack">
                <TextField
                  id="student-name"
                  label="Student name"
                  helperText="Use the name shown in the directory."
                  defaultValue={exampleMode === 'normal' ? 'Avery Johnson' : ''}
                  error={exampleMode === 'error' ? 'Enter a student name.' : undefined}
                />
                <SearchField
                  label="Search destinations"
                  description="Results update as you type."
                />
              </div>
            </Example>
            <Example title="ComboBox & Select">
              <div className="wf-stack">
                <ComboBox
                  label="Destination"
                  description="Type or use the arrow keys."
                  options={destinations}
                  data-testid="destination-combobox"
                />
                <Select
                  label="Check-in mode"
                  options={[
                    { id: 'none', label: 'None' },
                    { id: 'optional', label: 'Optional' },
                    { id: 'required', label: 'Required' },
                  ]}
                  defaultValue="optional"
                />
              </div>
            </Example>
            <Example title="Checkbox & Switch">
              <div className="wf-stack">
                <Checkbox defaultSelected>Notify when ready</Checkbox>
                <Switch defaultSelected>Queue enabled</Switch>
              </div>
            </Example>
            <Example title="Tabs">
              <Tabs
                label="Destination detail"
                tabs={[
                  { id: 'status', label: 'Status', content: <p>Open · 3 students out</p> },
                  { id: 'rules', label: 'Rules', content: <p>Teacher approval required.</p> },
                ]}
              />
            </Example>
            <Example title="Menu, popover & tooltip">
              <div className="wf-cluster">
                <Menu
                  label="Destination actions"
                  trigger="Actions"
                  items={[
                    { id: 'rename', label: 'Rename destination' },
                    { id: 'close', label: 'Close destination', description: 'Stops new passes' },
                  ]}
                />
                <Popover trigger="What counts as recorded?" label="Recorded movement explanation">
                  <p>
                    Recorded means OpenHall received an explicit event from a supported workflow.
                  </p>
                </Popover>
                <Tooltip label="Expected return is an estimate">
                  <span aria-hidden="true">?</span>
                </Tooltip>
              </div>
            </Example>
            <Example title="Dialog">
              <Dialog trigger="Close Nurse" title="Close Nurse?" confirmLabel="Close destination">
                <p>Students won't be able to start new passes here.</p>
                <p>Students already out remain active.</p>
              </Dialog>
            </Example>
            <Example title="Alerts & skeletons">
              <div className="wf-stack">
                <Alert title="Schedule updated">
                  <p>The new availability starts tomorrow.</p>
                </Alert>
                <Alert tone="warning" title="Review needed">
                  <p>One rule needs your attention.</p>
                </Alert>
                <Alert tone="danger" title="Could not save">
                  <p>Your changes are still here.</p>
                </Alert>
                <div className="wf-stack" aria-label="Loading examples">
                  <Skeleton width="72%" />
                  <Skeleton height="3.5rem" />
                </div>
              </div>
            </Example>
          </div>
        </Section>

        <Section
          id="patterns"
          title="WayPass patterns"
          intro="Movement patterns encode what OpenHall knows, and clearly distinguish recorded evidence from intent."
        >
          <div className="wf-example-grid">
            <Example title="Lightweight restroom route">
              <Route>
                <RouteStop label="Room 214" evidence="recorded" detail="Departed" />
                <RouteStop label="Restroom" evidence="intended" detail="Destination" last />
              </Route>
            </Example>
            <Example title="Tracked nurse route">
              <Route>
                <RouteStop label="Room 214" evidence="recorded" detail="Departed" time="10:31" />
                <RouteStop label="Nurse" evidence="recorded" detail="Arrived" time="10:35" />
                <RouteStop label="Return" evidence="intended" last />
              </Route>
            </Example>
            <Example title="Pass card">
              <PassCard
                context="You're ready."
                title="Nurse"
                tone="ready"
                supporting={
                  <p>
                    Start by <time className="wf-tabular">10:42 AM</time>
                  </p>
                }
                primaryAction={<Button>Start pass</Button>}
              />
            </Example>
            <Example title="Destination rows">
              <div>
                <DestinationRow name="Restroom" />
                <DestinationRow name="Nurse" description="Health office" />
                <DestinationRow name="Front office" />
              </div>
            </Example>
            <Example title="Queue position">
              <div className="wf-cluster">
                <QueuePosition ahead={0} />
                <QueuePosition ahead={1} />
                <QueuePosition ahead={2} />
              </div>
            </Example>
            <Example title="Conflict notice">
              <ConflictNotice />
            </Example>
            <Example title="Connection status">
              <div className="wf-stack">
                <ConnectionStatus state="reconnecting" />
                <ConnectionStatus state="stale" lastConfirmed="10:42 AM" />
              </div>
            </Example>
            <Example title="Recovery banner">
              <RecoveryBanner />
            </Example>
          </div>
          <div className="wf-truth-comparison">
            <article>
              <p className="wf-truth-label wf-truth-label--wrong">Wrong</p>
              <h3>Restroom</h3>
              <ul>
                <li>✓ Departed</li>
                <li>✓ Arrived</li>
                <li>✓ Returning</li>
              </ul>
            </article>
            <article>
              <p className="wf-truth-label">Correct</p>
              <ActiveRestroomState />
            </article>
            <p>WayPass only shows movement checkpoints OpenHall actually recorded.</p>
          </div>
        </Section>

        <Section
          id="student-states"
          title="Canonical student states"
          intro="Static compositions establish state hierarchy without coupling presentation to backend contracts."
        >
          <div className="wf-student-frame-control-note">
            <span>Stress-test width</span>
            <strong>{frameWidths.find((item) => item.value === frameWidth)?.label}</strong>
          </div>
          <div className="wf-student-state-list" data-testid="canonical-student-states">
            {canonicalStudentStates.map((state) => (
              <article className="wf-student-state-example" key={state.id}>
                <h3>{state.title}</h3>
                <div
                  className="wf-demo-frame"
                  style={{ '--wf-demo-width': frameWidth } as CSSProperties}
                >
                  {state.content}
                </div>
              </article>
            ))}
          </div>
        </Section>

        <Section
          id="resilience"
          title="Accessibility & resilience"
          intro="Wayfinder remains understandable with keyboard, narrow reflow, large text, reduced motion, and forced colors."
        >
          <div className="wf-example-grid">
            <Example title="Status announcement">
              <p>Announcements are deliberate and scoped, not a globally noisy live stream.</p>
              <div className="wf-cluster">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAnnouncement("You're ready to start your pass.");
                  }}
                >
                  Announce ready
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAnnouncement('Live updates paused.');
                  }}
                >
                  Announce interruption
                </Button>
              </div>
              <StatusAnnouncer
                message={announcement}
                priority={announcement.includes('paused') ? 'assertive' : 'polite'}
              />
            </Example>
            <Example title="Resilience contract">
              <ul className="wf-resilience-list">
                <li>Real focus rings against canvas, surfaces, actions, and status treatments</li>
                <li>No primary horizontal scrolling at 320 CSS px</li>
                <li>Controls grow at 200% text sizing</li>
                <li>Motion is supplementary and reduced on request</li>
                <li>Structure survives forced colors through borders and labels</li>
                <li>No offline mutation queue or fabricated movement</li>
              </ul>
            </Example>
          </div>
        </Section>
      </main>

      <footer className="wf-reference-footer">
        <span>Wayfinder</span>
        <span>Development only · never shipped as a production route</span>
      </footer>
    </div>
  );
}
