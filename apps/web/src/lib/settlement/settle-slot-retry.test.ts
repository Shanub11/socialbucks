// apps/web/src/lib/settlement/settle-slot-retry.test.ts
//
// Unit tests for withSerializableRetry — no DB needed.
//
// Run: pnpm vitest run src/lib/settlement/settle-slot-retry.test.ts

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { withSerializableRetry } from './settle-slot';

// Mock error classes to simulate Prisma errors
class MockPrismaError extends Error {
  constructor(public code: string) {
    super('Mock Prisma error');
    this.name = 'MockPrismaError';
    this.code = code;
  }
}

describe('withSerializableRetry', () => {
  let sleepSpy: Mock<(ms: number) => Promise<void>>;

  beforeEach(() => {
    sleepSpy = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sleepSpy.mockReset();
  });

  it('succeeds on the first attempt: fn called once, no sleep', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withSerializableRetry(fn, { sleep: sleepSpy });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('fails with P2034 twice, then succeeds: returns the value, fn called 3 times, sleep called 2 times', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new MockPrismaError('P2034'))
      .mockRejectedValueOnce(new MockPrismaError('P2034'))
      .mockResolvedValue('success');

    const result = await withSerializableRetry(fn, { sleep: sleepSpy });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });

  it('always fails with P2034: calls fn exactly maxAttempts times, rethrows the last error object (same reference), and logs the exhausted warning once', async () => {
    const error = new MockPrismaError('P2034');
    const fn = vi.fn().mockRejectedValue(error);

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      withSerializableRetry(fn, { maxAttempts: 3, sleep: sleepSpy })
    ).rejects.toBe(error); // Same reference

    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[settlement] slotId=%s serialization retries exhausted after %d attempts',
      'unknown',
      3
    );

    consoleSpy.mockRestore();
  });

  it('a non-P2034 error (plain Error) is rethrown immediately with fn called once and no sleep', async () => {
    const error = new Error('Plain error');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withSerializableRetry(fn, { sleep: sleepSpy })).rejects.toBe(error);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('an error with a different Prisma code is rethrown immediately with fn called once and no sleep', async () => {
    const error = new MockPrismaError('P2002'); // Unique constraint violation
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withSerializableRetry(fn, { sleep: sleepSpy })).rejects.toBe(error);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('delay bounds: with Math.random mocked to ~0.9999, every delay is <= min(maxDelayMs, baseDelayMs * 2 ** attempt)', async () => {
    // Mock Math.random to return values close to 1
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => 0.9999);

    const fn = vi.fn()
      .mockRejectedValueOnce(new MockPrismaError('P2034'))
      .mockRejectedValueOnce(new MockPrismaError('P2034'))
      .mockResolvedValue('success');

    await withSerializableRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 1000,
      sleep: sleepSpy,
    });

    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2);

    // First retry: attempt=0 -> baseDelayMs * 2^0 = 50 -> min(1000, 50) = 50 -> delay = floor(0.9999 * 50) = 49
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 49);

    // Second retry: attempt=1 -> baseDelayMs * 2^1 = 100 -> min(1000, 100) = 100 -> delay = floor(0.9999 * 100) = 99
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 99);

    randomSpy.mockRestore();
  });

  it('delay bounds: with Math.random mocked to 0, every delay is 0', async () => {
    // Mock Math.random to return 0
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => 0);

    const fn = vi.fn()
      .mockRejectedValueOnce(new MockPrismaError('P2034'))
      .mockRejectedValueOnce(new MockPrismaError('P2034'))
      .mockResolvedValue('success');

    await withSerializableRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 1000,
      sleep: sleepSpy,
    });

    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2);

    // Both delays should be 0
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 0);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 0);

    randomSpy.mockRestore();
  });

  it('delays never exceed maxDelayMs', async () => {
    // Mock Math.random to return values close to 1
    const randomSpy = vi.spyOn(Math, 'random').mockImplementation(() => 0.9999);

    const fn = vi.fn()
      .mockRejectedValueOnce(new MockPrismaError('P2034'))
      .mockRejectedValueOnce(new MockPrismaError('P2034'))
      .mockRejectedValueOnce(new MockPrismaError('P2034'))
      .mockRejectedValueOnce(new MockPrismaError('P2034'))
      .mockResolvedValue('success');

    await withSerializableRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 150, // Low max to test the cap
      sleep: sleepSpy,
    });

    expect(fn).toHaveBeenCalledTimes(5);
    expect(sleepSpy).toHaveBeenCalledTimes(4);

    // Attempt 0: base * 2^0 = 100 -> min(150, 100) = 100 -> delay = 99
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 99);

    // Attempt 1: base * 2^1 = 200 -> min(150, 200) = 150 -> delay = 149
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 149);

    // Attempt 2: base * 2^2 = 400 -> min(150, 400) = 150 -> delay = 149
    expect(sleepSpy).toHaveBeenNthCalledWith(3, 149);

    // Attempt 3: base * 2^3 = 800 -> min(150, 800) = 150 -> delay = 149
    expect(sleepSpy).toHaveBeenNthCalledWith(4, 149);

    randomSpy.mockRestore();
  });
});