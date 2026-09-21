import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react';

export type SignInChoice = 'google' | 'generic' | 'later';

export interface SchoolDraft {
  name: string;
  timeZone: string;
  organizationName: string;
  organizationSlug: string;
  schoolSlug: string;
  advancedOpen: boolean;
}

export interface AdministratorDraft {
  givenName: string;
  familyName: string;
  displayName: string;
  customDisplayName: boolean;
}

const SETUP_TIME_ZONE_FALLBACK = 'America/Chicago';

/**
 * Normalize a guessed IANA zone against the supported list. Runtimes can
 * report zones outside `supportedValuesOf('timeZone')` (for example `UTC`),
 * which would otherwise leave the timezone question without a default.
 */
export function resolveTimeZoneDefault(
  guessed: string | undefined,
  supported: readonly string[],
  fallback: string = SETUP_TIME_ZONE_FALLBACK,
): string {
  return guessed && supported.includes(guessed) ? guessed : fallback;
}

/** Browser default timezone, normalized so the question always has a default. */
export function defaultTimeZone(): string {
  if (typeof Intl === 'undefined') return SETUP_TIME_ZONE_FALLBACK;
  return resolveTimeZoneDefault(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    supportedTimeZones(),
  );
}

const FALLBACK_TIME_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Puerto_Rico',
];

export interface ProviderDraft {
  clientId: string;
  clientSecret: string;
  providerName: string;
  issuerUrl: string;
  providerKey: string;
  authMethod: 'client_secret_post' | 'client_secret_basic';
  scopes: string;
  advancedOpen: boolean;
}

export interface SetupState {
  /** One-time setup code. Memory-only: never persisted anywhere. */
  operatorToken: string;
  unlocked: boolean;
  school: SchoolDraft;
  administrator: AdministratorDraft;
  choice: SignInChoice | null;
  provider: ProviderDraft;
}

const initialState: SetupState = {
  operatorToken: '',
  unlocked: false,
  school: {
    name: '',
    timeZone: defaultTimeZone(),
    organizationName: '',
    organizationSlug: '',
    schoolSlug: '',
    advancedOpen: false,
  },
  administrator: {
    givenName: '',
    familyName: '',
    displayName: '',
    customDisplayName: false,
  },
  choice: null,
  provider: {
    clientId: '',
    clientSecret: '',
    providerName: '',
    issuerUrl: '',
    providerKey: '',
    authMethod: 'client_secret_post',
    scopes: 'openid',
    advancedOpen: false,
  },
};

export type SetupAction =
  | { type: 'unlock'; operatorToken: string }
  | { type: 'lock'; message?: undefined }
  | { type: 'setSchool'; school: Partial<SchoolDraft> }
  | { type: 'setAdministrator'; administrator: Partial<AdministratorDraft> }
  | { type: 'setChoice'; choice: SignInChoice }
  | { type: 'setProvider'; provider: Partial<ProviderDraft> }
  | { type: 'reset' };

function reducer(state: SetupState, action: SetupAction): SetupState {
  switch (action.type) {
    case 'unlock':
      return { ...state, operatorToken: action.operatorToken, unlocked: true };
    case 'lock':
      return { ...initialState };
    case 'setSchool':
      return { ...state, school: { ...state.school, ...action.school } };
    case 'setAdministrator': {
      const administrator = { ...state.administrator, ...action.administrator };
      if (!administrator.customDisplayName) {
        const combined = `${administrator.givenName} ${administrator.familyName}`
          .trim()
          .replace(/\s+/g, ' ');
        administrator.displayName = combined;
      }
      return { ...state, administrator };
    }
    case 'setChoice':
      return { ...state, choice: action.choice };
    case 'setProvider':
      return { ...state, provider: { ...state.provider, ...action.provider } };
    case 'reset':
      return { ...initialState };
  }
}

const SetupContext = createContext<{
  state: SetupState;
  dispatch: React.Dispatch<SetupAction>;
} | null>(null);

export function SetupProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <SetupContext.Provider value={value}>{children}</SetupContext.Provider>;
}

export function useSetup(): {
  state: SetupState;
  dispatch: React.Dispatch<SetupAction>;
} {
  const context = useContext(SetupContext);
  if (context === null) throw new Error('useSetup must be used inside SetupProvider');
  return context;
}

/** Client-side slug default. The server remains authoritative. */
export function deriveSlugDefault(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : '';
}

/** Valid IANA zones where supported, with a small fallback otherwise. */
export function supportedTimeZones(): string[] {
  try {
    const values = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.('timeZone');
    if (Array.isArray(values) && values.length > 0) return [...values].sort();
  } catch {
    // Fall through to the fallback list.
  }
  return [...FALLBACK_TIME_ZONES].sort();
}

/** Friendly label plus canonical zone for timezone options. */
export function timeZoneLabel(zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'short',
    }).formatToParts();
    const abbreviation = parts.find((part) => part.type === 'timeZoneName')?.value;
    const city = zone.split('/').pop()?.replace(/_/g, ' ') ?? zone;
    return abbreviation ? `${city} (${abbreviation}, ${zone})` : `${city} (${zone})`;
  } catch {
    return zone;
  }
}
