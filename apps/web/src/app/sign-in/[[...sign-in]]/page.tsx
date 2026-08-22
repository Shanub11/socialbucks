// TARGET PATH: apps/web/src/app/sign-in/[[...sign-in]]/page.tsx
// (the [[...sign-in]] catch-all lets Clerk handle its internal sub-routes,
// e.g. password reset and email verification, under this same page)

import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <SignIn />
    </div>
  );
}
