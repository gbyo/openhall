import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { organizationsQuery } from '../queries';
import { AppFrame } from '../AppFrame';

export function SchoolChooser() {
  const { data } = useQuery(organizationsQuery);
  return (
    <AppFrame>
      <section className="chooser" aria-labelledby="schools-title">
        <p className="auth-kicker">WayPass</p>
        <h1 className="wf-type-page-title" id="schools-title">
          Choose a school
        </h1>
        {data?.organizations.length === 0 ? (
          <p>You do not currently have access to a school.</p>
        ) : (
          <ul>
            {data?.organizations.map((school) => (
              <li key={school.id}>
                <Link to={`/schools/${school.id}`}>
                  <strong>{school.name}</strong>
                  <span>{school.affiliations.join(' · ')}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AppFrame>
  );
}
