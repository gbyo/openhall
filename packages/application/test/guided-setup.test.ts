import { Temporal } from '@js-temporal/polyfill';
import type { Clock } from '@openhall/domain';
import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  assertValidTimeZone,
  CANONICAL_GOOGLE_PROVIDER,
  deriveSlug,
  initializeBootstrapBase,
  SESSION_POLICY,
  sessionExpiry,
  toBase64Url,
  validateBootstrapToken,
  type BaseBootstrapFinalizer,
  type BootstrapInstallation,
  type CredentialDigester,
  type InitializeBootstrapDependencies,
  type OperatorGrantRecord,
  type OperatorGrantStore,
  type SecureRandomSource,
  type TenantDirectory,
  type ValidateBootstrapTokenDependencies,
} from '../src/authentication/index.js';
import type { SystemTransactionContext, SystemTransactionRunner } from '../src/persistence.js';

const T0 = Temporal.Instant.from('2026-09-20T12:00:00Z');

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function keyOf(digest: Uint8Array): string {
  return Buffer.from(digest).toString('hex');
}

const digester: CredentialDigester = {
  digest: (credential) => credential,
  digestSessionToken: (credential) => credential,
  deriveCsrfToken: (credential) => {
    const prefix = new TextEncoder().encode('csrf:v1:');
    const derived = new Uint8Array(prefix.length + credential.length);
    derived.set(prefix, 0);
    derived.set(credential, prefix.length);
    return derived;
  },
  matches: (first, second) =>
    first.length === second.length && first.every((value, index) => value === second[index]),
};

const random: SecureRandomSource = {
  randomBytes: (byteLength) => new Uint8Array(byteLength).fill(9),
};

function manualClock(): Clock {
  return { now: () => T0 };
}

const runner: SystemTransactionRunner = {
  run: (operation) => operation({} as SystemTransactionContext),
};

function grantFixture(id: string): OperatorGrantRecord {
  return {
    id,
    purpose: 'bootstrap',
    tenantId: null,
    accountId: null,
    createdAt: T0,
    expiresAt: T0.add({ seconds: 3600 }),
    consumedAt: null,
    revokedAt: null,
  };
}

interface GrantHarness {
  readonly store: OperatorGrantStore;
  readonly live: Map<string, OperatorGrantRecord>;
  consumeCalls: number;
}

function grantHarness(): GrantHarness {
  const live = new Map<string, OperatorGrantRecord>();
  const harness: GrantHarness = {
    live,
    consumeCalls: 0,
    store: {
      create: () => {
        throw new Error('not used');
      },
      findValidByTokenDigest: (digest) => Promise.resolve(live.get(keyOf(digest))),
      consumeByTokenDigest: (digest) => {
        harness.consumeCalls += 1;
        const grant = live.get(keyOf(digest));
        if (grant === undefined) return Promise.resolve(undefined);
        live.delete(keyOf(digest));
        return Promise.resolve(grant);
      },
      consumeById: () => Promise.resolve(undefined),
    },
  };
  return harness;
}

function tenantsWith(count: number): TenantDirectory {
  return {
    findById: () => Promise.resolve(undefined),
    findBySlug: () => Promise.resolve(undefined),
    listForDiscovery: () => Promise.resolve([]),
    countCanonical: () => Promise.resolve(count),
  };
}

async function errorCode(task: Promise<unknown>): Promise<string> {
  try {
    await task;
  } catch (error) {
    if (error instanceof AuthenticationError) return error.code;
    throw error;
  }
  throw new Error('Expected an AuthenticationError');
}

function installationFixture(): BootstrapInstallation {
  const expiry = sessionExpiry(T0, 'setup');
  return {
    tenant: { id: 'tenant-1', slug: 'greenwood-high', name: 'Greenwood High', status: 'active' },
    accountId: 'account-1',
    personId: 'person-1',
    session: {
      id: 'session-1',
      tenantId: 'tenant-1',
      accountId: 'account-1',
      identityProviderId: null,
      tokenDigest: bytes('session'),
      csrfTokenDigest: bytes('csrf'),
      accountSessionRevision: 0n,
      authenticationMethod: 'setup',
      createdAt: T0,
      authenticatedAt: T0,
      lastSeenAt: T0,
      idleExpiresAt: expiry.idleExpiresAt,
      absoluteExpiresAt: expiry.absoluteExpiresAt,
      revokedAt: null,
      revocationReason: null,
    },
  };
}

describe('setup session policy', () => {
  it('issues a genuinely useful 12-hour idle and 24-hour absolute lifetime', () => {
    const lifetimes = sessionExpiry(T0, 'setup');
    expect(lifetimes.idleExpiresAt.epochMilliseconds - T0.epochMilliseconds).toBe(
      SESSION_POLICY.setupIdleTtlSeconds * 1000,
    );
    expect(lifetimes.absoluteExpiresAt.epochMilliseconds - T0.epochMilliseconds).toBe(
      SESSION_POLICY.setupAbsoluteTtlSeconds * 1000,
    );
    expect(SESSION_POLICY.setupIdleTtlSeconds).toBe(12 * 60 * 60);
    expect(SESSION_POLICY.setupAbsoluteTtlSeconds).toBe(24 * 60 * 60);
  });

  it('keeps OIDC and recovery lifetimes unchanged', () => {
    const oidc = sessionExpiry(T0, 'oidc');
    expect(oidc.idleExpiresAt.epochMilliseconds - T0.epochMilliseconds).toBe(12 * 60 * 60 * 1000);
    expect(oidc.absoluteExpiresAt.epochMilliseconds - T0.epochMilliseconds).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    const recovery = sessionExpiry(T0, 'recovery');
    expect(recovery.idleExpiresAt.epochMilliseconds - T0.epochMilliseconds).toBe(15 * 60 * 1000);
    expect(recovery.absoluteExpiresAt.epochMilliseconds - T0.epochMilliseconds).toBe(
      30 * 60 * 1000,
    );
  });

  it('preserves the legacy boolean signature', () => {
    expect(sessionExpiry(T0, false).idleExpiresAt).toEqual(sessionExpiry(T0, 'oidc').idleExpiresAt);
    expect(sessionExpiry(T0, true).idleExpiresAt).toEqual(
      sessionExpiry(T0, 'recovery').idleExpiresAt,
    );
  });
});

describe('slug derivation', () => {
  it('derives deterministic lowercase slugs', () => {
    expect(deriveSlug('Ninety Six High School')).toBe('ninety-six-high-school');
    expect(deriveSlug('  Greenwood  High ')).toBe('greenwood-high');
    expect(deriveSlug('École Saint-Luc')).toBe('ecole-saint-luc');
  });

  it('refuses to silently produce empty slugs', () => {
    expect(deriveSlug('!!!')).toBeUndefined();
    expect(deriveSlug('   ')).toBeUndefined();
  });

  it('caps slugs at the canonical length', () => {
    const slug = deriveSlug(`${'a'.repeat(100)} school`);
    expect(slug?.length).toBeLessThanOrEqual(63);
  });
});

describe('time-zone validation', () => {
  it('accepts canonical IANA zones', () => {
    expect(assertValidTimeZone('America/Chicago')).toBe('America/Chicago');
    expect(assertValidTimeZone('America/New_York')).toBe('America/New_York');
  });

  it('rejects unknown zones without trusting the browser', () => {
    expect(() => assertValidTimeZone('Mars/Olympus')).toThrow(
      expect.objectContaining({ code: 'invalid_bootstrap_draft' }),
    );
    expect(() => assertValidTimeZone('')).toThrow(
      expect.objectContaining({ code: 'invalid_bootstrap_draft' }),
    );
  });
});

describe('Google preset ownership', () => {
  it('is fully server-owned, not frontend-supplied', () => {
    expect(CANONICAL_GOOGLE_PROVIDER.issuer).toBe('https://accounts.google.com');
    expect([...CANONICAL_GOOGLE_PROVIDER.scopes]).toEqual(['openid', 'email', 'profile']);
    expect(CANONICAL_GOOGLE_PROVIDER.key).toBe('workspace');
    expect(CANONICAL_GOOGLE_PROVIDER.displayName).toBe('Google Workspace');
    expect(CANONICAL_GOOGLE_PROVIDER.tokenEndpointAuthMethod).toBe('client_secret_post');
  });
});

describe('validateBootstrapToken', () => {
  function dependencies(
    harness: GrantHarness,
    canonicalCount: number,
  ): ValidateBootstrapTokenDependencies {
    return {
      grants: harness.store,
      tenants: tenantsWith(canonicalCount),
      random,
      digester,
      clock: manualClock(),
      runner,
    };
  }

  it('accepts a live grant without consuming it', async () => {
    const harness = grantHarness();
    const raw = toBase64Url(bytes('setup-code'));
    harness.live.set(keyOf(bytes('setup-code')), grantFixture('grant-1'));
    const result = await validateBootstrapToken(raw, dependencies(harness, 0));
    expect(result).toEqual({ valid: true });
    expect(harness.consumeCalls).toBe(0);
    expect(harness.live.has(keyOf(bytes('setup-code')))).toBe(true);
  });

  it('rejects malformed tokens without revealing why', async () => {
    const harness = grantHarness();
    expect(await errorCode(validateBootstrapToken('%%%', dependencies(harness, 0)))).toBe(
      'bootstrap_token_invalid',
    );
    expect(await errorCode(validateBootstrapToken('', dependencies(harness, 0)))).toBe(
      'bootstrap_token_invalid',
    );
    expect(harness.consumeCalls).toBe(0);
  });

  it('rejects unknown tokens without consuming anything', async () => {
    const harness = grantHarness();
    expect(
      await errorCode(
        validateBootstrapToken(toBase64Url(bytes('unknown')), dependencies(harness, 0)),
      ),
    ).toBe('bootstrap_token_invalid');
    expect(harness.consumeCalls).toBe(0);
  });

  it('refuses validation once an installation already exists', async () => {
    const harness = grantHarness();
    const raw = toBase64Url(bytes('setup-code'));
    harness.live.set(keyOf(bytes('setup-code')), grantFixture('grant-1'));
    expect(await errorCode(validateBootstrapToken(raw, dependencies(harness, 1)))).toBe(
      'bootstrap_unavailable',
    );
    expect(harness.consumeCalls).toBe(0);
  });
});

describe('initializeBootstrapBase', () => {
  function dependencies(
    harness: GrantHarness,
    canonicalCount: number,
    seen: { input?: Parameters<BaseBootstrapFinalizer['initializeBase']>[1] },
  ): InitializeBootstrapDependencies {
    const finalizer: BaseBootstrapFinalizer = {
      initializeBase: (_context, input) => {
        seen.input = input;
        return Promise.resolve(installationFixture());
      },
    };
    return {
      grants: harness.store,
      tenants: tenantsWith(canonicalCount),
      random,
      digester,
      clock: manualClock(),
      finalizer,
      runner,
    };
  }

  const baseInput = {
    operatorToken: toBase64Url(bytes('setup-code')),
    tenantName: '',
    schoolName: 'Ninety Six High School',
    schoolTimeZone: 'America/New_York',
    adminGivenName: 'Gibson',
    adminFamilyName: 'Bell',
    requestId: 'request-1',
  };

  it('creates the installation with derived defaults and a setup session', async () => {
    const harness = grantHarness();
    harness.live.set(keyOf(bytes('setup-code')), grantFixture('grant-1'));
    const seen: { input?: Parameters<BaseBootstrapFinalizer['initializeBase']>[1] } = {};
    const result = await initializeBootstrapBase(baseInput, dependencies(harness, 0, seen));
    expect(harness.consumeCalls).toBe(1);
    expect(seen.input?.tenantName).toBe('Ninety Six High School');
    expect(seen.input?.tenantSlug).toBe('ninety-six-high-school');
    expect(seen.input?.schoolSlug).toBe('ninety-six-high-school');
    expect(seen.input?.adminDisplayName).toBe('Gibson Bell');
    expect(seen.input && 'providerKey' in seen.input).toBe(false);
    expect(result.installation.session.authenticationMethod).toBe('setup');
    expect(typeof result.sessionToken).toBe('string');
    expect(typeof result.csrfToken).toBe('string');
  });

  it('rejects a second use of the same setup code', async () => {
    const harness = grantHarness();
    harness.live.set(keyOf(bytes('setup-code')), grantFixture('grant-1'));
    const seen: { input?: Parameters<BaseBootstrapFinalizer['initializeBase']>[1] } = {};
    await initializeBootstrapBase(baseInput, dependencies(harness, 0, seen));
    expect(
      await errorCode(initializeBootstrapBase(baseInput, dependencies(harness, 0, seen))),
    ).toBe('bootstrap_token_invalid');
  });

  it('refuses to initialize over an existing installation', async () => {
    const harness = grantHarness();
    harness.live.set(keyOf(bytes('setup-code')), grantFixture('grant-1'));
    const seen: { input?: Parameters<BaseBootstrapFinalizer['initializeBase']>[1] } = {};
    expect(
      await errorCode(initializeBootstrapBase(baseInput, dependencies(harness, 1, seen))),
    ).toBe('bootstrap_unavailable');
    expect(harness.consumeCalls).toBe(0);
    expect(seen.input).toBeUndefined();
  });

  it('rejects invalid time zones before touching the grant', async () => {
    const harness = grantHarness();
    harness.live.set(keyOf(bytes('setup-code')), grantFixture('grant-1'));
    const seen: { input?: Parameters<BaseBootstrapFinalizer['initializeBase']>[1] } = {};
    expect(
      await errorCode(
        initializeBootstrapBase(
          { ...baseInput, schoolTimeZone: 'Mars/Olympus' },
          dependencies(harness, 0, seen),
        ),
      ),
    ).toBe('invalid_bootstrap_draft');
    expect(harness.consumeCalls).toBe(0);
  });

  it('requires explicit slugs when derivation is impossible', async () => {
    const harness = grantHarness();
    harness.live.set(keyOf(bytes('setup-code')), grantFixture('grant-1'));
    const seen: { input?: Parameters<BaseBootstrapFinalizer['initializeBase']>[1] } = {};
    expect(
      await errorCode(
        initializeBootstrapBase(
          { ...baseInput, schoolName: '!!!' },
          dependencies(harness, 0, seen),
        ),
      ),
    ).toBe('invalid_bootstrap_draft');
    const explicit = await initializeBootstrapBase(
      { ...baseInput, schoolName: '!!!', tenantSlug: 'ninety-six', schoolSlug: 'ninety-six-high' },
      dependencies(harness, 0, seen),
    );
    expect(explicit.installation.session.authenticationMethod).toBe('setup');
    expect(seen.input?.schoolSlug).toBe('ninety-six-high');
  });
});
