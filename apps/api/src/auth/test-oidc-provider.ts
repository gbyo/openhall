import {
  createHash,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * Minimal local OIDC provider for tests only (never production). Serves
 * discovery metadata, JWKS, an auto-approving authorization endpoint,
 * authorization codes, PKCE-validated token responses with signed ID
 * tokens, and riggable failure modes. Listens on an ephemeral local port;
 * no Internet access required.
 */
export interface TestOidcOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly subject?: string;
  readonly email?: string;
  readonly s256Supported?: boolean;
}

/** Per-attempt rigging; cleared after each token issuance. */
export interface TokenRig {
  wrongNonce?: boolean | undefined;
  issuerOverride?: string | undefined;
  expired?: boolean | undefined;
  unknownKid?: boolean | undefined;
  malformedIdToken?: boolean | undefined;
  subjectOverride?: string | undefined;
  tokenError?: string | undefined;
}

interface PendingCode {
  readonly challenge: string;
  readonly nonce: string;
  readonly redirectUri: string;
}

function base64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export class TestOidcProvider {
  readonly issuer: string;
  readonly rig: TokenRig = {};
  /** Last issued tokens, so tests can prove they are never persisted. */
  lastAccessToken = '';
  lastIdToken = '';

  /** Mutable between logins so tests can change the asserted email. */
  email: string | undefined;
  private readonly server: Server;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly subject: string;
  private readonly s256Supported: boolean;
  private readonly privateKey: string;
  private readonly publicJwk: Record<string, unknown>;
  private readonly unknownKey: string;
  private readonly codes = new Map<string, PendingCode>();

  private constructor(
    server: Server,
    issuer: string,
    options: TestOidcOptions,
    privateKey: string,
    publicJwk: Record<string, unknown>,
    unknownKey: string,
  ) {
    this.server = server;
    this.issuer = issuer;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.subject = options.subject ?? 'test-subject-1';
    this.email = options.email;
    this.s256Supported = options.s256Supported ?? true;
    this.privateKey = privateKey;
    this.publicJwk = publicJwk;
    this.unknownKey = unknownKey;
  }

  static async start(options: TestOidcOptions): Promise<TestOidcProvider> {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const { privateKey: unknownPrivate } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const unknownPem = unknownPrivate.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicJwk = {
      ...publicKey.export({ format: 'jwk' }),
      kid: 'test-key-1',
      use: 'sig',
      alg: 'RS256',
    };
    const server = createServer();
    const provider = new TestOidcProvider(server, '', options, privatePem, publicJwk, unknownPem);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('Test provider failed to bind');
    }
    const issuer = `http://127.0.0.1:${String(address.port)}`;
    (provider as { issuer: string }).issuer = issuer;
    server.on('request', (request, response) => {
      provider.handle(request, response);
    });
    return provider;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(payload);
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', this.issuer);
    try {
      if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        this.sendJson(response, 200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: this.s256Supported ? ['S256'] : ['plain'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/jwks') {
        this.sendJson(response, 200, { keys: [this.publicJwk] });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/authorize') {
        this.handleAuthorize(url, response);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        void this.handleToken(request, response);
        return;
      }
      this.sendJson(response, 404, { error: 'not_found' });
    } catch {
      this.sendJson(response, 500, { error: 'server_error' });
    }
  }

  private handleAuthorize(url: URL, response: ServerResponse): void {
    const params = url.searchParams;
    const redirectUri = params.get('redirect_uri');
    const state = params.get('state');
    const challenge = params.get('code_challenge');
    const method = params.get('code_challenge_method');
    const nonce = params.get('nonce');
    if (!redirectUri || !state || !challenge || method !== 'S256' || !nonce) {
      this.sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, { challenge, nonce, redirectUri });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    target.searchParams.set('state', state);
    target.searchParams.set('iss', this.issuer);
    response.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
    response.end();
  }

  private async handleToken(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await new Promise<string>((resolve) => {
      let data = '';
      request.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      request.on('end', () => {
        resolve(data);
      });
    });
    const params = new URLSearchParams(body);
    let clientId = params.get('client_id') ?? '';
    let clientSecret = params.get('client_secret') ?? '';
    const basic = request.headers.authorization;
    if (typeof basic === 'string' && basic.startsWith('Basic ')) {
      // RFC 6749 clients (like openid-client) form-encode the credentials
      // before base64 (e.g. "-" arrives as "%2D"), so form-decode after
      // base64-decoding, splitting on the first colon.
      const decoded = Buffer.from(basic.slice('Basic '.length), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      try {
        clientId = decodeURIComponent(decoded.slice(0, separator));
        clientSecret = decodeURIComponent(decoded.slice(separator + 1));
      } catch {
        clientId = '';
        clientSecret = '';
      }
    }
    if (clientId !== this.clientId || clientSecret !== this.clientSecret) {
      this.sendJson(response, 401, { error: 'invalid_client' });
      return;
    }
    if (this.rig.tokenError) {
      const error = this.rig.tokenError;
      this.rig.tokenError = undefined;
      this.sendJson(response, 400, { error, error_description: 'rigged failure' });
      return;
    }
    if (params.get('grant_type') !== 'authorization_code') {
      this.sendJson(response, 400, { error: 'unsupported_grant_type' });
      return;
    }
    const code = params.get('code') ?? '';
    const pending = this.codes.get(code);
    this.codes.delete(code);
    if (!pending) {
      this.sendJson(response, 400, { error: 'invalid_grant' });
      return;
    }
    if (params.get('redirect_uri') !== pending.redirectUri) {
      this.sendJson(response, 400, { error: 'invalid_grant' });
      return;
    }
    const verifier = params.get('code_verifier') ?? '';
    const computed = createHash('sha256').update(verifier).digest('base64url');
    if (computed !== pending.challenge) {
      this.sendJson(response, 400, { error: 'invalid_grant' });
      return;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const issuer = this.rig.issuerOverride ?? this.issuer;
    const subject = this.rig.subjectOverride ?? this.subject;
    const idToken = this.rig.malformedIdToken
      ? 'not-a-jwt'
      : this.sign({
          iss: issuer,
          sub: subject,
          aud: this.clientId,
          exp: this.rig.expired ? nowSeconds - 60 : nowSeconds + 300,
          iat: nowSeconds,
          nonce: this.rig.wrongNonce ? 'wrong-nonce' : pending.nonce,
          ...(this.email ? { email: this.email } : {}),
        });
    this.rig.wrongNonce = undefined;
    this.rig.issuerOverride = undefined;
    this.rig.expired = undefined;
    this.rig.unknownKid = undefined;
    this.rig.malformedIdToken = undefined;
    this.rig.subjectOverride = undefined;
    const accessToken = `test-access-${randomBytes(16).toString('hex')}`;
    this.lastAccessToken = accessToken;
    this.lastIdToken = idToken;
    this.sendJson(response, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: idToken,
    });
  }

  private sign(claims: Record<string, unknown>): string {
    const signingKey = this.rig.unknownKid === true ? this.unknownKey : this.privateKey;
    const kid = this.rig.unknownKid === true ? 'unknown-key' : 'test-key-1';
    const header = base64UrlJson({ alg: 'RS256', typ: 'JWT', kid });
    const payload = base64UrlJson(claims);
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${signer.sign(signingKey, 'base64url')}`;
  }

  /** Verifies one of our own signatures in tests (sanity, not protocol). */
  verifyLocal(token: string): boolean {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) {
      return false;
    }
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    return verifier.verify(this.privateKey, signature, 'base64url');
  }
}
