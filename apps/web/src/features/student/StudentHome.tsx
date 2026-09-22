import { Skeleton } from '@/components/ui/skeleton';
import { StudentRoomGrid } from './StudentRoomGrid.js';
import type { ScheduledAuthorization } from './scheduled-presentation.js';
import type { StudentCatalogCategory, StudentCategory } from './student-room-intents.js';
import { splitStudentCatalog } from './student-room-intents.js';
import { ReadyNowPasses, UpcomingPasses } from './UpcomingPasses.js';

interface StudentHomeProps {
  categories: StudentCatalogCategory[];
  authorizations: ScheduledAuthorization[];
  timeZone: string;
  startingId: string | null;
  startPending: boolean;
  actionsDisabled: boolean;
  onSelectCategory: (category: StudentCategory) => void;
  onSelectMore: (secondary: StudentCategory[]) => void;
  onStartScheduled: (authorization: ScheduledAuthorization) => void;
}

export function StudentHome({
  categories,
  authorizations,
  timeZone,
  startingId,
  startPending,
  actionsDisabled,
  onSelectCategory,
  onSelectMore,
  onStartScheduled,
}: StudentHomeProps) {
  const { primary, secondary } = splitStudentCatalog(categories);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <ReadyNowPasses
        authorizations={authorizations}
        timeZone={timeZone}
        startingId={startingId}
        startPending={startPending}
        onStart={onStartScheduled}
      />
      <div className="flex flex-col gap-3">
        <h1 id="room-title" className="text-xl font-semibold tracking-tight text-balance">
          Where do you need to go?
        </h1>
        <StudentRoomGrid
          primary={primary}
          hasSecondary={secondary.length > 0}
          disabled={actionsDisabled}
          onSelectCategory={onSelectCategory}
          onSelectMore={() => {
            onSelectMore(secondary);
          }}
        />
      </div>
      <UpcomingPasses authorizations={authorizations} timeZone={timeZone} />
    </div>
  );
}

export function StudentHomeSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading rooms"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6"
    >
      <Skeleton className="h-7 w-2/3" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden="true">
        <Skeleton className="min-h-28 rounded-3xl" />
        <Skeleton className="min-h-28 rounded-3xl" />
        <Skeleton className="min-h-28 rounded-3xl" />
        <Skeleton className="min-h-28 rounded-3xl" />
      </div>
      <div className="flex flex-col gap-2" aria-hidden="true">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
      <span className="sr-only">Loading rooms…</span>
    </div>
  );
}
