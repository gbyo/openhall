import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type {
  CredentialDigester,
  ProtectedSecret,
  SecretProtector,
  SecureRandomSource,
  Sha256Hasher,
} from '@openhall/application';

/** Cryptographically secure randomness (at least 256 bits per credential). */
export class NodeSecureRandom implements SecureRandomSource {
  randomBytes(byteLength: number): Uint8Array {
    if (!Number.isInteger(byteLength) || byteLength <= 0) {
      throw new Error('byteLength must be a positive integer');
    }
    return new Uint8Array(randomBytes(byteLength));
  }
}

/**
 * One-way digests for high-entropy ephemeral Bearer [REDACTED]:
 * HMAC-SHA-256(APP_SECRET, credential). Password-hashing algorithms are
 * deliberately not used: these are 256-bit random tokens, not human
 * passwords. Rotating APP_SECRET invalidates outstanding credentials.
 */
export class HmacCredentialDigester implements CredentialDigester {
  constructor(private readonly appSecret: string) {
    if (appSecret.length === 0) {
      throw new Error('APP_SECRET is required');
    }
  }

  digest(credential: Uint8Array): Uint8Array {
    return new Uint8Array(createHmac('sha256', this.appSecret).update(credential).digest());
  }

  matches(credential: Uint8Array, expectedDigest: Uint8Array): boolean {
    const actual = Buffer.from(this.digest(credential));
    const expected = Buffer.from(
      expectedDigest.buffer as ArrayBuffer,
      expectedDigest.byteOffset,
      expectedDigest.byteLength,
    );
    if (actual.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(actual, expected);
  }
}

/** Plain SHA-256 for PKCE S256 challenges. */
export class NodeSha256Hasher implements Sha256Hasher {
  hash(data: Uint8Array): Uint8Array {
    return new Uint8Array(createHash('sha256').update(data).digest());
  }
}

export class SecretDecryptionError extends Error {
  constructor(message = 'Unable to decrypt stored secret with the current key') {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

/**
 * Durable AES-256-GCM encryption for long-lived provider secrets, backed by
 * DATA_ENCRYPTION_KEY (exactly 256 bits). Every encryption uses a fresh
 * random 96-bit nonce; the purpose context is bound as associated data so a
 * ciphertext copied into another context fails to decrypt. Never falls back
 * to another key: a key-id mismatch or authentication failure is an error.
 */
export class Aes256GcmSecretProtector implements SecretProtector {
  readonly keyId: string;
  private readonly key: Buffer;

  constructor(key: Uint8Array, keyId: string) {
    if (key.length !== 32) {
      throw new Error('DATA_ENCRYPTION_KEY must be exactly 32 bytes');
    }
    if (keyId.trim().length === 0) {
      throw new Error('DATA_ENCRYPTION_KEY_ID is required');
    }
    this.key = Buffer.from(key.buffer as ArrayBuffer, key.byteOffset, key.byteLength);
    this.keyId = keyId;
  }

  protect(plaintext: string, context: string): ProtectedSecret {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: new Uint8Array(ciphertext),
      nonce: new Uint8Array(nonce),
      tag: new Uint8Array(cipher.getAuthTag()),
      keyId: this.keyId,
    };
  }

  reveal(secret: ProtectedSecret, context: string): string {
    if (secret.keyId !== this.keyId) {
      throw new SecretDecryptionError(
        `Secret key id ${secret.keyId} does not match current key ${this.keyId}`,
      );
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(secret.nonce.buffer as ArrayBuffer, secret.nonce.byteOffset, secret.nonce.byteLength),
      );
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(
        Buffer.from(secret.tag.buffer as ArrayBuffer, secret.tag.byteOffset, secret.tag.byteLength),
      );
      const plaintext = Buffer.concat([
        decipher.update(
          Buffer.from(
            secret.ciphertext.buffer as ArrayBuffer,
            secret.ciphertext.byteOffset,
            secret.ciphertext.byteLength,
          ),
        ),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch {
      throw new SecretDecryptionError();
    }
  }
}
