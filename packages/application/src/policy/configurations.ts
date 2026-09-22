import { SCHEDULE_BLOCK_KINDS, type ScheduleBlockKind } from '@openhall/domain';
import type { PassRequestSource } from '@openhall/domain';

export const POLICY_RULE_TYPES = ['schedule_boundary', 'approval_requirement'] as const;

export type PolicyRuleType = (typeof POLICY_RULE_TYPES)[number];

export function isPolicyRuleType(value: string): value is PolicyRuleType {
  return (POLICY_RULE_TYPES as readonly string[]).includes(value);
}

export const POLICY_OVERRIDE_MODES = ['never', 'authorized', 'approval_required'] as const;

export type PolicyOverrideMode = (typeof POLICY_OVERRIDE_MODES)[number];

export function isPolicyOverrideMode(value: string): value is PolicyOverrideMode {
  return (POLICY_OVERRIDE_MODES as readonly string[]).includes(value);
}

export const OVERRIDE_CATEGORIES = ['urgent', 'private', 'safety', 'staff_directed'] as const;

export type OverrideCategory = (typeof OVERRIDE_CATEGORIES)[number];

export function isOverrideCategory(value: string): value is OverrideCategory {
  return (OVERRIDE_CATEGORIES as readonly string[]).includes(value);
}

/** Closed request-source vocabulary (matches pass.request_source). */
const REQUEST_SOURCES = [
  'student_web',
  'staff_web',
  'scheduled',
  'integration',
  'system',
] as const satisfies readonly PassRequestSource[];

export const POLICY_CONFIG_SCHEMA_VERSION = 1;

/** Upper bound for blackout windows: a schedule block never exceeds one day. */
const MAX_BOUNDARY_MINUTES = 1440;

export interface ScheduleBoundaryConfig {
  readonly schemaVersion: 1;
  readonly firstMinutes: number;
  readonly lastMinutes: number;
  readonly blockKinds: readonly ScheduleBlockKind[];
  readonly requestSources: readonly PassRequestSource[];
}

export type PolicyApprover = 'current_section_teacher' | 'destination_responsible_staff';

export interface ApprovalRequirementConfig {
  readonly schemaVersion: 1;
  readonly requestSources: readonly PassRequestSource[];
  readonly approver: PolicyApprover;
}

export type PolicyRuleConfiguration =
  | { readonly type: 'schedule_boundary'; readonly config: ScheduleBoundaryConfig }
  | { readonly type: 'approval_requirement'; readonly config: ApprovalRequirementConfig };

export interface PolicyConfigurationError {
  readonly valid: false;
  readonly reason: string;
}

export type PolicyConfigurationParseResult =
  | { readonly valid: true; readonly configuration: PolicyRuleConfiguration }
  | PolicyConfigurationError;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMinutes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 0 || value > MAX_BOUNDARY_MINUTES) return null;
  return value;
}

function parseBlockKinds(value: unknown): readonly ScheduleBlockKind[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const kinds: ScheduleBlockKind[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    if (!(SCHEDULE_BLOCK_KINDS as readonly string[]).includes(entry)) return null;
    if (!kinds.includes(entry as ScheduleBlockKind)) kinds.push(entry as ScheduleBlockKind);
  }
  return kinds;
}

function parseRequestSources(value: unknown): readonly PassRequestSource[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const sources: PassRequestSource[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    if (!(REQUEST_SOURCES as readonly string[]).includes(entry)) return null;
    if (!sources.includes(entry as PassRequestSource)) sources.push(entry as PassRequestSource);
  }
  return sources;
}

function invalid(reason: string): PolicyConfigurationError {
  return { valid: false, reason };
}

/**
 * Runtime validator for policy_rule.configuration. The stored JSONB must say
 * exactly what it means: closed exact shapes, no unknown keys, no coercion.
 * A future administration API must reuse this parser before saving.
 */
export function parsePolicyRuleConfiguration(
  ruleType: string,
  configuration: unknown,
): PolicyConfigurationParseResult {
  if (!isRecord(configuration)) return invalid('configuration_must_be_object');
  if (configuration.schemaVersion !== POLICY_CONFIG_SCHEMA_VERSION) {
    return invalid('unsupported_schema_version');
  }
  if (ruleType === 'schedule_boundary') {
    const allowed = new Set([
      'schemaVersion',
      'firstMinutes',
      'lastMinutes',
      'blockKinds',
      'requestSources',
    ]);
    for (const key of Object.keys(configuration)) {
      if (!allowed.has(key)) return invalid(`unknown_property:${key}`);
    }
    const firstMinutes = parseMinutes(configuration.firstMinutes);
    const lastMinutes = parseMinutes(configuration.lastMinutes);
    if (firstMinutes === null || lastMinutes === null) return invalid('invalid_boundary_minutes');
    if (firstMinutes === 0 && lastMinutes === 0) return invalid('empty_boundary_window');
    const blockKinds = parseBlockKinds(configuration.blockKinds);
    if (blockKinds === null) return invalid('invalid_block_kinds');
    const requestSources = parseRequestSources(configuration.requestSources);
    if (requestSources === null) return invalid('invalid_request_sources');
    return {
      valid: true,
      configuration: {
        type: 'schedule_boundary',
        config: { schemaVersion: 1, firstMinutes, lastMinutes, blockKinds, requestSources },
      },
    };
  }
  if (ruleType === 'approval_requirement') {
    const allowed = new Set(['schemaVersion', 'requestSources', 'approver']);
    for (const key of Object.keys(configuration)) {
      if (!allowed.has(key)) return invalid(`unknown_property:${key}`);
    }
    const requestSources = parseRequestSources(configuration.requestSources);
    if (requestSources === null) return invalid('invalid_request_sources');
    if (
      configuration.approver !== 'current_section_teacher' &&
      configuration.approver !== 'destination_responsible_staff'
    ) {
      return invalid('unknown_approver');
    }
    const approver: PolicyApprover =
      configuration.approver === 'destination_responsible_staff'
        ? 'destination_responsible_staff'
        : 'current_section_teacher';
    return {
      valid: true,
      configuration: {
        type: 'approval_requirement',
        config: { schemaVersion: 1, requestSources, approver },
      },
    };
  }
  return invalid('unknown_rule_type');
}
