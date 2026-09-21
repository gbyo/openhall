import { useState } from 'react';
import { AppFrame } from '../../app/AppFrame';
import { queryClient } from '../../app/query-client';
import { clearSessionMemory } from '../../api/session';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';

export type DemoPersona = 'administrator' | 'teacher' | 'student';
export interface DemoInfo {
  enabled: true;
  organizationId: string;
  personas: { id: DemoPersona; name: string; description: string }[];
}

export async function demoLoader(): Promise<DemoInfo> {
  const response = await fetch('/api/v1/demo', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Demo mode is unavailable.');
  return (await response.json()) as DemoInfo;
}

export function DemoPage({ info }: { info: DemoInfo }) {
  const [selecting, setSelecting] = useState<DemoPersona | null>(null);
  const [failed, setFailed] = useState(false);

  async function choose(persona: DemoPersona) {
    setSelecting(persona);
    setFailed(false);
    try {
      const response = await fetch('/api/v1/demo/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ persona }),
      });
      if (!response.ok) throw new Error('Demo session was not created');
      clearSessionMemory();
      queryClient.clear();
      window.location.assign(`/schools/${info.organizationId}`);
    } catch {
      setFailed(true);
      setSelecting(null);
    }
  }

  return (
    <AppFrame>
      <main className="mx-auto grid w-full max-w-3xl gap-6 py-10">
        <div className="grid gap-2 text-center">
          <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Local demo
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Explore OpenHall as…</h1>
          <p className="text-muted-foreground">
            Each choice signs in to a real seeded account with production authorization rules.
          </p>
        </div>
        {failed && (
          <Alert variant="destructive">
            <AlertTitle>Couldn’t start the demo</AlertTitle>
            <AlertDescription>Reset the demo database and try again.</AlertDescription>
          </Alert>
        )}
        <div className="grid gap-4 md:grid-cols-3">
          {info.personas.map((persona) => (
            <Card key={persona.id}>
              <CardHeader>
                <h2 className="text-lg font-semibold capitalize">{persona.id}</h2>
                <CardDescription>{persona.description}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <p className="font-medium">{persona.name}</p>
                <Button disabled={selecting !== null} onClick={() => void choose(persona.id)}>
                  {selecting === persona.id && <Spinner data-icon="inline-start" />}
                  Continue as {persona.id}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="text-center text-xs text-muted-foreground">
          Run <code>pnpm demo:reset</code> to restore the deterministic data.
        </p>
      </main>
    </AppFrame>
  );
}
