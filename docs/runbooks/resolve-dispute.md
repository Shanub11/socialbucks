# Resolving a disputed slot

Operator procedure for ADR-0004 D4: take a slot out of `DISPUTED` either by
resuming settlement (`--outcome resume`) or by closing it (`--outcome close`).

There is no public endpoint for this. It is a CLI on purpose: resolution is
driven by us for the first cohort, with the same compare-and-swap transitions
the API uses, so the state machine stays enforced in the database.

## Prerequisites

- Node 22.
- Run from `apps/web`.
- `DATABASE_URL` set in the shell to the database you intend to write to. The
  script prints the parsed target (`host:port/database`) before touching
  anything. **Read that line before you pass `--apply`**: it never prints the
  user, password or query string, only where it is pointed.
- The slot id, and a short operator name (1 to 100 characters, no control
  characters) to record in the logs.

## Commands (PowerShell)

Dry run — the default, writes nothing:

```powershell
cd apps/web
$env:DATABASE_URL = "<connection string for the intended database>"
pnpm resolve-dispute -- --slot <slotId> --outcome resume --operator "<your name>"
```

Apply the change you just reviewed:

```powershell
pnpm resolve-dispute -- --slot <slotId> --outcome resume --operator "<your name>" --apply
```

Use `--outcome close` instead of `--outcome resume` to close the slot.

## What each outcome does

`resume` sets the slot back to `IN_PROGRESS` and extends its settlement window
by exactly the time it spent disputed:

    newSettlementEndsAt = settlementEndsAt + (resolvedAt - disputedAt)

`resolvedAt` is the time of this run. Nothing else changes: the dispute record
stays on the row (`disputedAt`, `disputeReason`, `disputeRaisedByUserId`), and
`disputeResolvedAt` is set to the resolution time.

`close` sets the slot to `CLOSED` and records `closedAt` and
`disputeResolvedAt`. The settlement window is left as it was. The slot must
still have unreleased escrow (`escrowAmount - paidToDate > 0`); if everything
has been paid there is nothing to close and the tool refuses.

## What this tool never does

- It never writes a `PayoutEvent` and never moves money.
- It never returns unreleased escrow to the brand. Return handling has no
  implementation and no payment partner yet.
- It never changes `escrowAmount`, `paidToDate`, `currentTier` or `approvedAt`.
- A closed slot keeps counting its **full** `escrowAmount` in the campaign's
  committed budget until return handling exists (ADR-0004 D2).
- It never logs or prints the dispute reason.

## Reading the output

The tool prints one line per fact: outcome, operator, dispute and resolution
timestamps, status after, the settlement window before (and after, for resume),
the extension in hours, and the escrow / paid / unreleased amounts. A refused
run prints the refusal reason and a fixed message and exits 1.

The last line is machine readable:

    RESULT {"kind":"applied",...}

Save that line verbatim with the ticket. It is the audit record for the change;
it contains no dispute reason and no database credentials.

The exit codes are: `0` planned or applied, `1` refused or unexpected error,
`2` bad arguments or a missing `DATABASE_URL`.

## Read-only verification afterwards

Run against the same database and confirm the row:

```sql
SELECT id,
       status,
       "disputedAt",
       "disputeResolvedAt",
       "closedAt",
       "settlementEndsAt",
       "escrowAmount",
       "paidToDate",
       "currentTier"
FROM "CampaignCreatorSlot"
WHERE id = '<slotId>';
```

For a resume, expect `IN_PROGRESS`, a later `settlementEndsAt`, and a
`disputeResolvedAt` equal to the printed resolution time. For a close, expect
`CLOSED`, an unchanged `settlementEndsAt`, and `closedAt` set.

## Rules

- `CLOSE` is terminal by policy. There is no reopen tool; treat it as final.
- `RESUME` returns the slot to normal settlement, so the brand may raise a new
  dispute later. A new dispute starts a new clock.
- Operator identity is only in the log line, because the slot row has no column
  for it (ADR-0004 keeps the latest dispute only, until a dispute-history table
  is justified). Keep the `RESULT` line with the ticket.
- If the tool refuses with `dispute_changed` or `slot_changed`, re-read the slot
  and plan again. Never retry `--apply` with an old plan.
