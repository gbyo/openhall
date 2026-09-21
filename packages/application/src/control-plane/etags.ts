import { ControlPlaneError } from './errors.js';

/**
 * Deterministic strong ETags for versioned control-plane resources.
 * Format: "<kind>:<uuid>:<revision>" — for example
 * "location:<uuid>:3" or "schedule:<organization-uuid>:14". Revisions are
 * decimal strings on the wire because they are PostgreSQL bigints.
 */
export const CONTROL_PLANE_ETAG_KINDS = [
  'location',
  'destination',
  'schedule',
  'policy',
  'grant',
  'scheduled-authorization',
  'identity-enrollment',
] as const;

export type ControlPlaneEtagKind = (typeof CONTROL_PLANE_ETAG_KINDS)[number];

export function etagForResource(kind: ControlPlaneEtagKind, id: string, revision: bigint): string {
  return `"${kind}:${id}:${revision.toString(10)}"`;
}

/** Schedule ETag: one aggregate tag per school (organization id + aggregate revision). */
export function etagForSchedule(organizationId: string, revision: bigint): string {
  return etagForResource('schedule', organizationId, revision);
}

export interface ParsedResourceTag {
  readonly kind: ControlPlaneEtagKind;
  readonly id: string;
  readonly revision: bigint;
}

const UUID_PATTERN = '[0-9a-fA-F-]{36}';

/**
 * Narrow OpenHall If-Match contract for control-plane resources: exactly one
 * strong entity-tag previously produced by OpenHall for that resource
 * revision. Weak validators, wildcards, and lists are invalid_precondition;
 * a missing header is precondition_required (428).
 */
export function parseResourceIfMatch(
  header: unknown,
  expected: { readonly kind: ControlPlaneEtagKind; readonly id: string },
): ParsedResourceTag {
  if (typeof header !== 'string' || header.length === 0) {
    throw new ControlPlaneError('precondition_required', 'If-Match is required.');
  }
  if (header.trim() !== header) {
    throw new ControlPlaneError('invalid_precondition', 'Malformed If-Match.');
  }
  if (header === '*' || header.startsWith('W/')) {
    throw new ControlPlaneError('invalid_precondition', 'Malformed If-Match.');
  }
  const match = new RegExp(`^"([a-z-]+):(${UUID_PATTERN}):([0-9]{1,19})"$`).exec(header);
  if (match === null) {
    throw new ControlPlaneError('invalid_precondition', 'Malformed If-Match.');
  }
  const [, tagKind, tagId, tagRevision] = match;
  if (
    tagKind !== expected.kind ||
    tagId !== expected.id ||
    !(CONTROL_PLANE_ETAG_KINDS as readonly string[]).includes(tagKind)
  ) {
    throw new ControlPlaneError('invalid_precondition', 'Malformed If-Match.');
  }
  let revision: bigint;
  try {
    revision = BigInt(tagRevision ?? '0');
  } catch {
    throw new ControlPlaneError('invalid_precondition', 'Malformed If-Match.');
  }
  if (revision < 1n) {
    throw new ControlPlaneError('invalid_precondition', 'Malformed If-Match.');
  }
  return { kind: expected.kind, id: expected.id, revision };
}
