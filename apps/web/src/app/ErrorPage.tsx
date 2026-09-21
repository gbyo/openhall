import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { AppFrame } from './AppFrame';

export function ErrorPage() {
  const error = useRouteError();
  const title =
    isRouteErrorResponse(error) && error.status === 404
      ? 'Page not found'
      : 'WayPass hit a problem';
  return (
    <AppFrame>
      <section className="system-message" aria-labelledby="route-error-title">
        <div>
          <h1 className="wf-type-heading" id="route-error-title">
            {title}
          </h1>
          <p>The page could not be opened. Your school data was not changed.</p>
          <Link className="auth-text-link" to="/">
            Return to WayPass
          </Link>
        </div>
      </section>
    </AppFrame>
  );
}
