import { useEffect, useMemo, useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import type { QuestionnaireItemDefinition } from '@shadcn/react/questionnaire';
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
} from '@/components/ui/questionnaire';
import { ApiProblem } from '../../api/problems';
import { queryClient } from '../../app/query-client';
import { useSetup, type SignInChoice } from './setup-state';
import { initializeInstallation, prepareSchoolSignIn } from './setup-api';
import { SchoolNameQuestion, SchoolTimeZoneQuestion } from './school-questions';
import { AdminFamilyNameQuestion, AdminGivenNameQuestion } from './administrator-questions';
import {
  GenericClientIdQuestion,
  GenericClientSecretQuestion,
  GoogleClientIdQuestion,
  GoogleClientSecretQuestion,
  IssuerUrlQuestion,
  ProviderNameQuestion,
  SignInMethodQuestion,
} from './signin-questions';
import { ReviewItem } from './ReviewStep';

export type SetupQuestionName =
  | 'school-name'
  | 'school-timezone'
  | 'admin-given'
  | 'admin-family'
  | 'signin-method'
  | 'google-client-id'
  | 'google-client-secret'
  | 'provider-name'
  | 'issuer-url'
  | 'generic-client-id'
  | 'generic-client-secret'
  | 'review';

/** One QuestionnaireItem per question. Provider questions render only for
 * the selected sign-in method, so progress counts applicable questions. */
function visibleQuestions(choice: SignInChoice | null): SetupQuestionName[] {
  const names: SetupQuestionName[] = [
    'school-name',
    'school-timezone',
    'admin-given',
    'admin-family',
    'signin-method',
  ];
  if (choice === 'google') names.push('google-client-id', 'google-client-secret');
  if (choice === 'generic')
    names.push('provider-name', 'issuer-url', 'generic-client-id', 'generic-client-secret');
  names.push('review');
  return names;
}

const ITEM_DEFS: Record<SetupQuestionName, QuestionnaireItemDefinition> = {
  'school-name': { name: 'school-name', required: true },
  'school-timezone': { name: 'school-timezone', required: true },
  'admin-given': { name: 'admin-given', required: true },
  'admin-family': { name: 'admin-family', required: true },
  'signin-method': {
    name: 'signin-method',
    required: true,
    choices: [{ value: 'google' }, { value: 'generic' }, { value: 'later' }],
  },
  'google-client-id': { name: 'google-client-id', required: true },
  'google-client-secret': { name: 'google-client-secret', required: true },
  'provider-name': { name: 'provider-name', required: true },
  'issuer-url': { name: 'issuer-url', required: true },
  'generic-client-id': { name: 'generic-client-id', required: true },
  'generic-client-secret': { name: 'generic-client-secret', required: true },
  review: { name: 'review', required: true },
};

/** The guided-setup flow is Questionnaire: it owns item order, progress,
 * Previous/Next/Submit visibility, focus transfer, and keyboard navigation.
 * Answers live in setup memory; required validation is native per question
 * and the server remains authoritative. */
export function GuidedSetupFlow() {
  const { state, dispatch } = useSetup();
  const navigate = useNavigate();
  const [current, setCurrent] = useState<SetupQuestionName>('school-name');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const names = useMemo(() => visibleQuestions(state.choice), [state.choice]);
  const items = useMemo(() => names.map((name) => ITEM_DEFS[name]), [names]);

  useEffect(() => {
    if (!names.includes(current)) setCurrent('signin-method');
  }, [names, current]);

  async function submit(): Promise<void> {
    if (submitting) return;
    if (state.choice === null) {
      setCurrent('signin-method');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await initializeInstallation(state.operatorToken, {
        tenantName: state.school.organizationName,
        tenantSlug: state.school.organizationSlug || undefined,
        schoolName: state.school.name.trim(),
        schoolSlug: state.school.schoolSlug || undefined,
        schoolTimeZone: state.school.timeZone,
        adminGivenName: state.administrator.givenName.trim(),
        adminFamilyName: state.administrator.familyName.trim(),
        adminDisplayName: state.administrator.displayName.trim() || undefined,
      });
      // Secrets leave memory the moment they are no longer needed.
      const choice = state.choice;
      const provider = state.provider;
      dispatch({ type: 'reset' });
      await queryClient.invalidateQueries();
      if (choice === 'later') {
        await navigate('/');
        return;
      }
      const authorizationUrl = await prepareSchoolSignIn(
        choice === 'google'
          ? {
              providerPreset: 'google',
              clientId: provider.clientId.trim(),
              clientSecret: provider.clientSecret,
            }
          : {
              providerPreset: 'generic',
              clientId: provider.clientId.trim(),
              clientSecret: provider.clientSecret,
              providerName: provider.providerName.trim(),
              issuerUrl: provider.issuerUrl.trim(),
              providerKey: provider.providerKey.trim() || undefined,
              authMethod: provider.authMethod,
              scopes: provider.scopes.split(/[\s,]+/).filter((scope) => scope.length > 0),
            },
      );
      window.location.assign(authorizationUrl);
    } catch (cause) {
      if (cause instanceof ApiProblem) {
        if (cause.code === 'bootstrap_token_invalid') {
          dispatch({ type: 'lock' });
          await navigate('/setup', { state: { lockedOut: true } });
          return;
        }
        if (cause.code === 'bootstrap_unavailable') {
          setError('WayPass is already set up on this server. Sign in instead.');
        } else if (
          cause.code === 'provider_configuration_unsupported' ||
          cause.code === 'auth_provider_unavailable'
        ) {
          await navigate('/connect-sign-in', {
            state: { setupFailed: true, reason: cause.code },
          });
          return;
        } else if (cause.code === 'provider_setup_conflict') {
          setError('School sign-in is already connected. Sign in instead.');
        } else if (cause.code === 'invalid_bootstrap_draft') {
          setError('Check the school details and try again.');
          setCurrent('school-name');
          return;
        } else {
          setError('WayPass could not finish setup. Try again.');
        }
      } else {
        setError('WayPass could not connect. Check your connection and try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit();
  }

  return (
    <main className="min-h-dvh bg-background px-5 py-10 text-foreground sm:px-6">
      <Questionnaire
        items={items}
        item={current}
        onItemChange={(name) => {
          setCurrent(name as SetupQuestionName);
        }}
        onSubmit={handleSubmit}
        className="mx-auto w-full max-w-lg"
      >
        <QuestionnaireProgress />
        <SchoolNameQuestion />
        <SchoolTimeZoneQuestion />
        <AdminGivenNameQuestion />
        <AdminFamilyNameQuestion />
        <SignInMethodQuestion />
        {state.choice === 'google' ? (
          <>
            <GoogleClientIdQuestion />
            <GoogleClientSecretQuestion />
          </>
        ) : null}
        {state.choice === 'generic' ? (
          <>
            <ProviderNameQuestion />
            <IssuerUrlQuestion />
            <GenericClientIdQuestion />
            <GenericClientSecretQuestion />
          </>
        ) : null}
        <ReviewItem error={error} onEdit={setCurrent} />
        <QuestionnaireActions>
          <QuestionnairePrevious />
          <QuestionnaireNext />
          <QuestionnaireSubmit disabled={submitting}>
            {submitting ? 'Creating…' : 'Create WayPass'}
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </main>
  );
}
