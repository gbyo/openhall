import type {
  PeopleRepository,
  PersonDirectoryRow,
  PersonSearchCursor,
  PersonSearchInput,
  SectionChoiceRow,
  SectionSearchCursor,
  SectionSearchInput,
  TenantTransactionContext,
} from '@openhall/application';
import { connectionFor } from '../transactions.js';

/** Escapes LIKE/ILIKE metacharacters so `q` matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

interface PeopleRow {
  person_id: string;
  display_name: string;
  given_name: string;
  family_name: string;
  affiliation: string;
  grade_level: string | null;
  person_status: string;
  membership_status: string;
  account_id: string | null;
  account_status: string | null;
  identity_linked: boolean;
}

function toDirectoryRow(row: PeopleRow): PersonDirectoryRow {
  return {
    personId: row.person_id,
    displayName: row.display_name,
    givenName: row.given_name,
    familyName: row.family_name,
    affiliation: row.affiliation,
    gradeLevel: row.grade_level,
    personStatus: row.person_status,
    membershipStatus: row.membership_status,
    accountId: row.account_id,
    accountStatus: row.account_status,
    identityLinked: row.identity_linked,
  };
}

/** PostgreSQL read-only school directory persistence (tenant-scoped). */
export class PostgresPeopleRepository implements PeopleRepository {
  async searchPeople(
    context: TenantTransactionContext,
    organizationId: string,
    input: PersonSearchInput,
  ): Promise<readonly PersonDirectoryRow[]> {
    const connection = connectionFor(context);
    const cursor: PersonSearchCursor | null = input.cursor;
    const pattern = input.q === null ? null : `%${escapeLike(input.q)}%`;
    const rows = await connection
      .selectFrom('organization_membership as m')
      .innerJoin('person as p', (join) =>
        join.onRef('p.tenant_id', '=', 'm.tenant_id').onRef('p.id', '=', 'm.person_id'),
      )
      .leftJoin('account as a', (join) =>
        join.onRef('a.tenant_id', '=', 'm.tenant_id').onRef('a.person_id', '=', 'm.person_id'),
      )
      .select([
        'm.person_id',
        'p.display_name',
        'p.given_name',
        'p.family_name',
        'm.affiliation',
        'm.grade_level',
        'p.status as person_status',
        'm.status as membership_status',
        'a.id as account_id',
        'a.status as account_status',
        (eb) =>
          eb
            .exists(
              eb
                .selectFrom('auth_identity as i')
                .select('i.id')
                .whereRef('i.tenant_id', '=', 'm.tenant_id')
                .whereRef('i.account_id', '=', 'a.id'),
            )
            .as('identity_linked'),
      ])
      .where('m.tenant_id', '=', context.tenantId)
      .where('m.organization_id', '=', organizationId)
      .$call((qb) =>
        input.affiliation === null ? qb : qb.where('m.affiliation', '=', input.affiliation),
      )
      .$call((qb) =>
        pattern === null
          ? qb
          : qb.where((eb) =>
              eb.or([
                eb('p.display_name', 'ilike', pattern),
                eb('p.given_name', 'ilike', pattern),
                eb('p.family_name', 'ilike', pattern),
              ]),
            ),
      )
      .$call((qb) =>
        cursor === null
          ? qb
          : qb.where((eb) =>
              eb.or([
                eb('p.display_name', '>', cursor.displayName),
                eb.and([
                  eb('p.display_name', '=', cursor.displayName),
                  eb('m.person_id', '>', cursor.personId),
                ]),
              ]),
            ),
      )
      .orderBy('p.display_name')
      .orderBy('m.person_id')
      .limit(input.limit + 1)
      .execute();
    return rows.map((row) =>
      toDirectoryRow({
        person_id: row.person_id,
        display_name: row.display_name,
        given_name: row.given_name,
        family_name: row.family_name,
        affiliation: row.affiliation,
        grade_level: row.grade_level,
        person_status: row.person_status,
        membership_status: row.membership_status,
        account_id: row.account_id,
        account_status: row.account_status,
        identity_linked: row.identity_linked === true,
      }),
    );
  }

  async searchSections(
    context: TenantTransactionContext,
    organizationId: string,
    input: SectionSearchInput,
  ): Promise<readonly SectionChoiceRow[]> {
    const connection = connectionFor(context);
    const cursor: SectionSearchCursor | null = input.cursor;
    const pattern = input.q === null ? null : `%${escapeLike(input.q)}%`;
    const rows = await connection
      .selectFrom('section')
      .select(['id', 'code', 'title', 'status'])
      .where('tenant_id', '=', context.tenantId)
      .where('organization_id', '=', organizationId)
      .$call((qb) =>
        pattern === null
          ? qb
          : qb.where((eb) => eb.or([eb('title', 'ilike', pattern), eb('code', 'ilike', pattern)])),
      )
      .$call((qb) =>
        cursor === null
          ? qb
          : qb.where((eb) =>
              eb.or([
                eb('title', '>', cursor.title),
                eb.and([eb('title', '=', cursor.title), eb('id', '>', cursor.sectionId)]),
              ]),
            ),
      )
      .orderBy('title')
      .orderBy('id')
      .limit(input.limit + 1)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      title: row.title,
      status: row.status,
    }));
  }
}
