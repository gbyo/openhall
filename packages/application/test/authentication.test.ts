import { Temporal } from '@js-temporal/polyfill';
import type { Clock } from '@openhall/domain';
import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  completeOidcLogin,
  logoutAllSessions,
  logoutSession,
  prepareBootstrap,
  resolveSession,
  SESSION_POLICY,
  sessionExpiry,
  toBase64Url,
} from '../src/authentication/index.js';
import type {
  PrepareBootstrapDependencies,
  PrepareBootstrapInput,
} from '../src/authentication/index.js';
import type {
  AccountRecord,
  AuditWriter,
  AuthIdentityRecord,
  BootstrapRepository,
  CredentialDigester,
  IdentityDirectory,
  IdentityProviderRecord,
  OidcProtocolAdapter,
  OidcTransactionRecord,
  OidcTransactionStore,
  OperatorGrantStore,
  PersonRecord,
  SecretProtector,
  SecureRandomSource,
  SessionCredentialLookup,
  SessionRecord,
  SessionRepository,
  Sha256Hasher,
  TenantDirectory,
  TenantRecord,
} from '../src/authentication/ports.js';
import type {
  SystemTransactionContext,
  SystemTransactionRunner,
  TenantTransactionContext,
  TenantTransactionRunner,
} from '../src/persistence.js';
import type { ResolvedSession } from '../src/authentication/sessions.js';

const T0 = Temporal.Instant.from('2026-09-20T12:00:00Z');

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function tenantContext(tenantId: string): TenantTransactionContext {
  return { tenantId } as TenantTransactionContext;
}

/**
 * Identity digester with explicit domain separation for the mock: generic
 * digests are the raw bytes, session digests are the raw bytes, and derived
 * CSRF material is visibly distinct (prefixed) so tests can prove the two
 * domains never collide. Matching is byte equality.
 */
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

function manualClock(start: Temporal.Instant): Clock {
  const current = start;
  return { now: () => current };
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

const tenant: TenantRecord = {
  id: 'tenant-1',
  slug: 'greenwood',
  name: 'Greenwood',
  status: 'active',
};

const account: AccountRecord = {
  id: 'account-1',
  tenantId: 'tenant-1',
  personId: 'person-1',
  status: 'active',
  sessionRevision: 1n,
};

const person: PersonRecord = {
  id: 'person-1',
  tenantId: 'tenant-1',
  givenName: 'Ada',
  familyName: 'Admin',
  displayName: 'Ada Admin',
  status: 'active',
};

function sessionFixture(overrides?: Partial<SessionRecord>): SessionRecord {
  const authenticatedAt = T0;
  return {
    id: 'session-1',
    tenantId: 'tenant-1',
    accountId: 'account-1',
    identityProviderId: 'provider-1',
    tokenDigest: bytes('token-digest'),
    csrfTokenDigest: bytes('csrf-digest'),
    accountSessionRevision: 1n,
    authenticationMethod: 'oidc',
    createdAt: authenticatedAt,
    authenticatedAt,
    lastSeenAt: authenticatedAt,
    idleExpiresAt: authenticatedAt.add({ seconds: SESSION_POLICY.idleTtlSeconds }),
    absoluteExpiresAt: authenticatedAt.add({ seconds: SESSION_POLICY.absoluteTtlSeconds }),
    revokedAt: null,
    revocationReason: null,
    ...overrides,
  };
}

interface SessionHarness {
  readonly touched: { sessionId: string; at: Temporal.Instant }[];
  readonly ranTenants: string[];
  resolve: (
    token: Uint8Array,
    setup: {
      session?: SessionRecord;
      tenantStatus?: TenantRecord['status'];
      accountStatus?: AccountRecord['status'];
      accountRevision?: bigint;
      personStatus?: PersonRecord['status'];
      now?: Temporal.Instant;
    },
  ) => Promise<ResolvedSession>;
}

function sessionHarness(): SessionHarness {
  const touched: { sessionId: string; at: Temporal.Instant }[] = [];
  const ranTenants: string[] = [];
  const sessions: SessionRepository = {
    create: () => {
      throw new Error('not used');
    },
    touchLastSeen: (_context, sessionId, lastSeenAt) => {
      touched.push({ sessionId, at: lastSeenAt });
      return Promise.resolve();
    },
    revokeSession: () => {
      throw new Error('not used');
    },
    revokeAllForAccount: () => {
      throw new Error('not used');
    },
  };
  return {
    touched,
    ranTenants,
    resolve: (token, setup) => {
      const record = setup.session ?? sessionFixture();
      const liveTenant: TenantRecord = { ...tenant, status: setup.tenantStatus ?? 'active' };
      const liveAccount: AccountRecord = {
        ...account,
        status: setup.accountStatus ?? 'active',
        sessionRevision: setup.accountRevision ?? 1n,
      };
      const livePerson: PersonRecord = { ...person, status: setup.personStatus ?? 'active' };
      const lookup: SessionCredentialLookup = {
        findByTokenDigest: (digest) =>
          Promise.resolve(
            digest.length === record.tokenDigest.length &&
              digest.every((value, index) => value === record.tokenDigest[index])
              ? record
              : undefined,
          ),
      };
      const directory: IdentityDirectory = {
        findTenant: (_context, tenantId) => {
          return Promise.resolve(tenantId === liveTenant.id ? liveTenant : undefined);
        },
        findAccount: (_context, accountId) => {
          return Promise.resolve(accountId === liveAccount.id ? liveAccount : undefined);
        },
        findPerson: (_context, personId) => {
          return Promise.resolve(personId === livePerson.id ? livePerson : undefined);
        },
        findProvider: () => Promise.reject(new Error('not used')),
        findProviderByKey: () => Promise.reject(new Error('not used')),
        listActiveProviders: () => Promise.reject(new Error('not used')),
        findIdentity: () => Promise.reject(new Error('not used')),
        createIdentity: () => Promise.reject(new Error('not used')),
        updateIdentityEmailSnapshot: () => Promise.reject(new Error('not used')),
        incrementSessionRevision: () => Promise.reject(new Error('not used')),
        hasActiveSystemAdminGrant: () => Promise.reject(new Error('not used')),
      };
      const runner: TenantTransactionRunner = {
        run: (tenantId, operation) => {
          ranTenants.push(tenantId);
          return operation(tenantContext(tenantId));
        },
      };
      return resolveSession(token, {
        lookup,
        directory,
        sessions,
        digester,
        clock: manualClock(setup.now ?? T0),
        runTenantTransaction: (tenantId, operation) => runner.run(tenantId, operation),
      });
    },
  };
}

describe('resolveSession', () => {
  it('resolves a valid session to a principal carrying the bigint revision', async () => {
    const harness = sessionHarness();
    const resolved = await harness.resolve(bytes('token-digest'), {});
    expect(resolved.principal).toEqual({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      personId: 'person-1',
      sessionRevision: 1n,
      authenticationMethod: 'oidc',
    });
    expect(typeof resolved.principal.sessionRevision).toBe('bigint');
    expect(resolved.touched).toBe(false);
    expect(harness.touched).toEqual([]);
    expect(harness.ranTenants).toEqual(['tenant-1']);
  });

  it('rejects unknown sessions generically', async () => {
    const harness = sessionHarness();
    await expect(harness.resolve(bytes('no-such-token'), {})).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(await errorCode(harness.resolve(bytes('no-such-token'), {}))).toBe('unauthenticated');
  });

  it('rejects revoked sessions', async () => {
    const harness = sessionHarness();
    const revoked = sessionFixture({ revokedAt: T0, revocationReason: 'logout' });
    expect(await errorCode(harness.resolve(bytes('token-digest'), { session: revoked }))).toBe(
      'unauthenticated',
    );
  });

  it('rejects idle-expired sessions while absolute lifetime remains', async () => {
    const harness = sessionHarness();
    const stale = sessionFixture({
      authenticatedAt: T0.add({ hours: -13 }),
      lastSeenAt: T0.add({ hours: -13 }),
      idleExpiresAt: T0.add({ hours: -1 }),
      absoluteExpiresAt: T0.add({ hours: 155 }),
    });
    expect(await errorCode(harness.resolve(bytes('token-digest'), { session: stale }))).toBe(
      'unauthenticated',
    );
  });

  it('rejects absolute-expired sessions', async () => {
    const harness = sessionHarness();
    const aged = sessionFixture({
      authenticatedAt: T0.add({ hours: -192 }),
      lastSeenAt: T0.add({ minutes: -1 }),
      idleExpiresAt: T0.add({ hours: 11 }),
      absoluteExpiresAt: T0.add({ hours: -24 }),
    });
    expect(await errorCode(harness.resolve(bytes('token-digest'), { session: aged }))).toBe(
      'unauthenticated',
    );
  });

  it('rejects suspended and archived tenants', async () => {
    for (const tenantStatus of ['suspended', 'archived'] as const) {
      const harness = sessionHarness();
      expect(await errorCode(harness.resolve(bytes('token-digest'), { tenantStatus }))).toBe(
        'unauthenticated',
      );
    }
  });

  it('rejects locked and disabled accounts', async () => {
    for (const accountStatus of ['locked', 'disabled'] as const) {
      const harness = sessionHarness();
      expect(await errorCode(harness.resolve(bytes('token-digest'), { accountStatus }))).toBe(
        'unauthenticated',
      );
    }
  });

  it('rejects inactive and archived people', async () => {
    for (const personStatus of ['inactive', 'archived'] as const) {
      const harness = sessionHarness();
      expect(await errorCode(harness.resolve(bytes('token-digest'), { personStatus }))).toBe(
        'unauthenticated',
      );
    }
  });

  it('rejects session-revision mismatch after logout-all', async () => {
    const harness = sessionHarness();
    expect(await errorCode(harness.resolve(bytes('token-digest'), { accountRevision: 2n }))).toBe(
      'unauthenticated',
    );
  });

  it('rewrites last_seen_at only after the touch window elapses', async () => {
    const due = sessionHarness();
    const resolved = await due.resolve(bytes('token-digest'), {
      session: sessionFixture({ lastSeenAt: T0.add({ minutes: -6 }) }),
    });
    expect(resolved.touched).toBe(true);
    expect(due.touched).toHaveLength(1);
    expect(due.touched[0]?.sessionId).toBe('session-1');

    const fresh = sessionHarness();
    const untouched = await fresh.resolve(bytes('token-digest'), {
      session: sessionFixture({ lastSeenAt: T0.add({ minutes: -1 }) }),
    });
    expect(untouched.touched).toBe(false);
    expect(fresh.touched).toEqual([]);
  });
});

describe('sessionExpiry', () => {
  it('issues 12-hour idle and 7-day absolute lifetimes for OIDC sessions', () => {
    const lifetimes = sessionExpiry(T0, false);
    expect(lifetimes.idleExpiresAt.epochMilliseconds - T0.epochMilliseconds).toBe(
      12 * 60 * 60 * 1000,
    );
    expect(lifetimes.absoluteExpiresAt.epochMilliseconds - T0.epochMilliseconds).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
  });

  it('issues 15-minute idle and 30-minute absolute lifetimes for recovery sessions', () => {
    const lifetimes = sessionExpiry(T0, true);
    expect(lifetimes.idleExpiresAt.epochMilliseconds - T0.epochMilliseconds).toBe(15 * 60 * 1000);
    expect(lifetimes.absoluteExpiresAt.epochMilliseconds - T0.epochMilliseconds).toBe(
      30 * 60 * 1000,
    );
  });
});

describe('logout', () => {
  it('revokes the session and audits the logout', async () => {
    const revoked: { sessionId: string; reason: string }[] = [];
    const events: { action: string }[] = [];
    const sessions: SessionRepository = {
      create: () => {
        throw new Error('not used');
      },
      touchLastSeen: () => {
        throw new Error('not used');
      },
      revokeSession: (_context, sessionId, reason) => {
        revoked.push({ sessionId, reason });
        return Promise.resolve();
      },
      revokeAllForAccount: () => {
        throw new Error('not used');
      },
    };
    const audit: AuditWriter = {
      append: (_context, event) => {
        events.push({ action: event.action });
        return Promise.resolve();
      },
    };
    await logoutSession(tenantContext('tenant-1'), sessionFixture(), 'request-1', {
      sessions,
      audit,
      clock: manualClock(T0),
    });
    expect(revoked).toEqual([{ sessionId: 'session-1', reason: 'logout' }]);
    expect(events).toEqual([{ action: 'auth.logout' }]);
  });

  it('bumps the revision and revokes every session on logout-all', async () => {
    const bumped: string[] = [];
    const revokedAll: string[] = [];
    const events: { action: string }[] = [];
    const sessions: SessionRepository = {
      create: () => {
        throw new Error('not used');
      },
      touchLastSeen: () => {
        throw new Error('not used');
      },
      revokeSession: () => {
        throw new Error('not used');
      },
      revokeAllForAccount: (_context, accountId, reason) => {
        expect(reason).toBe('logout-all');
        revokedAll.push(accountId);
        return Promise.resolve(2);
      },
    };
    const audit: AuditWriter = {
      append: (_context, event) => {
        events.push({ action: event.action });
        return Promise.resolve();
      },
    };
    const directory: IdentityDirectory = {
      findTenant: () => Promise.reject(new Error('not used')),
      findAccount: () => Promise.reject(new Error('not used')),
      findPerson: () => Promise.reject(new Error('not used')),
      findProvider: () => Promise.reject(new Error('not used')),
      findProviderByKey: () => Promise.reject(new Error('not used')),
      listActiveProviders: () => Promise.reject(new Error('not used')),
      findIdentity: () => Promise.reject(new Error('not used')),
      createIdentity: () => Promise.reject(new Error('not used')),
      updateIdentityEmailSnapshot: () => Promise.reject(new Error('not used')),
      incrementSessionRevision: (_context, accountId) => {
        bumped.push(accountId);
        return Promise.resolve(2n);
      },
      hasActiveSystemAdminGrant: () => Promise.reject(new Error('not used')),
    };
    await logoutAllSessions(tenantContext('tenant-1'), sessionFixture(), 'request-1', {
      sessions,
      audit,
      clock: manualClock(T0),
      directory,
    });
    expect(bumped).toEqual(['account-1']);
    expect(revokedAll).toEqual(['account-1']);
    expect(events).toEqual([{ action: 'auth.logout_all' }]);
  });
});

describe('completeOidcLogin canonical lookup', () => {
  const protector: SecretProtector = {
    keyId: 'test-key',
    protect: (plaintext) => ({
      ciphertext: bytes(plaintext),
      nonce: new Uint8Array(0),
      tag: new Uint8Array(0),
      keyId: 'test-key',
    }),
    reveal: (secret) => new TextDecoder().decode(secret.ciphertext),
  };

  const provider: IdentityProviderRecord = {
    id: 'provider-1',
    tenantId: 'tenant-1',
    key: 'workspace',
    displayName: 'Workspace',
    issuer: 'https://provider.example',
    clientId: 'test-client',
    clientSecret: protector.protect('client-secret', 'provider-secret:v1:tenant-1:provider-1'),
    tokenEndpointAuthMethod: 'client_secret_basic',
    scopes: ['openid'],
    status: 'active',
    revision: 1,
  };

  const identity: AuthIdentityRecord = {
    id: 'identity-1',
    tenantId: 'tenant-1',
    accountId: 'account-1',
    issuer: 'https://provider.example',
    providerSubject: 'subject-1',
    emailSnapshot: null,
  };

  it('resolves identity by issuer and subject, never by email', async () => {
    const identityLookups: { issuer: string; subject: string }[] = [];
    const created: SessionRecord[] = [];
    const transaction: OidcTransactionRecord = {
      id: 'transaction-1',
      tenantId: 'tenant-1',
      identityProviderId: 'provider-1',
      bootstrapSetupId: null,
      identityEnrollmentGrantId: null,
      providerSetupAccountId: null,
      purpose: 'login',
      providerRevision: 1,
      stateDigest: bytes('test-state'),
      browserBindingDigest: bytes('test-binding'),
      transactionSecret: protector.protect(
        JSON.stringify({ verifier: 'verifier', nonce: 'nonce' }),
        'oidc-tx:v1:tenant-1:provider-1',
      ),
      returnPath: '/dashboard',
      status: 'pending',
      createdAt: T0,
      expiresAt: T0.add({ minutes: 10 }),
    };
    const transactions: OidcTransactionStore = {
      create: () => Promise.reject(new Error('not used')),
      claimByStateDigest: (digest) => {
        const claimed =
          digest.length === transaction.stateDigest.length &&
          digest.every((value, index) => value === transaction.stateDigest[index])
            ? transaction
            : undefined;
        return Promise.resolve(claimed);
      },
      peekByStateDigest: () => Promise.resolve(transaction),
      markFailed: () => Promise.resolve(),
      consume: () => Promise.resolve(),
    };
    const directory: IdentityDirectory = {
      findTenant: (_context, tenantId) => {
        return Promise.resolve(tenantId === tenant.id ? tenant : undefined);
      },
      findAccount: (_context, accountId) => {
        return Promise.resolve(accountId === account.id ? account : undefined);
      },
      findPerson: (_context, personId) => {
        return Promise.resolve(personId === person.id ? person : undefined);
      },
      findProvider: (_context, providerId) => {
        return Promise.resolve(providerId === provider.id ? provider : undefined);
      },
      findProviderByKey: () => Promise.reject(new Error('not used')),
      listActiveProviders: () => Promise.reject(new Error('not used')),
      findIdentity: (_context, issuer, subject) => {
        identityLookups.push({ issuer, subject });
        return Promise.resolve(
          issuer === identity.issuer && subject === identity.providerSubject ? identity : undefined,
        );
      },
      createIdentity: () => Promise.reject(new Error('not used')),
      updateIdentityEmailSnapshot: () => Promise.resolve(),
      incrementSessionRevision: () => Promise.reject(new Error('not used')),
      hasActiveSystemAdminGrant: () => Promise.reject(new Error('not used')),
    };
    const sessions: SessionRepository = {
      create: (_context, input) => {
        const createdRecord = sessionFixture({
          id: 'session-2',
          accountSessionRevision: input.accountSessionRevision,
          authenticationMethod: input.authenticationMethod,
        });
        created.push(createdRecord);
        return Promise.resolve(createdRecord);
      },
      touchLastSeen: () => Promise.resolve(),
      revokeSession: () => Promise.resolve(),
      revokeAllForAccount: () => Promise.resolve(0),
    };
    const adapter: OidcProtocolAdapter = {
      validateProviderConfiguration: () => Promise.resolve(),
      buildAuthorizationUrl: () => Promise.reject(new Error('not used')),
      exchangeCode: () =>
        Promise.resolve({
          issuer: 'https://provider.example',
          subject: 'subject-1',
          email: 'changed@example.com',
        }),
    };
    const random: SecureRandomSource = {
      randomBytes: (byteLength) => new Uint8Array(byteLength).fill(9),
    };
    const hasher: Sha256Hasher = {
      hash: (data) => data,
    };
    const completed = await completeOidcLogin(
      {
        state: 'test-state',
        browserBinding: toBase64Url(bytes('test-binding')),
        callbackUrl: 'https://openhall.example/api/v1/auth/oidc/callback?code=x&state=test-state',
        requestId: 'request-1',
        supersededSession: undefined,
      },
      {
        tenants: {
          findById: () => Promise.reject(new Error('not used')),
          findBySlug: () => Promise.reject(new Error('not used')),
          listForDiscovery: () => Promise.reject(new Error('not used')),
          countCanonical: () => Promise.reject(new Error('not used')),
        },
        directory,
        transactions,
        sessions,
        audit: { append: () => Promise.resolve() },
        adapter,
        random,
        digester,
        hasher,
        protector,
        clock: manualClock(T0),
        runner: {
          run: (tenantId, operation) => operation(tenantContext(tenantId)),
        },
        redirectUri: 'https://openhall.example/api/v1/auth/oidc/callback',
        allowInsecureHttp: false,
      },
    );
    // The only identity lookup uses the transaction-bound issuer plus the
    // verified subject: the changed email address is metadata, never a key.
    expect(identityLookups).toEqual([{ issuer: 'https://provider.example', subject: 'subject-1' }]);
    expect(completed.returnPath).toBe('/dashboard');
    expect(completed.sessionToken.length).toBeGreaterThan(0);
    expect(created).toHaveLength(1);
    expect(created[0]?.accountSessionRevision).toBe(1n);
  });
});

describe('prepareBootstrap operator token', () => {
  function operatorDependencies(): PrepareBootstrapDependencies {
    const grants: OperatorGrantStore = {
      create: () => Promise.reject(new Error('not used')),
      findValidByTokenDigest: () => Promise.resolve(undefined),
      consumeByTokenDigest: () => Promise.reject(new Error('not used')),
      consumeById: () => Promise.reject(new Error('not used')),
    };
    const tenants: TenantDirectory = {
      findById: () => Promise.reject(new Error('not used')),
      findBySlug: () => Promise.reject(new Error('not used')),
      listForDiscovery: () => Promise.reject(new Error('not used')),
      countCanonical: () => Promise.reject(new Error('not used')),
    };
    const transactions: OidcTransactionStore = {
      create: () => Promise.reject(new Error('not used')),
      claimByStateDigest: () => Promise.reject(new Error('not used')),
      peekByStateDigest: () => Promise.reject(new Error('not used')),
      markFailed: () => Promise.reject(new Error('not used')),
      consume: () => Promise.reject(new Error('not used')),
    };
    const drafts: BootstrapRepository = {
      findByGrantId: () => Promise.reject(new Error('not used')),
      findBySetupId: () => Promise.reject(new Error('not used')),
      createDraft: () => Promise.reject(new Error('not used')),
      updateDraft: () => Promise.reject(new Error('not used')),
    };
    const adapter: OidcProtocolAdapter = {
      validateProviderConfiguration: () => Promise.reject(new Error('not used')),
      buildAuthorizationUrl: () => Promise.reject(new Error('not used')),
      exchangeCode: () => Promise.reject(new Error('not used')),
    };
    const protector: SecretProtector = {
      keyId: 'test-key-1',
      protect: () => {
        throw new Error('not used');
      },
      reveal: () => {
        throw new Error('not used');
      },
    };
    const random: SecureRandomSource = {
      randomBytes: (byteLength) => new Uint8Array(byteLength).fill(9),
    };
    const hasher: Sha256Hasher = {
      hash: (data) => data,
    };
    const runner: SystemTransactionRunner = {
      run: (operation) => operation({ system: 'system-bootstrap' } as SystemTransactionContext),
    };
    return {
      grants,
      random,
      digester,
      clock: manualClock(T0),
      drafts,
      transactions,
      tenants,
      adapter,
      protector,
      hasher,
      redirectUri: 'https://openhall.example/api/v1/auth/oidc/callback',
      allowInsecureHttp: false,
      runner,
    };
  }

  function operatorInput(operatorToken: string): PrepareBootstrapInput {
    return {
      operatorToken,
      tenantName: 'Greenwood',
      tenantSlug: 'greenwood',
      schoolName: 'Greenwood High',
      schoolSlug: 'greenwood-high',
      schoolTimeZone: 'America/Chicago',
      adminGivenName: 'Ada',
      adminFamilyName: 'Admin',
      adminDisplayName: 'Ada Admin',
      providerKey: 'workspace',
      providerDisplayName: 'Workspace',
      providerIssuer: 'https://provider.example',
      providerClientId: 'test-client',
      providerClientSecret: 'test-client-secret',
      providerAuthMethod: 'client_secret_basic',
      providerScopes: ['openid', 'email'],
      browserBinding: toBase64Url(bytes('test-binding')),
    };
  }

  it('remaps malformed operator encodings to bootstrap_token_invalid', async () => {
    expect(await errorCode(prepareBootstrap(operatorInput('!!!'), operatorDependencies()))).toBe(
      'bootstrap_token_invalid',
    );
  });

  it('rejects empty operator tokens', async () => {
    expect(await errorCode(prepareBootstrap(operatorInput(''), operatorDependencies()))).toBe(
      'bootstrap_token_invalid',
    );
  });

  it('decodes well-formed encodings and fails closed on unknown grants', async () => {
    expect(
      await errorCode(
        prepareBootstrap(
          operatorInput(toBase64Url(bytes('unknown-operator-token'))),
          operatorDependencies(),
        ),
      ),
    ).toBe('bootstrap_token_invalid');
  });
});
