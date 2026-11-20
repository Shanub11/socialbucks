import type { Metadata } from 'next';
import { prisma } from '@repo/database';

import { ensureUserProvisioned } from '@/lib/auth/ensure-user';
import { requireAuth } from '@/lib/auth/require-auth';
import {
  connectionNotice,
  type ConnectionNotice,
} from '@/lib/creator/connection-notice';
import { displayHandle } from '@/lib/creator/format';

export const metadata: Metadata = { title: 'Social accounts' };
export const dynamic = 'force-dynamic';

const NOTICE_STYLES: Record<ConnectionNotice['tone'], string> = {
  success: 'border-emerald-400/20 bg-emerald-400/5',
  info: 'border-[#23323d] bg-[#101820]',
  error: 'border-rose-400/20 bg-rose-400/5',
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function Notice({ notice }: { notice: ConnectionNotice }) {
  const titleClass =
    notice.tone === 'error' ? 'text-rose-200' : 'text-emerald-200';

  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={`rounded-2xl border p-4 ${NOTICE_STYLES[notice.tone]}`}
    >
      <p className={`text-sm font-semibold ${titleClass}`}>{notice.title}</p>
      <p className="mt-1 text-sm leading-6 text-slate-300">{notice.body}</p>
      {notice.reference !== undefined && (
        <p className="mt-2 text-xs text-slate-500">
          Reference: {notice.reference}
        </p>
      )}
    </div>
  );
}

export default async function Accounts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ userId }, query] = await Promise.all([requireAuth(), searchParams]);
  const provisioned = await ensureUserProvisioned(userId);

  if (!provisioned.ok) {
    return (
      <p className="text-sm text-amber-300">
        Account setup is incomplete. Reference: {provisioned.reason}
      </p>
    );
  }

  const creator = await prisma.creator.findUnique({
    where: { userId: provisioned.userId },
    select: {
      socialAccounts: {
        where: { revokedAt: null },
        select: {
          platform: true,
          handle: true,
          displayName: true,
          connectedAt: true,
        },
      },
    },
  });

  const accounts = creator?.socialAccounts ?? [];
  const notice = connectionNotice({
    youtube: first(query.youtube),
    instagram: first(query.instagram),
    reason: first(query.reason),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-7">
      {notice !== null && <Notice notice={notice} />}

      <div>
        <p className="text-xs font-semibold uppercase tracking-[.18em] text-emerald-400">
          CHANNELS &amp; PERMISSIONS
        </p>
        <h1 className="mt-3 text-3xl font-semibold text-white">
          Social accounts
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
          Connect the channels you publish from. SocialBucks uses approved
          account data to verify eligible campaign performance; it does not
          publish content on your behalf.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {(['YOUTUBE', 'INSTAGRAM'] as const).map((platform) => {
          const account = accounts.find(
            (candidate) => candidate.platform === platform,
          );
          const youtube = platform === 'YOUTUBE';

          return (
            <section
              key={platform}
              className="rounded-2xl border border-[#23323d] bg-[#101820] p-6"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <span className="grid size-12 place-items-center rounded-2xl bg-slate-800 text-xl">
                    {youtube ? '▶' : '◎'}
                  </span>
                  <div>
                    <h2 className="font-semibold text-white">
                      {youtube ? 'YouTube' : 'Instagram'}
                    </h2>
                    <p className="mt-1 text-xs text-slate-500">
                      {youtube
                        ? 'YouTube channel'
                        : 'Instagram professional account'}
                    </p>
                  </div>
                </div>
                <span
                  className={
                    account
                      ? 'rounded-full bg-emerald-400/10 px-2.5 py-1 text-[10px] text-emerald-300'
                      : 'rounded-full bg-slate-800 px-2.5 py-1 text-[10px] text-slate-500'
                  }
                >
                  {account ? 'Connected' : 'Not connected'}
                </span>
              </div>

              {account ? (
                <>
                  <div className="mt-6 rounded-xl border border-[#23323d] bg-[#0c141b] p-4">
                    <p className="text-xs text-slate-500">Connected account</p>
                    <p className="mt-1 font-medium text-slate-100">
                      {displayHandle(
                        account.handle,
                        account.displayName,
                        'Connected account',
                      )}
                    </p>
                    <p className="mt-2 text-xs text-slate-600">
                      Connected{' '}
                      {account.connectedAt.toLocaleDateString('en-IN')}
                    </p>
                  </div>
                  <form
                    className="mt-4"
                    action={
                      youtube
                        ? '/api/auth/youtube/disconnect'
                        : '/api/auth/instagram/disconnect'
                    }
                    method="post"
                  >
                    <button
                      className="rounded-lg border border-rose-400/20 px-4 py-2.5 text-xs font-medium text-rose-300 hover:bg-rose-400/5"
                      type="submit"
                    >
                      Disconnect account
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <p className="mt-5 min-h-12 text-sm leading-6 text-slate-400">
                    {youtube
                      ? 'Connect your YouTube channel to enable verified Shorts submissions and engaged-view tracking.'
                      : 'Connect a professional Instagram Business or Creator account. Instagram campaign settlement is not enabled yet.'}
                  </p>
                  {/* Plain anchor: prefetching /start would mint and overwrite the OAuth nonce. */}
                  <a
                    href={
                      youtube
                        ? '/api/auth/youtube/start'
                        : '/api/auth/instagram/start'
                    }
                    className="mt-5 inline-flex rounded-lg bg-emerald-400 px-4 py-2.5 text-xs font-semibold text-slate-950 hover:bg-emerald-300"
                  >
                    Connect {youtube ? 'YouTube' : 'Instagram'} ↗
                  </a>
                </>
              )}
            </section>
          );
        })}
      </div>

      <div className="rounded-2xl border border-amber-400/15 bg-amber-400/[.04] p-5">
        <p className="text-sm font-semibold text-amber-200">
          Platform availability
        </p>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          YouTube is currently enabled for campaign submission verification and
          settlement. Instagram connection is supported, but Instagram
          settlement remains disabled until its media ownership and analytics
          adapter are complete. Do not treat an Instagram connection as payout
          eligibility.
        </p>
      </div>
    </div>
  );
}
