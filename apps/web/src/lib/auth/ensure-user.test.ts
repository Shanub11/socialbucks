import { randomUUID } from 'node:crypto';

import { clerkClient } from '@clerk/nextjs/server';
import { prisma } from '@repo/database';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureUserProvisioned } from './ensure-user';

vi.mock('@clerk/nextjs/server', () => ({ clerkClient: vi.fn() }));

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

const PREFIX = 'clerk_test_ensure_';
const newClerkId = (): string => `${PREFIX}${randomUUID()}`;
const newEmail = (): string => `${randomUUID()}@example.com`;

interface FakeClerkUser {
  emailAddresses: { id: string; emailAddress: string }[];
  primaryEmailAddressId: string | null;
  firstName: string | null;
  lastName: string | null;
}

type ClerkClient = Awaited<ReturnType<typeof clerkClient>>;

function mockClerkUser(user: FakeClerkUser) {
  const getUser = vi.fn().mockResolvedValue(user);
  vi.mocked(clerkClient).mockResolvedValue({ users: { getUser } } as unknown as ClerkClient);
  return getUser;
}

describeDb('ensureUserProvisioned (real database)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(clerkClient).mockReset();
    await prisma.user.deleteMany({ where: { clerkId: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates the user on the first call from the primary Clerk email and names', async () => {
    const clerkId = newClerkId();
    const primary = newEmail();
    const getUser = mockClerkUser({
      emailAddresses: [
        { id: 'idn_1', emailAddress: newEmail() },
        { id: 'idn_2', emailAddress: primary },
      ],
      primaryEmailAddressId: 'idn_2',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    const result = await ensureUserProvisioned(clerkId);

    expect(result).toMatchObject({ ok: true, created: true });
    expect(getUser).toHaveBeenCalledWith(clerkId);
    const row = await prisma.user.findUniqueOrThrow({ where: { clerkId } });
    expect(row).toMatchObject({ clerkId, email: primary, firstName: 'Ada', lastName: 'Lovelace', deletedAt: null });
    if (!result.ok) throw new Error('expected a provisioned user');
    expect(result.userId).toBe(row.id);
  });

  it('falls back to the first address when no address matches the primary id', async () => {
    const clerkId = newClerkId();
    const first = newEmail();
    mockClerkUser({
      emailAddresses: [{ id: 'idn_1', emailAddress: first }],
      primaryEmailAddressId: 'idn_missing',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    await ensureUserProvisioned(clerkId);

    const row = await prisma.user.findUniqueOrThrow({ where: { clerkId } });
    expect(row.email).toBe(first);
  });

  it('stores null names when Clerk has none', async () => {
    const clerkId = newClerkId();
    mockClerkUser({
      emailAddresses: [{ id: 'idn_1', emailAddress: newEmail() }],
      primaryEmailAddressId: 'idn_1',
      firstName: null,
      lastName: null,
    });

    await ensureUserProvisioned(clerkId);

    const row = await prisma.user.findUniqueOrThrow({ where: { clerkId } });
    expect(row.firstName).toBeNull();
    expect(row.lastName).toBeNull();
  });

  it('returns the same row on a second call without asking Clerk again', async () => {
    const clerkId = newClerkId();
    const getUser = mockClerkUser({
      emailAddresses: [{ id: 'idn_1', emailAddress: newEmail() }],
      primaryEmailAddressId: 'idn_1',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    const first = await ensureUserProvisioned(clerkId);
    const second = await ensureUserProvisioned(clerkId);

    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false });
    if (!first.ok || !second.ok) throw new Error('expected both calls to succeed');
    expect(second.userId).toBe(first.userId);
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(await prisma.user.count({ where: { clerkId } })).toBe(1);
  });

  it('does not refresh the email or names of an existing row (the webhook owns updates)', async () => {
    const clerkId = newClerkId();
    const original = newEmail();
    mockClerkUser({
      emailAddresses: [{ id: 'idn_1', emailAddress: original }],
      primaryEmailAddressId: 'idn_1',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    await ensureUserProvisioned(clerkId);

    mockClerkUser({
      emailAddresses: [{ id: 'idn_1', emailAddress: newEmail() }],
      primaryEmailAddressId: 'idn_1',
      firstName: 'Grace',
      lastName: 'Hopper',
    });
    const second = await ensureUserProvisioned(clerkId);

    expect(second).toMatchObject({ ok: true, created: false });
    const row = await prisma.user.findUniqueOrThrow({ where: { clerkId } });
    expect(row).toMatchObject({ email: original, firstName: 'Ada', lastName: 'Lovelace' });
  });

  it('creates exactly one row when five first logins race', async () => {
    const clerkId = newClerkId();
    mockClerkUser({
      emailAddresses: [{ id: 'idn_1', emailAddress: newEmail() }],
      primaryEmailAddressId: 'idn_1',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => ensureUserProvisioned(clerkId)));

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const values = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(values.every((v) => v.ok)).toBe(true);
    expect(values.filter((v) => v.ok && v.created)).toHaveLength(1);
    expect(new Set(values.flatMap((v) => (v.ok ? [v.userId] : []))).size).toBe(1);
    expect(await prisma.user.count({ where: { clerkId } })).toBe(1);
  });

  it('keeps two different Clerk ids as two separate users', async () => {
    const a = newClerkId();
    const b = newClerkId();
    mockClerkUser({
      emailAddresses: [{ id: 'idn_1', emailAddress: newEmail() }],
      primaryEmailAddressId: 'idn_1',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    const first = await ensureUserProvisioned(a);
    mockClerkUser({
      emailAddresses: [{ id: 'idn_1', emailAddress: newEmail() }],
      primaryEmailAddressId: 'idn_1',
      firstName: 'Grace',
      lastName: 'Hopper',
    });
    const second = await ensureUserProvisioned(b);

    if (!first.ok || !second.ok) throw new Error('expected both users to be provisioned');
    expect(first.userId).not.toBe(second.userId);
    expect(await prisma.user.count({ where: { clerkId: { in: [a, b] } } })).toBe(2);
  });

  it('refuses a soft-deleted user, does not resurrect them and never calls Clerk', async () => {
    const clerkId = newClerkId();
    const getUser = mockClerkUser({
      emailAddresses: [{ id: 'idn_1', emailAddress: newEmail() }],
      primaryEmailAddressId: 'idn_1',
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
    const existing = await prisma.user.create({
      data: { clerkId, email: newEmail(), deletedAt: new Date() },
    });

    const result = await ensureUserProvisioned(clerkId);

    expect(result).toEqual({ ok: false, reason: 'soft_deleted' });
    expect(getUser).not.toHaveBeenCalled();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it.each([
    {
      name: 'clerkClient() rejects',
      arrange: (): void => {
        vi.mocked(clerkClient).mockRejectedValue(new Error('clerk is down'));
      },
    },
    {
      name: 'users.getUser() rejects',
      arrange: (): void => {
        const getUser = vi.fn().mockRejectedValue(new Error('user not found'));
        vi.mocked(clerkClient).mockResolvedValue({ users: { getUser } } as unknown as ClerkClient);
      },
    },
  ])('returns clerk_lookup_failed and creates no row when $name', async ({ arrange }) => {
    const clerkId = newClerkId();
    arrange();

    const result = await ensureUserProvisioned(clerkId);

    expect(result).toEqual({ ok: false, reason: 'clerk_lookup_failed' });
    expect(await prisma.user.count({ where: { clerkId } })).toBe(0);
  });
});