// apps/web/src/lib/settlement/money.test.ts
//
// Tests for money.ts — Decimal ↔ BigInt conversion.
// These tests can fail (no expect(true) assertions, no mocked DB).

import { describe, it, expect } from 'vitest';
import { Prisma } from '@repo/database';
const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;;
import {
  toMinorUnits,
  fromMinorUnits,
  assertTwoDecimalCurrency,
  bigintFloorDiv,
  bigintCeilDiv,
  MoneyError,
} from './money';

// ---------------------------------------------------------------------------
// toMinorUnits
// ---------------------------------------------------------------------------

describe('toMinorUnits', () => {
  it('converts whole dollar amounts correctly', () => {
    expect(toMinorUnits(new Decimal('100.00'))).toBe(10000n);
    expect(toMinorUnits(new Decimal('1.00'))).toBe(100n);
    expect(toMinorUnits(new Decimal('0.00'))).toBe(0n);
  });

  it('converts fractional amounts correctly', () => {
    expect(toMinorUnits(new Decimal('0.01'))).toBe(1n);
    expect(toMinorUnits(new Decimal('0.10'))).toBe(10n);
    expect(toMinorUnits(new Decimal('9999999999.99'))).toBe(999999999999n);
    expect(toMinorUnits(new Decimal('100.01'))).toBe(10001n);
    expect(toMinorUnits(new Decimal('0.03'))).toBe(3n);
  });

  it('handles max DECIMAL(12,2) value', () => {
    // 9,999,999,999.99 — largest value the column accepts
    expect(toMinorUnits(new Decimal('9999999999.99'))).toBe(999999999999n);
  });

  it('throws on more than 2 decimal places', () => {
    expect(() => toMinorUnits(new Decimal('1.001'))).toThrow(MoneyError);
    expect(() => toMinorUnits(new Decimal('0.001'))).toThrow(MoneyError);
    expect(() => toMinorUnits(new Decimal('99.999'))).toThrow(MoneyError);
  });

  it('throws on negative amounts', () => {
    expect(() => toMinorUnits(new Decimal('-1.00'))).toThrow(MoneyError);
    expect(() => toMinorUnits(new Decimal('-0.01'))).toThrow(MoneyError);
  });
});

// ---------------------------------------------------------------------------
// fromMinorUnits
// ---------------------------------------------------------------------------

describe('fromMinorUnits', () => {
  it('converts minor units back to Decimal with 2dp', () => {
    expect(fromMinorUnits(10000n).toString()).toBe('100');
    expect(fromMinorUnits(1n).toString()).toBe('0.01');
    expect(fromMinorUnits(0n).toString()).toBe('0');
    expect(fromMinorUnits(999999999999n).toString()).toBe('9999999999.99');
  });

  it('round-trips with toMinorUnits', () => {
    const amounts = ['0.01', '0.03', '100.01', '9999999999.99', '1.00', '0.50', '123.45'];
    for (const a of amounts) {
      const d = new Decimal(a);
      expect(fromMinorUnits(toMinorUnits(d)).toString()).toBe(d.toString());
    }
  });

  it('throws on negative minor units', () => {
    expect(() => fromMinorUnits(-1n)).toThrow(MoneyError);
  });
});

// ---------------------------------------------------------------------------
// assertTwoDecimalCurrency
// ---------------------------------------------------------------------------

describe('assertTwoDecimalCurrency', () => {
  it('accepts standard 2-decimal currencies', () => {
    expect(() => assertTwoDecimalCurrency('USD')).not.toThrow();
    expect(() => assertTwoDecimalCurrency('EUR')).not.toThrow();
    expect(() => assertTwoDecimalCurrency('GBP')).not.toThrow();
    expect(() => assertTwoDecimalCurrency('INR')).not.toThrow();
  });

  it('is case-insensitive', () => {
    expect(() => assertTwoDecimalCurrency('usd')).not.toThrow();
    expect(() => assertTwoDecimalCurrency('Eur')).not.toThrow();
  });

  it('throws for 0-decimal currencies (JPY, KRW)', () => {
    expect(() => assertTwoDecimalCurrency('JPY')).toThrow(MoneyError);
    expect(() => assertTwoDecimalCurrency('KRW')).toThrow(MoneyError);
  });

  it('throws for 3-decimal currencies (KWD, BHD)', () => {
    expect(() => assertTwoDecimalCurrency('KWD')).toThrow(MoneyError);
    expect(() => assertTwoDecimalCurrency('BHD')).toThrow(MoneyError);
  });

  it('throws for unknown/invented currency codes', () => {
    expect(() => assertTwoDecimalCurrency('XYZ')).toThrow(MoneyError);
    expect(() => assertTwoDecimalCurrency('')).toThrow(MoneyError);
  });
});

// ---------------------------------------------------------------------------
// bigintFloorDiv and bigintCeilDiv
// ---------------------------------------------------------------------------

describe('bigintFloorDiv', () => {
  it('floors correctly', () => {
    // floor(100 * 2000 / 10000) = 20
    expect(bigintFloorDiv(100n, 2000n, 10000n)).toBe(20n);
    // floor(1 * 2000 / 10000) = 0
    expect(bigintFloorDiv(1n, 2000n, 10000n)).toBe(0n);
    // floor(7 * 7000 / 10000) = 4
    expect(bigintFloorDiv(7n, 7000n, 10000n)).toBe(4n);
  });

  it('throws on division by zero', () => {
    expect(() => bigintFloorDiv(10n, 5n, 0n)).toThrow(MoneyError);
  });
});

describe('bigintCeilDiv', () => {
  it('ceils correctly', () => {
    // ceil(100 * 2000 / 10000) = 20 (exact)
    expect(bigintCeilDiv(100n, 2000n, 10000n)).toBe(20n);
    // ceil(1 * 2000 / 10000) = ceil(0.2) = 1
    expect(bigintCeilDiv(1n, 2000n, 10000n)).toBe(1n);
    // ceil(3 * 2000 / 10000) = ceil(0.6) = 1
    expect(bigintCeilDiv(3n, 2000n, 10000n)).toBe(1n);
    // ceil(7 * 4000 / 10000) = ceil(2.8) = 3
    expect(bigintCeilDiv(7n, 4000n, 10000n)).toBe(3n);
  });

  it('throws on division by zero', () => {
    expect(() => bigintCeilDiv(10n, 5n, 0n)).toThrow(MoneyError);
  });

  it('throws on negative numerator product', () => {
    expect(() => bigintCeilDiv(-1n, 5n, 10n)).toThrow(MoneyError);
  });
});
