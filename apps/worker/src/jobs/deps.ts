// apps/worker/src/jobs/deps.ts
//
// The single place in the worker that value-imports from apps/web (ADR-0005 D4,
// ADR-0006 D7). Everything else in the worker uses `import type` for web types,
// which disappears at compile time, so the worker can be built and started
// without the web app's module graph.
//
// IMPORTANT: this file is deliberately NOT in main.ts's static graph (R10). It
// is loaded with a dynamic import() right after the logger and *before* the
// database is built, because two things here are startup decisions:
//
//   1. `loadSettlementEnv` is the settlement preflight (ADR-0006 D6, D8). It
//      runs before any client exists, so a missing variable exits 2 with
//      variable names only - never a database error that masks it.
//   2. `buildDeps` binds the web app's settlement function and the YouTube
//      provider. `settleSlot` takes an injected client, so the worker hands it
//      the connection it already proved (ADR-0006 D5).
//
// Adding a web module here is a decision, not a convenience: R9 allows value
// imports from apps/web in this file only, and `worker-imports.test.ts` enforces
// it. `@/lib/env-parts` is the fifth such module, and it is imported here for
// the preflight alone.

import { z } from 'zod';

import { parseSettlementEnv, type SettlementEnv } from '@/lib/env-parts';
import { youtubeMetricsProvider } from '@/lib/settlement/adapters/youtube';
import { settleSlot as settleSlotService } from '@/lib/settlement/settle-slot';

import { ConfigError } from '../config';
import type { JobDeps } from './context';

/**
 * Validates the settlement environment, turning a ZodError into the worker's own
 * ConfigError (ADR-0006 D8).
 *
 * The message names the variables (the issue paths) and nothing else. Zod's own
 * issue messages are dropped, and no value is ever interpolated: a malformed key
 * is still a secret, and this line goes to the platform log.
 *
 * @throws {ConfigError} when a required variable is missing or malformed.
 */
export function loadSettlementEnv(
  source: Record<string, string | undefined>,
): SettlementEnv {
  try {
    return parseSettlementEnv(source);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const names = [
        ...new Set(
          error.issues
            .map((issue) => issue.path.map((part) => String(part)).join('.'))
            .filter((path) => path !== ''),
        ),
      ];

      throw new ConfigError(
        names.length > 0
          ? `Invalid settlement configuration: ${names.join(', ')}`
          : 'Invalid settlement configuration',
      );
    }

    throw error;
  }
}

/**
 * Binds the web app's settlement code to the worker's own database client.
 *
 * Throws only if a module fails to load; the environment is validated by
 * `loadSettlementEnv` before the database is built, so a missing variable is
 * reported there with exit 2 rather than surfacing here as a module error.
 */
export function buildDeps(): JobDeps {
  return {
    settleSlot: (slotId, db) => settleSlotService(slotId, db, youtubeMetricsProvider),
  };
}
