import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { AppFrame } from './AppFrame';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';

export function ErrorPage() {
  const error = useRouteError();
  const title =
    isRouteErrorResponse(error) && error.status === 404
      ? 'Page not found'
      : 'WayPass hit a problem';
  return (
    <AppFrame>
      <div className="mx-auto grid w-full max-w-md gap-4 py-10">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>
              The page could not be opened. Your school data was not changed.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<Link to="/" />}>Return to WayPass</Button>
          </EmptyContent>
        </Empty>
      </div>
    </AppFrame>
  );
}
