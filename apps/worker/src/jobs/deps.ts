// apps/worker/src/jobs/deps.ts
//
// The single place in the worker that value-imports from apps/web (ADR-0005 D4,
// ADR-0006 D7). Everything else in the worker uses `import type` for web types,
// which disappears at compile time, so the worker can be built and started
// without the web app's module graph.
//
// IMPORTANT: this file is deliberately NOT in main.ts's static graph (R10). It
// is loaded with a dynamic import() after configuration has been validated,
// because the modules bound here read process.env as they are imported.
//
// Stage 1: there is nothing to bind yet - the invite sweeper is pure database
// work. Stage 2 adds the settlement provider:
//
//   export function buildDeps(): JobDeps {
//     return {
//       settleSlot: (slotId, db) => settleSlot(slotId, db, youtubeMetricsProvider),
//     };
//   }
//
// going through `parseSettlementEnv` first, which reports variable names only.

import type { JobDeps } from './context';

/** Builds the bound web-app dependencies. Throws only if a module cannot load. */
export function buildDeps(): JobDeps {
  return {};
}
