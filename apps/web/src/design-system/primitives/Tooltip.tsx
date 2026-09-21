import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Tooltip as AriaTooltip,
  TooltipTrigger,
} from 'react-aria-components';

export interface TooltipProps {
  label: string;
  children: ReactNode;
}

export function Tooltip({ label, children }: TooltipProps) {
  return (
    <TooltipTrigger delay={400}>
      <AriaButton className="wf-icon-button" aria-label={label}>
        {children}
      </AriaButton>
      <AriaTooltip className="wf-tooltip" offset={6}>
        {label}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
