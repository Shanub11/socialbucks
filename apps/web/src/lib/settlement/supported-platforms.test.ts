// apps/web/src/lib/settlement/supported-platforms.test.ts
//
// Unit tests for the single source of truth for settlement-supported platforms.

import { describe, expect, it } from 'vitest';
import { SocialPlatform } from '@repo/database';
import {
  SETTLEMENT_SUPPORTED_PLATFORMS,
  isSettlementSupported,
} from './supported-platforms';

describe('supported-platforms', () => {
  it('is a Record<SocialPlatform, boolean> with every enum member', () => {
    const values = Object.values(SocialPlatform);
    const keys = Object.keys(SETTLEMENT_SUPPORTED_PLATFORMS);

    values.forEach((platform) => {
      expect(keys).toContain(platform);
    });

    keys.forEach((key) => {
      expect(values).toContain(key as SocialPlatform);
    });
  });

  it('YOUTUBE is settled, INSTAGRAM is not', () => {
    expect(SETTLEMENT_SUPPORTED_PLATFORMS[SocialPlatform.YOUTUBE]).toBe(true);
    expect(SETTLEMENT_SUPPORTED_PLATFORMS[SocialPlatform.INSTAGRAM]).toBe(
      false,
    );
  });

  it('iterates Object.values(SocialPlatform) asserting each has an explicit entry', () => {
    Object.values(SocialPlatform).forEach((platform) => {
      const supported = isSettlementSupported(platform);
      if (platform === SocialPlatform.YOUTUBE) {
        expect(supported).toBe(true);
      } else if (platform === SocialPlatform.INSTAGRAM) {
        expect(supported).toBe(false);
      }
    });
  });

  it('isSettlementSupported(null) returns false', () => {
    expect(isSettlementSupported(null)).toBe(false);
  });

  it('isSettlementSupported(undefined) returns false', () => {
    expect(isSettlementSupported(undefined)).toBe(false);
  });

  it('isSettlementSupported(unknown runtime value) returns false without narrowing', () => {
    expect(isSettlementSupported('TIKTOK' as never)).toBe(false);
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'rejects prototype key %s',
    (k) => expect(isSettlementSupported(k as never)).toBe(false),
  );
});