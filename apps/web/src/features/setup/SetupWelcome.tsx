import { useEffect, useState, type SubmitEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { FieldError, Input, Label, Text, TextField } from 'react-aria-components';
import { ApiProblem } from '../../api/problems';
import { SetupLayout } from './SetupLayout';
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
    <SetupLayout kicker="WayPass">
      <h1 className="maia-page-title" id="setup-welcome-title">
        Let&apos;s set up WayPass
      </h1>
      <p className="setup-lede">This should only take a few minutes.</p>
      {lockedOut ? (
        <div className="maia-alert maia-alert--info">
          <p className="maia-alert__title">Continue setup</p>
          <p>For security, enter your setup code again to continue.</p>
        </div>
      ) : null}
      {installed ? (
        <div className="maia-alert maia-alert--info">
          <p className="maia-alert__title">WayPass is already set up</p>
          <p>
            This server already has a school installation. <Link to="/login">Sign in</Link> instead.
          </p>
        </div>
      ) : null}
      {error ? (
        <div className="maia-alert maia-alert--destructive" role="alert">
          <p className="maia-alert__title">Setup could not continue</p>
          <p>{error}</p>
        </div>
      ) : null}
      <form
        onSubmit={(event) => void submit(event)}
        noValidate
        aria-labelledby="setup-welcome-title"
      >
        <TextField
          className="maia-field"
          isInvalid={error !== null}
          isRequired
          value={code}
          onChange={setCode}
        >
          <Label className="maia-label" htmlFor="setup-code">
            Setup code
          </Label>
          <Input className="maia-input" id="setup-code" type="password" autoComplete="off" />
          <Text slot="description" className="maia-field__description">
            Enter the one-time setup code shown by your WayPass server.
          </Text>
          <FieldError className="maia-field__error">{error ?? undefined}</FieldError>
        </TextField>
        <details className="setup-details">
          <summary>Where do I find this?</summary>
          <p className="setup-details__copy">
            Your WayPass server prints a one-time setup code in its startup log when it first runs.
            It works once, and for security you may be asked for it again if you reload this page
            before setup finishes.
          </p>
        </details>
        <div className="setup-actions">
          <div className="setup-actions__buttons">
            <button type="submit" className="maia-button maia-button--primary" disabled={pending}>
              {pending ? 'Working…' : 'Continue'}
            </button>
          </div>
        </div>
      </form>
    </SetupLayout>
  );
}
