import { useEffect, useState, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import { AppFrame } from '../../app/AppFrame';
import { queryClient } from '../../app/query-client';
import { ApiProblem } from '../../api/problems';
import { consumeRecoveryCode } from '../setup/setup-api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

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
      <div className="mx-auto grid w-full max-w-md gap-4 py-10">
        <Card>
          <CardHeader>
            <h1 className="text-xl font-semibold tracking-tight">Recovery access</h1>
            <CardDescription>
              Enter the temporary recovery code shown by your WayPass server.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
              {error ? (
                <Alert variant="destructive" role="alert">
                  <AlertTitle>Recovery could not continue</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <Field>
                <FieldLabel htmlFor="recovery-access-code">Recovery code</FieldLabel>
                <Input
                  id="recovery-access-code"
                  type="password"
                  autoComplete="off"
                  value={code}
                  aria-invalid={error ? true : undefined}
                  onChange={(event) => {
                    setCode(event.target.value);
                  }}
                  required
                />
                {error ? <FieldError>{error}</FieldError> : null}
              </Field>
              <div>
                <Button type="submit" disabled={pending}>
                  {pending && <Spinner data-icon="inline-start" />}
                  {pending ? 'Working…' : 'Continue'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </AppFrame>
  );
}
