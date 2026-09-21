import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireTitle,
} from '@/components/ui/questionnaire';
import { useSetup, type SignInChoice } from './setup-state';

const METHOD_OPTIONS: readonly {
  value: SignInChoice;
  title: string;
  description: string;
}[] = [
  {
    value: 'google',
    title: 'Google Workspace',
    description:
      "Use your school's Google accounts. Recommended for schools using Google Workspace.",
  },
  {
    value: 'generic',
    title: 'Another OpenID Connect provider',
    description: 'Connect any standards-based sign-in service your school already uses.',
  },
  {
    value: 'later',
    title: 'Set up sign-in later',
    description:
      'Start configuring WayPass now and connect your school’s sign-in afterward. This browser will receive temporary setup access.',
  },
];

/** The sign-in method is a canonical single-choice question controlled by
 * the single setup-state selection. Provider secrets stay in memory and the
 * server owns issuer, scopes, keys, and auth method for Google. */
export function SignInMethodQuestion() {
  const { state, dispatch } = useSetup();

  return (
    <QuestionnaireItem name="signin-method" required>
      <QuestionnaireTitle>How should people sign in?</QuestionnaireTitle>
      <QuestionnaireDescription>
        Choose the sign-in your school will use every day.
      </QuestionnaireDescription>
      <QuestionnaireChoices aria-label="Sign-in options">
        {METHOD_OPTIONS.map((option) => (
          <QuestionnaireChoice
            key={option.value}
            value={option.value}
            checked={state.choice === option.value}
            // Canonical choice washes drop muted description text below
            // WCAG AA (checked tint ~4.11:1, hover wash ~4.34:1, both
            // serious axe findings). muted/50 hover plus foreground
            // descriptions on checked hold ≥4.5:1 via className merge.
            className="hover:bg-muted/50"
            onChange={() => {
              dispatch({ type: 'setChoice', choice: option.value });
            }}
          >
            {option.title}
            <QuestionnaireChoiceDescription className="group-data-checked/questionnaire-choice:text-foreground">
              {option.description}
            </QuestionnaireChoiceDescription>
          </QuestionnaireChoice>
        ))}
      </QuestionnaireChoices>
      {state.choice === 'later' ? (
        <Alert>
          <AlertDescription>
            You’ll need to connect school sign-in before temporary setup access expires. If you lose
            access first, a WayPass recovery code can be used to finish setup.
          </AlertDescription>
        </Alert>
      ) : null}
      <QuestionnaireError />
    </QuestionnaireItem>
  );
}

export function GoogleClientIdQuestion() {
  const { state, dispatch } = useSetup();

  return (
    <QuestionnaireItem name="google-client-id" required>
      <QuestionnaireTitle>What is your Google client ID?</QuestionnaireTitle>
      <QuestionnaireInput
        aria-label="Client ID"
        autoComplete="off"
        required
        value={state.provider.clientId}
        onChange={(event) => {
          dispatch({ type: 'setProvider', provider: { clientId: event.target.value } });
        }}
      />
      <QuestionnaireError />
    </QuestionnaireItem>
  );
}

export function GoogleClientSecretQuestion() {
  const { state, dispatch } = useSetup();

  return (
    <QuestionnaireItem name="google-client-secret" required>
      <QuestionnaireTitle>What is your Google client secret?</QuestionnaireTitle>
      <QuestionnaireInput
        type="password"
        aria-label="Client secret"
        autoComplete="new-password"
        required
        value={state.provider.clientSecret}
        onChange={(event) => {
          dispatch({ type: 'setProvider', provider: { clientSecret: event.target.value } });
        }}
      />
      <QuestionnaireError />
    </QuestionnaireItem>
  );
}

export function ProviderNameQuestion() {
  const { state, dispatch } = useSetup();

  return (
    <QuestionnaireItem name="provider-name" required>
      <QuestionnaireTitle>What is your sign-in provider called?</QuestionnaireTitle>
      <QuestionnaireDescription>
        The name staff will see at sign-in, for example “Fabrikam sign-in”.
      </QuestionnaireDescription>
      <QuestionnaireInput
        aria-label="Provider name"
        autoComplete="off"
        required
        value={state.provider.providerName}
        onChange={(event) => {
          dispatch({ type: 'setProvider', provider: { providerName: event.target.value } });
        }}
      />
      <QuestionnaireError />
    </QuestionnaireItem>
  );
}

export function IssuerUrlQuestion() {
  const { state, dispatch } = useSetup();

  return (
    <QuestionnaireItem name="issuer-url" required>
      <QuestionnaireTitle>What is your provider’s issuer URL?</QuestionnaireTitle>
      <QuestionnaireDescription>
        The address your provider gives for OpenID configuration, starting with https://.
      </QuestionnaireDescription>
      <QuestionnaireInput
        aria-label="Issuer URL"
        autoComplete="off"
        inputMode="url"
        required
        value={state.provider.issuerUrl}
        onChange={(event) => {
          dispatch({ type: 'setProvider', provider: { issuerUrl: event.target.value } });
        }}
      />
      <QuestionnaireError />
    </QuestionnaireItem>
  );
}

export function GenericClientIdQuestion() {
  const { state, dispatch } = useSetup();

  return (
    <QuestionnaireItem name="generic-client-id" required>
      <QuestionnaireTitle>What is your provider’s client ID?</QuestionnaireTitle>
      <QuestionnaireInput
        aria-label="Client ID"
        autoComplete="off"
        required
        value={state.provider.clientId}
        onChange={(event) => {
          dispatch({ type: 'setProvider', provider: { clientId: event.target.value } });
        }}
      />
      <QuestionnaireError />
    </QuestionnaireItem>
  );
}

export function GenericClientSecretQuestion() {
  const { state, dispatch } = useSetup();

  return (
    <QuestionnaireItem name="generic-client-secret" required>
      <QuestionnaireTitle>What is your provider’s client secret?</QuestionnaireTitle>
      <QuestionnaireInput
        type="password"
        aria-label="Client secret"
        autoComplete="new-password"
        required
        value={state.provider.clientSecret}
        onChange={(event) => {
          dispatch({ type: 'setProvider', provider: { clientSecret: event.target.value } });
        }}
      />
      <QuestionnaireError />
    </QuestionnaireItem>
  );
}
