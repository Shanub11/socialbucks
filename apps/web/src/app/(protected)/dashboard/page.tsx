// TARGET PATH: apps/web/src/app/(protected)/dashboard/page.tsx
//
// The creator-facing surface for the Instagram connection. Server component
// apart from one deliberate client island: the connect action is a link, the
// disconnect action is a plain form POST, and the live check is a link to a
// JSON endpoint. Only sign-out needs browser JavaScript — see the note in
// sign-out-button.tsx for why it cannot be a server action.
//
// One non-obvious rule: the connect action must be a plain <a>, never
// next/link. Link prefetches on hover, and prefetching /start would mint an
// OAuth nonce and overwrite the cookie before the creator ever clicks —
// so the click would then arrive carrying a state value that no longer
// matches, and every connection attempt would fail state validation.

import { ensureUserProvisioned } from '@/lib/auth/ensure-user';
import { requireAuth } from '@/lib/auth/require-auth';
import { getInstagramConnection } from '@/lib/instagram/connection';
import { REQUIRED_SCOPES } from '@/lib/instagram/constants';

import { SignOutControl } from './sign-out-button';

export const dynamic = 'force-dynamic';

/** Copy for the `reason` codes the callback can return. */
const FAILURE_COPY: Record<string, string> = {
  denied: 'You cancelled the Instagram authorization. Nothing was changed.',
  invalid_request:
    'Instagram sent us back without an authorization code. Please try again.',
  security_check_failed:
    'That connection attempt could not be verified — it may have expired or been opened in a different browser. Start again from this page.',
  missing_scope: `Some permissions were declined. socialbucks needs all of: ${REQUIRED_SCOPES.join(', ')}. Please reconnect and leave every permission enabled.`,
  already_linked:
    'That Instagram account is already connected to a different socialbucks account.',
  not_provisioned:
    'Your socialbucks account is still being set up. Wait a moment and try again.',
  instagram_error:
    'Instagram rejected the connection. Confirm your account is a Business or Creator account, then try again.',
  unexpected: 'Something went wrong connecting your account. Please try again.',
};

function Banner({ status, reason }: { status?: string; reason?: string }) {
  if (status === 'connected') {
    return (
      <div className="rounded-md border border-green-300 bg-green-50 p-4 text-sm text-green-900">
        <strong className="font-semibold">Instagram connected.</strong> Run the
        live check below to confirm view tracking is working.
      </div>
    );
  }

  if (status === 'disconnected') {
    return (
      <div className="rounded-md border border-gray-300 bg-gray-50 p-4 text-sm text-gray-800">
        <strong className="font-semibold">Instagram disconnected.</strong> Your
        stored access token has been destroyed.
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900">
        <strong className="font-semibold">Could not connect. </strong>
        {FAILURE_COPY[reason ?? ''] ?? FAILURE_COPY.unexpected}
        <span className="mt-1 block text-xs text-red-700">
          Reference: {reason ?? 'unknown'}
        </span>
      </div>
    );
  }

  return null;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Already enforced by the layout, but calling it again here is cheap
  // and means this page is still safe even if it's ever moved out of
  // the (protected) group by accident later — defense in depth applies
  // to your own code, not just Clerk's.
  const { userId } = await requireAuth();

  // Creates the User row if the Clerk webhook never delivered. Runs before
  // reading the connection so the page and the database agree.
  const provisioned = await ensureUserProvisioned(userId);

  const [query, connection] = await Promise.all([
    searchParams,
    getInstagramConnection(userId),
  ]);

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="mt-1 text-xs text-gray-500">Signed in as {userId}</p>
        </div>

        <SignOutControl />
      </div>

      <Banner status={first(query.instagram)} reason={first(query.reason)} />

      {!provisioned.ok && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <strong className="font-semibold">Account not fully set up.</strong>{' '}
          {provisioned.reason === 'soft_deleted'
            ? 'This account has been deleted and cannot be reactivated automatically.'
            : 'We could not reach Clerk to finish setting up your account. Connecting Instagram will fail until this resolves.'}
          <span className="mt-1 block text-xs text-amber-700">
            Reference: {provisioned.reason}
          </span>
        </div>
      )}

      <section className="rounded-lg border border-gray-200 p-6">
        <h2 className="text-base font-semibold">Instagram</h2>

        {!connection.connected ? (
          <>
            <p className="mt-2 text-sm text-gray-600">
              Connect the Instagram account you post from. socialbucks reads
              your reel view counts to settle campaign milestones — it never
              posts on your behalf.
            </p>
            <p className="mt-2 text-xs text-gray-500">
              Requires a Business or Creator account. Personal accounts cannot
              be connected.
            </p>

            {/* Plain anchor by design — see the note at the top of this file. */}
            <a
              href="/api/auth/instagram/start"
              className="mt-4 inline-block rounded-md bg-black px-4 py-2 text-sm font-medium text-white"
            >
              Connect Instagram
            </a>
          </>
        ) : (
          <>
            <dl className="mt-4 grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
              <dt className="text-gray-500">Account</dt>
              <dd className="font-medium">@{connection.username}</dd>

              <dt className="text-gray-500">Type</dt>
              <dd>{connection.accountType ?? 'unknown'}</dd>

              <dt className="text-gray-500">Connected</dt>
              <dd>{connection.connectedAt?.toLocaleString() ?? '—'}</dd>

              <dt className="text-gray-500">Token expires</dt>
              <dd>
                {connection.tokenExpiresAt?.toLocaleDateString() ?? '—'}
                {connection.daysUntilTokenExpiry !== null && (
                  <span
                    className={
                      connection.needsRefresh
                        ? 'ml-2 text-amber-700'
                        : 'ml-2 text-gray-500'
                    }
                  >
                    ({connection.daysUntilTokenExpiry} days left)
                  </span>
                )}
              </dd>
            </dl>

            {connection.needsRefresh && (
              <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                This token is inside the refresh window. Once the refresh job
                exists it will renew automatically; until then, reconnect
                before it expires.
              </p>
            )}

            <div className="mt-5 flex items-center gap-3">
              <a
                href="/api/auth/instagram/verify"
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium"
              >
                Run live check
              </a>

              {/* Form POST, not a link: a GET disconnect would be
                  triggerable by any third-party page. */}
              <form action="/api/auth/instagram/disconnect" method="post">
                <button
                  type="submit"
                  className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700"
                >
                  Disconnect
                </button>
              </form>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
