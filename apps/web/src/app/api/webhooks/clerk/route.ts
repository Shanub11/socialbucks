// TARGET PATH: apps/web/src/app/api/webhooks/clerk/route.ts
//
// Same file as before — only change is the import now points at the
// real shared database package instead of a local placeholder.

import { headers } from 'next/headers';
import { Webhook } from 'svix';
import type { WebhookEvent } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { prisma } from '@repo/database'; // <- changed from '@/lib/prisma'
import { env } from '@/lib/env';

export async function POST(req: Request) {
    if (!env.CLERK_WEBHOOK_SIGNING_SECRET) {
        return NextResponse.json(
            { error: 'Webhook secret not configured' },
            { status: 500 },
        );
    }

    const headerPayload = await headers();
    const svixId = headerPayload.get('svix-id');
    const svixTimestamp = headerPayload.get('svix-timestamp');
    const svixSignature = headerPayload.get('svix-signature');

    if (!svixId || !svixTimestamp || !svixSignature) {
        return NextResponse.json({ error: 'Missing svix headers' }, { status: 400 });
    }

    const body = await req.text();
    const wh = new Webhook(env.CLERK_WEBHOOK_SIGNING_SECRET);

    let event: WebhookEvent;
    try {
        event = wh.verify(body, {
            'svix-id': svixId,
            'svix-timestamp': svixTimestamp,
            'svix-signature': svixSignature,
        }) as WebhookEvent;
    } catch (err) {
        console.error('Clerk webhook signature verification failed', err);
        return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    // Upsert keyed on clerkId — webhooks are at-least-once delivery, so
    // this handler must be safe to run twice for the same event.
    switch (event.type) {
        case 'user.created':
        case 'user.updated': {
            const { id, email_addresses, first_name, last_name } = event.data;
            const primaryEmail = email_addresses.find(
                (e) => e.id === event.data.primary_email_address_id,
            )?.email_address;

            await prisma.user.upsert({
                where: { clerkId: id },
                create: {
                    clerkId: id,
                    email: primaryEmail ?? '',
                    firstName: first_name ?? null,
                    lastName: last_name ?? null,
                },
                update: {
                    email: primaryEmail ?? '',
                    firstName: first_name ?? null,
                    lastName: last_name ?? null,
                },
            });
            break;
        }
        case 'user.deleted': {
            const { id } = event.data;
            if (id) {
                await prisma.user.updateMany({
                    where: { clerkId: id },
                    data: { deletedAt: new Date() },
                });
            }
            break;
        }
        default:
            break;
    }

    return NextResponse.json({ received: true });
}