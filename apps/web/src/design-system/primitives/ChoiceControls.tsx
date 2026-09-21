import {
  CheckboxButton,
  CheckboxField,
  SwitchButton,
  SwitchField,
  type CheckboxFieldProps,
  type SwitchFieldProps,
} from 'react-aria-components';
import type { ReactNode } from 'react';

export interface CheckboxProps extends Omit<CheckboxFieldProps, 'children' | 'className'> {
  children: ReactNode;
}
export interface SwitchProps extends Omit<SwitchFieldProps, 'children' | 'className'> {
  children: ReactNode;
}

export function Checkbox({ children, ...props }: CheckboxProps) {
  return (
    <CheckboxField {...props}>
      <CheckboxButton className="wf-choice">
        {({ isSelected }) => (
          <>
            <span className="wf-checkbox__box" aria-hidden="true">
              {isSelected ? '✓' : ''}
            </span>
            <span>{children}</span>
          </>
        )}
      </CheckboxButton>
    </CheckboxField>
  );
}

export function Switch({ children, ...props }: SwitchProps) {
  return (
    <SwitchField {...props}>
      <SwitchButton className="wf-choice wf-switch">
        <span className="wf-switch__track" aria-hidden="true">
          <span />
        </span>
        <span>{children}</span>
      </SwitchButton>
    </SwitchField>
  );
}
