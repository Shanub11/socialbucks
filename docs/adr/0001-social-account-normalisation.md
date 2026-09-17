# ADR-0001 — Normalise social-platform connections into `SocialAccount`

| Field       | Value                        |
|-------------|------------------------------|
| Status      | **Accepted**                 |
| Date        | 2026-09-10                   |
| Author      | @Shanub11                    |
| Supersedes  | —                            |
| Superseded by | —                          |

---

## Context

The initial schema stored Instagram credentials directly on the `Creator` model as
six nullable columns (`instagramUserId`, `instagramUsername`, `instagramAccountType`,
`instagramConnectedAt`, `instagramTokenCiphertext`, `instagramTokenExpiresAt`).

This had three compounding problems:

1. **No audit trail.** Disconnect nulled-out all six columns, destroying all evidence
   the connection ever existed. Payout disputes that hinge on "was this creator
   connected during this campaign?" become unresolvable.

2. **Reconnect was silently broken.** `instagramUserId @unique` is an unconditional
   Postgres index. A creator who disconnected and then tried to reconnect the same
   Instagram account would hit a P2002 constraint violation on the re-insert against
   the revoked (NULL-ed) row.

3. **Schema doesn't scale.** YouTube OAuth was already planned. Adding another
   six-column block per platform is an anti-pattern.

---

## Decision

Introduce `SocialAccount` as the canonical home for every OAuth connection.

### Key design choices

**Partial indexes instead of flat unique constraints.**
`@@unique([creatorId, platform], where: { revokedAt: null })` enforces uniqueness
only among *active* rows. A revoked row does not occupy the unique slot, so
reconnecting the same account later succeeds without constraint violations.
Prisma 7 supports this natively via `previewFeatures = ["partialIndexes"]`.

**`revokedAt` soft-delete, not hard DELETE.**
`CampaignCreatorSlot` rows may reference the same creator. Deleting rows severs
the audit trail. `revokedAt` timestamps the revocation while the row remains
readable for dispute resolution.

**`onDelete: Restrict` on the creator relation.**
Creator deletion is already soft-delete-only (`deletedAt` field). Restrict turns an
accidental hard delete into an explicit error rather than silently destroying history.
This is consistent with `CampaignCreatorSlot -> Creator: onDelete: Restrict`.

**`externalId` left unencrypted.**
Instagram user ids and YouTube channel ids appear in public API responses — not
secrets. Encrypting them with AES-256-GCM (random nonce per call) would produce
non-deterministic ciphertext, which Postgres cannot enforce equality-based uniqueness
on. Encrypting them would break the `@@unique` constraint for no confidentiality gain.

**Versioned `tokenCiphertext` format.**
Format: `v1.<iv_b64url>.<tag_b64url>.<ct_b64url>` (as produced by
`secret-box.ts`). The `v1` prefix allows the decrypt function to branch on
version, so algorithm rotation later leaves existing rows decryptable without a data
migration.

**`scopes` stored at connect time.**
Stored as `String[]` so that if Meta or Google expands/contracts permissions, we
can detect which connections predate the change and prompt re-authorisation.

---

## Migration path

**Step 1 (this):** Add `SocialAccount` table alongside the existing `instagram*`
columns on `Creator`. Both coexist; no data is moved.

**Step 2 (next):** Backfill existing connections into `SocialAccount`, then drop
`instagram*` columns and the `InstagramAccountType` enum.

---

## Consequences

**Positive:** Reconnect-after-disconnect works. Full connection history survives
revocations. YouTube and any future platform slots in with no schema changes beyond
a new `SocialPlatform` enum value.

**Negative:** One JOIN added to connection-reads. `partialIndexes` is still a
Prisma preview feature (fallback: express the Postgres partial index in raw SQL).
`InstagramAccountType` enum is dead code until Step 2.

---

## Alternatives rejected

- Per-platform columns + `disconnectedAt` flag: does not scale, no audit trail.
- Hard DELETE + separate `ConnectionHistory` table: double write surface, same data.
- Unconditional unique index + application-level reconnect guard: racy (TOCTOU),
  more footgun surface.
