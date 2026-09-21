import {
  FieldError,
  Input,
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
  Text,
  TextField,
} from 'react-aria-components';
import type { ProviderDraft, SignInChoice } from './setup-state';

export interface ProviderChoiceErrors {
  choice?: string;
  clientId?: string;
  clientSecret?: string;
  providerName?: string;
  issuerUrl?: string;
  providerKey?: string;
  scopes?: string;
}

export interface ProviderChoiceFormProps {
  idPrefix: string;
  choice: SignInChoice | null;
  provider: ProviderDraft;
  errors: ProviderChoiceErrors;
  allowLater: boolean;
  onChoice: (choice: SignInChoice) => void;
  onProvider: (provider: Partial<ProviderDraft>) => void;
}

/** Sign-in options as a real radio group: the whole card surface selects the
 * option. Google exposes only client ID + secret; the server owns issuer,
 * scopes, keys, and auth method. Advanced generic settings start collapsed. */
export function ProviderChoiceForm({
  idPrefix,
  choice,
  provider,
  errors,
  allowLater,
  onChoice,
  onProvider,
}: ProviderChoiceFormProps) {
  return (
    <div className="setup-choices">
      <RadioGroup
        aria-label="Sign-in options"
        {...(errors.choice ? { 'aria-describedby': `${idPrefix}-choice-error` } : {})}
        value={choice}
        onChange={(value) => {
          onChoice(value as SignInChoice);
        }}
        isInvalid={Boolean(errors.choice)}
      >
        <RadioField value="google" className="maia-choice-card" id={`${idPrefix}-choice-google`}>
          <RadioButton className="maia-choice-card__button">
            <span className="maia-choice-card__text">
              <span className="maia-choice-card__title">Google Workspace</span>
              <span className="maia-choice-card__description">
                Use your school&apos;s Google accounts. Recommended for schools using Google
                Workspace.
              </span>
            </span>
          </RadioButton>
        </RadioField>
        <RadioField value="generic" className="maia-choice-card" id={`${idPrefix}-choice-generic`}>
          <RadioButton className="maia-choice-card__button">
            <span className="maia-choice-card__text">
              <span className="maia-choice-card__title">Another OpenID Connect provider</span>
              <span className="maia-choice-card__description">
                Connect any standards-based sign-in service your school already uses.
              </span>
            </span>
          </RadioButton>
        </RadioField>
        {allowLater ? (
          <RadioField value="later" className="maia-choice-card" id={`${idPrefix}-choice-later`}>
            <RadioButton className="maia-choice-card__button">
              <span className="maia-choice-card__text">
                <span className="maia-choice-card__title">Set up sign-in later</span>
                <span className="maia-choice-card__description">
                  Start configuring WayPass now and connect your school&apos;s sign-in afterward.
                  This browser will receive temporary setup access.
                </span>
              </span>
            </RadioButton>
          </RadioField>
        ) : null}
      </RadioGroup>
      {choice === 'google' ? (
        <div className="setup-choice__fields">
          <TextField
            className="maia-field"
            isInvalid={Boolean(errors.clientId)}
            isRequired
            value={provider.clientId}
            onChange={(value) => {
              onProvider({ clientId: value });
            }}
          >
            <Label className="maia-label" htmlFor={`${idPrefix}-google-client-id`}>
              Client ID
            </Label>
            <Input className="maia-input" id={`${idPrefix}-google-client-id`} autoComplete="off" />
            <FieldError className="maia-field__error">{errors.clientId}</FieldError>
          </TextField>
          <TextField
            className="maia-field"
            isInvalid={Boolean(errors.clientSecret)}
            isRequired
            value={provider.clientSecret}
            onChange={(value) => {
              onProvider({ clientSecret: value });
            }}
          >
            <Label className="maia-label" htmlFor={`${idPrefix}-google-client-secret`}>
              Client secret
            </Label>
            <Input
              className="maia-input"
              id={`${idPrefix}-google-client-secret`}
              type="password"
              autoComplete="new-password"
            />
            <FieldError className="maia-field__error">{errors.clientSecret}</FieldError>
          </TextField>
        </div>
      ) : null}
      {choice === 'generic' ? (
        <div className="setup-choice__fields">
          <TextField
            className="maia-field"
            isInvalid={Boolean(errors.providerName)}
            isRequired
            value={provider.providerName}
            onChange={(value) => {
              onProvider({ providerName: value });
            }}
          >
            <Label className="maia-label" htmlFor={`${idPrefix}-provider-name`}>
              Provider name
            </Label>
            <Input className="maia-input" id={`${idPrefix}-provider-name`} autoComplete="off" />
            <Text slot="description" className="maia-field__description">
              The name staff will see at sign-in, for example “Fabrikam sign-in”.
            </Text>
            <FieldError className="maia-field__error">{errors.providerName}</FieldError>
          </TextField>
          <TextField
            className="maia-field"
            isInvalid={Boolean(errors.issuerUrl)}
            isRequired
            value={provider.issuerUrl}
            onChange={(value) => {
              onProvider({ issuerUrl: value });
            }}
          >
            <Label className="maia-label" htmlFor={`${idPrefix}-issuer-url`}>
              Issuer URL
            </Label>
            <Input
              className="maia-input"
              id={`${idPrefix}-issuer-url`}
              autoComplete="off"
              inputMode="url"
            />
            <Text slot="description" className="maia-field__description">
              The address your provider gives for OpenID configuration, starting with https://.
            </Text>
            <FieldError className="maia-field__error">{errors.issuerUrl}</FieldError>
          </TextField>
          <TextField
            className="maia-field"
            isInvalid={Boolean(errors.clientId)}
            isRequired
            value={provider.clientId}
            onChange={(value) => {
              onProvider({ clientId: value });
            }}
          >
            <Label className="maia-label" htmlFor={`${idPrefix}-generic-client-id`}>
              Client ID
            </Label>
            <Input className="maia-input" id={`${idPrefix}-generic-client-id`} autoComplete="off" />
            <FieldError className="maia-field__error">{errors.clientId}</FieldError>
          </TextField>
          <TextField
            className="maia-field"
            isInvalid={Boolean(errors.clientSecret)}
            isRequired
            value={provider.clientSecret}
            onChange={(value) => {
              onProvider({ clientSecret: value });
            }}
          >
            <Label className="maia-label" htmlFor={`${idPrefix}-generic-client-secret`}>
              Client secret
            </Label>
            <Input
              className="maia-input"
              id={`${idPrefix}-generic-client-secret`}
              type="password"
              autoComplete="new-password"
            />
            <FieldError className="maia-field__error">{errors.clientSecret}</FieldError>
          </TextField>
          <details
            className="setup-details"
            open={provider.advancedOpen}
            onToggle={(event) => {
              onProvider({ advancedOpen: (event.target as HTMLDetailsElement).open });
            }}
          >
            <summary>Advanced provider settings</summary>
            <TextField
              className="maia-field"
              isInvalid={Boolean(errors.providerKey)}
              value={provider.providerKey}
              onChange={(value) => {
                onProvider({ providerKey: value });
              }}
            >
              <Label className="maia-label" htmlFor={`${idPrefix}-provider-key`}>
                Provider key
              </Label>
              <Input className="maia-input" id={`${idPrefix}-provider-key`} autoComplete="off" />
              <Text slot="description" className="maia-field__description">
                Lowercase letters, numbers, and dashes. Defaults to the provider name.
              </Text>
              <FieldError className="maia-field__error">{errors.providerKey}</FieldError>
            </TextField>
            <div className="maia-field">
              <Label className="maia-label" htmlFor={`${idPrefix}-auth-method`}>
                Client authentication
              </Label>
              <select
                id={`${idPrefix}-auth-method`}
                className="maia-input"
                value={provider.authMethod}
                onChange={(event) => {
                  onProvider({
                    authMethod:
                      event.target.value === 'client_secret_basic'
                        ? 'client_secret_basic'
                        : 'client_secret_post',
                  });
                }}
              >
                <option value="client_secret_post">
                  Send credentials with the request (most providers)
                </option>
                <option value="client_secret_basic">
                  Send credentials as an authorization header
                </option>
              </select>
            </div>
            <TextField
              className="maia-field"
              isInvalid={Boolean(errors.scopes)}
              value={provider.scopes}
              onChange={(value) => {
                onProvider({ scopes: value });
              }}
            >
              <Label className="maia-label" htmlFor={`${idPrefix}-scopes`}>
                Scopes
              </Label>
              <Input className="maia-input" id={`${idPrefix}-scopes`} autoComplete="off" />
              <Text slot="description" className="maia-field__description">
                Space-separated permissions. Must include openid.
              </Text>
              <FieldError className="maia-field__error">{errors.scopes}</FieldError>
            </TextField>
          </details>
        </div>
      ) : null}
      {allowLater && choice === 'later' ? (
        <div className="setup-choice__fields">
          <p className="setup-choice__note">
            You&apos;ll need to connect school sign-in before temporary setup access expires. If you
            lose access first, a WayPass recovery code can be used to finish setup.
          </p>
        </div>
      ) : null}
      {errors.choice ? (
        <p className="maia-field__error" id={`${idPrefix}-choice-error`} role="alert">
          {errors.choice}
        </p>
      ) : null}
    </div>
  );
}
