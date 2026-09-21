import { useRef, useState, type MouseEvent } from 'react';
import { buttonVariants } from '@/components/ui/button';
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireError,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
} from '@/components/ui/questionnaire';
import { SetupLayout } from './SetupLayout';
import type { StepHandle } from './SetupLayout';
import { SetupProgress } from './SetupProgress';
import { SchoolFields } from './SchoolStep';
import { AdministratorFields } from './AdministratorStep';
import { SignInFields } from './SignInStep';
import { ReviewFields, type ReviewHandle } from './ReviewStep';

export type SetupItemName = 'school' | 'administrator' | 'sign-in' | 'review';

const ORDER: readonly SetupItemName[] = ['school', 'administrator', 'sign-in', 'review'];
const ITEMS = ORDER.map((name) => ({ name, required: true }));

/** The guided-setup flow controller is Questionnaire. It owns item order,
 * progress, Previous/Next/Submit visibility, focus transfer, and keyboard
 * navigation. Answer state stays in setup memory; per-step field validation
 * runs before advancing and the server remains authoritative.
 *
 * Known gap: Questionnaire's answer model is one Choice/Input answer per
 * item, so multi-field school/administrator/review steps cannot satisfy its
 * built-in required validation. Items run in controlled mode with external
 * validity shown through `invalid` + `QuestionnaireError`. */
export function GuidedSetupFlow() {
  const [item, setItem] = useState<SetupItemName>('school');
  const [invalid, setInvalid] = useState<Record<SetupItemName, boolean>>({
    school: false,
    administrator: false,
    'sign-in': false,
    review: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const schoolHandle = useRef<StepHandle | null>(null);
  const administratorHandle = useRef<StepHandle | null>(null);
  const signInHandle = useRef<StepHandle | null>(null);
  const reviewHandle = useRef<ReviewHandle | null>(null);

  const index = ORDER.indexOf(item);

  // Read refs at call time: they are assigned in child effects after render,
  // so snapshotting them during render would freeze them as null.
  function getHandle(name: SetupItemName): StepHandle | ReviewHandle | null {
    switch (name) {
      case 'school':
        return schoolHandle.current;
      case 'administrator':
        return administratorHandle.current;
      case 'sign-in':
        return signInHandle.current;
      case 'review':
        return reviewHandle.current;
    }
  }

  function goTo(name: SetupItemName): void {
    setItem(name);
  }

  function markInvalid(name: SetupItemName) {
    return (value: boolean) => {
      setInvalid((previous) =>
        previous[name] === value ? previous : { ...previous, [name]: value },
      );
    };
  }

  function advance(): void {
    if (getHandle(item)?.validateAndCommit()) {
      const next = ORDER[index + 1];
      if (next) goTo(next);
    }
  }

  async function submit(): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    try {
      await reviewHandle.current?.submit();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SetupLayout kicker="WayPass setup">
      <Questionnaire
        items={ITEMS}
        item={item}
        onItemChange={(name) => {
          goTo(name as SetupItemName);
        }}
      >
        <QuestionnaireProgress
          render={(_props: Record<string, unknown>, state: { current: number; total: number }) => (
            <SetupProgress current={state.current - 1} total={state.total} />
          )}
        />
        <QuestionnaireItem name="school" required invalid={invalid.school}>
          <SchoolFields handleRef={schoolHandle} onInvalidChange={markInvalid('school')} />
          <QuestionnaireError>Fix the highlighted fields to continue.</QuestionnaireError>
        </QuestionnaireItem>
        <QuestionnaireItem name="administrator" required invalid={invalid.administrator}>
          <AdministratorFields
            handleRef={administratorHandle}
            onInvalidChange={markInvalid('administrator')}
          />
          <QuestionnaireError>Fix the highlighted fields to continue.</QuestionnaireError>
        </QuestionnaireItem>
        <QuestionnaireItem name="sign-in" required invalid={invalid['sign-in']}>
          <SignInFields handleRef={signInHandle} onInvalidChange={markInvalid('sign-in')} />
          <QuestionnaireError>Fix the highlighted fields to continue.</QuestionnaireError>
        </QuestionnaireItem>
        <QuestionnaireItem name="review" required invalid={invalid.review}>
          <ReviewFields
            handleRef={reviewHandle}
            onInvalidChange={markInvalid('review')}
            onEdit={goTo}
          />
        </QuestionnaireItem>
        <QuestionnaireActions>
          <QuestionnairePrevious
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              const previous = ORDER[index - 1];
              if (previous) goTo(previous);
            }}
          >
            Back
          </QuestionnairePrevious>
          <QuestionnaireNext
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              advance();
            }}
          >
            Continue
          </QuestionnaireNext>
          <QuestionnaireSubmit
            render={(props: Record<string, unknown>) => (
              <button
                type="button"
                className={buttonVariants()}
                hidden={props.hidden as boolean | undefined}
                tabIndex={props.tabIndex as number | undefined}
                disabled={submitting}
                onClick={() => {
                  void submit();
                }}
              >
                {submitting ? 'Working…' : 'Create WayPass'}
              </button>
            )}
          />
        </QuestionnaireActions>
      </Questionnaire>
    </SetupLayout>
  );
}
