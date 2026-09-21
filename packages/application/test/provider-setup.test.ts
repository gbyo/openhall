import { Temporal } from '@js-temporal/polyfill';
import type { Clock } from '@openhall/domain';
import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  completeProviderSetup,
  prepareProviderSetup,
  type CompleteProviderSetupDependencies,
  type CredentialDigester,
  type IdentityDirectory,
  type OidcProtocolAdapter,
  type OidcTransactionRecord,
  type OidcTransactionStore,
  type Principal,
  type ProtectedSecret,
  type ProviderSetupDependencies,
  type ProviderSetupFinalizer,
  type SecretProtector,
  type SecureRandomSource,
  type Sha256Hasher,
} from '../src/authentication/index.js';
import type {
  SystemTransactionContext,
  TenantTransactionContext,
  TenantTransactionRunner,
} from '../src/persistence.js';

const T0 = Temporal.Instant.from('2026-09-20T12:00:00Z');

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
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

let randomCounter = 0;
const random: SecureRandomSource = {
  // Distinct material per call so transaction states never collide.
  randomBytes: (byteLength) => {
    randomCounter += 1;
    return new Uint8Array(byteLength).fill(randomCounter % 256);
  },
};

const hasher: Sha256Hasher = {
  hash: (data) => data,
};

function manualClock(): Clock {
  return { now: () => T0 };
}

function tenantContext(tenantId: string): TenantTransactionContext {
  return { tenantId } as TenantTransactionContext;
}

const runner: TenantTransactionRunner = {
  run: (tenantId, operation) => operation(tenantContext(tenantId)),
};

/** Context-bound fake vault: reveal only succeeds under the exact context. */
function vault(): SecretProtector & { plaintexts: Map<string, string> } {
  const plaintexts = new Map<string, string>();
  const secret = (context: string): ProtectedSecret => ({
    ciphertext: bytes(`vault:${context}`),
    nonce: bytes('nonce'),
    tag: bytes('tag'),
    keyId: 'test-key',
  });
  return {
    plaintexts,
    keyId: 'test-key',
    protect: (plaintext, context) => {
      plaintexts.set(context, plaintext);
      return secret(context);
    },
    reveal: (stored, context) => {
      const expected = secret(context);
      const match =
        stored.ciphertext.length === expected.ciphertext.length &&
        stored.ciphertext.every((value, index) => value === expected.ciphertext[index]);
      if (!match) throw new Error('wrong context');
      const plaintext = plaintexts.get(context);
      if (plaintext === undefined) throw new Error('unknown secret');
      return plaintext;
    },
  };
}

function principalFixture(overrides?: Partial<Principal>): Principal {
  return {
    tenantId: 'tenant-1',
    accountId: 'account-1',
    personId: 'person-1',
    sessionRevision: 0n,
    authenticationMethod: 'setup',
    ...overrides,
  };
}

const activeAccount = {
  id: 'account-1',
  tenantId: 'tenant-1',
  personId: 'person-1',
  status: 'active' as const,
  sessionRevision: 0n,
};

const activePerson = {
  id: 'person-1',
  tenantId: 'tenant-1',
  givenName: 'Gibson',
  familyName: 'Bell',
  displayName: 'Gibson Bell',
  status: 'active' as const,
};

function directoryFixture(
  overrides?: Partial<{
    admin: boolean;
    providers: number;
    accountActive: boolean;
  }>,
): IdentityDirectory {
  const providers = Array.from({ length: overrides?.providers ?? 0 }, (_, index) => ({
    id: `provider-${String(index)}`,
    tenantId: 'tenant-1',
    key: `provider-${String(index)}`,
    displayName: `Provider ${String(index)}`,
    issuer: 'https://provider.example',
    clientId: 'client',
    clientSecret: {
      ciphertext: bytes('c'),
      nonce: bytes('n'),
      tag: bytes('t'),
      keyId: 'test-key',
    },
    tokenEndpointAuthMethod: 'client_secret_post' as const,
    scopes: ['openid'],
    status: 'active' as const,
    revision: 1,
  }));
  return {
    findIdentity: () => Promise.resolve(undefined),
    findAccount: () =>
      Promise.resolve(
        overrides?.accountActive === false
          ? { ...activeAccount, status: 'locked' as const }
          : activeAccount,
      ),
    findPerson: () => Promise.resolve(activePerson),
    findTenant: () => Promise.resolve(undefined),
    findProvider: () => Promise.resolve(undefined),
    findProviderByKey: () => Promise.resolve(undefined),
    listActiveProviders: () => Promise.resolve(providers),
    createIdentity: () => {
      throw new Error('not used');
    },
    updateIdentityEmailSnapshot: () => Promise.resolve(),
    incrementSessionRevision: () => Promise.resolve(1n),
    hasActiveSystemAdminGrant: () => Promise.resolve(overrides?.admin ?? true),
  };
}

function transactionStoreFixture(): {
  store: OidcTransactionStore;
  created: Parameters<OidcTransactionStore['create']>[1][];
  claimed: OidcTransactionRecord | undefined;
  failed: string[];
  consumed: string[];
} {
  const fixture = {
    created: [] as Parameters<OidcTransactionStore['create']>[1][],
    claimed: undefined as OidcTransactionRecord | undefined,
    failed: [] as string[],
    consumed: [] as string[],
    store: {
      create: (
        _context: TenantTransactionContext | SystemTransactionContext,
        input: Parameters<OidcTransactionStore['create']>[1],
      ) => {
        fixture.created.push(input);
        throw new Error('unused return');
      },
      claimByStateDigest: () => Promise.resolve(fixture.claimed),
      peekByStateDigest: () => Promise.resolve(fixture.claimed),
      markFailed: (transactionId: string) => {
        fixture.failed.push(transactionId);
        return Promise.resolve();
      },
      consume: (transactionId: string) => {
        fixture.consumed.push(transactionId);
        return Promise.resolve();
      },
    } as OidcTransactionStore,
  };
  return fixture;
}

function adapterFixture(): {
  adapter: OidcProtocolAdapter;
  validated: { issuer: string; clientId: string }[];
  identity: { issuer: string; subject: string; email?: string };
} {
  const fixture = {
    validated: [] as { issuer: string; clientId: string }[],
    identity: {
      issuer: 'https://accounts.google.com',
      subject: 'subject-1',
      email: 'gibson@example.com',
    },
    adapter: {
      validateProviderConfiguration: (configuration: { issuer: string; clientId: string }) => {
        fixture.validated.push({ issuer: configuration.issuer, clientId: configuration.clientId });
        return Promise.resolve();
      },
      buildAuthorizationUrl: (input: { state: string }) =>
        Promise.resolve(`https://provider.example/authorize?state=${input.state}`),
      exchangeCode: () => Promise.resolve({ ...fixture.identity }),
    } as OidcProtocolAdapter,
  };
  return fixture;
}

function dependenciesFixture(
  options?: Partial<{ admin: boolean; providers: number; accountActive: boolean }>,
): {
  dependencies: ProviderSetupDependencies;
  transactions: ReturnType<typeof transactionStoreFixture>;
  adapter: ReturnType<typeof adapterFixture>;
  protector: ReturnType<typeof vault>;
} {
  const transactions = transactionStoreFixture();
  const adapter = adapterFixture();
  const protector = vault();
  return {
    transactions,
    adapter,
    protector,
    dependencies: {
      directory: directoryFixture(options),
      transactions: transactions.store,
      audit: { append: () => Promise.resolve() },
      adapter: adapter.adapter,
      random,
      digester,
      hasher,
      protector,
      clock: manualClock(),
      runner,
      redirectUri: 'http://localhost:3000/api/v1/auth/oidc/callback',
      allowInsecureHttp: true,
    },
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

const googleInput = {
  principal: principalFixture(),
  providerPreset: 'google' as const,
  clientId: 'google-client-id',
  clientSecret: 'google-client-secret',
  browserBinding: 'YmluZGluZw',
};

describe('prepareProviderSetup', () => {
  it('stages the server-owned Google preset, never frontend-supplied values', async () => {
    const { dependencies, transactions, adapter, protector } = dependenciesFixture();
    // create() throws by design in the fake; capture instead.
    transactions.store.create = (_context, input) => {
      transactions.created.push(input);
      return Promise.resolve({} as OidcTransactionRecord);
    };
    const prepared = await prepareProviderSetup(googleInput, dependencies);
    expect(prepared.authorizationUrl).toContain('https://provider.example/authorize');
    expect(adapter.validated).toHaveLength(1);
    expect(adapter.validated[0]).toMatchObject({
      issuer: 'https://accounts.google.com',
      clientId: 'google-client-id',
    });
    expect(transactions.created).toHaveLength(1);
    const stored = transactions.created[0];
    expect(stored?.purpose).toBe('provider_setup');
    expect(stored?.providerSetupAccountId).toBe('account-1');
    expect(stored?.identityProviderId).toBeNull();
    expect(stored?.bootstrapSetupId).toBeNull();
    const staged = JSON.parse(
      protector.plaintexts.get(`provider-setup-tx:v1:tenant-1:account-1:${prepared.state}`) ??
        'null',
    ) as { config: Record<string, unknown>; clientSecret: string };
    expect(staged.config).toMatchObject({
      providerKey: 'workspace',
      providerDisplayName: 'Google Workspace',
      providerIssuer: 'https://accounts.google.com',
      providerClientId: 'google-client-id',
      providerAuthMethod: 'client_secret_post',
      providerScopes: ['openid', 'email', 'profile'],
    });
    expect(staged.clientSecret).toBe('google-client-secret');
  });

  it('binds each staged secret to its own transaction state', async () => {
    const { dependencies, transactions, protector } = dependenciesFixture();
    transactions.store.create = (_context, input) => {
      transactions.created.push(input);
      return Promise.resolve({} as OidcTransactionRecord);
    };
    const first = await prepareProviderSetup(googleInput, dependencies);
    const second = await prepareProviderSetup(
      { ...googleInput, clientId: 'other-client' },
      dependencies,
    );
    expect(first.state).not.toBe(second.state);
    const firstStored = transactions.created[0]?.transactionSecret;
    expect(firstStored).toBeDefined();
    if (firstStored === undefined) throw new Error('expected a staged transaction secret');
    expect(() =>
      protector.reveal(firstStored, `provider-setup-tx:v1:tenant-1:account-1:${second.state}`),
    ).toThrow();
  });

  it('rejects an already-connected provider without network calls', async () => {
    const { dependencies, transactions, adapter } = dependenciesFixture({ providers: 1 });
    expect(await errorCode(prepareProviderSetup(googleInput, dependencies))).toBe(
      'provider_setup_conflict',
    );
    expect(transactions.created).toHaveLength(0);
    expect(adapter.validated).toHaveLength(0);
  });

  it('rejects ineligible accounts and foreign session methods', async () => {
    const nonAdmin = dependenciesFixture({ admin: false });
    expect(await errorCode(prepareProviderSetup(googleInput, nonAdmin.dependencies))).toBe(
      'unauthenticated',
    );
    const oidc = dependenciesFixture();
    expect(
      await errorCode(
        prepareProviderSetup(
          { ...googleInput, principal: principalFixture({ authenticationMethod: 'oidc' }) },
          oidc.dependencies,
        ),
      ),
    ).toBe('unauthenticated');
    const recovery = dependenciesFixture();
    transactionsBypass(recovery.transactions);
    const prepared = await prepareProviderSetup(
      { ...googleInput, principal: principalFixture({ authenticationMethod: 'recovery' }) },
      recovery.dependencies,
    );
    expect(prepared.state.length).toBeGreaterThan(0);
  });

  function transactionsBypass(transactions: ReturnType<typeof transactionStoreFixture>): void {
    transactions.store.create = (_context, input) => {
      transactions.created.push(input);
      return Promise.resolve({} as OidcTransactionRecord);
    };
  }

  it('resolves generic providers with explicit keys and defaults', async () => {
    const { dependencies, transactions, adapter, protector } = dependenciesFixture();
    transactions.store.create = (_context, input) => {
      transactions.created.push(input);
      return Promise.resolve({} as OidcTransactionRecord);
    };
    const prepared = await prepareProviderSetup(
      {
        principal: principalFixture(),
        providerPreset: 'generic',
        clientId: 'custom-client',
        clientSecret: 'custom-secret',
        providerName: 'Fabrikam Schools',
        issuerUrl: 'https://login.fabrikam.example',
        browserBinding: 'YmluZGluZw',
      },
      dependencies,
    );
    expect(adapter.validated[0]?.issuer).toBe('https://login.fabrikam.example');
    const staged = JSON.parse(
      protector.plaintexts.get(`provider-setup-tx:v1:tenant-1:account-1:${prepared.state}`) ??
        'null',
    ) as { config: Record<string, unknown> };
    expect(staged.config).toMatchObject({
      providerKey: 'fabrikam-schools',
      providerDisplayName: 'Fabrikam Schools',
      providerAuthMethod: 'client_secret_post',
      providerScopes: ['openid'],
    });
  });

  it('surfaces provider discovery failures without staging anything', async () => {
    const { dependencies, transactions, adapter } = dependenciesFixture();
    adapter.adapter.validateProviderConfiguration = () =>
      Promise.reject(new Error('discovery offline'));
    expect(await errorCode(prepareProviderSetup(googleInput, dependencies))).toBe(
      'provider_configuration_unsupported',
    );
    expect(transactions.created).toHaveLength(0);
  });
});

function claimFixture(overrides?: Partial<OidcTransactionRecord>): OidcTransactionRecord {
  return {
    id: 'transaction-1',
    tenantId: 'tenant-1',
    identityProviderId: null,
    bootstrapSetupId: null,
    identityEnrollmentGrantId: null,
    providerSetupAccountId: 'account-1',
    purpose: 'provider_setup',
    providerRevision: null,
    stateDigest: bytes('state'),
    browserBindingDigest: bytes('binding'),
    transactionSecret: {
      ciphertext: bytes('c'),
      nonce: bytes('n'),
      tag: bytes('t'),
      keyId: 'test-key',
    },
    returnPath: '/',
    status: 'pending',
    createdAt: T0,
    expiresAt: T0.add({ seconds: 600 }),
    ...overrides,
  };
}

function stageGooglePayload(
  protector: ReturnType<typeof vault>,
  state: string,
  accountId = 'account-1',
): ProtectedSecret {
  return protector.protect(
    JSON.stringify({
      config: {
        providerKey: 'workspace',
        providerDisplayName: 'Google Workspace',
        providerIssuer: 'https://accounts.google.com',
        providerClientId: 'google-client-id',
        providerAuthMethod: 'client_secret_post',
        providerScopes: ['openid', 'email', 'profile'],
      },
      clientSecret: 'google-client-secret',
      verifier: 'verifier',
      nonce: 'nonce',
    }),
    `provider-setup-tx:v1:tenant-1:${accountId}:${state}`,
  );
}

function completeDependencies(
  claimed: OidcTransactionRecord | undefined,
  protector: ReturnType<typeof vault>,
  adapter: ReturnType<typeof adapterFixture>,
  seen: { accountId?: unknown },
): CompleteProviderSetupDependencies {
  const transactions = transactionStoreFixture();
  transactions.claimed = claimed;
  return {
    directory: directoryFixture(),
    transactions: transactions.store,
    audit: { append: () => Promise.resolve() },
    adapter: adapter.adapter,
    random,
    digester,
    hasher,
    protector,
    clock: manualClock(),
    runner,
    redirectUri: 'http://localhost:3000/api/v1/auth/oidc/callback',
    allowInsecureHttp: true,
    finalizer: {
      completeProviderSetup: (_context, input) => {
        seen.accountId = input.accountId;
        return Promise.resolve({
          provider: {
            id: 'provider-1',
            tenantId: 'tenant-1',
            key: input.config.providerKey,
            displayName: input.config.providerDisplayName,
            issuer: input.config.providerIssuer,
            clientId: input.config.providerClientId,
            clientSecret: {
              ciphertext: bytes('c'),
              nonce: bytes('n'),
              tag: bytes('t'),
              keyId: 'test-key',
            },
            tokenEndpointAuthMethod: input.config.providerAuthMethod,
            scopes: [...input.config.providerScopes],
            status: 'active' as const,
            revision: 1,
          },
          session: {
            id: 'session-1',
            tenantId: 'tenant-1',
            accountId: input.accountId,
            identityProviderId: 'provider-1',
            tokenDigest: input.sessionTokenDigest,
            csrfTokenDigest: input.csrfTokenDigest,
            accountSessionRevision: 1n,
            authenticationMethod: 'oidc',
            createdAt: T0,
            authenticatedAt: T0,
            lastSeenAt: T0,
            idleExpiresAt: T0.add({ seconds: 12 * 60 * 60 }),
            absoluteExpiresAt: T0.add({ seconds: 7 * 24 * 60 * 60 }),
            revokedAt: null,
            revocationReason: null,
          },
        });
      },
    } satisfies ProviderSetupFinalizer,
  };
}

const completeInput = {
  state: 'raw-state-value',
  browserBinding: 'YmluZGluZw',
  callbackUrl: 'http://localhost:3000/api/v1/auth/oidc/callback?code=abc&state=raw-state-value',
  requestId: 'request-1',
};

describe('completeProviderSetup', () => {
  it('completes for the predetermined account, never by email', async () => {
    const protector = vault();
    const adapter = adapterFixture();
    const state = completeInput.state;
    const stagedSecret = stageGooglePayload(protector, state);
    const seen: { accountId?: unknown } = {};
    // The fake digester is identity: the stored digest is the decoded
    // binding ('YmluZGluZw' decodes to the same bytes).
    const withClaim = completeDependencies(
      claimFixture({ browserBindingDigest: bytes('binding'), transactionSecret: stagedSecret }),
      protector,
      adapter,
      seen,
    );
    const completed = await completeProviderSetup(
      { ...completeInput, browserBinding: 'YmluZGluZw', state },
      withClaim,
    );
    expect(seen.accountId).toBe('account-1');
    expect(completed.session.authenticationMethod).toBe('oidc');
    expect(typeof completed.sessionToken).toBe('string');
  });

  it('never consults the directory for account selection at completion', async () => {
    const protector = vault();
    const adapter = adapterFixture();
    const state = completeInput.state;
    const stagedSecret = stageGooglePayload(protector, state);
    const seen: { accountId?: unknown } = {};
    const dependencies = completeDependencies(
      claimFixture({ browserBindingDigest: bytes('binding'), transactionSecret: stagedSecret }),
      protector,
      adapter,
      seen,
    );
    // External email is metadata only: even a directory that explodes on
    // every lookup still completes, because the predetermined account comes
    // from the claimed transaction, never from email matching.
    const exploding: IdentityDirectory = {
      findIdentity: () => {
        throw new Error('must not consult directory');
      },
      findAccount: () => {
        throw new Error('must not consult directory');
      },
      findPerson: () => {
        throw new Error('must not consult directory');
      },
      findTenant: () => {
        throw new Error('must not consult directory');
      },
      findProvider: () => {
        throw new Error('must not consult directory');
      },
      findProviderByKey: () => {
        throw new Error('must not consult directory');
      },
      listActiveProviders: () => {
        throw new Error('must not consult directory');
      },
      createIdentity: () => {
        throw new Error('must not consult directory');
      },
      updateIdentityEmailSnapshot: () => Promise.resolve(),
      incrementSessionRevision: () => Promise.resolve(1n),
      hasActiveSystemAdminGrant: () => Promise.resolve(true),
    };
    const completed = await completeProviderSetup(
      { ...completeInput, browserBinding: 'YmluZGluZw', state },
      { ...dependencies, directory: exploding },
    );
    expect(seen.accountId).toBe('account-1');
    expect(completed.session.accountId).toBe('account-1');
  });

  it('rejects unknown transactions and binding mismatches', async () => {
    const protector = vault();
    const adapter = adapterFixture();
    const seen: { accountId?: unknown } = {};
    expect(
      await errorCode(
        completeProviderSetup(
          completeInput,
          completeDependencies(undefined, protector, adapter, seen),
        ),
      ),
    ).toBe('auth_transaction_invalid');
    expect(
      await errorCode(
        completeProviderSetup(
          completeInput,
          completeDependencies(
            claimFixture({ browserBindingDigest: bytes('other') }),
            protector,
            adapter,
            seen,
          ),
        ),
      ),
    ).toBe('auth_transaction_invalid');
    expect(seen.accountId).toBeUndefined();
  });

  it('rejects expired transactions and issuer mismatches', async () => {
    const protector = vault();
    const adapter = adapterFixture();
    const seen: { accountId?: unknown } = {};
    expect(
      await errorCode(
        completeProviderSetup(
          completeInput,
          completeDependencies(
            claimFixture({
              browserBindingDigest: bytes('binding'),
              expiresAt: T0.add({ seconds: -1 }),
            }),
            protector,
            adapter,
            seen,
          ),
        ),
      ),
    ).toBe('auth_transaction_expired');
    const mismatched = adapterFixture();
    mismatched.identity = { issuer: 'https://evil.example', subject: 'subject-1' };
    const state = completeInput.state;
    const mismatchSecret = stageGooglePayload(protector, state);
    expect(
      await errorCode(
        completeProviderSetup(
          { ...completeInput, browserBinding: 'YmluZGluZw', state },
          completeDependencies(
            claimFixture({
              browserBindingDigest: bytes('binding'),
              transactionSecret: mismatchSecret,
            }),
            protector,
            mismatched,
            seen,
          ),
        ),
      ),
    ).toBe('auth_transaction_invalid');
    expect(seen.accountId).toBeUndefined();
  });
});
