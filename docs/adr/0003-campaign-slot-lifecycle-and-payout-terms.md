# ADR-0003: Campaign and slot lifecycle, payout terms, and settlement worker

- Status: Accepted
- Date: 2026-10-26
- Amends: ADR-0002 (D4, timing of the BASELINE release)
- Related: ADR-0001, ADR-0002

## Context

The settlement engine (ADR-0002) is built and tested, but the product around it is
not: there is no way to create an organization or campaign, invite a creator, or
accept an invite through the API, and nothing calls `settleSlot()`. Three product
questions also had to be settled before more code is written: when the baseline is
paid, who fixes the view target and when, and which metric decides payout tiers.

## Decisions

### D1. Baseline is released at approval

- The BASELINE tier (20 % of escrow, unchanged from ADR-0002) is released when the
  brand approves the content, not when 20 % of the view target is reached.
- The release is a `PayoutEvent` row written in the same database transaction that
  moves the slot from CONTENT_SUBMITTED to IN_PROGRESS. It needs no analytics call.
- It stays idempotent through the existing unique key on (slotId, tier). The
  settlement worker must treat BASELINE as already paid and only advance TIER_40,
  TIER_70 and TIER_100.
- Approval remains fail-closed: ownership is verified at submit and the Shorts check
  runs at approval, so no baseline is released for content that is not verified.
- Consequence: a brand pays 20 % of escrow for content that could later be removed.
  See open question OQ-1.

### D2. The brand sets the view target at invite; it is fixed after acceptance

- `escrowAmount`, `viewTarget` and `metric` are set when the slot is created at
  invite time and are visible to the creator before they accept.
- After the creator accepts, these three fields are immutable. The approve endpoint
  no longer accepts a `viewTarget`. Immutability is enforced in code and by a
  database-level guard, with tests for both.

### D3. The payout metric is `engagedViews`, stored on the slot

- The YouTube metric is `engagedViews` (as in ADR-0002 D2). It is stored on each slot
  at invite, so a later change of rule never alters a slot that is already running.
- The UI labels the number "Engaged views" wherever it is shown, and explains at
  invite time that it can be lower than the public view count.

### D4. Timeouts

| Window | Default | Behavior at expiry |
|---|---|---|
| Invite | 7 days | INVITED becomes EXPIRED (worker) |
| Brand review | 5 days after submission | Reminder and a visible overdue flag; no automatic approval or rejection |
| Settlement | 30 days after approval | Final settlement run, then the slot is closed; unreleased escrow is recorded for later return handling |
| Submission deadline | Set per campaign | Required before a campaign can be activated |

Money movement is out of scope until a payment partner is chosen, so "return of
unreleased escrow" is a ledger record only in this phase.

### D5. Settlement runs in a separate worker using pg-boss

- A new `apps/worker` service runs pg-boss against a direct or session-mode database
  connection, never the transaction pooler.
- A sweeper enqueues one job per IN_PROGRESS slot using a singleton key per slot,
  so overlapping runs and duplicate enqueues cannot double-process a slot.
- Errors are classified: transient errors retry with backoff; no data holds the slot
  visibly; a dead refresh token marks the account as needing re-authorization;
  anything unexpected goes to a dead-letter queue and raises an alert.
- The worker never runs migrations. The hosting provider is an open decision (OQ-5).

### D6. Organizations use our own tables

Clerk organization sync is deferred. The creator of an organization becomes its
OWNER; the last OWNER cannot be removed or demoted.

### D7. Brands invite existing creators by email

The invitee must already be a signed-up creator with an active YouTube connection.
Error responses must not reveal whether an email address is registered. Email
invitations for people who have not signed up are deferred.

D6 and D7 were proposed as defaults and adopted without objection.

## Slot state machine

Proposed. The status names are reconciled with `schema.prisma` in the Day 5 migration.

| From | Event | To | Actor |
|---|---|---|---|
| INVITED | accept | ACCEPTED | creator |
| INVITED | decline | DECLINED | creator |
| INVITED | invite expires | EXPIRED | worker |
| INVITED, ACCEPTED | cancel | CANCELLED | brand OWNER or ADMIN |
| ACCEPTED | submit content | CONTENT_SUBMITTED | creator |
| CONTENT_SUBMITTED | approve (pays BASELINE) | IN_PROGRESS | brand OWNER or ADMIN, not the creator |
| CONTENT_SUBMITTED | reject with reason | ACCEPTED | brand OWNER or ADMIN |
| IN_PROGRESS | final tier reached | COMPLETED | worker |
| IN_PROGRESS | settlement window ends | closed | worker |
| any active state | raise dispute | DISPUTED | brand or admin |
| DISPUTED | resolve | IN_PROGRESS or CANCELLED | admin |

After approval the baseline has been paid, so a slot cannot be cancelled after
approval. It can only be disputed.

## Invariants the code must enforce

1. Every transition is a compare-and-swap on the expected current status.
2. The sum of slot escrow amounts in a campaign never exceeds the campaign budget,
   enforced race-safely and proven by a concurrent-invite test.
3. `PayoutEvent` rows are append-only and unique on (slotId, tier). The total paid
   never exceeds the slot's escrow.
4. A creator can never approve their own slot.
5. Only ACTIVE campaigns in non-deleted organizations accept submissions or approvals.
6. All permission checks go through one shared helper.
7. No network call happens inside a database transaction.
8. Money is held as integer minor units only.

## Consequences

- ADR-0002 D4 changes: BASELINE is released at approval, not at 20 % of the target.
- The Day 5 migration adds slot timestamps, the new statuses, `metric`, a
  rejection reason and the immutability guard.
- Day 7 to 11 build the organization, campaign, invite, accept, reject and
  hardened approve endpoints. Day 13 to 15 add cancel, dispute and the worker.
- The earlier approve tests that set `viewTarget` at approval must be rewritten.

## Open questions

- OQ-1. Is any part of the baseline clawed back if approved content is later
  removed? This is for a later ADR, and it matters before real money moves.
- OQ-2. Is the baseline always 20 % of escrow, or set per campaign?
- OQ-3. What sanity bounds apply to `viewTarget` relative to `escrowAmount`, so a
  brand cannot set a target no creator could reach?
- OQ-4. What is the status name for a slot that closes at the end of the settlement
  window with unreleased escrow?
- OQ-5. Which host runs the worker (Railway, Fly, Render or another)?
- OQ-6. Which currencies are supported at launch, and who resolves disputes?