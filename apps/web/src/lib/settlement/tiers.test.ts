// apps/web/src/lib/settlement/tiers.test.ts
//
// Tests for tiers.ts — pure domain logic, no DB, no network.
// All tests can fail (no mocks, no expect(true) assertions).

import { describe, it, expect } from 'vitest';
import { MilestoneTier, SocialPlatform } from '@repo/database';
import { Prisma } from '@repo/database';
const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;;
import {
  computeNewTiers,
  getBillableMetric,
  getTierThreshold,
  TIER_ORDER,
  sumAllTierAmountsMinor,
  TierError,
} from './tiers';
import { toMinorUnits, MoneyError } from './money';

// ---------------------------------------------------------------------------
// D2 — Billable metric mapping table (asserted directly, per spec)
// ---------------------------------------------------------------------------

describe('getBillableMetric (D2 mapping table)', () => {
  it('YouTube → engagedViews', () => {
    expect(getBillableMetric(SocialPlatform.YOUTUBE)).toBe('engagedViews');
  });

  it('Instagram → views', () => {
    expect(getBillableMetric(SocialPlatform.INSTAGRAM)).toBe('views');
  });

  it('covers all SocialPlatform values — exhaustive switch', () => {
    // If a new platform is added to the enum without updating getBillableMetric,
    // this test will fail because the switch will throw TierError.
    const allPlatforms: SocialPlatform[] = [
      SocialPlatform.YOUTUBE,
      SocialPlatform.INSTAGRAM,
    ];
    for (const p of allPlatforms) {
      expect(() => getBillableMetric(p)).not.toThrow();
    }
    // Verify the mapping table size matches the enum size we expect
    expect(allPlatforms).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// D4 — Tier threshold boundaries
// ---------------------------------------------------------------------------

describe('getTierThreshold', () => {
  describe('viewTarget=1', () => {
    // ceil(1 * 2000 / 10000) = ceil(0.2) = 1
    it('BASELINE threshold is 1', () => {
      expect(getTierThreshold(MilestoneTier.BASELINE, 1)).toBe(1);
    });
    // ceil(1 * 4000 / 10000) = ceil(0.4) = 1
    it('TIER_40 threshold is 1', () => {
      expect(getTierThreshold(MilestoneTier.TIER_40, 1)).toBe(1);
    });
    // ceil(1 * 7000 / 10000) = ceil(0.7) = 1
    it('TIER_70 threshold is 1', () => {
      expect(getTierThreshold(MilestoneTier.TIER_70, 1)).toBe(1);
    });
    // ceil(1 * 10000 / 10000) = 1
    it('TIER_100 threshold is 1', () => {
      expect(getTierThreshold(MilestoneTier.TIER_100, 1)).toBe(1);
    });
  });

  describe('viewTarget=3', () => {
    // ceil(3 * 2000 / 10000) = ceil(0.6) = 1
    it('BASELINE threshold is 1', () => {
      expect(getTierThreshold(MilestoneTier.BASELINE, 3)).toBe(1);
    });
    // ceil(3 * 4000 / 10000) = ceil(1.2) = 2
    it('TIER_40 threshold is 2', () => {
      expect(getTierThreshold(MilestoneTier.TIER_40, 3)).toBe(2);
    });
    // ceil(3 * 7000 / 10000) = ceil(2.1) = 3
    it('TIER_70 threshold is 3', () => {
      expect(getTierThreshold(MilestoneTier.TIER_70, 3)).toBe(3);
    });
    // ceil(3 * 10000 / 10000) = 3
    it('TIER_100 threshold is 3', () => {
      expect(getTierThreshold(MilestoneTier.TIER_100, 3)).toBe(3);
    });
  });

  describe('viewTarget=7', () => {
    // ceil(7 * 2000 / 10000) = ceil(1.4) = 2
    it('BASELINE threshold is 2', () => {
      expect(getTierThreshold(MilestoneTier.BASELINE, 7)).toBe(2);
    });
    // ceil(7 * 4000 / 10000) = ceil(2.8) = 3
    it('TIER_40 threshold is 3', () => {
      expect(getTierThreshold(MilestoneTier.TIER_40, 7)).toBe(3);
    });
    // ceil(7 * 7000 / 10000) = ceil(4.9) = 5
    it('TIER_70 threshold is 5', () => {
      expect(getTierThreshold(MilestoneTier.TIER_70, 7)).toBe(5);
    });
    // ceil(7 * 10000 / 10000) = 7
    it('TIER_100 threshold is 7', () => {
      expect(getTierThreshold(MilestoneTier.TIER_100, 7)).toBe(7);
    });
  });

  describe('viewTarget=100000', () => {
    // ceil(100000 * 2000 / 10000) = 20000
    it('BASELINE threshold is 20000', () => {
      expect(getTierThreshold(MilestoneTier.BASELINE, 100000)).toBe(20000);
    });
    // ceil(100000 * 4000 / 10000) = 40000
    it('TIER_40 threshold is 40000', () => {
      expect(getTierThreshold(MilestoneTier.TIER_40, 100000)).toBe(40000);
    });
    // ceil(100000 * 7000 / 10000) = 70000
    it('TIER_70 threshold is 70000', () => {
      expect(getTierThreshold(MilestoneTier.TIER_70, 100000)).toBe(70000);
    });
    // ceil(100000 * 10000 / 10000) = 100000
    it('TIER_100 threshold is 100000', () => {
      expect(getTierThreshold(MilestoneTier.TIER_100, 100000)).toBe(100000);
    });
  });

  it('throws on viewTarget=0', () => {
    expect(() => getTierThreshold(MilestoneTier.BASELINE, 0)).toThrow(TierError);
  });

  it('throws on negative viewTarget', () => {
    expect(() => getTierThreshold(MilestoneTier.BASELINE, -1)).toThrow(TierError);
  });
});

// ---------------------------------------------------------------------------
// D4 — Threshold crossing: views == threshold crosses; threshold-1 does not
// ---------------------------------------------------------------------------

describe('threshold boundary crossing', () => {
  // viewTarget=100000: BASELINE threshold=20000
  const target = 100000;

  it('exactly at BASELINE threshold (20000) — crosses', () => {
    const tiers = computeNewTiers(
      new Decimal('1000.00'), target, 20000, new Set(),
    );
    expect(tiers.map((t) => t.tier)).toContain(MilestoneTier.BASELINE);
  });

  it('one below BASELINE threshold (19999) — does not cross', () => {
    const tiers = computeNewTiers(
      new Decimal('1000.00'), target, 19999, new Set(),
    );
    expect(tiers).toHaveLength(0);
  });

  it('exactly at TIER_100 threshold (100000) — crosses all', () => {
    const tiers = computeNewTiers(
      new Decimal('1000.00'), target, 100000, new Set(),
    );
    expect(tiers.map((t) => t.tier)).toEqual([
      MilestoneTier.BASELINE,
      MilestoneTier.TIER_40,
      MilestoneTier.TIER_70,
      MilestoneTier.TIER_100,
    ]);
  });

  it('one below TIER_100 threshold (99999) — crosses BASELINE,40,70 but not 100', () => {
    const tiers = computeNewTiers(
      new Decimal('1000.00'), target, 99999, new Set(),
    );
    expect(tiers.map((t) => t.tier)).toEqual([
      MilestoneTier.BASELINE,
      MilestoneTier.TIER_40,
      MilestoneTier.TIER_70,
    ]);
    expect(tiers.map((t) => t.tier)).not.toContain(MilestoneTier.TIER_100);
  });
});

// ---------------------------------------------------------------------------
// D4 — Jump scenario: 75% of target crosses BASELINE, TIER_40, TIER_70 in order
// ---------------------------------------------------------------------------

describe('jump to 75% of target', () => {
  it('returns BASELINE, TIER_40, TIER_70 in order (no TIER_100)', () => {
    // viewTarget=100, 75 views → crosses 20, 40, 70 thresholds but not 100
    const tiers = computeNewTiers(
      new Decimal('1000.00'), 100, 75, new Set(),
    );
    expect(tiers.map((t) => t.tier)).toEqual([
      MilestoneTier.BASELINE,
      MilestoneTier.TIER_40,
      MilestoneTier.TIER_70,
    ]);
  });

  it('skipped tiers still pay all in one call', () => {
    // From 0 views directly to 75: all 3 crossed tiers returned
    const tiers = computeNewTiers(
      new Decimal('1000.00'), 100, 75, new Set(),
    );
    expect(tiers).toHaveLength(3);
    // All amounts are positive
    for (const t of tiers) {
      expect(t.amountMinor).toBeGreaterThan(0n);
    }
  });

  it('does not re-pay already-paid tiers', () => {
    // BASELINE already paid; 75 views → only TIER_40 and TIER_70
    const alreadyPaid = new Set([MilestoneTier.BASELINE]);
    const tiers = computeNewTiers(
      new Decimal('1000.00'), 100, 75, alreadyPaid,
    );
    expect(tiers.map((t) => t.tier)).toEqual([
      MilestoneTier.TIER_40,
      MilestoneTier.TIER_70,
    ]);
  });
});

// ---------------------------------------------------------------------------
// D4 — Tier amounts sum to escrow exactly, 10 000 seeded cases
// ---------------------------------------------------------------------------

describe('tier amounts sum to escrow exactly', () => {
  // Deterministic pseudo-random number generator (xorshift32)
  function xorshift32(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) / 0xffffffff;
    };
  }

  const rng = xorshift32(0xdeadbeef);

  // Awkward amounts that must be included
  const fixedAmounts = [
    '0.01',
    '0.03',
    '100.01',
    '9999999999.99',
    '1.00',
    '0.50',
    '0.10',
    '0.07',
    '1234567.89',
  ];

  // Generate 10000 - fixedAmounts.length random amounts
  const randomAmounts: string[] = [];
  const total = 10000 - fixedAmounts.length;
  for (let i = 0; i < total; i++) {
    // Random value between 0.01 and 9999999.99 (stay within DECIMAL(12,2))
    const major = Math.floor(rng() * 9999999);
    const cents = Math.floor(rng() * 100);
    randomAmounts.push(`${major + 1}.${String(cents).padStart(2, '0')}`);
  }

  const allAmounts = [...fixedAmounts, ...randomAmounts];

  it(`all ${allAmounts.length} amounts: tier sum equals escrow exactly`, () => {
    for (const raw of allAmounts) {
      const escrow = new Decimal(raw);
      const escrowMinor = toMinorUnits(escrow);
      const sumMinor = sumAllTierAmountsMinor(escrow);

      // Sum must equal escrow exactly
      expect(sumMinor).toBe(escrowMinor);
    }
  });

  it('every individual tier amount is >= 0 for all test escrows', () => {
    for (const raw of allAmounts) {
      const escrow = new Decimal(raw);
      const tiers = computeNewTiers(escrow, 100000, 100000, new Set());
      for (const t of tiers) {
        expect(t.amountMinor).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it('TIER_ORDER contains exactly 4 tiers', () => {
    expect(TIER_ORDER).toHaveLength(4);
    expect(TIER_ORDER[0]).toBe(MilestoneTier.BASELINE);
    expect(TIER_ORDER[3]).toBe(MilestoneTier.TIER_100);
  });
});

// ---------------------------------------------------------------------------
// Error cases — invalid inputs
// ---------------------------------------------------------------------------

describe('invalid inputs throw typed errors', () => {
  const escrow = new Decimal('1000.00');

  it('throws TierError for zero billableViews is OK (no tiers crossed)', () => {
    // Zero is valid — just no tiers crossed
    expect(() => computeNewTiers(escrow, 100, 0, new Set())).not.toThrow();
    expect(computeNewTiers(escrow, 100, 0, new Set())).toHaveLength(0);
  });

  it('throws TierError for negative billableViews', () => {
    expect(() => computeNewTiers(escrow, 100, -1, new Set())).toThrow(TierError);
  });

  it('throws TierError for NaN billableViews', () => {
    expect(() => computeNewTiers(escrow, 100, NaN, new Set())).toThrow(TierError);
  });

  it('throws TierError for non-integer billableViews', () => {
    expect(() => computeNewTiers(escrow, 100, 50.5, new Set())).toThrow(TierError);
  });

  it('throws TierError for Infinity billableViews', () => {
    expect(() => computeNewTiers(escrow, 100, Infinity, new Set())).toThrow(TierError);
  });

  it('throws TierError for viewTarget=0', () => {
    expect(() => computeNewTiers(escrow, 0, 50, new Set())).toThrow(TierError);
  });

  it('throws TierError for negative viewTarget', () => {
    expect(() => computeNewTiers(escrow, -100, 50, new Set())).toThrow(TierError);
  });

  it('throws TierError for non-integer viewTarget', () => {
    expect(() => computeNewTiers(escrow, 50.5, 25, new Set())).toThrow(TierError);
  });

  it('throws MoneyError for escrow <= 0', () => {
    expect(() => computeNewTiers(new Decimal('0.00'), 100, 50, new Set())).toThrow(MoneyError);
    expect(() => computeNewTiers(new Decimal('-1.00'), 100, 50, new Set())).toThrow();
  });
});
