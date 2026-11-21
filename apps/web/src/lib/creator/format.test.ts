// apps/web/src/lib/creator/format.test.ts
//
// Pure unit tests for the creator workspace formatters: no database, no React,
// no clock. The label map is exhaustive by type, so these check the copy and
// the money/handle edge cases that a compiler cannot.

import { describe, expect, it } from 'vitest';

import {
  ACTIVE_SLOT_STATUSES,
  SLOT_STATUS_LABEL,
  displayHandle,
  formatMoney,
  slotStatusLabel,
} from './format';

describe('slotStatusLabel', () => {
  it('renders IN_PROGRESS as words, not the enum value', () => {
    expect(slotStatusLabel('IN_PROGRESS')).toBe('In progress');
  });

  it('labels every status with a non-empty, distinct string', () => {
    const labels = Object.values(SLOT_STATUS_LABEL);

    expect(labels).toHaveLength(11);

    for (const label of labels) {
      expect(typeof label).toBe('string');
      expect(label.trim().length).toBeGreaterThan(0);
    }

    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('ACTIVE_SLOT_STATUSES', () => {
  it('is exactly the four live states, in lifecycle order', () => {
    expect(ACTIVE_SLOT_STATUSES).toEqual([
      'ACCEPTED',
      'CONTENT_SUBMITTED',
      'CONTENT_APPROVED',
      'IN_PROGRESS',
    ]);
  });
});

describe('formatMoney', () => {
  it('keeps the currency minor units instead of rounding to whole rupees', () => {
    expect(formatMoney('1250.5', 'INR')).toContain('1,250.50');
  });

  it('shows the decimals on a zero amount', () => {
    expect(formatMoney(0, 'USD')).toContain('0.00');
  });

  it('does not throw on an invalid currency code and keeps the amount', () => {
    expect(() => formatMoney('1250.5', 'XX1')).not.toThrow();
    expect(formatMoney('1250.5', 'XX1')).toBe('1250.5 XX1');
  });
});

describe('displayHandle', () => {
  it('keeps a handle that already has one leading @', () => {
    expect(displayHandle('@name', null, 'unknown')).toBe('@name');
  });

  it('adds the @ when the stored handle omits it', () => {
    expect(displayHandle('name', null, 'unknown')).toBe('@name');
  });

  it('trims a stored handle before showing it', () => {
    expect(displayHandle('  name  ', null, 'unknown')).toBe('@name');
  });

  it('falls back to the display name when there is no handle', () => {
    expect(displayHandle(null, 'Channel name', 'unknown')).toBe('Channel name');
  });

  it('falls back to the caller-supplied label when both are missing', () => {
    expect(displayHandle(null, null, 'YouTube channel')).toBe('YouTube channel');
  });

  it('ignores a whitespace-only handle and display name', () => {
    expect(displayHandle('   ', '   ', 'unknown')).toBe('unknown');
  });
});
