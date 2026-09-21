import type { Clock } from '@openhall/domain';
import type { Principal } from '../authentication/principal.js';
import type { RelationshipAuthorizationService } from '../authorization/service.js';
import type { TenantTransactionRunner } from '../persistence.js';
import { ControlPlaneError } from './errors.js';
import type { PeopleRepository, PersonDirectoryRow, SectionChoiceRow } from './ports.js';
import { denialToError } from './shared.js';

export interface PeopleDependencies {
  readonly clock: Clock;
  readonly runner: TenantTransactionRunner;
  readonly authorization: RelationshipAuthorizationService;
  readonly people: PeopleRepository;
}

export interface PersonDirectoryEntry {
  readonly personId: string;
  readonly displayName: string;
  readonly givenName: string;
  readonly familyName: string;
  readonly affiliation: string;
  readonly gradeLevel: string | null;
  readonly personStatus: string;
  readonly membershipStatus: string;
  readonly account: {
    readonly exists: boolean;
    readonly status: string | null;
    readonly identityLinked: boolean;
  };
}

export interface PeopleSearchQuery {
  readonly q: string | null;
  readonly affiliation: 'student' | 'staff' | null;
  readonly limit: number;
  readonly cursor: unknown;
}

export interface PeopleSearchResult {
  readonly people: readonly PersonDirectoryEntry[];
  readonly nextCursor: string | null;
}

export interface SectionSearchQuery {
  readonly q: string | null;
  readonly limit: number;
  readonly cursor: unknown;
}

export interface SectionChoice {
  readonly id: string;
  readonly code: string | null;
  readonly title: string;
  readonly status: string;
}

export interface SectionSearchResult {
  readonly sections: readonly SectionChoice[];
  readonly nextCursor: string | null;
}

function toDirectoryEntry(row: PersonDirectoryRow): PersonDirectoryEntry {
  return {
    personId: row.personId,
    displayName: row.displayName,
    givenName: row.givenName,
    familyName: row.familyName,
    affiliation: row.affiliation,
    gradeLevel: row.gradeLevel,
    personStatus: row.personStatus,
    membershipStatus: row.membershipStatus,
    account: {
      exists: row.accountId !== null,
      status: row.accountStatus,
      identityLinked: row.accountId !== null && row.identityLinked,
    },
  };
}

function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodePersonCursor(
  cursor: unknown,
): { readonly displayName: string; readonly personId: string } | null {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 500) {
    throw new ControlPlaneError('invalid_search_cursor', 'Invalid search cursor.');
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ControlPlaneError('invalid_search_cursor', 'Invalid search cursor.');
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.displayName !== 'string' || typeof record.personId !== 'string') {
      throw new ControlPlaneError('invalid_search_cursor', 'Invalid search cursor.');
    }
    return { displayName: record.displayName, personId: record.personId };
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw new ControlPlaneError('invalid_search_cursor', 'Invalid search cursor.');
  }
}

function decodeSectionCursor(
  cursor: unknown,
): { readonly title: string; readonly sectionId: string } | null {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 500) {
    throw new ControlPlaneError('invalid_search_cursor', 'Invalid search cursor.');
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ControlPlaneError('invalid_search_cursor', 'Invalid search cursor.');
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.title !== 'string' || typeof record.sectionId !== 'string') {
      throw new ControlPlaneError('invalid_search_cursor', 'Invalid search cursor.');
    }
    return { title: record.title, sectionId: record.sectionId };
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw new ControlPlaneError('invalid_search_cursor', 'Invalid search cursor.');
  }
}

function cleanQueryText(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 100);
}

/** GET /organizations/:id/people — people.view search over the exact school. */
export async function searchOrganizationPeople(
  principal: Principal,
  organizationId: string,
  query: PeopleSearchQuery,
  dependencies: PeopleDependencies,
): Promise<PeopleSearchResult> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const decision = await dependencies.authorization.decideWithContext(context, {
      principal,
      capability: 'people.view',
      resource: { kind: 'organization', organizationId },
      at: now,
    });
    if (!decision.allowed) {
      throw denialToError(decision.reason, 'person_not_found');
    }
    const rows = await dependencies.people.searchPeople(context, organizationId, {
      q: cleanQueryText(query.q),
      affiliation: query.affiliation,
      limit: query.limit,
      cursor: decodePersonCursor(query.cursor),
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      people: page.map(toDirectoryEntry),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ displayName: last.displayName, personId: last.personId })
          : null,
    };
  });
}

/**
 * GET /organizations/:id/sections — read-only section chooser authorized by
 * schedule.view or people.view, whichever the caller holds.
 */
export async function searchOrganizationSections(
  principal: Principal,
  organizationId: string,
  query: SectionSearchQuery,
  dependencies: PeopleDependencies,
): Promise<SectionSearchResult> {
  const now = dependencies.clock.now();
  return dependencies.runner.run(principal.tenantId, async (context) => {
    const resource = { kind: 'organization', organizationId } as const;
    const schedule = await dependencies.authorization.decideWithContext(context, {
      principal,
      capability: 'schedule.view',
      resource,
      at: now,
    });
    const people = schedule.allowed
      ? null
      : await dependencies.authorization.decideWithContext(context, {
          principal,
          capability: 'people.view',
          resource,
          at: now,
        });
    if (!schedule.allowed && !people?.allowed) {
      throw denialToError(people?.reason ?? schedule.reason, 'section_not_found');
    }
    const rows = await dependencies.people.searchSections(context, organizationId, {
      q: cleanQueryText(query.q),
      limit: query.limit,
      cursor: decodeSectionCursor(query.cursor),
    });
    const page = rows.slice(0, query.limit);
    const last: SectionChoiceRow | undefined = page[page.length - 1];
    return {
      sections: page.map((row) => ({
        id: row.id,
        code: row.code,
        title: row.title,
        status: row.status,
      })),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ title: last.title, sectionId: last.id })
          : null,
    };
  });
}
