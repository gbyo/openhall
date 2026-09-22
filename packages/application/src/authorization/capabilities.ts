/**
 * Closed application capability vocabulary. Authorization capabilities name
 * what an actor may attempt; they never encode hall-pass movement policy
 * (first/last N minutes, capacity, emergency state). Adding a capability
 * requires reviewed code; capability names are never administrator-editable
 * JSON or arbitrary scripts.
 */
export const CAPABILITIES = [
  'self.read',
  'organization.context.read',

  'pass.request.self',
  'pass.view.self',
  'pass.cancel.self',
  'pass.depart.self',
  'pass.depart.student',
  'pass.progress.self',
  'pass.create.student',
  'pass.approve.section',
  'pass.approve.destination',
  'pass.override.request.self',
  'pass.override.request.student',
  'pass.override.resolve.section',
  'pass.override.resolve.school',
  'pass.view.section_live',
  'pass.view.school_live',
  'pass.view.school_history',

  'scheduled_authorization.manage',

  'destination.station.manage',
  'destination.manage',

  'schedule.view',
  'schedule.manage',

  'people.view',
  'people.manage',

  'policy.manage',
  'authorization.manage',
  'integration.manage',

  'incident.view',
  'incident.manage',

  'audit.view',

  'identity.enroll',
  'identity.manage',
  'system.manage',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Canonical registry order for deterministic UI capability lists. */
export const CAPABILITY_ORDER: readonly Capability[] = CAPABILITIES;

const CAPABILITY_SET = new Set<string>(CAPABILITIES);

export function isCapability(value: string): value is Capability {
  return CAPABILITY_SET.has(value);
}

/** Sorts capabilities by canonical registry order, not database row order. */
export function sortCapabilities(capabilities: Iterable<Capability>): Capability[] {
  const order = new Map<Capability, number>(
    CAPABILITIES.map((capability, index) => [capability, index]),
  );
  return [...new Set(capabilities)].sort(
    (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
}
