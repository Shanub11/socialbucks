# CPX launch plan and working agreement

Status as of 2026-11-22. origin/main = 5b676b7. Estimates are rough, not commitments.
Intended repo path: docs/plan/launch-plan.md. Read this first, then docs/engineering/agent-rules.md.

## 1. Product

CPX (Creator Performance Exchange, repo "socialbucks") is a creator marketplace. Brands fund campaigns
in escrow. Creators receive a guaranteed baseline when content is approved, plus view-based milestone
tiers measured from YouTube analytics. This is a real startup launch: production-grade security and
quality are mandatory, with no shortcuts and no TODOs. One owner (solo founder) works with two AI lanes:
Claude (design and review) and Freebuff (implementation agent).

## 2. Launch decisions (fixed unless the owner changes them)

- Open to everyone: public self-serve. No invite-only gate.
- Platform at launch: YouTube only. Instagram settlement is disabled (SETTLEMENT_SUPPORTED_PLATFORMS)
  and stays out of the launch.
- Region and currency: India, INR (assumption, matches Razorpay).
- Discovery: both models. Creators browse and apply to open campaigns. Brands search creators and invite them.
- Payment partner: Razorpay (account currently in test mode). Razorpay must confirm in writing that its
  products permit holding brand funds and paying creators out BEFORE the money design is finalised.
- Fee model: NOT decided. The owner must decide before Phase 2 starts.

## 3. State on main

Built: Clerk auth and webhook sync, orgs, campaigns (create, edit draft, activate with fundingVerified
false), invites, accept, decline, reject, cancel, submit, approve, dispute, YouTube and Instagram OAuth
with encrypted tokens, settlement worker (pg-boss: invite expiry, settlement sweep and settle job, window
close sweep and close job; YouTube only), ledger rows (PayoutEvent, no money moves), operator dispute
resolution CLI, RLS lockdown migration, OAuth hardening, CI floors (web 1336, worker 190).

Missing: Razorpay integration (none in repo), brand frontend, creator slot frontend (invites, submit,
earnings), payout accounts and KYC, withdrawals, escrow return, discovery and applications, notifications,
abuse controls, admin console, legal pages, production deploy, monitoring, and real landing copy.
Nothing is deployed. The worker has never run against a real Supabase project.

## 4. Phases (target: late February to mid March 2027)

- Phase 0 (week 1, days 1-3): working-agreement tooling: agent-rules.md in the repo, protected-paths CI
  check, review-packet script, PR template. Done when a branch named fb/... that touches a protected path fails CI.
- Phase 1 (week 1): staging Supabase project (separate, free), worker first start, audit SQL confirming pgboss
  tables are not exposed to anon/authenticated, stable public staging URL for webhooks. ADR-0007 money design
  drafted for owner approval.
- Phase 2 (weeks 2-3): money in. Brand funds a campaign: Razorpay order, signed webhook, idempotency, real
  fundingVerified, refunds, failed payments, brand screens.
- Phase 3 (weeks 3-6): invite to submit, plus discovery (ADR-0008). Creator invite inbox, accept, submit; open
  campaign listings with apply; opt-in creator profiles with brand search and invite; transactional email.
- Phase 4 (weeks 6-7): approve to earnings. Brand review and approve, baseline ledger, creator earnings view,
  the 5-day review window job (needs decision OQ-12).
- Phase 5 (weeks 7-9): money out. Payout accounts and KYC, withdrawal via Razorpay, webhooks, retries, TDS,
  failure handling.
- Phase 6 (weeks 9-10): closing the loop. Escrow return for closed and cancelled slots, unreadable-slot rule
  (OQ-10), reconciliation, operator runbooks.
- Phase 7 (weeks 10-12): abuse controls (bot protection, rate limits, duplicate channels, self-dealing checks,
  new-account limits) and admin console with audit trail (ADR-0009).
- Phase 8 (weeks 12-14): scale readiness (load test, indexes, pooling, worker capacity, YouTube quota plan),
  support and compliance surface (help centre, grievance contact, account deletion and data export),
  credential rotation, Cloudflare, Sentry and alerts, money-path security review, restore drill.
- Phase 9 (weeks 14-16): go-live. Live-money smoke test with the owner's own accounts, then public launch.

## 5. Owner-only external work (start now, runs in parallel)

- Razorpay: live activation and business KYC; ask in writing which products fit (payments, split or on-hold
  transfers, payouts) and whether the escrow-style flow is approved; later live keys and live webhooks.
- Google: production domain, privacy policy and terms on that domain, brand verification and sensitive-scope
  verification for youtube.readonly and yt-analytics.readonly (Testing mode refresh tokens expire after 7
  days, so a real launch cannot run in Testing); Clerk production instance with its own Google OAuth client;
  check YouTube quota against planned reads and plan any quota-extension audit.
- Legal and tax: terms, privacy policy (DPDP Act), refund and cancellation policy, creator and brand
  agreements; lawyer review of the custody structure; CA on GST and TDS.
- Dashboards, DNS, secrets entry, production environment variables: owner only.

## 6. Open decisions (owner)

Fee model; OQ-12 (brand does not review within 5 days: auto-approve or auto-reject and release escrow);
OQ-10 (auto-close unreadable slots after a grace period, and creator disconnect while a slot is IN_PROGRESS);
escrow return policy for CLOSED slots; what creator profile data is public to brands; creator eligibility
rules (for example minimum channel age).

## 7. Working model: who does what

Tier A - Claude designs, Freebuff writes from a Claude prompt, Claude reviews the full diff, owner reviews
key-handling and money diffs personally. Covers: anything about money (funding, payouts, ledger, escrow,
TDS), authentication and authorisation helpers, token and crypto handling, OAuth, webhooks and signature
verification, database schema, migrations, triggers and RLS, the slot state machine and worker, env and
secrets handling, CI and tooling, rate limiting and security headers, KYC and personal data handling,
public-profile visibility rules, admin authorisation and audit logging, abuse and fraud rules, account
deletion and export, payment UI code that handles Razorpay callbacks.

Tier B - Claude writes a short spec once, Freebuff writes, automated gates must pass, Claude reviews the
API route and data-access diffs only (not the UI). Covers: read-only discovery and search endpoints, listing
and application CRUD that uses Tier A models and helpers, notification dispatch plumbing, pagination and
filters, and the lib data functions that server-rendered pages call.

Tier C - Freebuff alone, owner checks with the gates. MUST NOT touch protected paths (see agent-rules.md).
Covers: UI pages and components (presentational only; any data comes from existing lib functions, never
directly from the database or Clerk server code; existing files that already do so are Tier B), forms that
call existing APIs, styling, empty, loading and error states,
accessibility, copy, email HTML templates, legal page layouts (text supplied by the lawyer), docs and
runbook drafts, tests for pure utilities, Playwright happy-path smoke tests, dev-only seed scripts,
refactors with no behaviour change.

Branch naming: fb/<task> = Tier C only (CI fails the branch if it touches a protected path). cl/<task> = Tier
A or B (needs Claude review before merge).

## 8. Definition of done for any task

tsc clean; eslint 0 errors and no new warnings; new tests in new files; full web suite green on a DB-on
run by the owner; CI floor raised by hand; review packet pasted for Tier A and B; no secrets, tokens, PII
or provider error text in logs or responses; every route authenticates, authorises and validates input.

## 9. Cadence and token budget

One working tree (C:\Shanu\socialbucks), one agent task at a time, so the DB test rules hold. Parallelism is
between lanes, not between trees: while Freebuff executes task N, Claude designs task N+1 and reviews task
N-1 from pasted diffs. Claude is used for designs, Tier A prompts, Tier A and B reviews and final slice
review; everything else goes to Freebuff. Reviews use a compact review packet, never full logs. When a Claude
chat gets long, start a new one with /context-transfer.
