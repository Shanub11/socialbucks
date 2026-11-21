# Creator frontend architecture

## Direction
- Visual system: premium fintech, dark-first, emerald accent.
- App framework: Next.js App Router, React 19, TypeScript, Tailwind CSS 4.
- Authentication: existing Clerk integration.
- Database access: existing Prisma client through `@repo/database`.
- No new UI, chart, form, or query dependencies introduced in this first pass.

## Route map
- `/`: public marketing landing page.
- `/sign-in`, `/sign-up`: existing Clerk hosted components; signing in or up lands on `/creator/dashboard`, and the landing page shows "Open your workspace" to signed-in visitors.
- `/creator/dashboard`: authenticated creator overview backed by Prisma.
- `/creator/accounts`: authenticated social account connection management, and the return path for both provider OAuth callbacks.
- `/dashboard`: pre-existing Instagram connection screen; the creator workspace manages connections at `/creator/accounts`.
- Future creator routes: `/creator/campaigns`, `/creator/invitations`, `/creator/earnings`.

## Data and security rules
- Server Components read creator and SocialAccount records through Prisma.
- Each protected page calls the existing auth/provisioning helpers.
- OAuth entry points must remain ordinary anchors, not prefetched Next Link components: prefetching the start endpoint can mint and overwrite the single-use OAuth nonce.
- Disconnect is POST-only; preserve the existing route handlers and their Origin protections.
- Tokens never reach the client. Only public account metadata is rendered.
- Payout amounts shown in the creator overview are ledger values from `paidToDate`; they are not proof of successful external disbursement.
- YouTube is currently the only settlement-supported platform. Instagram may be connected, but must not be represented as payout-enabled.
- Campaign discovery and invitation controls are not part of the creator workspace yet. Show honest empty/coming-soon states rather than fake controls.

## Current limitations
- The creator workspace surfaces no campaign discovery, invitation management or payout history yet; those routes are labelled "Soon" in the navigation.
- The legacy `/dashboard` page is still routed, but it is no longer linked from the creator workspace and is not an OAuth return path; both callbacks return to `/creator/accounts`.
- Brand workspace and public-site expansion are separate phases.
