# Creator frontend architecture

## Direction
- Visual system: premium fintech, dark-first, emerald accent.
- App framework: Next.js App Router, React 19, TypeScript, Tailwind CSS 4.
- Authentication: existing Clerk integration.
- Database access: existing Prisma client through `@repo/database`.
- No new UI, chart, form, or query dependencies introduced in this first pass.

## Route map
- `/`: public marketing landing page.
- `/sign-in`, `/sign-up`: existing Clerk hosted components.
- `/creator/dashboard`: authenticated creator overview backed by Prisma.
- `/creator/accounts`: authenticated social account connection management.
- Future creator routes: `/creator/campaigns`, `/creator/invitations`, `/creator/earnings`.

## Data and security rules
- Server Components read creator and SocialAccount records through Prisma.
- Each protected page calls the existing auth/provisioning helpers.
- OAuth entry points must remain ordinary anchors, not prefetched Next Link components: prefetching the start endpoint can mint and overwrite the single-use OAuth nonce.
- Disconnect is POST-only; preserve the existing route handlers and their Origin protections.
- Tokens never reach the client. Only public account metadata is rendered.
- Payout amounts shown in the creator overview are ledger values from `paidToDate`; they are not proof of successful external disbursement.
- YouTube is currently the only settlement-supported platform. Instagram may be connected, but must not be represented as payout-enabled.
- Campaign discovery and invitation actions are not implemented in the current API. Show honest empty/coming-soon states rather than fake controls.

## Current limitations
- No organization/campaign discovery, invitation, accept/decline or creator payout-history APIs are present in the inspected route tree.
- The existing `/dashboard` route remains in place for compatibility while the new creator workspace is introduced.
- Brand workspace and public-site expansion are separate phases.
