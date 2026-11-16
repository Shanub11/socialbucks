// apps/worker/src/jobs/context.ts
//
// What a job function is allowed to reach: a database client, a logger and a
// clock. Nothing else is in scope, which is what makes a job testable without a
// process, a queue or a system clock (ADR-0006 R7).
//
// The client is a parameter, not an import. Two consequences matter:
//   - a job test can hand in a Proxy over the real client to force a race, and
//   - nothing below this file decides which database it talks to.
//
// `import type` only: this file must stay loadable without creating the Prisma
// singleton, and R10 keeps it out of main.ts's static graph.

import type { PrismaClient } from '@repo/database';

import type { Logger } from '../logger';

/** Injected clock. A job never calls Date.now() on its own (R7). */
export type Clock = () => Date;

export interface JobContext {
  db: PrismaClient;
  logger: Logger;
  now: Clock;
}

/**
 * The web app's settlement code, bound once at startup (ADR-0006 D7).
 *
 * Stage 1 registers only the invite sweeper, which needs nothing from the web
 * app, so this is empty. Stage 2 adds the settlement provider here and
 * `jobs/deps.ts` becomes the only module in the worker that value-imports from
 * apps/web.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface JobDeps {}
