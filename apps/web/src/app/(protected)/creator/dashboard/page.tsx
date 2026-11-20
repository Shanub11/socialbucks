import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@repo/database';

import { ensureUserProvisioned } from '@/lib/auth/ensure-user';
import { requireAuth } from '@/lib/auth/require-auth';
import {
  ACTIVE_SLOT_STATUSES,
  displayHandle,
  formatMoney,
  slotStatusLabel,
} from '@/lib/creator/format';

export const metadata: Metadata = { title: 'Creator dashboard' };
export const dynamic = 'force-dynamic';

function Stat({
  label,
  value,
  note,
  icon,
}: {
  label: string;
  value: string;
  note: string;
  icon: string;
}) {
  return (
    <div className="rounded-2xl border border-[#23323d] bg-[#101820] p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">{label}</p>
        <span className="grid size-9 place-items-center rounded-xl bg-emerald-400/10 text-lg text-emerald-300">
          {icon}
        </span>
      </div>
      <p className="mt-5 text-3xl font-semibold tracking-tight text-white">
        {value}
      </p>
      <p className="mt-1 text-xs text-slate-500">{note}</p>
    </div>
  );
}

export default async function Dashboard() {
  const { userId } = await requireAuth();
  const provisioned = await ensureUserProvisioned(userId);

  if (!provisioned.ok) {
    return (
      <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-6">
        <h1 className="font-semibold text-amber-200">
          Your account needs attention
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          We could not finish setting up your profile. Please sign in again or
          contact support.
        </p>
        <p className="mt-3 text-xs text-slate-600">
          Reference: {provisioned.reason}
        </p>
      </div>
    );
  }

  // The table is capped at the most recent slots. The headline totals are
  // separate aggregate queries, so neither stops at that cap.
  const [user, creator, activeCount, currencies] = await Promise.all([
    prisma.user.findUnique({
      where: { id: provisioned.userId },
      select: { firstName: true },
    }),
    prisma.creator.findUnique({
      where: { userId: provisioned.userId },
      select: {
        trustScore: true,
        socialAccounts: {
          where: { revokedAt: null },
          select: {
            id: true,
            platform: true,
            handle: true,
            displayName: true,
          },
        },
        slots: {
          where: { deletedAt: null },
          orderBy: { updatedAt: 'desc' },
          take: 8,
          select: {
            id: true,
            status: true,
            escrowAmount: true,
            paidToDate: true,
            currentViewCount: true,
            viewTarget: true,
            createdAt: true,
            campaign: { select: { title: true, currency: true } },
          },
        },
      },
    }),
    prisma.campaignCreatorSlot.count({
      where: {
        deletedAt: null,
        creator: { userId: provisioned.userId },
        status: { in: [...ACTIVE_SLOT_STATUSES] },
      },
    }),
    prisma.campaign.findMany({
      where: {
        slots: {
          some: {
            deletedAt: null,
            creator: { userId: provisioned.userId },
            paidToDate: { gt: 0 },
          },
        },
      },
      select: { currency: true },
      distinct: ['currency'],
    }),
  ]);

  const slots = creator?.slots ?? [];
  const accounts = creator?.socialAccounts ?? [];
  const name = user?.firstName?.trim() || 'there';

  const earnedByCurrency = await Promise.all(
    currencies
      .map((campaign) => campaign.currency)
      .sort((left, right) => left.localeCompare(right))
      .map(async (currency) => {
        const sum = await prisma.campaignCreatorSlot.aggregate({
          _sum: { paidToDate: true },
          where: {
            deletedAt: null,
            creator: { userId: provisioned.userId },
            campaign: { currency },
          },
        });

        return formatMoney(sum._sum.paidToDate?.toString() ?? '0', currency);
      }),
  );

  const earned =
    earnedByCurrency.length === 0
      ? formatMoney(0, 'INR')
      : earnedByCurrency.join(' · ');

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[.18em] text-emerald-400">
            CREATOR WORKSPACE
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Good to see you, {name}.
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            Here’s what’s happening across your creator workspace.
          </p>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Active collaborations"
          value={String(activeCount)}
          note="Current campaign slots"
          icon="▦"
        />
        <Stat
          label="Total earned"
          value={earned}
          note="Recorded ledger releases"
          icon="↗"
        />
        <Stat
          label="Social accounts"
          value={String(accounts.length)}
          note="Active connected accounts"
          icon="◎"
        />
        <Stat
          label="Trust score"
          value={creator ? String(creator.trustScore) : '—'}
          note="Creator trust score"
          icon="✳"
        />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.55fr_1fr]">
        <div className="overflow-hidden rounded-2xl border border-[#23323d] bg-[#101820]">
          <div className="flex items-center justify-between border-b border-[#23323d] px-5 py-5">
            <div>
              <h2 className="font-semibold text-white">Your campaigns</h2>
              <p className="mt-1 text-xs text-slate-500">
                Recent creator collaborations
              </p>
            </div>
            <span className="rounded-lg border border-[#2a3a45] px-3 py-1.5 text-xs text-slate-400">
              {slots.length} recent
            </span>
          </div>

          {slots.length > 0 ? (
            <div className="divide-y divide-[#23323d]">
              {slots.map((slot) => {
                const progress =
                  slot.viewTarget &&
                  slot.viewTarget > 0 &&
                  slot.currentViewCount !== null
                    ? Math.min(
                        100,
                        Math.round(
                          (slot.currentViewCount / slot.viewTarget) * 100,
                        ),
                      )
                    : null;

                return (
                  <div key={slot.id} className="px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-100">
                          {slot.campaign.title}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          Escrow{' '}
                          {formatMoney(
                            slot.escrowAmount.toString(),
                            slot.campaign.currency,
                          )}
                        </p>
                      </div>
                      <span className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[10px] text-slate-300">
                        {slotStatusLabel(slot.status)}
                      </span>
                    </div>

                    {progress !== null && (
                      <div className="mt-4">
                        <div className="mb-2 flex justify-between text-[11px] text-slate-500">
                          <span>Engaged views</span>
                          <span>
                            {slot.currentViewCount?.toLocaleString('en-IN')} /{' '}
                            {slot.viewTarget?.toLocaleString('en-IN')}
                          </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                          <div
                            className="h-full rounded-full bg-emerald-400"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="px-6 py-12 text-center">
              <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-slate-800 text-xl text-slate-400">
                ▦
              </div>
              <h3 className="mt-4 font-medium text-white">
                Your campaign space is ready
              </h3>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-500">
                When a brand invites you, campaign terms, escrow and view
                targets will appear here.
              </p>
              <p className="mt-4 text-xs text-slate-600">
                Invitation management is coming to this workspace soon.
              </p>
            </div>
          )}
        </div>

        <div className="space-y-5">
          <div className="rounded-2xl border border-[#23323d] bg-[#101820] p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-semibold text-white">Social accounts</h2>
                <p className="mt-1 text-xs text-slate-500">
                  Your connected channels
                </p>
              </div>
              <Link
                href="/creator/accounts"
                className="text-xs text-emerald-300"
              >
                Manage ↗
              </Link>
            </div>

            <div className="mt-5 space-y-3">
              {(['YOUTUBE', 'INSTAGRAM'] as const).map((platform) => {
                const account = accounts.find(
                  (candidate) => candidate.platform === platform,
                );

                return (
                  <div
                    key={platform}
                    className="flex items-center gap-3 rounded-xl border border-[#23323d] bg-[#0c141b] p-3"
                  >
                    <span className="grid size-10 place-items-center rounded-xl bg-slate-800 text-lg">
                      {platform === 'YOUTUBE' ? '▶' : '◎'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-200">
                        {platform === 'YOUTUBE' ? 'YouTube' : 'Instagram'}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        {account
                          ? displayHandle(
                              account.handle,
                              account.displayName,
                              'Connected',
                            )
                          : 'Not connected'}
                      </p>
                    </div>
                    <span
                      className={
                        account
                          ? 'text-xs text-emerald-300'
                          : 'text-xs text-slate-600'
                      }
                    >
                      {account ? 'Connected' : 'Not linked'}
                    </span>
                  </div>
                );
              })}
            </div>

            <p className="mt-4 text-[11px] leading-5 text-slate-600">
              YouTube is currently the only platform enabled for campaign
              settlement. Instagram connection is available, but payout
              settlement is not enabled.
            </p>
          </div>

          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[.045] p-5">
            <p className="text-xs font-semibold uppercase tracking-[.16em] text-emerald-300">
              Creator setup
            </p>
            <h3 className="mt-3 font-semibold text-white">
              Connect your YouTube channel
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              A verified channel connection is required for supported Shorts
              campaigns and engaged-view tracking.
            </p>
            <Link
              href="/creator/accounts"
              className="mt-4 inline-flex rounded-lg bg-emerald-400 px-4 py-2.5 text-xs font-semibold text-slate-950"
            >
              Set up accounts ↗
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
