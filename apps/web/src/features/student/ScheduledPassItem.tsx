import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { iconForCategoryKey } from '../../lib/destination-category-presentation.js';
import type { ScheduledAuthorization } from './scheduled-presentation.js';
import { formatSchoolTime, formatScheduledWhen } from './student-time.js';

interface ScheduledPassItemProps {
  authorization: ScheduledAuthorization;
  timeZone: string;
  ready: boolean;
  starting: boolean;
  startDisabled: boolean;
  onStart: () => void;
}

export function ScheduledPassItem({
  authorization,
  timeZone,
  ready,
  starting,
  startDisabled,
  onStart,
}: ScheduledPassItemProps) {
  const icon = iconForCategoryKey(authorization.destination.category?.iconKey ?? 'generic');
  if (!ready) {
    // Future or expired appointments render without any Start action.
    return (
      <Item role="listitem" variant="outline">
        <ItemMedia variant="icon">
          <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{authorization.destination.displayName}</ItemTitle>
          <ItemDescription>
            {formatScheduledWhen(authorization.validFrom, timeZone)}
          </ItemDescription>
        </ItemContent>
      </Item>
    );
  }
  const availableUntil = formatSchoolTime(authorization.validUntil, timeZone);
  return (
    <Item role="listitem" variant="outline">
      <ItemMedia variant="icon">
        <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{authorization.destination.displayName}</ItemTitle>
        <ItemDescription>
          {availableUntil ? `Available until ${availableUntil}` : 'Available now'}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button size="sm" disabled={startDisabled} aria-busy={starting} onClick={onStart}>
          {starting ? <Spinner data-icon="inline-start" /> : null}
          {starting ? 'Starting…' : 'Start WayPass'}
        </Button>
      </ItemActions>
    </Item>
  );
}
