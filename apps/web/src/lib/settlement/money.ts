// apps/web/src/lib/settlement/money.ts
//
// Deterministic Decimal ↔ BigInt conversion for settlement arithmetic.
//
// Rule: all tier math runs in BigInt minor units (integer cents for USD).
// Floats are never used. Decimal is only the storage/display type.
//
// Node-only: imports Decimal from @prisma/client runtime.

import { Prisma } from '@repo/database';
const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

// ---------------------------------------------------------------------------
// 2-decimal currency guard (D10)
//
// Minor-unit factor is 100 for all standard 2-decimal currencies (USD, EUR,
// GBP, AUD, CAD, …). 0-decimal currencies (JPY, KRW) and 3-decimal
// currencies (KWD, BHD) are not supported and throw.
//
// The SUPPORTED set is an explicit allowlist — fail closed.
// ---------------------------------------------------------------------------

const TWO_DECIMAL_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'SEK', 'NOK', 'DKK',
  'NZD', 'SGD', 'HKD', 'MXN', 'BRL', 'INR', 'ZAR', 'PLN', 'CZK',
  'HUF', 'RON', 'TRY', 'MYR', 'THB', 'IDR', 'PHP', 'EGP', 'SAR',
  'AED', 'QAR', 'KES', 'GHS', 'NGN', 'PKR', 'BDT',
]);

/**
 * Asserts the currency uses 2 decimal places (minor-unit factor = 100).
 * Throws MoneyError for 0-decimal (JPY) or 3-decimal (KWD) currencies.
 *
 * Called once at the start of settleSlot() before any arithmetic (D10).
 */
export function assertTwoDecimalCurrency(currency: string): void {
  if (!TWO_DECIMAL_CURRENCIES.has(currency.toUpperCase())) {
    throw new MoneyError(
      `Currency "${currency}" is not in the supported 2-decimal allowlist. ` +
      `Add it explicitly if it uses exactly 2 decimal places.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Decimal → BigInt (toMinorUnits)
// ---------------------------------------------------------------------------

/**
 * Converts a Prisma Decimal (stored as DECIMAL(12,2)) to BigInt minor units.
 *
 * Invariant: the Decimal must have at most 2 decimal places, as enforced by
 * the database schema. If it has more, this throws — never silently rounds.
 *
 * Uses Decimal.js arithmetic throughout; no JS float conversion.
 */
export function toMinorUnits(amount: Decimal): bigint {
  // Multiply by 100 in exact decimal arithmetic.
  const shifted = amount.times(new Decimal(100));

  // Guard: result must be an integer (no sub-cent fractions).
  if (!shifted.isInteger()) {
    throw new MoneyError(
      `Amount ${amount.toString()} has more than 2 decimal places — ` +
      `cannot convert to integer minor units without rounding.`,
    );
  }

  // Guard: must be non-negative (escrow amounts are always >= 0).
  if (shifted.isNegative()) {
    throw new MoneyError(
      `Amount ${amount.toString()} is negative — escrow amounts must be >= 0.`,
    );
  }

  return BigInt(shifted.toFixed(0));
}

// ---------------------------------------------------------------------------
// BigInt → Decimal (fromMinorUnits)
// ---------------------------------------------------------------------------

/**
 * Converts BigInt minor units back to a Prisma Decimal with exactly 2dp.
 *
 * The result is suitable for writing to DECIMAL(12,2) columns.
 */
export function fromMinorUnits(minor: bigint): Decimal {
  if (minor < 0n) {
    throw new MoneyError(`Minor units must be >= 0, got ${minor}`);
  }
  // Decimal arithmetic: divide by 100, result has exactly 2dp.
  return new Decimal(minor.toString()).dividedBy(new Decimal(100));
}

// ---------------------------------------------------------------------------
// Floor division helper used in tier math
// ---------------------------------------------------------------------------

/**
 * Integer floor division: floor(a * b / c) — all in BigInt, no floats.
 *
 * Used for: cumAmount = floor(escrowMinor * cumBps / 10000)
 *       and: thresholdViews = ceil(viewTarget * cumBps / 10000)
 *
 * JavaScript BigInt division already truncates toward zero (i.e. floor for
 * non-negative values), which is what we want here.
 */
export function bigintFloorDiv(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new MoneyError('Division by zero in bigintFloorDiv');
  return (a * b) / c;
}

/**
 * Integer ceiling division: ceil(a * b / c) — all in BigInt, no floats.
 *
 * Used for: thresholdViews = ceil(viewTarget * cumBps / 10000)
 */
export function bigintCeilDiv(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new MoneyError('Division by zero in bigintCeilDiv');
  const product = a * b;
  // ceil(product / c) = (product + c - 1) / c for positive values
  if (product < 0n) throw new MoneyError('Negative numerator in bigintCeilDiv');
  return (product + c - 1n) / c;
}
