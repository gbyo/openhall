import {
  Button as AriaButton,
  ComboBox as AriaComboBox,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Text,
  type ComboBoxProps as AriaComboBoxProps,
} from 'react-aria-components';

export interface ComboBoxOption {
  id: string;
  label: string;
  description?: string;
}

export interface ComboBoxProps extends Omit<
  AriaComboBoxProps<ComboBoxOption>,
  'children' | 'items' | 'className'
> {
  label: string;
  description?: string;
  options: ComboBoxOption[];
}

export function ComboBox({ label, description, options, ...props }: ComboBoxProps) {
  return (
    <AriaComboBox {...props} items={options} className="wf-field wf-combobox">
      <Label className="wf-field__label">{label}</Label>
      <div className="wf-combobox__control">
        <Input className="wf-input" />
        <AriaButton className="wf-combobox__button" aria-label="Show suggestions">
          <span aria-hidden="true">⌄</span>
        </AriaButton>
      </div>
      {description && (
        <Text slot="description" className="wf-field__helper">
          {description}
        </Text>
      )}
      <Popover className="wf-popover" offset={6}>
        <ListBox<ComboBoxOption> className="wf-listbox" items={options}>
          {(option) => (
            <ListBoxItem className="wf-listbox__item" textValue={option.label}>
              <span>{option.label}</span>
              {option.description && <Text slot="description">{option.description}</Text>}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaComboBox>
  );
}
