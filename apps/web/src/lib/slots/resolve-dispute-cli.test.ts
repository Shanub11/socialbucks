// apps/web/src/lib/slots/resolve-dispute-cli.test.ts
//
// Pure unit tests for the resolve-dispute CLI helpers. No database, no Prisma
// and no process access, so these always run (they are NOT gated on
// RUN_DB_TESTS).
//
// The canaries prove two things: rejected input is never echoed back, and the
// dispute reason never reaches an operator-facing string.

import { describe, expect, it } from 'vitest';

import type { ResolveDisputeResult } from './resolve-dispute';
import {
  USAGE,
  describeDatabaseTarget,
  formatResult,
  parseResolveDisputeArgs,
} from './resolve-dispute-cli';

const OPERATOR_CANARY = 'CANARY_7be2';
const REASON_CANARY = 'CANARY_dispute_reason_4c1';

const VALID_ARGV = [
  '--slot',
  'slot_abc',
  '--outcome',
  'resume',
  '--operator',
  'alice',
];

/** Asserts the arguments are rejected, that usage is shown and nothing leaks. */
function expectRejected(argv: string[], ...forbidden: string[]): string {
  const parsed = parseResolveDisputeArgs(argv);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error('expected the arguments to be rejected');
  expect(parsed.message).toContain(USAGE);
  for (const value of forbidden) {
    expect(parsed.message).not.toContain(value);
  }
  return parsed.message;
}

describe('parseResolveDisputeArgs', () => {
  it('accepts the minimal command and defaults to a dry run', () => {
    const parsed = parseResolveDisputeArgs(VALID_ARGV);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected the arguments to parse');
    expect(parsed.value).toEqual({
      slotId: 'slot_abc',
      outcome: 'RESUME',
      operator: 'alice',
      apply: false,
    });
  });

  it('accepts --apply', () => {
    const parsed = parseResolveDisputeArgs([...VALID_ARGV, '--apply']);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected the arguments to parse');
    expect(parsed.value.apply).toBe(true);
  });

  it('accepts the --flag=value form and a case-insensitive outcome', () => {
    const parsed = parseResolveDisputeArgs([
      '--slot=slot_abc',
      '--outcome=Close',
      '--operator=alice',
      '--apply',
    ]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected the arguments to parse');
    expect(parsed.value).toEqual({
      slotId: 'slot_abc',
      outcome: 'CLOSE',
      operator: 'alice',
      apply: true,
    });
  });

  it('trims and lowercases the outcome but passes the operator through', () => {
    const parsed = parseResolveDisputeArgs([
      '--slot',
      'slot_abc',
      '--outcome',
      '  ReSuMe  ',
      '--operator',
      '  alice  ',
    ]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected the arguments to parse');
    expect(parsed.value.outcome).toBe('RESUME');
    // Normalization is the library's job, not the parser's.
    expect(parsed.value.operator).toBe('  alice  ');
  });

  it('rejects an unknown flag without echoing its value', () => {
    const message = expectRejected(
      [...VALID_ARGV, '--reason', REASON_CANARY],
      REASON_CANARY,
    );

    expect(message).toContain('Invalid arguments');
  });

  it('rejects positional arguments without echoing them', () => {
    expectRejected([...VALID_ARGV, OPERATOR_CANARY], OPERATOR_CANARY);
  });

  it('rejects a repeated option even when the values agree', () => {
    const message = expectRejected(
      [...VALID_ARGV, '--slot', 'slot_abc'],
      'slot_abc',
    );

    expect(message).toContain('Repeated option');
  });

  it('rejects a boolean option given a value', () => {
    expectRejected([...VALID_ARGV, '--apply=true'], 'true');
  });

  it.each([
    {
      missing: '--slot',
      argv: ['--outcome', 'resume', '--operator', 'alice'],
    },
    {
      missing: '--outcome',
      argv: ['--slot', 'slot_abc', '--operator', 'alice'],
    },
    {
      missing: '--operator',
      argv: ['--slot', 'slot_abc', '--outcome', 'resume'],
    },
  ])('rejects a missing $missing', ({ argv, missing }) => {
    expect(expectRejected(argv)).toContain(`Missing ${missing}`);
  });

  it('rejects an empty option value', () => {
    expect(
      expectRejected(['--slot=', '--outcome=resume', '--operator=alice']),
    ).toContain('Missing --slot');
  });

  it('rejects an unknown outcome without echoing it', () => {
    const message = expectRejected(
      [
        '--slot',
        'slot_abc',
        '--outcome',
        OPERATOR_CANARY,
        '--operator',
        'alice',
      ],
      OPERATOR_CANARY,
    );

    expect(message).toContain('Invalid --outcome');
  });
});

describe('describeDatabaseTarget', () => {
  it('renders only host, port and database', () => {
    const target = describeDatabaseTarget(
      `postgresql://app_user:${OPERATOR_CANARY}@db.example.com:6543/socialbucks?sslmode=require`,
    );

    expect(target).toBe('db.example.com:6543/socialbucks');
    expect(target).not.toContain('app_user');
    expect(target).not.toContain(OPERATOR_CANARY);
    expect(target).not.toContain('sslmode');
  });

  it('defaults a missing port to 5432', () => {
    expect(describeDatabaseTarget('postgres://u:p@localhost/socialbucks')).toBe(
      'localhost:5432/socialbucks',
    );
  });

  it('accepts a percent-encoded database name', () => {
    expect(
      describeDatabaseTarget('postgres://u:p@localhost:5432/social%20bucks'),
    ).toBe('localhost:5432/social bucks');
  });

  it('returns unknown for a non-postgres protocol', () => {
    expect(
      describeDatabaseTarget('mysql://u:p@localhost/socialbucks'),
    ).toBe('unknown');
  });

  it('returns unknown for a URL with no database name', () => {
    expect(describeDatabaseTarget('postgres://u:p@localhost:5432')).toBe(
      'unknown',
    );
  });

  it('returns unknown for undefined, blank and unparseable values', () => {
    expect(describeDatabaseTarget(undefined)).toBe('unknown');
    expect(describeDatabaseTarget('   ')).toBe('unknown');
    expect(describeDatabaseTarget('not a database url')).toBe('unknown');
  });

  it('never echoes an unparseable value', () => {
    const target = describeDatabaseTarget(
      `postgres://user:${OPERATOR_CANARY}@[`,
    );

    expect(target).toBe('unknown');
    expect(target).not.toContain(OPERATOR_CANARY);
  });
});

const BASE_RESULT = {
  slotId: 'slot_abc',
  operator: 'Alice',
  disputedAt: '2026-02-01T00:00:00.000Z',
  resolvedAt: '2026-02-01T12:00:00.000Z',
  escrowAmount: '1000.00',
  paidToDate: '250.00',
  unreleasedAmount: '750.00',
} as const;

const PLANNED_RESUME: ResolveDisputeResult = {
  kind: 'planned',
  outcome: 'RESUME',
  newStatus: 'IN_PROGRESS',
  settlementEndsAt: '2026-03-01T00:00:00.000Z',
  newSettlementEndsAt: '2026-03-01T12:00:00.000Z',
  extensionMs: 12 * 60 * 60 * 1000,
  ...BASE_RESULT,
};

const PLANNED_CLOSE: ResolveDisputeResult = {
  kind: 'planned',
  outcome: 'CLOSE',
  newStatus: 'CLOSED',
  settlementEndsAt: '2026-03-01T00:00:00.000Z',
  newSettlementEndsAt: null,
  extensionMs: null,
  ...BASE_RESULT,
};

const APPLIED_RESUME: ResolveDisputeResult = { ...PLANNED_RESUME, kind: 'applied' };
const APPLIED_CLOSE: ResolveDisputeResult = { ...PLANNED_CLOSE, kind: 'applied' };

describe('formatResult', () => {
  it('formats a planned RESUME with the extension and the dry-run reminder', () => {
    const lines = formatResult(PLANNED_RESUME);

    expect(lines[0]).toBe('PLANNED RESUME for slot slot_abc');
    expect(lines).toContain('Status after: IN_PROGRESS');
    expect(lines).toContain(
      'Settlement ends at (after): 2026-03-01T12:00:00.000Z',
    );
    expect(lines).toContain('Extension: 12.0 hours');
    expect(lines[lines.length - 1]).toBe(
      'DRY RUN: nothing was changed. Re-run with --apply to write.',
    );
    expect(lines.some((line) => line.startsWith('RESULT '))).toBe(false);
  });

  it('formats a planned CLOSE without a new window or extension', () => {
    const lines = formatResult(PLANNED_CLOSE);

    expect(lines[0]).toBe('PLANNED CLOSE for slot slot_abc');
    expect(lines).toContain('Status after: CLOSED');
    expect(
      lines.some((line) => line.startsWith('Settlement ends at (after):')),
    ).toBe(false);
    expect(lines.some((line) => line.startsWith('Extension:'))).toBe(false);
    expect(lines[lines.length - 1]).toContain('DRY RUN');
  });

  it('does not add the dry-run reminder to an applied result', () => {
    const lines = formatResult(APPLIED_RESUME);

    expect(lines[0]).toBe('APPLIED RESUME for slot slot_abc');
    expect(lines.some((line) => line.includes('DRY RUN'))).toBe(false);
  });

  it('formats an applied CLOSE without a new window or extension', () => {
    const lines = formatResult(APPLIED_CLOSE);

    expect(lines[0]).toBe('APPLIED CLOSE for slot slot_abc');
    expect(
      lines.some((line) => line.startsWith('Settlement ends at (after):')),
    ).toBe(false);
    expect(lines.some((line) => line.startsWith('Extension:'))).toBe(false);
    expect(lines.some((line) => line.includes('DRY RUN'))).toBe(false);
  });

  it('reports the escrow, paid and unreleased amounts', () => {
    const lines = formatResult(APPLIED_CLOSE);

    expect(lines).toContain('Escrow: 1000.00');
    expect(lines).toContain('Paid to date: 250.00');
    expect(lines).toContain('Unreleased amount: 750.00');
  });

  it('formats a refusal as its reason and message', () => {
    const lines = formatResult({
      kind: 'refused',
      reason: 'not_disputed',
      message: 'Slot is not DISPUTED, so there is nothing to resolve.',
    });

    expect(lines).toEqual([
      'Refused: not_disputed',
      'Reason: Slot is not DISPUTED, so there is nothing to resolve.',
    ]);
  });

  it('never renders a dispute reason even if one is attached at runtime', () => {
    const withReason = {
      ...APPLIED_RESUME,
      disputeReason: REASON_CANARY,
      disputeReasonText: REASON_CANARY,
    } as unknown as ResolveDisputeResult;

    const text = formatResult(withReason).join('\n');

    expect(text).not.toContain(REASON_CANARY);
    expect(text).not.toContain('disputeReason');
  });
});
