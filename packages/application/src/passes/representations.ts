import { PassApplicationError } from './errors.js';
import type { DestinationCheckInMode, PassRow } from './ports.js';

export interface PassDestinationCategoryView {
  readonly id: string;
  readonly name: string;
  readonly iconKey: string;
  readonly toneKey: string;
}

export interface PassDestinationView {
  readonly id: string;
  readonly displayName: string;
  readonly serviceType: string;
  readonly checkInMode: DestinationCheckInMode;
  /** Current category presentation; null when the category is unavailable. */
  readonly category: PassDestinationCategoryView | null;
}

/**
 * Safe non-dynamic movement projection. Every value is tied to the pass
 * revision: ready/queue leases only change when the pass revision changes,
 * so this stays inside the strong ETag. Live queue position, live capacity,
 * and wall-clock overdue booleans are excluded by design.
 */
export interface MovementProjection {
  readonly readyUntil: string | null;
  readonly queueEnteredAt: string | null;
  readonly queueExpiresAt: string | null;
  readonly expectedReturnAt: string | null;
  /**
   * Check-in behavior governing this movement. Before departure there is no
   * movement contract yet, so this is null. Active movement uses the
   * departure snapshot, with the same live-destination fallback used by the
   * command layer for legacy rows that predate snapshots.
   */
  readonly effectiveCheckInMode: DestinationCheckInMode | null;
  readonly reasonCode: string | null;
}

export const EMPTY_MOVEMENT: MovementProjection = {
  readyUntil: null,
  queueEnteredAt: null,
  queueExpiresAt: null,
  expectedReturnAt: null,
  effectiveCheckInMode: null,
  reasonCode: null,
};

export interface PassOriginView {
  readonly placementKind: string;
  readonly block: { id: string; code: string; displayName: string } | null;
  readonly section: { id: string; code: string | null; title: string } | null;
  readonly location: { id: string; name: string } | null;
}

export interface PassRepresentation {
  readonly id: string;
  readonly organizationId: string;
  readonly studentId: string;
  readonly destination: PassDestinationView;
  readonly origin: PassOriginView;
  readonly requestSource: string;
  /** Exact scheduled authorization backing this movement, if scheduled. */
  readonly scheduledAuthorizationId: string | null;
  readonly requestedAt: string;
  readonly lifecycleState: string;
  /** Decimal string: the underlying value is PostgreSQL bigint. */
  readonly revision: string;
  /**
   * Latest safe movement-policy projection. Null for legacy passes that
   * predate Phase 6 evaluation: reads never fabricate a historical decision.
   */
  readonly policy: PassPolicyProjection | null;
  /** Non-dynamic destination-flow facts tied to this pass revision. */
  readonly movement: MovementProjection;
}

/** Safe client projection of the latest persisted policy evaluation. */
export interface PassPolicyProjection {
  readonly decision: string;
  readonly evaluatedAt: string;
  readonly reasonCodes: string[];
  readonly approvalPending: boolean;
  readonly overrideAvailable: boolean;
  readonly overridePending: boolean;
}

/** Strong ETag derived from pass id + revision only. Deterministic. */
export function etagForPass(passId: string, revision: bigint): string {
  return `"pass:${passId}:${revision.toString(10)}"`;
}

export interface ParsedIfMatch {
  readonly passId: string;
  readonly revision: bigint;
}

/**
 * Narrow OpenHall If-Match contract: exactly one strong entity-tag previously
 * produced by OpenHall for that pass revision. Weak (W/...) validators,
 * wildcards, and lists are rejected as invalid_precondition.
 */
export function parseIfMatch(header: unknown, passId: string): ParsedIfMatch {
  if (typeof header !== 'string' || header.length === 0) {
    throw new PassApplicationError('precondition_required', 'If-Match is required.');
  }
  if (header.trim() !== header) {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  if (header === '*' || header.startsWith('W/')) {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  const match = /^"pass:([0-9a-fA-F-]{36}):([0-9]{1,19})"$/.exec(header);
  if (match === null) {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  const [, tagPassId, tagRevision] = match;
  if (tagPassId !== passId) {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  let revision: bigint;
  try {
    revision = BigInt(tagRevision ?? '0');
  } catch {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  if (revision < 1n) {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  return { passId, revision };
}

/**
 * Derives a truthful origin kind from stored row fields when the original
 * placement kind is not at hand. Never fabricates room/section detail.
 */
export function placementKindFromRow(row: {
  originBlock: unknown;
  originSection: unknown;
}): string {
  if (row.originSection !== null) return 'resolved';
  if (row.originBlock !== null) return 'block_only';
  return 'unresolved';
}

/**
 * Canonical pass representation builder. Every mutation and read uses this
 * so destination/check-in/movement fields cannot drift between endpoints.
 */
export function toPassRepresentation(
  row: PassRow,
  policy: PassPolicyProjection | null,
  movement: MovementProjection,
): PassRepresentation {
  return {
    id: row.id,
    organizationId: row.organizationId,
    studentId: row.studentId,
    destination: {
      id: row.destinationId,
      displayName: row.destinationDisplayName,
      serviceType: row.destinationServiceType,
      checkInMode: row.destinationCheckInMode,
      category: row.destinationCategory,
    },
    origin: {
      placementKind: placementKindFromRow(row),
      block: row.originBlock,
      section: row.originSection,
      location: row.originLocation,
    },
    requestSource: row.requestSource,
    scheduledAuthorizationId: row.scheduledAuthorizationId,
    requestedAt: row.requestedAt.toString(),
    lifecycleState: row.lifecycleState,
    revision: row.revision.toString(10),
    policy,
    movement,
  };
}

export function requireIfMatch(header: unknown, passId: string): ParsedIfMatch {
  if (typeof header !== 'string' || header.length === 0) {
    throw new PassApplicationError('precondition_required', 'If-Match is required.');
  }
  return parseIfMatch(header, passId);
}

/**
 * Parses an OpenHall strong pass ETag without binding it to a pass up front.
 * Workflow endpoints (approvals/overrides) address the workflow row, so the
 * pass binding is verified after the server derives the pass canonically.
 */
export function parseAnyIfMatch(header: unknown): ParsedIfMatch {
  if (typeof header !== 'string' || header.length === 0) {
    throw new PassApplicationError('precondition_required', 'If-Match is required.');
  }
  if (header.trim() !== header) {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  if (header === '*' || header.startsWith('W/')) {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  const match = /^"pass:([0-9a-fA-F-]{36}):([0-9]{1,19})"$/.exec(header);
  if (match === null) {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  const [, tagPassId, tagRevision] = match;
  if (tagPassId === undefined) {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  let revision: bigint;
  try {
    revision = BigInt(tagRevision ?? '0');
  } catch {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  if (revision < 1n) {
    throw new PassApplicationError('invalid_precondition', 'Malformed If-Match.');
  }
  return { passId: tagPassId, revision };
}
