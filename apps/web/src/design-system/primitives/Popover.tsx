import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Dialog,
  DialogTrigger,
  Popover as AriaPopover,
} from 'react-aria-components';

export interface PopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  label: string;
}

export function Popover({ trigger, children, label }: PopoverProps) {
  return (
    <DialogTrigger>
      <AriaButton className="wf-button wf-button--secondary wf-button--standard">
        {trigger}
      </AriaButton>
      <AriaPopover className="wf-popover wf-context-popover" offset={6}>
        <Dialog aria-label={label} className="wf-context-popover__content">
          {children}
        </Dialog>
      </AriaPopover>
    </DialogTrigger>
  );
}
