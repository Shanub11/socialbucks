// TARGET PATH: apps/web/src/app/(protected)/layout.tsx
//
// Everything nested under this folder requires a signed-in user.
// The (protected) folder name does not appear in the URL.

import { requireAuth } from '@/lib/auth/require-auth';

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAuth(); // redirects to /sign-in if not authenticated

  return <>{children}</>;
}
