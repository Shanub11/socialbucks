import { randomUUID } from 'node:crypto';

import { prisma } from '@repo/database';
import { headers } from 'next/headers';
import { Webhook } from 'svix';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';

const h = vi.hoisted(() => ({
  env: { CLERK_WEBHOOK_SIGNING_SECRET: undefined as string | undefined },
}));

vi.mock('@/lib/env', () => ({ env: h.env }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));

const describeDb = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

const SECRET = `whsec_${Buffer.from('webhook-test-secret-material-0123456789').toString('base64')}`;
const OTHER_SECRET = `whsec_${Buffer.from('a-completely-different-secret-9876543210').toString('base64')}`;
const PREFIX = 'clerk_test_webhook_';

const newClerkId = (): string => `${PREFIX}${randomUUID()}`;
const newEmail = (): string => `${randomUUID()}@example.com`;

interface Delivery {
  body: string;
  headers: Record<string, string>;
}

function sign(body: string, options: { secret?: string; ageSeconds?: number } = {}): Delivery {
  const id = `msg_${randomUUID()}`;
  const timestamp = new Date(Date.now() - (options.ageSeconds ?? 0) * 1000);
  const signature = new Webhook(options.secret ?? SECRET).sign(id, timestamp, body);
  return {
    body,
    headers: {
      'svix-id': id,
      'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'svix-signature': signature,
    },
  };
}

async function deliver(delivery: Delivery): Promise<Response> {
  vi.mocked(headers).mockResolvedValue(
    new Headers(delivery.headers) as unknown as Awaited<ReturnType<typeof headers>>,
  );
  return POST(new Request('http://localhost/api/webhooks/clerk', { method: 'POST', body: delivery.body }));
}

function userEvent(
  type: 'user.created' | 'user.updated',
  clerkId: string,
  email: string | null,
  firstName: string | null = 'Ada',
  lastName: string | null = 'Lovelace',
): string {
  return JSON.stringify({
    type,
    data: {
      id: clerkId,
      email_addresses: email ? [{ id: 'idn_1', email_address: email }] : [],
      primary_email_address_id: email ? 'idn_1' : null,
      first_name: firstName,
      last_name: lastName,
    },
  });
}

const deletedEvent = (clerkId: string): string =>
  JSON.stringify({ type: 'user.deleted', data: { id: clerkId, deleted: true, object: 'user' } });

describeDb('POST /api/webhooks/clerk (real database, real svix signatures)', () => {
  beforeEach(() => {
    h.env.CLERK_WEBHOOK_SIGNING_SECRET = SECRET;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(headers).mockReset();
    await prisma.user.deleteMany({ where: { clerkId: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('rejects bad deliveries', () => {
    it.each(['svix-id', 'svix-timestamp', 'svix-signature'])('returns 400 when the %s header is missing', async (name) => {
      const clerkId = newClerkId();
      const delivery = sign(userEvent('user.created', clerkId, newEmail()));
      const remaining = Object.fromEntries(Object.entries(delivery.headers).filter(([key]) => key !== name));

      const res = await deliver({ body: delivery.body, headers: remaining });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Missing svix headers' });
      expect(await prisma.user.count({ where: { clerkId } })).toBe(0);
    });

    it('returns 400 for an invalid signature', async () => {
      const clerkId = newClerkId();
      const delivery = sign(userEvent('user.created', clerkId, newEmail()));
      const forged = { ...delivery, headers: { ...delivery.headers, 'svix-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } };

      const res = await deliver(forged);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid signature' });
      expect(await prisma.user.count({ where: { clerkId } })).toBe(0);
    });

    it('returns 400 for a delivery signed with a different secret', async () => {
      const clerkId = newClerkId();

      const res = await deliver(sign(userEvent('user.created', clerkId, newEmail()), { secret: OTHER_SECRET }));

      expect(res.status).toBe(400);
      expect(await prisma.user.count({ where: { clerkId } })).toBe(0);
    });

    it('returns 400 for a stale timestamp even when the signature is valid', async () => {
      const clerkId = newClerkId();

      const res = await deliver(sign(userEvent('user.created', clerkId, newEmail()), { ageSeconds: 3600 }));

      expect(res.status).toBe(400);
      expect(await prisma.user.count({ where: { clerkId } })).toBe(0);
    });

    it('returns 400 when the body is changed after signing', async () => {
      const original = newClerkId();
      const swapped = newClerkId();
      const delivery = sign(userEvent('user.created', original, newEmail()));

      const res = await deliver({ ...delivery, body: userEvent('user.created', swapped, newEmail()) });

      expect(res.status).toBe(400);
      expect(await prisma.user.count({ where: { clerkId: { in: [original, swapped] } } })).toBe(0);
    });

    // ASSUMPTION: svix parses the JSON inside verify(), so a correctly signed but
    // malformed body ends in the same 400 branch. If this fails, paste the real status.
    it('returns 400 for a correctly signed body that is not JSON', async () => {
      const res = await deliver(sign('this is { not json'));

      expect(res.status).toBe(400);
    });

    it('returns 500 and writes nothing when the signing secret is not configured', async () => {
      h.env.CLERK_WEBHOOK_SIGNING_SECRET = undefined;
      const clerkId = newClerkId();

      const res = await deliver(sign(userEvent('user.created', clerkId, newEmail())));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Webhook secret not configured' });
      expect(await prisma.user.count({ where: { clerkId } })).toBe(0);
    });

    it('never puts the signing secret in a response or a log line', async () => {
      const res = await deliver(sign(userEvent('user.created', newClerkId(), newEmail()), { secret: OTHER_SECRET }));

      const logged = vi
        .mocked(console.error)
        .mock.calls.flat()
        .map((item) => (item instanceof Error ? item.message : String(item)))
        .join(' ');
      const responseText = JSON.stringify(await res.json());
      for (const text of [logged, responseText]) {
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(OTHER_SECRET);
        expect(text).not.toContain(SECRET.slice('whsec_'.length));
      }
    });
  });

  describe('handles valid events', () => {
    it('user.created creates the user from the primary email and names', async () => {
      const clerkId = newClerkId();
      const email = newEmail();

      const res = await deliver(sign(userEvent('user.created', clerkId, email, 'Ada', 'Lovelace')));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
      const row = await prisma.user.findUniqueOrThrow({ where: { clerkId } });
      expect(row).toMatchObject({ email, firstName: 'Ada', lastName: 'Lovelace', deletedAt: null });
    });

    it('user.created without any email stores an empty email', async () => {
      const clerkId = newClerkId();

      const res = await deliver(sign(userEvent('user.created', clerkId, null, null, null)));

      expect(res.status).toBe(200);
      const row = await prisma.user.findUniqueOrThrow({ where: { clerkId } });
      expect(row).toMatchObject({ email: '', firstName: null, lastName: null });
    });

    it('is idempotent when the same delivery is replayed', async () => {
      const clerkId = newClerkId();
      const delivery = sign(userEvent('user.created', clerkId, newEmail()));

      const first = await deliver(delivery);
      const second = await deliver(delivery);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await prisma.user.count({ where: { clerkId } })).toBe(1);
    });

    it('user.updated changes the email and names of an existing user', async () => {
      const clerkId = newClerkId();
      const updatedEmail = newEmail();
      await deliver(sign(userEvent('user.created', clerkId, newEmail(), 'Ada', 'Lovelace')));

      const res = await deliver(sign(userEvent('user.updated', clerkId, updatedEmail, 'Grace', 'Hopper')));

      expect(res.status).toBe(200);
      const row = await prisma.user.findUniqueOrThrow({ where: { clerkId } });
      expect(row).toMatchObject({ email: updatedEmail, firstName: 'Grace', lastName: 'Hopper' });
      expect(await prisma.user.count({ where: { clerkId } })).toBe(1);
    });

    it('user.updated for an unknown user creates the row (upsert)', async () => {
      const clerkId = newClerkId();
      const email = newEmail();

      const res = await deliver(sign(userEvent('user.updated', clerkId, email)));

      expect(res.status).toBe(200);
      const row = await prisma.user.findUniqueOrThrow({ where: { clerkId } });
      expect(row.email).toBe(email);
    });

    it('user.deleted soft-deletes the user and keeps the row', async () => {
      const clerkId = newClerkId();
      const email = newEmail();
      await deliver(sign(userEvent('user.created', clerkId, email)));

      const res = await deliver(sign(deletedEvent(clerkId)));

      expect(res.status).toBe(200);
      const row = await prisma.user.findUniqueOrThrow({ where: { clerkId } });
      expect(row.deletedAt).not.toBeNull();
      expect(row.email).toBe(email);
    });

    it('user.deleted for an unknown user succeeds and creates nothing', async () => {
      const clerkId = newClerkId();

      const res = await deliver(sign(deletedEvent(clerkId)));

      expect(res.status).toBe(200);
      expect(await prisma.user.count({ where: { clerkId } })).toBe(0);
    });

    it('user.deleted without an id leaves every other user untouched', async () => {
      const sentinel = await prisma.user.create({ data: { clerkId: newClerkId(), email: newEmail() } });

      const res = await deliver(sign(JSON.stringify({ type: 'user.deleted', data: { deleted: true, object: 'user' } })));

      expect(res.status).toBe(200);
      const row = await prisma.user.findUniqueOrThrow({ where: { id: sentinel.id } });
      expect(row.deletedAt).toBeNull();
    });

    it('a later user.updated does not resurrect a deleted user', async () => {
      const clerkId = newClerkId();
      await deliver(sign(userEvent('user.created', clerkId, newEmail())));
      await deliver(sign(deletedEvent(clerkId)));

      const res = await deliver(sign(userEvent('user.updated', clerkId, newEmail())));

      expect(res.status).toBe(200);
      const row = await prisma.user.findUniqueOrThrow({ where: { clerkId } });
      expect(row.deletedAt).not.toBeNull();
    });

    it('an unknown event type succeeds and changes nothing', async () => {
      const sentinel = await prisma.user.create({ data: { clerkId: newClerkId(), email: newEmail() } });
      const before = await prisma.user.findUniqueOrThrow({ where: { id: sentinel.id } });

      const res = await deliver(sign(JSON.stringify({ type: 'session.created', data: { id: sentinel.clerkId } })));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true });
      const after = await prisma.user.findUniqueOrThrow({ where: { id: sentinel.id } });
      expect(after).toEqual(before);
    });
  });
});