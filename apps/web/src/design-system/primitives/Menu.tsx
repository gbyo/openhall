import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Menu as AriaMenu,
  MenuItem,
  MenuTrigger,
  Popover,
  type Key,
} from 'react-aria-components';

export interface MenuAction {
  id: Key;
  label: string;
  description?: string;
}

export interface MenuProps {
  label: string;
  trigger: ReactNode;
  items: MenuAction[];
  onAction?: (key: Key) => void;
}

export function Menu({ label, trigger, items, onAction }: MenuProps) {
  return (
    <MenuTrigger>
      <AriaButton className="wf-button wf-button--secondary wf-button--standard">
        {trigger}
      </AriaButton>
      <Popover className="wf-popover" offset={6}>
        <AriaMenu
          aria-label={label}
          className="wf-menu"
          items={items}
          {...(onAction ? { onAction } : {})}
        >
          {(item) => (
            <MenuItem className="wf-menu__item" textValue={item.label}>
              <span>{item.label}</span>
              {item.description && <small>{item.description}</small>}
            </MenuItem>
          )}
        </AriaMenu>
      </Popover>
    </MenuTrigger>
  );
}
