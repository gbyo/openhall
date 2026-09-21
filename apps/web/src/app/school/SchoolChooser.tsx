import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { organizationsQuery } from '../queries';
import { AppFrame } from '../AppFrame';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Item, ItemContent, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';

export function SchoolChooser() {
  const { data, isPending } = useQuery(organizationsQuery);
  const schools = data?.organizations ?? [];
  return (
    <AppFrame>
      <div className="mx-auto grid w-full max-w-md gap-4 py-10">
        <Card>
          <CardHeader>
            <h1 className="text-xl font-semibold tracking-tight">Choose a school</h1>
            <CardDescription>Open the workspace you need right now.</CardDescription>
          </CardHeader>
          <CardContent>
            {isPending ? (
              <div className="grid gap-2" role="status" aria-label="Loading schools">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : schools.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No schools available</EmptyTitle>
                  <EmptyDescription>You do not currently have access to a school.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ItemGroup>
                {schools.map((school) => (
                  <Item key={school.id} render={<Link to={`/schools/${school.id}`} />}>
                    <ItemContent>
                      <ItemTitle>{school.name}</ItemTitle>
                      <div className="flex flex-wrap gap-1 pt-1">
                        {school.affiliations.map((affiliation) => (
                          <Badge key={affiliation} variant="secondary">
                            {affiliation}
                          </Badge>
                        ))}
                      </div>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            )}
          </CardContent>
        </Card>
      </div>
    </AppFrame>
  );
}
