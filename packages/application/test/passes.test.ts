import { describe, expect, it } from 'vitest';
import {
  advisoryLockKey,
  assertValidIdempotencyKey,
  etagForPass,
  fingerprintSelfCancel,
  fingerprintSelfRequest,
  fingerprintStaffRequest,
  parseIfMatch,
  passHttpStatus,
  PassApplicationError,
  placementKindFromRow,
  requireIdempotencyKey,
} from '../src/index.js';

describe('Idempotency-Key contract', () => {
  it('accepts opaque token-like keys and UUIDs', () => {
    expect(assertValidIdempotencyKey('abc')).toBe('abc');
    expect(assertValidIdempotencyKey('019abc00-0000-7000-8000-000000000001')).toBe(
      '019abc00-0000-7000-8000-000000000001',
    );
  });

  it('rejects empty, long, whitespace-padded, and control-character keys', () => {
    expect(() => requireIdempotencyKey(undefined)).toThrow(
      expect.objectContaining({ code: 'idempotency_key_required' }),
    );
    for (const bad of ['', ' abc', 'abc ', 'a'.repeat(256), 'has space', 'tab\there', 'ünïcodé']) {
      expect(() => assertValidIdempotencyKey(bad)).toThrow(
        expect.objectContaining({ code: 'invalid_idempotency_key' }),
      );
    }
  });

  it('never trims and reinterprets a key', () => {
    expect(() => assertValidIdempotencyKey(' padded ')).toThrow(
      expect.objectContaining({ code: 'invalid_idempotency_key' }),
    );
  });

  it('builds deterministic fingerprints that separate commands and inputs', () => {
    const destination = '019abc00-0000-7000-8000-000000000040';
    const student = '019abc00-0000-7000-8000-000000000030';
    expect(fingerprintSelfRequest(destination)).toBe(fingerprintSelfRequest(destination));
    expect(fingerprintSelfRequest(destination)).not.toBe(
      fingerprintStaffRequest(student, destination),
    );
    expect(fingerprintStaffRequest(student, destination)).not.toBe(
      fingerprintStaffRequest(student, '019abc00-0000-7000-8000-000000000041'),
    );
    expect(fingerprintSelfCancel('pass-1', 1n)).toBe(fingerprintSelfCancel('pass-1', 1n));
    expect(fingerprintSelfCancel('pass-1', 1n)).not.toBe(fingerprintSelfCancel('pass-1', 2n));
  });

  it('derives advisory-lock keys in signed 64-bit range', () => {
    const key = advisoryLockKey('tenant', 'account', 'pass.request.self:v1', 'abc');
    expect(typeof key).toBe('bigint');
    expect(key >= -(2n ** 63n) && key < 2n ** 63n).toBe(true);
    expect(advisoryLockKey('tenant', 'account', 'pass.request.self:v1', 'abc')).toBe(key);
  });

  it('scopes idempotency identity per command namespace', async () => {
    const { fingerprintApprovalResolve } = await import('../src/passes/idempotency.js');
    // Approve and deny are distinct commands: the same key across them starts
    // an independent execution (documented on advisoryLockKey). Fingerprints
    // separate decisions within and across commands.
    expect(
      fingerprintApprovalResolve('019abc00-0000-7000-8000-000000000050', 'pass-1', 1n, 'approved'),
    ).not.toBe(
      fingerprintApprovalResolve('019abc00-0000-7000-8000-000000000050', 'pass-1', 1n, 'denied'),
    );
    expect(advisoryLockKey('tenant', 'account', 'pass.approval.approve:v1', 'abc')).not.toBe(
      advisoryLockKey('tenant', 'account', 'pass.approval.deny:v1', 'abc'),
    );
  });
});

describe('pass ETag and If-Match', () => {
  const passId = '019abc00-0000-7000-8000-000000000001';

  it('is deterministic over id plus revision only', () => {
    expect(etagForPass(passId, 1n)).toBe(etagForPass(passId, 1n));
    expect(etagForPass(passId, 1n)).not.toBe(etagForPass(passId, 2n));
    expect(etagForPass(passId, 1n)).toBe(`"pass:${passId}:1"`);
  });

  it('round-trips the exact strong ETag OpenHall emits', () => {
    const etag = etagForPass(passId, 3n);
    expect(parseIfMatch(etag, passId)).toEqual({ passId, revision: 3n });
  });

  it('requires If-Match and rejects weak, wildcard, and malformed tags', () => {
    expect(() => parseIfMatch(undefined, passId)).toThrow(
      expect.objectContaining({ code: 'precondition_required' }),
    );
    for (const bad of ['*', 'W/"pass:1:1"', '"pass:1"', '"other"', 'pass:1:1', ' "pass:x:1"']) {
      expect(() => parseIfMatch(bad, 'whatever')).toThrow(
        expect.objectContaining({ code: 'invalid_precondition' }),
      );
    }
    expect(() => parseIfMatch(etagForPass(passId, 1n), 'other-pass-id')).toThrow(
      expect.objectContaining({ code: 'invalid_precondition' }),
    );
  });
});

describe('pass error mapping', () => {
  it('maps stable errors to HTTP statuses', () => {
    expect(passHttpStatus('destination_not_found')).toBe(404);
    expect(passHttpStatus('student_not_found')).toBe(404);
    expect(passHttpStatus('pass_not_found')).toBe(404);
    expect(passHttpStatus('forbidden')).toBe(403);
    expect(passHttpStatus('recovery_session_restricted')).toBe(403);
    expect(passHttpStatus('active_pass_exists')).toBe(409);
    expect(passHttpStatus('idempotency_key_reused')).toBe(409);
    expect(passHttpStatus('invalid_pass_transition')).toBe(409);
    expect(passHttpStatus('destination_unavailable')).toBe(409);
    expect(passHttpStatus('stale_pass_revision')).toBe(412);
    expect(passHttpStatus('precondition_required')).toBe(428);
    expect(passHttpStatus('invalid_idempotency_key')).toBe(400);
    expect(new PassApplicationError('stale_pass_revision', 'x').code).toBe('stale_pass_revision');
  });

  it('derives truthful origin kinds without fabricating placement', () => {
    expect(placementKindFromRow({ originBlock: { id: 'b' }, originSection: { id: 's' } })).toBe(
      'resolved',
    );
    expect(placementKindFromRow({ originBlock: { id: 'b' }, originSection: null })).toBe(
      'block_only',
    );
    expect(placementKindFromRow({ originBlock: null, originSection: null })).toBe('unresolved');
  });
});
