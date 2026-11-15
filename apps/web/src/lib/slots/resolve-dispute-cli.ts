// apps/web/src/lib/slots/resolve-dispute-cli.ts
//
// Pure argument and presentation helpers for scripts/resolve-dispute.ts.
// No I/O, no Prisma and no process access, so they are unit-testable and the CLI
// stays thin.
//
// Failure messages never echo the offending argument: parseArgs' own errors
// quote the value, so they are replaced with a fixed usage line.

import { parseArgs } from 'node:util';

import type { ResolutionOutcome, ResolveDisputeResult } from './resolve-dispute';

export const USAGE =
  'Usage: resolve-dispute --slot <slotId> --outcome <resume|close> --operator <name> [--apply]';

const OUTCOMES_BY_FLAG: Record<string, ResolutionOutcome> = {
  resume: 'RESUME',
  close: 'CLOSE',
};

const KNOWN_FLAGS = ['--slot', '--outcome', '--operator', '--apply'] as const;

export interface ParsedResolveDisputeArgs {
  slotId: string;
  outcome: ResolutionOutcome;
  operator: string;
  apply: boolean;
}

export type ParseResolveDisputeArgsResult =
  | { ok: true; value: ParsedResolveDisputeArgs }
  | { ok: false; message: string };

/** True when any known flag is given more than once (parseArgs keeps the last). */
function isFlagRepeated(argv: string[]): boolean {
  return KNOWN_FLAGS.some((flag) => {
    const seen = argv.filter(
      (arg) => arg === flag || arg.startsWith(`${flag}=`),
    ).length;
    return seen > 1;
  });
}

/**
 * Parses `resolve-dispute` arguments.
 *
 * `strict` rejects unknown flags and positional arguments; repetition and the
 * required flags are checked here because parseArgs silently keeps the last
 * occurrence of a non-multiple option.
 */
export function parseResolveDisputeArgs(
  argv: string[],
): ParseResolveDisputeArgsResult {
  if (isFlagRepeated(argv)) {
    return { ok: false, message: `Repeated option. ${USAGE}` };
  }

  let values: {
    slot?: string;
    outcome?: string;
    operator?: string;
    apply?: boolean;
  };
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        slot: { type: 'string' },
        outcome: { type: 'string' },
        operator: { type: 'string' },
        apply: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    values = parsed.values;
  } catch {
    // Never surface the parser's message: it quotes the offending argument.
    return { ok: false, message: `Invalid arguments. ${USAGE}` };
  }

  const slotId = values.slot;
  if (slotId === undefined || slotId.trim() === '') {
    return { ok: false, message: `Missing --slot. ${USAGE}` };
  }

  const rawOutcome = values.outcome;
  if (rawOutcome === undefined || rawOutcome.trim() === '') {
    return { ok: false, message: `Missing --outcome. ${USAGE}` };
  }

  const operator = values.operator;
  if (operator === undefined || operator.trim() === '') {
    return { ok: false, message: `Missing --operator. ${USAGE}` };
  }

  const outcome = OUTCOMES_BY_FLAG[rawOutcome.trim().toLowerCase()];
  if (outcome === undefined) {
    return { ok: false, message: `Invalid --outcome. ${USAGE}` };
  }

  // slotId is deliberately not trimmed: an id with spaces is not a valid id and
  // the library refuses it.
  return {
    ok: true,
    value: {
      slotId,
      outcome,
      operator,
      apply: values.apply === true,
    },
  };
}

/**
 * Renders a database URL as `host:port/database` for an operator to eyeball
 * before an --apply run. Never returns the user name, password, path segments
 * or query string, and never echoes unparseable input.
 */
export function describeDatabaseTarget(url: string | undefined): string {
  if (url === undefined || url.trim() === '') return 'unknown';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'unknown';
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return 'unknown';
  }

  const host = parsed.hostname;
  if (host === '') return 'unknown';

  const port = parsed.port === '' ? '5432' : parsed.port;

  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return 'unknown';
  }
  if (database === '') return 'unknown';

  return `${host}:${port}/${database}`;
}

/**
 * Human-readable lines for a resolution result. A planned result ends with the
 * dry-run reminder so an operator cannot mistake it for a write.
 */
export function formatResult(result: ResolveDisputeResult): string[] {
  if (result.kind === 'refused') {
    return [`Refused: ${result.reason}`, `Reason: ${result.message}`];
  }

  const lines = [
    `${result.kind === 'planned' ? 'PLANNED' : 'APPLIED'} ${result.outcome} for slot ${result.slotId}`,
    `Operator: ${result.operator}`,
    `Disputed at: ${result.disputedAt}`,
    `Resolved at: ${result.resolvedAt}`,
    `Status after: ${result.newStatus}`,
    `Settlement ends at (before): ${result.settlementEndsAt ?? 'none'}`,
  ];

  if (result.outcome === 'RESUME') {
    lines.push(
      `Settlement ends at (after): ${result.newSettlementEndsAt ?? 'none'}`,
    );
    lines.push(
      `Extension: ${((result.extensionMs ?? 0) / 3_600_000).toFixed(1)} hours`,
    );
  }

  lines.push(`Escrow: ${result.escrowAmount}`);
  lines.push(`Paid to date: ${result.paidToDate}`);
  lines.push(`Unreleased amount: ${result.unreleasedAmount}`);

  if (result.kind === 'planned') {
    lines.push('DRY RUN: nothing was changed. Re-run with --apply to write.');
  }

  return lines;
}
