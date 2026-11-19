// apps/web/scripts/resolve-dispute.ts
//
// Operator CLI for ADR-0004 D4: resolve a disputed slot.
//   DISPUTED -> IN_PROGRESS (--outcome resume)
//   DISPUTED -> CLOSED      (--outcome close)
//
// The library does the work; this file only parses arguments, prints where it is
// pointed, and reports the result. Dry run is the default: nothing is written
// unless --apply is passed.
//
// The Prisma client is imported lazily, after arguments and DATABASE_URL are
// settled, so a usage error exits 2 without constructing a database client.
//
// Run from apps/web:
//   pnpm resolve-dispute -- --slot <id> --outcome resume --operator <name> [--apply]

import {
  describeDatabaseTarget,
  formatResult,
  parseResolveDisputeArgs,
} from '../src/lib/slots/resolve-dispute-cli';

interface DisconnectableClient {
  $disconnect: () => Promise<void>;
}

async function main(): Promise<void> {
  let exitCode = 1;
  let client: DisconnectableClient | null = null;

  try {
    // pnpm forwards the literal "--" separator to the script, so it is dropped
    // here to keep the documented `pnpm resolve-dispute -- --slot ...` form.
    const rawArgs = process.argv.slice(2);
    const argv = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;

    const parsed = parseResolveDisputeArgs(argv);
    if (!parsed.ok) {
      console.error(parsed.message);
      exitCode = 2;
      return;
    }

    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (databaseUrl === undefined || databaseUrl === '') {
      console.error('DATABASE_URL is not set');
      exitCode = 2;
      return;
    }

    // Printed before the database is touched: an operator must be able to see
    // which database an --apply run would write to.
    console.log(`Target database: ${describeDatabaseTarget(databaseUrl)}`);
    console.log(`Mode: ${parsed.value.apply ? 'APPLY' : 'DRY RUN'}`);

    const [{ prisma }, { resolveDispute }] = await Promise.all([
      import('@repo/database'),
      import('../src/lib/slots/resolve-dispute'),
    ]);
    client = prisma;

    const result = await resolveDispute(prisma, parsed.value);

    for (const line of formatResult(result)) {
      console.log(line);
    }
    // One machine-readable line an operator can paste into the ticket as the
    // audit record. The result never contains the dispute reason.
    console.log(`RESULT ${JSON.stringify(result)}`);

    exitCode = result.kind === 'refused' ? 1 : 0;
  } catch (error) {
    // Only the message: never a stack, and never the connection string.
    console.error(error instanceof Error ? error.message : 'Unexpected error');
    exitCode = 1;
  } finally {
    if (client !== null) {
      try {
        await client.$disconnect();
      } catch {
        // A disconnect failure must not mask the run's exit code.
      }
    }
    process.exitCode = exitCode;
  }
}

void main();
