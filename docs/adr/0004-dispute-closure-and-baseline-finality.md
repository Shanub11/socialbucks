# ADR-0004: Dispute, closure and baseline finality

- Status: Accepted
- Date: 2026-11-14
- Amends: ADR-0003 (state machine, D4, OQ-1, OQ-4)
- Related: ADR-0001, ADR-0002, ADR-0003

## Context

Two of ADR-0003's open questions blocked the next two pieces of work. OQ-1 asked
whether the BASELINE could be clawed back, which had to be answered before a
dispute endpoint could exist, and OQ-4 asked what a slot is called when its
settlement window ends with escrow still unreleased, which the settlement worker
needs to close a slot at all.

ADR-0003 also let a dispute resolve to CANCELLED. That is unsafe with a baseline
in place: CANCELLED is one of the freed statuses in the invite budget check, so a
slot whose baseline had already been paid would stop counting its escrow against
the campaign budget while the creator kept the money. That breaks ADR-0003
invariant 2 (committed escrow never exceeds the campaign budget) and invites an
overspend simply by disputing and cancelling a slot.

This ADR fixes the money semantics of both, adds the missing terminal state, and
puts the transitions in the database, not only in route code.

## Decisions

### D1. The BASELINE released at approval is final (resolves OQ-1)

The BASELINE tier is paid at approval and is never clawed back in this phase. A
dispute freezes further tier releases only; it cannot reverse money already
released. The rationale is structural: PayoutEvent is an append-only ledger with
amount >= 0, so there is no row shape that could record a reversal, and adding a
negative amount would break the invariant that the sum of a slot's events never
exceeds its escrow. The baseline is also a promise made to the creator at invite
time, and the brand already has three protections before it is paid: ownership of
the submitted content is verified with the platform at submit, YouTube content is
confirmed to be a Short at approval, and the brand controls the five-day review
window before approving. If a clawback is ever needed, it will be a separate
append-only adjustments table introduced with a payment partner, leaving
PayoutEvent untouched.

### D2. CLOSED means the settlement window ended with unreleased escrow (resolves OQ-4)

A new SlotStatus value CLOSED, plus a closedAt timestamp on the slot, records a
slot whose settlement window ended while part of its escrow was still unreleased.
The unreleased amount is derived as escrowAmount - paidToDate; no new money column
is added, so there is nothing to keep in sync. COMPLETED keeps its current
meaning, "the final tier was reached", because CLOSED is a different business
outcome: a return is owed to the brand, and collapsing the two would hide that.
The enum value is permanent once shipped, since Postgres cannot drop an enum value
cheaply, so the name is chosen deliberately.

CLOSED is deliberately NOT added to FREED_ESCROW_STATUSES. It keeps counting its
full escrowAmount in the campaign's committed total until return handling exists;
counting escrow that may still be owed is the conservative direction, and
conservative accounting can refuse an invite but can never overspend a budget.

### D3. A dispute can be raised only from IN_PROGRESS, and never resolves to CANCELLED

A brand OWNER or ADMIN may raise a dispute only on a slot that is IN_PROGRESS,
using a reason of 1 to 1000 characters and recording who raised it. DISPUTED
resolves to IN_PROGRESS (the dispute was settled and settlement resumes) or to
CLOSED (the dispute ended the slot), never to CANCELLED. CANCELLED stays limited
to INVITED and ACCEPTED slots where nothing has been paid, which is the only
situation in which freeing the slot's escrow is truthful. Before approval the
brand does not need a dispute at all: it has reject (which returns the slot to
ACCEPTED for a resubmission) and cancel.

### D4. Dispute resolution has no public endpoint at first

Resolution is driven by an operator-run script that performs the same
compare-and-swap transitions the API uses, so the transition rules are enforced in
one place (the database) rather than duplicated in a second surface. When a
dispute resolves back to IN_PROGRESS, settlementEndsAt is extended by exactly the
time the slot spent disputed, disputeResolvedAt - disputedAt, so a brand cannot
consume a creator's settlement window by disputing it. The extension is applied by
the resolver as part of the same compare-and-swap; the settle worker only checks
that the window has ended.

### D5. A cancelled or declined slot permanently blocks re-inviting that creator

The unique (campaignId, creatorId) constraint already allows one slot per creator
per campaign, and createInvite refuses a second slot for the same creator in any
status. The consequence is that cancelling or declining a slot ends that
creator's participation in that campaign for good: no new slot can be created for
them there. This is accepted as a known limitation for the first cohort rather
than worked around by deleting rows or reusing the slot, both of which would
destroy the audit trail or resurrect paid state.

## Slot state machine changes

| From | Event | To | Actor |
|---|---|---|---|
| IN_PROGRESS | raise dispute | DISPUTED | brand OWNER or ADMIN |
| DISPUTED | resolve (resume) | IN_PROGRESS | operator |
| DISPUTED | resolve (close) | CLOSED | operator |
| IN_PROGRESS | settlement window ends with unreleased escrow | CLOSED | worker |

ADR-0003's "any active state | raise dispute" row is narrowed to IN_PROGRESS.
Before approval the brand already has cancel and reject, so a dispute there is
redundant, and settleSlot() already refuses any slot that is not IN_PROGRESS,
which means a disputed slot freezes settlement automatically with no worker
change.

## Database enforcement

Migration 20261114100000_slot_status_closed adds the CLOSED enum value and
commits; nothing else may live in that migration because Postgres cannot
reference a new enum value in the same transaction that adds it. Migration
20261114100100_slot_closure_and_dispute then adds the columns, the foreign key,
the CHECK constraints and the transition trigger.

CHECK constraints on CampaignCreatorSlot:

- slot_closed_requires_closed_at: a CLOSED slot must carry closedAt.
- slot_disputed_requires_record: a DISPUTED slot must carry disputedAt,
  disputeReason and disputeRaisedByUserId.
- slot_dispute_reason_len: disputeReason, when present, is 1 to 1000 characters.
- slot_dispute_resolved_order: disputeResolvedAt, when present, cannot precede
  disputedAt and requires disputedAt.

The trigger slot_status_transition_guard runs BEFORE UPDATE on
CampaignCreatorSlot. It leaves every same-status write alone (cache updates,
timestamps, disbursement bookkeeping) and otherwise rejects, with
restrict_violation:

- a move to CANCELLED unless the slot was INVITED or ACCEPTED with approvedAt
  null and paidToDate 0;
- a move to DISPUTED unless the slot was IN_PROGRESS;
- a move to CLOSED unless the slot was IN_PROGRESS or DISPUTED.

The CANCELLED rule exists because CANCELLED frees escrow in the invite budget
check, so allowing it after a baseline was paid would let a campaign overspend
(ADR-0003 invariant 2). The disputeRaisedByUserId foreign key additionally
guarantees that a dispute always names a real user.

## Consequences

- One migration pair, additive only: no existing row changes shape and no
  existing constraint is dropped.
- The worker and every transition must continue to compare-and-swap on the
  expected current status. The trigger is a backstop, not a substitute for the
  CAS, and it reports a constraint violation rather than a retryable conflict.
- The invite sweeper must expire only rows whose status is exactly INVITED, so a
  slot that was cancelled can never be flipped to EXPIRED (cancelled already
  means freed; EXPIRED would rewrite history).
- Only the latest dispute is kept on the slot row. Earlier disputes for the same
  slot live in the application logs until a dispute-history table is justified.
- The resolver is an operator script for the first cohort. That also answers the
  "who resolves disputes" half of ADR-0003 OQ-6: us, manually, with the same
  transitions the API enforces.

## Open questions

- OQ-2. Is the baseline always 20 % of escrow, or set per campaign?
- OQ-3. What sanity bounds apply to viewTarget relative to escrowAmount?
- OQ-5. Which host runs the settlement worker?
- OQ-6 (partly). The resolver is answered above; which currencies are supported
  at launch is still open.
