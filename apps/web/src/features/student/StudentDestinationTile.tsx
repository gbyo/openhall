import { HugeiconsIcon } from '@hugeicons/react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { tileTone } from '../../lib/destination-category-presentation.js';
import type { CategoryIcon } from '../../lib/destination-category-presentation.js';
import type { CategoryToneKey } from '../../lib/destination-category-presentation.js';

interface StudentDestinationTileProps {
  label: string;
  icon: CategoryIcon;
  tone: CategoryToneKey;
  disabled?: boolean | undefined;
  onSelect: () => void;
}

export function StudentDestinationTile({
  label,
  icon,
  tone,
  disabled,
  onSelect,
}: StudentDestinationTileProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      disabled={disabled}
      onClick={() => {
        onSelect();
      }}
      className={cn(tileTone({ tone }), 'h-full w-full')}
    >
      <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" className="size-8" />
      <span>{label}</span>
    </Button>
  );
}
