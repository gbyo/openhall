import { describe, expect, it } from 'vitest';
import {
  Aes256GcmSecretProtector,
  HmacCredentialDigester,
  NodeSecureRandom,
  NodeSha256Hasher,
  SecretDecryptionError,
} from './crypto.js';

const KEY = new Uint8Array(32).fill(9);
const OTHER_KEY = new Uint8Array(32).fill(10);

describe('Aes256GcmSecretProtector', () => {
  it('round-trips through encrypt and decrypt', () => {
    const protector = new Aes256GcmSecretProtector(KEY, 'key-1');
    const sealed = protector.protect('super-secret-client-secret', 'provider-secret:v1:t:p');
    expect(sealed.ciphertext).not.toEqual(Buffer.from('super-secret-client-secret'));
    expect(protector.reveal(sealed, 'provider-secret:v1:t:p')).toBe('super-secret-client-secret');
  });

  it('uses a fresh nonce for every encryption', () => {
    const protector = new Aes256GcmSecretProtector(KEY, 'key-1');
    const first = protector.protect('same', 'ctx');
    const second = protector.protect('same', 'ctx');
    expect(Buffer.from(first.nonce)).not.toEqual(Buffer.from(second.nonce));
    expect(Buffer.from(first.ciphertext)).not.toEqual(Buffer.from(second.ciphertext));
  });

  it('rejects tampered ciphertext and tags', () => {
    const protector = new Aes256GcmSecretProtector(KEY, 'key-1');
    const sealed = protector.protect('same', 'ctx');
    const tamperedBytes = new Uint8Array(sealed.ciphertext);
    tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 1;
    expect(() => protector.reveal({ ...sealed, ciphertext: tamperedBytes }, 'ctx')).toThrow(
      SecretDecryptionError,
    );
    const tamperedTag = new Uint8Array(sealed.tag);
    tamperedTag[0] = (tamperedTag[0] ?? 0) ^ 1;
    expect(() => protector.reveal({ ...sealed, tag: tamperedTag }, 'ctx')).toThrow(
      SecretDecryptionError,
    );
  });

  it('rejects the wrong associated-data context', () => {
    const protector = new Aes256GcmSecretProtector(KEY, 'key-1');
    const sealed = protector.protect('same', 'provider-secret:v1:t:p');
    expect(() => protector.reveal(sealed, 'provider-secret:v1:t:other')).toThrow(
      SecretDecryptionError,
    );
  });

  it('rejects the wrong key and never falls back', () => {
    const protector = new Aes256GcmSecretProtector(KEY, 'key-1');
    const sealed = protector.protect('same', 'ctx');
    const other = new Aes256GcmSecretProtector(OTHER_KEY, 'key-2');
    expect(() => other.reveal(sealed, 'ctx')).toThrow(SecretDecryptionError);
  });

  it('fails cleanly on a key-id mismatch', () => {
    const protector = new Aes256GcmSecretProtector(KEY, 'key-1');
    const sealed = protector.protect('same', 'ctx');
    const rotated = new Aes256GcmSecretProtector(OTHER_KEY, 'key-2');
    expect(() => rotated.reveal({ ...sealed, keyId: 'key-1' }, 'ctx')).toThrow(
      SecretDecryptionError,
    );
  });
});

describe('HmacCredentialDigester', () => {
  it('digests do not equal raw credentials and verify timing-safe', () => {
    const digester = new HmacCredentialDigester('app-secret-for-tests-only');
    const credential = new NodeSecureRandom().randomBytes(32);
    const digest = digester.digest(credential);
    expect(digest.length).toBe(32);
    expect(Buffer.from(digest)).not.toEqual(Buffer.from(credential));
    expect(digester.matches(credential, digest)).toBe(true);
    const other = new NodeSecureRandom().randomBytes(32);
    expect(digester.matches(other, digest)).toBe(false);
  });
});

describe('NodeSecureRandom', () => {
  it('generates distinct 256-bit credentials', () => {
    const random = new NodeSecureRandom();
    const first = random.randomBytes(32);
    const second = random.randomBytes(32);
    expect(first.length).toBe(32);
    expect(Buffer.from(first)).not.toEqual(Buffer.from(second));
  });
});

describe('NodeSha256Hasher', () => {
  it('matches the PKCE S256 test vector shape', () => {
    const hasher = new NodeSha256Hasher();
    const digest = hasher.hash(new TextEncoder().encode('test-verifier'));
    expect(digest.length).toBe(32);
    expect(Buffer.from(digest)).not.toEqual(Buffer.from(new TextEncoder().encode('test-verifier')));
  });
});
