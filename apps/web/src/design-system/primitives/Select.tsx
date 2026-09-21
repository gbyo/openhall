import {
  Button as AriaButton,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Text,
  type SelectProps as AriaSelectProps,
} from 'react-aria-components';

export interface SelectOption {
  id: string;
  label: string;
}

export interface SelectProps extends Omit<
  AriaSelectProps<SelectOption>,
  'children' | 'items' | 'className'
> {
  label: string;
  description?: string;
  options: SelectOption[];
}

export function Select({ label, description, options, ...props }: SelectProps) {
  return (
    <AriaSelect<SelectOption> {...props} className="wf-field wf-select">
      <Label className="wf-field__label">{label}</Label>
      <AriaButton className="wf-select__button">
        <SelectValue />
        <span aria-hidden="true">⌄</span>
      </AriaButton>
      {description && (
        <Text slot="description" className="wf-field__helper">
          {description}
        </Text>
      )}
      <Popover className="wf-popover" offset={6}>
        <ListBox<SelectOption> className="wf-listbox" items={options}>
          {(option) => <ListBoxItem className="wf-listbox__item">{option.label}</ListBoxItem>}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
