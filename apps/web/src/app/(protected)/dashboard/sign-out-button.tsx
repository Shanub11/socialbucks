// TARGET PATH: apps/web/src/app/(protected)/dashboard/sign-out-button.tsx
//
// The only client-side island on the dashboard. Sign-out has to run in the
// browser: Clerk's signOut() ends the session against its Frontend API and
// clears the cookies it owns. A server action deleting `__session` by hand
// would leave the session live at Clerk, and the client would re-establish
// the cookie on the next handshake — so it would look like logout worked
// until it didn't.
//
// No `sessionId` is passed, which means every session on this client is
// ended rather than just the active one. That is what makes signing back in
// as a *different* user work instead of silently resuming the previous one.

'use client';

import { SignOutButton } from '@clerk/nextjs';

export function SignOutControl() {
  return (
    // SignOutButton clones its single child and attaches the click handler to
    // it (assertSingleChild), so this must be exactly one element and must not
    // be wrapped in another <button> — that would nest interactive elements.
    <SignOutButton redirectUrl="/sign-in">
      <button
        type="button"
        className="shrink-0 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
      >
        Sign out
      </button>
    </SignOutButton>
  );
}
