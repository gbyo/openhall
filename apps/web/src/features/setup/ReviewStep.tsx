import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Button } from '@/components/ui/button';
import {
  QuestionnaireDescription,
  QuestionnaireItem,
  QuestionnaireTitle,
} from '@/components/ui/questionnaire';
import { AnswerBridge } from './answer-bridge';
import { timeZoneLabel, useSetup } from './setup-state';
import type { SetupQuestionName } from './GuidedSetupFlow';

function signInLabel(choice: string | null, providerName: string): string {
  if (choice === 'google') return 'Google Workspace';
  if (choice === 'generic') return providerName.trim() || 'Sign-in provider';
  return 'Set up later';
}

/** Review uses entered values only: never the setup token, client secret,
 * raw scopes, issuer, or internal IDs. Edit returns to the matching
 * Questionnaire question with in-memory answers intact. The item carries no
 * question of its own, so a constant bridge marks it answered for the
 * native submit path. */
export function ReviewItem({
  error,
  onEdit,
}: {
  error: string | null;
  onEdit: (name: SetupQuestionName) => void;
}) {
  const { state } = useSetup();
  const administrator =
    state.administrator.displayName.trim() ||
    `${state.administrator.givenName} ${state.administrator.familyName}`
      .trim()
      .replace(/\s+/g, ' ') ||
    '—';

  return (
    <QuestionnaireItem name="review" required>
      <QuestionnaireTitle>Review and create WayPass</QuestionnaireTitle>
      <QuestionnaireDescription>
        Make sure everything looks right before creating WayPass.
      </QuestionnaireDescription>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Setup could not finish</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <ItemGroup aria-label="Setup answers" role="list">
        <Item variant="outline" role="listitem">
          <ItemContent>
            <ItemTitle>School</ItemTitle>
            <ItemDescription>
              {state.school.name.trim() || '—'} · {timeZoneLabel(state.school.timeZone)}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              variant="link"
              type="button"
              onClick={() => {
                onEdit('school-name');
              }}
            >
              Edit
            </Button>
          </ItemActions>
        </Item>
        <Item variant="outline" role="listitem">
          <ItemContent>
            <ItemTitle>Administrator</ItemTitle>
            <ItemDescription>{administrator}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              variant="link"
              type="button"
              onClick={() => {
                onEdit('admin-given');
              }}
            >
              Edit
            </Button>
          </ItemActions>
        </Item>
        <Item variant="outline" role="listitem">
          <ItemContent>
            <ItemTitle>Sign-in</ItemTitle>
            <ItemDescription>
              {signInLabel(state.choice, state.provider.providerName)}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <Button
              variant="link"
              type="button"
              onClick={() => {
                onEdit('signin-method');
              }}
            >
              Edit
            </Button>
          </ItemActions>
        </Item>
      </ItemGroup>
      <AnswerBridge value="review" />
    </QuestionnaireItem>
  );
}
