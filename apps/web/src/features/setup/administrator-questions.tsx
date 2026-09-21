import {
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireTitle,
} from '@/components/ui/questionnaire';
import { useSetup } from './setup-state';

/** The display name derives from first + last in setup memory; identity
 * fields are never asked for here. */
export function AdminGivenNameQuestion() {
  const { state, dispatch } = useSetup();

  return (
    <QuestionnaireItem name="admin-given" required>
      <QuestionnaireTitle>What is the administrator’s first name?</QuestionnaireTitle>
      <QuestionnaireDescription>
        This person’s account will manage WayPass for your school.
      </QuestionnaireDescription>
      <QuestionnaireInput
        aria-label="First name"
        autoComplete="given-name"
        required
        value={state.administrator.givenName}
        onChange={(event) => {
          dispatch({ type: 'setAdministrator', administrator: { givenName: event.target.value } });
        }}
      />
      <QuestionnaireError />
    </QuestionnaireItem>
  );
}

export function AdminFamilyNameQuestion() {
  const { state, dispatch } = useSetup();

  return (
    <QuestionnaireItem name="admin-family" required>
      <QuestionnaireTitle>What is the administrator’s last name?</QuestionnaireTitle>
      <QuestionnaireInput
        aria-label="Last name"
        autoComplete="family-name"
        required
        value={state.administrator.familyName}
        onChange={(event) => {
          dispatch({ type: 'setAdministrator', administrator: { familyName: event.target.value } });
        }}
      />
      <QuestionnaireError />
    </QuestionnaireItem>
  );
}
