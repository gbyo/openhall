import {
  Button as AriaButton,
  Input,
  Label,
  SearchField as AriaSearchField,
  type SearchFieldProps as AriaSearchFieldProps,
} from 'react-aria-components';

export interface SearchFieldProps extends Omit<AriaSearchFieldProps, 'children' | 'className'> {
  label: string;
  description?: string;
}

export function SearchField({ label, description, ...props }: SearchFieldProps) {
  return (
    <AriaSearchField {...props} className="wf-field wf-search-field">
      <Label className="wf-field__label">{label}</Label>
      <div className="wf-search-field__control">
        <span aria-hidden="true" className="wf-search-field__icon">
          ⌕
        </span>
        <Input className="wf-input" />
        <AriaButton className="wf-search-field__clear">Clear</AriaButton>
      </div>
      {description && <p className="wf-field__helper">{description}</p>}
    </AriaSearchField>
  );
}
