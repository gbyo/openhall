import type { Kysely, Transaction } from 'kysely';
import type { TenantId } from '@openhall/domain';
import type { DB as Database } from './database.generated.js';

export class TenantDatabase {
  private constructor(
    readonly tenantId: TenantId,
    readonly connection: Kysely<Database> | Transaction<Database>,
  ) {}

  static scoped(
    tenantId: TenantId,
    connection: Kysely<Database> | Transaction<Database>,
  ): TenantDatabase {
    if (tenantId.length === 0) {
      throw new Error('Tenant context is required');
    }
    return new TenantDatabase(tenantId, connection);
  }
}

export class SystemDatabaseAccess {
  private constructor(readonly connection: Kysely<Database>) {}

  static explicitlyUnscoped(connection: Kysely<Database>): SystemDatabaseAccess {
    return new SystemDatabaseAccess(connection);
  }
}
