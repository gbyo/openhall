import type * as React from 'react';
import type { ChangeEvent } from 'react';
import { cn } from 'cn';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
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

const CHOICE_OPTIONS: readonly {
  value: SignInChoice;
  title: string;
  description: string;
}[] = [
  {
    value: 'google',
    title: 'Google Workspace',
    description:
      "Use your school's Google accounts. Recommended for schools using Google Workspace.",
  },
  {
    value: 'generic',
    title: 'Another OpenID Connect provider',
    description: 'Connect any standards-based sign-in service your school already uses.',
  },
  {
    value: 'later',
    title: 'Set up sign-in later',
    description:
      'Start configuring WayPass now and connect your school’s sign-in afterward. This browser will receive temporary setup access.',
  },
];

function choiceOptions(allowLater: boolean): readonly (typeof CHOICE_OPTIONS)[number][] {
  return allowLater ? CHOICE_OPTIONS : CHOICE_OPTIONS.slice(0, 2);
}

const cardClassName =
  'flex cursor-pointer items-start gap-3 rounded-2xl border border-border bg-background p-4 transition-colors hover:bg-muted/50 has-data-checked:border-primary has-data-checked:bg-primary/10 has-focus-visible:border-ring has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50';

function ChoiceCard({
  idPrefix,
  value,
  title,
  description,
}: {
  idPrefix: string;
  value: SignInChoice;
  title: string;
  description: string;
}) {
  return (
    <label className={cn(cardClassName)} htmlFor={`${idPrefix}-choice-${value}`}>
      <RadioGroupItem id={`${idPrefix}-choice-${value}`} value={value} className="mt-1" />
      <span className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
        <span className="text-[15px] font-semibold">{title}</span>
        <span className="text-sm text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

export interface ProviderChoiceGroupProps {
  idPrefix?: string | undefined;
  choice: SignInChoice | null;
  allowLater: boolean;
  errorId?: string | undefined;
  onChoice: (choice: SignInChoice) => void;
}

/** Sign-in options as Base UI radio cards. Used outside Questionnaire (for
 * example the connect-sign-in page), where Questionnaire choice primitives
 * have no Item context. */
export function ProviderChoiceCards({
  idPrefix,
  choice,
  allowLater,
  errorId,
  onChoice,
}: ProviderChoiceGroupProps) {
  return (
    <RadioGroup
      aria-label="Sign-in options"
      {...(errorId ? { 'aria-describedby': errorId } : {})}
      value={choice}
      onValueChange={(value) => {
        onChoice(value as SignInChoice);
      }}
    >
      {choiceOptions(allowLater).map((option) => (
        <ChoiceCard
          key={option.value}
          idPrefix={idPrefix ?? 'provider-choice'}
          value={option.value}
          title={option.title}
          description={option.description}
        />
      ))}
    </RadioGroup>
  );
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

/** Provider-specific follow-up fields shared by every sign-in surface. Google
 * exposes only client ID + secret; the server owns issuer, scopes, keys, and
 * auth method. Advanced generic settings start collapsed. */
export function ProviderDetailsForm({
  idPrefix,
  choice,
  provider,
  errors,
  allowLater,
  onProvider,
}: Omit<ProviderChoiceFormProps, 'onChoice'>) {
  return (
    <>
      {choice === 'google' ? (
        <div className="mt-2 ml-2 border-l-2 border-border pl-4">
          <Field data-invalid={errors.clientId !== undefined}>
            <FieldLabel htmlFor={`${idPrefix}-google-client-id`}>Client ID</FieldLabel>
            <Input
              id={`${idPrefix}-google-client-id`}
              autoComplete="off"
              required
              value={provider.clientId}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                onProvider({ clientId: event.target.value });
              }}
              aria-invalid={errors.clientId !== undefined}
              aria-describedby={errors.clientId ? `${idPrefix}-google-client-id-error` : undefined}
            />
            {errors.clientId ? (
              <FieldError id={`${idPrefix}-google-client-id-error`}>{errors.clientId}</FieldError>
            ) : null}
          </Field>
          <Field data-invalid={errors.clientSecret !== undefined}>
            <FieldLabel htmlFor={`${idPrefix}-google-client-secret`}>Client secret</FieldLabel>
            <Input
              id={`${idPrefix}-google-client-secret`}
              type="password"
              autoComplete="new-password"
              required
              value={provider.clientSecret}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                onProvider({ clientSecret: event.target.value });
              }}
              aria-invalid={errors.clientSecret !== undefined}
              aria-describedby={
                errors.clientSecret ? `${idPrefix}-google-client-secret-error` : undefined
              }
            />
            {errors.clientSecret ? (
              <FieldError id={`${idPrefix}-google-client-secret-error`}>
                {errors.clientSecret}
              </FieldError>
            ) : null}
          </Field>
        </div>
      ) : null}
      {choice === 'generic' ? (
        <div className="mt-2 ml-2 border-l-2 border-border pl-4">
          <Field data-invalid={errors.providerName !== undefined}>
            <FieldLabel htmlFor={`${idPrefix}-provider-name`}>Provider name</FieldLabel>
            <Input
              id={`${idPrefix}-provider-name`}
              autoComplete="off"
              required
              value={provider.providerName}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                onProvider({ providerName: event.target.value });
              }}
              aria-invalid={errors.providerName !== undefined}
              aria-describedby={
                errors.providerName
                  ? `${idPrefix}-provider-name-error ${idPrefix}-provider-name-description`
                  : `${idPrefix}-provider-name-description`
              }
            />
            <FieldDescription id={`${idPrefix}-provider-name-description`}>
              The name staff will see at sign-in, for example “Fabrikam sign-in”.
            </FieldDescription>
            {errors.providerName ? (
              <FieldError id={`${idPrefix}-provider-name-error`}>{errors.providerName}</FieldError>
            ) : null}
          </Field>
          <Field data-invalid={errors.issuerUrl !== undefined}>
            <FieldLabel htmlFor={`${idPrefix}-issuer-url`}>Issuer URL</FieldLabel>
            <Input
              id={`${idPrefix}-issuer-url`}
              autoComplete="off"
              inputMode="url"
              required
              value={provider.issuerUrl}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                onProvider({ issuerUrl: event.target.value });
              }}
              aria-invalid={errors.issuerUrl !== undefined}
              aria-describedby={
                errors.issuerUrl
                  ? `${idPrefix}-issuer-url-error ${idPrefix}-issuer-url-description`
                  : `${idPrefix}-issuer-url-description`
              }
            />
            <FieldDescription id={`${idPrefix}-issuer-url-description`}>
              The address your provider gives for OpenID configuration, starting with https://.
            </FieldDescription>
            {errors.issuerUrl ? (
              <FieldError id={`${idPrefix}-issuer-url-error`}>{errors.issuerUrl}</FieldError>
            ) : null}
          </Field>
          <Field data-invalid={errors.clientId !== undefined}>
            <FieldLabel htmlFor={`${idPrefix}-generic-client-id`}>Client ID</FieldLabel>
            <Input
              id={`${idPrefix}-generic-client-id`}
              autoComplete="off"
              required
              value={provider.clientId}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                onProvider({ clientId: event.target.value });
              }}
              aria-invalid={errors.clientId !== undefined}
              aria-describedby={errors.clientId ? `${idPrefix}-generic-client-id-error` : undefined}
            />
            {errors.clientId ? (
              <FieldError id={`${idPrefix}-generic-client-id-error`}>{errors.clientId}</FieldError>
            ) : null}
          </Field>
          <Field data-invalid={errors.clientSecret !== undefined}>
            <FieldLabel htmlFor={`${idPrefix}-generic-client-secret`}>Client secret</FieldLabel>
            <Input
              id={`${idPrefix}-generic-client-secret`}
              type="password"
              autoComplete="new-password"
              required
              value={provider.clientSecret}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                onProvider({ clientSecret: event.target.value });
              }}
              aria-invalid={errors.clientSecret !== undefined}
              aria-describedby={
                errors.clientSecret ? `${idPrefix}-generic-client-secret-error` : undefined
              }
            />
            {errors.clientSecret ? (
              <FieldError id={`${idPrefix}-generic-client-secret-error`}>
                {errors.clientSecret}
              </FieldError>
            ) : null}
          </Field>
          <Collapsible
            open={provider.advancedOpen}
            onOpenChange={(open: boolean) => {
              onProvider({ advancedOpen: open });
            }}
          >
            <CollapsibleTrigger className="text-sm font-medium text-primary underline underline-offset-4 hover:text-primary/80">
              Advanced provider settings
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <Field data-invalid={errors.providerKey !== undefined}>
                <FieldLabel htmlFor={`${idPrefix}-provider-key`}>Provider key</FieldLabel>
                <Input
                  id={`${idPrefix}-provider-key`}
                  autoComplete="off"
                  value={provider.providerKey}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    onProvider({ providerKey: event.target.value });
                  }}
                  aria-invalid={errors.providerKey !== undefined}
                  aria-describedby={`${idPrefix}-provider-key-description`}
                />
                <FieldDescription id={`${idPrefix}-provider-key-description`}>
                  Lowercase letters, numbers, and dashes. Defaults to the provider name.
                </FieldDescription>
                {errors.providerKey ? <FieldError>{errors.providerKey}</FieldError> : null}
              </Field>
              <Field>
                <FieldLabel htmlFor={`${idPrefix}-auth-method`}>Client authentication</FieldLabel>
                <NativeSelect
                  id={`${idPrefix}-auth-method`}
                  value={provider.authMethod}
                  onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                    onProvider({
                      authMethod:
                        event.target.value === 'client_secret_basic'
                          ? 'client_secret_basic'
                          : 'client_secret_post',
                    });
                  }}
                >
                  <NativeSelectOption value="client_secret_post">
                    Send credentials with the request (most providers)
                  </NativeSelectOption>
                  <NativeSelectOption value="client_secret_basic">
                    Send credentials as an authorization header
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field data-invalid={errors.scopes !== undefined}>
                <FieldLabel htmlFor={`${idPrefix}-scopes`}>Scopes</FieldLabel>
                <Input
                  id={`${idPrefix}-scopes`}
                  autoComplete="off"
                  value={provider.scopes}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    onProvider({ scopes: event.target.value });
                  }}
                  aria-invalid={errors.scopes !== undefined}
                  aria-describedby={`${idPrefix}-scopes-description`}
                />
                <FieldDescription id={`${idPrefix}-scopes-description`}>
                  Space-separated permissions. Must include openid.
                </FieldDescription>
                {errors.scopes ? <FieldError>{errors.scopes}</FieldError> : null}
              </Field>
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : null}
      {allowLater && choice === 'later' ? (
        <Alert className="mt-2">
          <AlertDescription>
            You&apos;ll need to connect school sign-in before temporary setup access expires. If you
            lose access first, a WayPass recovery code can be used to finish setup.
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

/** Sign-in options plus provider fields for surfaces outside Questionnaire. */
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
    <div>
      <ProviderChoiceCards
        idPrefix={idPrefix}
        choice={choice}
        allowLater={allowLater}
        errorId={errors.choice ? `${idPrefix}-choice-error` : undefined}
        onChoice={(value) => {
          onChoice(value);
        }}
      />
      <ProviderDetailsForm
        idPrefix={idPrefix}
        choice={choice}
        provider={provider}
        errors={errors}
        allowLater={allowLater}
        onProvider={onProvider}
      />
      {errors.choice ? (
        <p
          className="mt-2 text-sm font-medium text-destructive"
          id={`${idPrefix}-choice-error`}
          role="alert"
        >
          {errors.choice}
        </p>
      ) : null}
    </div>
  );
}
