import { HugeiconsIcon } from '@hugeicons/react';
import { cva } from 'class-variance-authority';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import type { StudentIntent } from './student-intents.js';

// Centralized tile tones. Low saturation, generous radius, clear interactive
// states. Icon + text stay authoritative; color is supplemental only and the
// border keeps tiles distinct under forced-colors.
const tileTone = cva(
  'h-auto min-h-28 flex-col gap-2 rounded-3xl border-2 p-4 text-base font-semibold wrap-break-word whitespace-normal forced-colors:border-[ButtonText]',
  {
    variants: {
      tone: {
        aqua: 'border-cyan-700/20 bg-cyan-100 text-cyan-950 hover:bg-cyan-200/70 dark:border-cyan-300/20 dark:bg-cyan-950 dark:text-cyan-50 dark:hover:bg-cyan-900',
        rose: 'border-rose-700/20 bg-rose-100 text-rose-950 hover:bg-rose-200/70 dark:border-rose-300/20 dark:bg-rose-950 dark:text-rose-50 dark:hover:bg-rose-900',
        violet:
          'border-violet-700/20 bg-violet-100 text-violet-950 hover:bg-violet-200/70 dark:border-violet-300/20 dark:bg-violet-950 dark:text-violet-50 dark:hover:bg-violet-900',
        amber:
          'border-amber-700/20 bg-amber-100 text-amber-950 hover:bg-amber-200/70 dark:border-amber-300/20 dark:bg-amber-950 dark:text-amber-50 dark:hover:bg-amber-900',
        slate:
          'border-slate-700/20 bg-slate-200 text-slate-900 hover:bg-slate-300/70 dark:border-slate-300/20 dark:bg-slate-800 dark:text-slate-50 dark:hover:bg-slate-700',
        neutral: 'border-border bg-muted text-foreground hover:bg-muted/60 dark:hover:bg-muted/40',
      },
    },
  },
);

interface StudentDestinationTileProps {
  intent: StudentIntent;
  disabled?: boolean | undefined;
  onSelect: (intent: StudentIntent) => void;
}

export function StudentDestinationTile({
  intent,
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
        onSelect(intent);
      }}
      className={cn(tileTone({ tone: intent.tone }), 'h-full w-full')}
    >
      <HugeiconsIcon icon={intent.icon} strokeWidth={2} aria-hidden="true" className="size-8" />
      <span>{intent.label}</span>
    </Button>
  );
}
