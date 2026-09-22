import { sql } from 'kysely';
import type {
  PlaceClassDetailRow,
  PlaceClassUsageRow,
  PlacesRepository,
  TenantTransactionContext,
} from '@openhall/application';
import { connectionFor } from '../transactions.js';

interface ClassUsageResultRow {
  location_id: string;
  section_count: string | number | bigint;
  teacher_names: string[] | null;
  section_titles: string[] | null;
  section_codes: string[] | null;
}

/**
 * PostgreSQL Places read projection (tenant-scoped, no unscoped path).
 * Classroom teacher associations derive from current school academic
 * records in ONE grouped query: active sections through applicable
 * section meetings at each location to active teacher memberships.
 * Distinct people; tenant/school/date bounded. Never persisted.
 */
export class PostgresPlacesRepository implements PlacesRepository {
  async listClassUsageByOrganization(
    context: TenantTransactionContext,
    organizationId: string,
    today: string,
  ): Promise<readonly PlaceClassUsageRow[]> {
    const connection = connectionFor(context);
    const result = await sql<ClassUsageResultRow>`
      SELECT
        sm.location_id,
        COUNT(DISTINCT s.id)::int AS section_count,
        COALESCE(ARRAY_AGG(DISTINCT p.display_name) FILTER (WHERE p.display_name IS NOT NULL), '{}') AS teacher_names,
        COALESCE(ARRAY_AGG(DISTINCT s.title) FILTER (WHERE s.title IS NOT NULL), '{}') AS section_titles,
        COALESCE(ARRAY_AGG(DISTINCT s.code) FILTER (WHERE s.code IS NOT NULL), '{}') AS section_codes
      FROM section_meeting sm
      JOIN section s
        ON s.tenant_id = sm.tenant_id
        AND s.id = sm.section_id
      LEFT JOIN section_membership m
        ON m.tenant_id = sm.tenant_id
        AND m.section_id = s.id
        AND m.role = 'teacher'
        AND m.status = 'active'
      LEFT JOIN person p
        ON p.tenant_id = sm.tenant_id
        AND p.id = m.person_id
        AND p.status = 'active'
      WHERE sm.tenant_id = ${context.tenantId}
        AND s.organization_id = ${organizationId}
        AND s.status = 'active'
        AND sm.location_id IS NOT NULL
        AND (sm.effective_from IS NULL OR sm.effective_from <= ${today}::date)
        AND (sm.effective_until IS NULL OR sm.effective_until >= ${today}::date)
      GROUP BY sm.location_id
    `.execute(connection);
    return result.rows.map((row) => ({
      locationId: row.location_id,
      sectionCount: Number(row.section_count),
      teacherNames: [...(row.teacher_names ?? [])].sort((a, b) =>
        a.localeCompare(b, 'en', { sensitivity: 'base' }),
      ),
      sectionTitles: [...(row.section_titles ?? [])].sort((a, b) =>
        a.localeCompare(b, 'en', { sensitivity: 'base' }),
      ),
      sectionCodes: [...(row.section_codes ?? [])].sort((a, b) =>
        a.localeCompare(b, 'en', { sensitivity: 'base' }),
      ),
    }));
  }

  async listClassDetailsByLocation(
    context: TenantTransactionContext,
    organizationId: string,
    locationId: string,
    today: string,
  ): Promise<readonly PlaceClassDetailRow[]> {
    const connection = connectionFor(context);
    const result = await sql<ClassDetailResultRow>`
      SELECT
        s.title,
        s.code,
        COALESCE(ARRAY_AGG(DISTINCT p.display_name) FILTER (WHERE p.display_name IS NOT NULL), '{}') AS teacher_names
      FROM section_meeting sm
      JOIN section s
        ON s.tenant_id = sm.tenant_id
        AND s.id = sm.section_id
      LEFT JOIN section_membership m
        ON m.tenant_id = sm.tenant_id
        AND m.section_id = s.id
        AND m.role = 'teacher'
        AND m.status = 'active'
      LEFT JOIN person p
        ON p.tenant_id = sm.tenant_id
        AND p.id = m.person_id
        AND p.status = 'active'
      WHERE sm.tenant_id = ${context.tenantId}
        AND s.organization_id = ${organizationId}
        AND s.status = 'active'
        AND sm.location_id = ${locationId}
        AND (sm.effective_from IS NULL OR sm.effective_from <= ${today}::date)
        AND (sm.effective_until IS NULL OR sm.effective_until >= ${today}::date)
      GROUP BY s.title, s.code
      ORDER BY s.title, s.code
    `.execute(connection);
    return result.rows.map((row) => ({
      title: row.title,
      code: row.code,
      teacherNames: [...(row.teacher_names ?? [])].sort((a, b) =>
        a.localeCompare(b, 'en', { sensitivity: 'base' }),
      ),
    }));
  }
}

interface ClassDetailResultRow {
  title: string;
  code: string | null;
  teacher_names: string[] | null;
}
