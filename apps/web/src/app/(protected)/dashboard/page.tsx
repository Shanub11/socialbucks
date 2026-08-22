// TARGET PATH: apps/web/src/app/(protected)/dashboard/page.tsx
//
// Temporary smoke test — confirms the (protected) layout is working.
// Replace with your real dashboard once campaigns/creators exist.

import { requireAuth } from '@/lib/auth/require-auth';

export default async function DashboardPage() {
  // Already enforced by the layout, but calling it again here is cheap
  // and means this page is still safe even if it's ever moved out of
  // the (protected) group by accident later — defense in depth applies
  // to your own code, not just Clerk's.
  const { userId } = await requireAuth();

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-sm text-gray-600">Signed in as: {userId}</p>
    </div>
  );
}
