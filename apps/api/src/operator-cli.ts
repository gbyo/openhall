import { randomUUID } from 'node:crypto';
import { loadConfig } from '@openhall/config';
import {
  createDatabase,
  PostgresAuditWriter,
  PostgresOperatorGrantStore,
  PostgresRecoveryEligibilityChecker,
  PostgresSystemTransactionRunner,
  PostgresTenantDirectory,
  PostgresTenantTransactionRunner,
} from '@openhall/db';
import { issueBootstrapGrant, issueRecoveryGrant } from '@openhall/application';
import { SystemClock } from '@openhall/domain';
import { HmacCredentialDigester, NodeSecureRandom } from './auth/crypto.js';

function usage(): string {
  return [
    'Usage:',
    '  openhall-operator operator bootstrap issue',
    '  openhall-operator operator recovery issue --tenant <id-or-slug> --account <uuid>',
    '',
    'The raw one-time token is printed to stdout exactly once. It never',
    'appears in logs. Pass it to the browser out of band; never place it in',
    'a URL, shell history, or process arguments.',
  ].join('\n');
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] !== 'operator') {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const config = loadConfig();
  const database = createDatabase(config.databaseUrl, { max: 2 });
  try {
    const random = new NodeSecureRandom();
    const digester = new HmacCredentialDigester(config.appSecret);
    const clock = new SystemClock();
    const tenants = new PostgresTenantDirectory(database.database);
    const grants = new PostgresOperatorGrantStore(database.database);
    const systemRunner = new PostgresSystemTransactionRunner(database.database);
    const tenantRunner = new PostgresTenantTransactionRunner(database.database);
    const requestId = randomUUID();

    if (args[1] === 'bootstrap' && args[2] === 'issue' && args.length === 3) {
      const issued = await systemRunner.run((context) =>
        issueBootstrapGrant(context, tenants, {
          grants,
          random,
          digester,
          clock,
        }),
      );
      process.stderr.write(
        [
          'Bootstrap grant issued. It is short-lived and one-time.',
          `Open the OpenHall setup page and paste the token when asked: ${config.appBaseUrl.origin}`,
          'The token below is shown exactly once and is never logged.',
        ].join('\n') + '\n',
      );
      process.stdout.write(`${issued.rawToken}\n`);
      return 0;
    }

    if (args[1] === 'recovery' && args[2] === 'issue') {
      const tenantRef = flagValue(args, '--tenant');
      const accountId = flagValue(args, '--account');
      if (tenantRef === undefined || accountId === undefined || args.length !== 7) {
        process.stderr.write(`${usage()}\n`);
        return 2;
      }
      const tenant =
        (await tenants.findBySlug(tenantRef.toLowerCase())) ?? (await tenants.findById(tenantRef));
      if (tenant === undefined) {
        process.stderr.write('No matching active tenant for recovery grant.\n');
        return 1;
      }
      const issued = await systemRunner.run((context) =>
        issueRecoveryGrant(
          context,
          { tenantId: tenant.id, accountId, requestId },
          tenants,
          new PostgresRecoveryEligibilityChecker(),
          {
            grants,
            random,
            digester,
            clock,
            audit: new PostgresAuditWriter(),
            tenantRunner,
          },
        ),
      );
      process.stderr.write(
        [
          `Recovery grant issued for tenant ${tenant.slug}.`,
          'It is short-lived and single-use, and creates a 30-minute break-glass session.',
          'The token below is shown exactly once and is never logged.',
        ].join('\n') + '\n',
      );
      process.stdout.write(`${issued.rawToken}\n`);
      return 0;
    }

    process.stderr.write(`${usage()}\n`);
    return 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Operator command failed';
    process.stderr.write(`openhall-operator: ${message}\n`);
    return 1;
  } finally {
    await database.destroy();
  }
}

const code = await main();
process.exitCode = code;
