import { useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Spinner } from '@/components/ui/spinner';
import type { DestinationCatalogEntry, StudentIntent } from './student-intents.js';
import { StudentDestinationPicker } from './StudentDestinationPicker.js';

function useDesktopViewport(): boolean {
  const [desktop, setDesktop] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 768px)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)');
    const update = () => {
      setDesktop(query.matches);
    };
    update();
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);
  return desktop;
}

export interface StudentPassRequestState {
  intent: StudentIntent;
  destination: DestinationCatalogEntry | null;
  pending: boolean;
  error: string | null;
  uncertain: boolean;
}

interface StudentPassRequestSurfaceProps {
  request: StudentPassRequestState | null;
  onPickDestination: (destination: DestinationCatalogEntry) => void;
  onConfirm: () => void;
  onRetry: () => void;
  onClose: () => void;
}

function RequestBody({
  request,
  onPickDestination,
  onConfirm,
  onRetry,
}: Omit<StudentPassRequestSurfaceProps, 'request' | 'onClose'> & {
  request: StudentPassRequestState;
}) {
  const needsChoice = request.intent.destinations.length > 1 && !request.destination;
  if (needsChoice) {
    return <StudentDestinationPicker intent={request.intent} onPick={onPickDestination} />;
  }
  const destination = request.destination ?? request.intent.destinations[0];
  return (
    <div className="flex flex-col items-center gap-2 py-2 text-center">
      <HugeiconsIcon
        icon={request.intent.icon}
        strokeWidth={1.5}
        aria-hidden="true"
        className="size-12"
      />
      <p className="text-lg font-semibold">{destination?.displayName ?? request.intent.label}</p>
      {request.error && (
        <Alert variant="destructive">
          <AlertTitle>Request not confirmed</AlertTitle>
          <AlertDescription>{request.error}</AlertDescription>
        </Alert>
      )}
      <div className="mt-2 flex w-full flex-col gap-2">
        <Button
          type="button"
          disabled={request.pending}
          aria-busy={request.pending}
          onClick={onConfirm}
        >
          {request.pending ? <Spinner data-icon="inline-start" /> : null}
          {request.pending ? 'Requesting…' : 'Request WayPass'}
        </Button>
        {request.error && !request.pending && (
          <Button type="button" variant="outline" onClick={onRetry}>
            {request.uncertain ? 'Check again' : 'Try again'}
          </Button>
        )}
      </div>
    </div>
  );
}

export function StudentPassRequestSurface({
  request,
  onPickDestination,
  onConfirm,
  onRetry,
  onClose,
}: StudentPassRequestSurfaceProps) {
  const desktop = useDesktopViewport();
  const open = request !== null;
  const title = request
    ? request.intent.destinations.length > 1 && !request.destination
      ? `Choose a ${request.intent.label.toLowerCase()}`
      : 'Request a WayPass'
    : 'Request a WayPass';

  if (desktop) {
    return (
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !(request?.pending ?? false)) onClose();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>Confirm where you need to go.</DialogDescription>
          </DialogHeader>
          {request && (
            <RequestBody
              request={request}
              onPickDestination={onPickDestination}
              onConfirm={onConfirm}
              onRetry={onRetry}
            />
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next && !(request?.pending ?? false)) onClose();
      }}
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
          <DrawerDescription>Confirm where you need to go.</DrawerDescription>
        </DrawerHeader>
        <div className="px-4 pb-2">
          {request && (
            <RequestBody
              request={request}
              onPickDestination={onPickDestination}
              onConfirm={onConfirm}
              onRetry={onRetry}
            />
          )}
        </div>
        <DrawerFooter>
          <DrawerClose render={<Button variant="outline" />}>Cancel</DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
