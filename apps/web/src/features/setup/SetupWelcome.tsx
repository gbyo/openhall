import { useEffect, useState, type ChangeEvent, type SubmitEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ApiProblem } from '../../api/problems';
import { useSetup } from './setup-state';
import { validateSetupCode } from './setup-api';

/** One-time setup-code unlock. Deliberately outside Questionnaire: after the
 * code validates, the Questionnaire flow starts. The code stays in React
 * memory only and a reload asks for it again. */
export function SetupWelcome() {
  const { state, dispatch } = useSetup();
  const navigate = useNavigate();
  const location = useLocation();
  const lockedOut =
    typeof location.state === 'object' && location.state !== null && 'lockedOut' in location.state;
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (error) document.getElementById('setup-code')?.focus({ preventScroll: true });
  }, [error]);

  if (state.unlocked) return <Navigate to="/setup/flow" replace />;

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setError('Enter the setup code shown by your WayPass server.');
      return;
    }
    setError(null);
    setPending(true);
    try {
      await validateSetupCode(trimmed);
      dispatch({ type: 'unlock', operatorToken: trimmed });
      await navigate('/setup/flow');
    } catch (cause) {
      if (cause instanceof ApiProblem && cause.code === 'bootstrap_unavailable') {
        setInstalled(true);
      } else {
        setError(
          'That setup code didn\u2019t work. Check the code shown by your WayPass server and try again.',
        );
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="min-h-dvh bg-background px-5 py-10 text-foreground sm:px-6">
      <div className="mx-auto w-full max-w-lg">
        <h1 id="setup-welcome-title" className="text-2xl font-semibold tracking-tight">
          Let&apos;s set up WayPass
        </h1>
        <p className="mt-2 text-muted-foreground">This should only take a few minutes.</p>
        {lockedOut ? (
          <Alert className="mt-6">
            <AlertTitle>Continue setup</AlertTitle>
            <AlertDescription>
              For security, enter your setup code again to continue.
            </AlertDescription>
          </Alert>
        ) : null}
        {installed ? (
          <Alert className="mt-6">
            <AlertTitle>WayPass is already set up</AlertTitle>
            <AlertDescription>
              This server already has a school installation. <Link to="/login">Sign in</Link>{' '}
              instead.
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive" className="mt-6">
            <AlertTitle>Setup could not continue</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <form
          onSubmit={(event) => void submit(event)}
          noValidate
          aria-labelledby="setup-welcome-title"
          className="mt-6"
        >
          <Field data-invalid={error !== null}>
            <FieldLabel htmlFor="setup-code">Setup code</FieldLabel>
            <Input
              id="setup-code"
              type="password"
              autoComplete="off"
              required
              value={code}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                setCode(event.target.value);
              }}
              aria-invalid={error !== null}
              aria-describedby={
                error ? 'setup-code-description setup-code-error' : 'setup-code-description'
              }
            />
            <FieldDescription id="setup-code-description">
              Enter the one-time setup code shown by your WayPass server.
            </FieldDescription>
            {error ? <FieldError id="setup-code-error">{error}</FieldError> : null}
          </Field>
          <Collapsible className="mt-6">
            <CollapsibleTrigger className="text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80">
              Where do I find this?
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2 text-sm text-muted-foreground">
              Your WayPass server prints a one-time setup code in its startup log when it first
              runs. It works once, and for security you may be asked for it again if you reload this
              page before setup finishes.
            </CollapsibleContent>
          </Collapsible>
          <div className="mt-8">
            <Button type="submit" disabled={pending}>
              {pending ? 'Working…' : 'Continue'}
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}
