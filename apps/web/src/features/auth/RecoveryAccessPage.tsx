import { useEffect, useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import { Alert } from '../../design-system/primitives/Alert';
import { TextField } from '../../design-system/primitives/TextField';
import { AppFrame } from '../../app/AppFrame';
import { queryClient } from '../../app/query-client';
import { ApiProblem } from '../../api/problems';
import { consumeRecoveryCode } from '../setup/setup-api';

/** Unauthenticated recovery entry: trades a recovery code for a session. */
export function RecoveryAccessPage() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (error) document.getElementById('recovery-access-code')?.focus({ preventScroll: true });
  }, [error]);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setError('Enter the temporary recovery code shown by your WayPass server.');
      return;
    }
    setError(null);
    setPending(true);
    try {
      await consumeRecoveryCode(trimmed);
      setCode('');
      await queryClient.invalidateQueries();
      await navigate('/connect-sign-in');
    } catch (cause) {
      if (cause instanceof ApiProblem) {
        setError('That recovery code didn\u2019t work. Check the code and try again.');
      } else {
        setError('WayPass could not connect. Check your connection and try again.');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <AppFrame>
      <section className="setup-view setup-view--narrow" aria-labelledby="recovery-access-title">
        <p className="auth-kicker">WayPass</p>
        <h1 className="wf-type-page-title" id="recovery-access-title">
          Recovery access
        </h1>
        <p className="setup-lede">
          Enter the temporary recovery code shown by your WayPass server.
        </p>
        {error ? (
          <Alert tone="danger" role="alert" title="Recovery could not continue">
            <p>{error}</p>
          </Alert>
        ) : null}
        <form onSubmit={(event) => void submit(event)} noValidate>
          <TextField
            id="recovery-access-code"
            label="Recovery code"
            type="password"
            autoComplete="off"
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
            error={error ?? undefined}
            required
          />
          <div className="setup-actions">
            <div className="setup-actions__buttons">
              <button
                type="submit"
                className="wf-button wf-button--primary wf-button--standard"
                disabled={pending}
              >
                {pending ? 'Working…' : 'Continue'}
              </button>
            </div>
          </div>
        </form>
      </section>
    </AppFrame>
  );
}
