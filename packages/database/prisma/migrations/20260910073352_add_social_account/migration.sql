-- ============================================================
-- Migration: add_social_account
-- Created:   2026-09-10
--
-- Execution order:
--   1. Create SocialPlatform enum.
--   2. Create SocialAccount table + indexes + FK.
--   3. Backfill live Instagram connections from Creator into
--      SocialAccount (data-preserving — no rows are modified
--      or deleted in Creator).
--   4. Column drops are DEFERRED to the next migration so they
--      land atomically with the app-code refactor (Steps 3-6).
--
-- Safety invariants:
--   • Runs in a single implicit transaction. Any failure rolls
--     back completely — Creator is left exactly as-is.
--   • Only rows where BOTH instagramUserId IS NOT NULL AND
--     instagramTokenCiphertext IS NOT NULL are backfilled.
--     The old unlink path zeroed instagramUserId on disconnect,
--     so a non-null instagramUserId always means an active
--     connection. A missing ciphertext is a bug state; we skip
--     it rather than violate the NOT NULL constraint.
--   • tokenCiphertext is copied verbatim. It was produced by
--     secret-box.ts (AES-256-GCM, v1.<iv>.<tag>.<ct>) under
--     INSTAGRAM_TOKEN_ENCRYPTION_KEY — still decryptable as-is.
--     No re-encryption is needed or performed.
--   • scopes were never stored in the old schema. We store the
--     scopes the OAuth flow requests as a best-effort default.
--     Real granted scopes will be written on next token refresh.
-- ============================================================

-- ------------------------------------------------------------
-- Step 1: SocialPlatform enum
-- ------------------------------------------------------------

CREATE TYPE "SocialPlatform" AS ENUM ('INSTAGRAM', 'YOUTUBE');

-- ------------------------------------------------------------
-- Step 2: SocialAccount table + indexes + FK
-- ------------------------------------------------------------

CREATE TABLE "SocialAccount" (
    "id"              TEXT NOT NULL,
    "creatorId"       TEXT NOT NULL,
    "platform"        "SocialPlatform" NOT NULL,
    "externalId"      TEXT NOT NULL,
    "handle"          TEXT,
    "displayName"     TEXT,
    -- Versioned ciphertext envelope: v1.<iv_b64url>.<tag_b64url>.<ct_b64url>
    -- Copied verbatim from Creator.instagramTokenCiphertext for backfilled rows;
    -- produced fresh by secret-box.ts for all future writes.
    "tokenCiphertext" TEXT NOT NULL,
    "tokenExpiresAt"  TIMESTAMP(3),
    -- Defaults to empty array. Overwritten with real granted scopes on next
    -- token refresh once the app code reads them from Meta's token response.
    "scopes"          TEXT[] NOT NULL DEFAULT '{}',
    "connectedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NULL = active connection. Set to a timestamp on revocation (soft-delete).
    -- The partial indexes below make uniqueness conditional on this field.
    "revokedAt"       TIMESTAMP(3),
    "lastVerifiedAt"  TIMESTAMP(3),

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- FK index — explicit even though Postgres often creates one for FK columns,
-- because Prisma's FK-index behavior has varied across versions.
CREATE INDEX "SocialAccount_creatorId_idx"
    ON "SocialAccount"("creatorId");

-- Supports the YouTube 30-day re-verification sweep (platform-filtered range scan).
CREATE INDEX "SocialAccount_platform_lastVerifiedAt_idx"
    ON "SocialAccount"("platform", "lastVerifiedAt");

-- Partial unique indexes — uniqueness is enforced only among ACTIVE rows
-- (revokedAt IS NULL). A revoked row does not occupy the slot, so:
--   • reconnecting the same Instagram/YouTube account later succeeds, and
--   • the revoked row remains as an immutable audit-trail entry.
CREATE UNIQUE INDEX "social_account_active_external_id_key"
    ON "SocialAccount"("platform", "externalId")
    WHERE ("revokedAt" IS NULL);

CREATE UNIQUE INDEX "social_account_active_creator_platform_key"
    ON "SocialAccount"("creatorId", "platform")
    WHERE ("revokedAt" IS NULL);

-- onDelete: RESTRICT — consistent with CampaignCreatorSlot → Creator.
-- Creator rows are soft-delete-only (deletedAt); hard deletion is already
-- blocked by the slot FK. This adds a second guard for SocialAccount history.
ALTER TABLE "SocialAccount"
    ADD CONSTRAINT "SocialAccount_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "Creator"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ------------------------------------------------------------
-- Step 3: Backfill live Instagram connections
-- ------------------------------------------------------------
--
-- gen_random_uuid()::text is a valid TEXT primary key.
-- It is not a cuid (Prisma generates those app-side), but the id
-- column has no format constraint beyond TEXT — UUIDs are fine.
--
-- COALESCE(instagramConnectedAt, createdAt) handles the edge case
-- where instagramConnectedAt was not recorded by an older schema
-- version before that column was added.

INSERT INTO "SocialAccount" (
    "id",
    "creatorId",
    "platform",
    "externalId",
    "handle",
    "displayName",
    "tokenCiphertext",
    "tokenExpiresAt",
    "scopes",
    "connectedAt",
    "revokedAt",
    "lastVerifiedAt"
)
SELECT
    gen_random_uuid()::text                              AS "id",
    c."id"                                               AS "creatorId",
    'INSTAGRAM'::"SocialPlatform"                        AS "platform",
    c."instagramUserId"                                  AS "externalId",
    c."instagramUsername"                                AS "handle",
    NULL::TEXT                                           AS "displayName",
    c."instagramTokenCiphertext"                         AS "tokenCiphertext",
    c."instagramTokenExpiresAt"                          AS "tokenExpiresAt",
    ARRAY[
        'instagram_business_basic',
        'instagram_business_manage_insights'
    ]                                                    AS "scopes",
    COALESCE(c."instagramConnectedAt", c."createdAt")    AS "connectedAt",
    NULL::TIMESTAMP                                      AS "revokedAt",
    NULL::TIMESTAMP                                      AS "lastVerifiedAt"
FROM "Creator" c
WHERE
    c."instagramUserId"              IS NOT NULL
    AND c."instagramTokenCiphertext" IS NOT NULL;

-- Surface the backfill count in the migration log.
DO $$
DECLARE
    n INT;
BEGIN
    SELECT COUNT(*) INTO n
    FROM "SocialAccount"
    WHERE "platform" = 'INSTAGRAM';
    RAISE NOTICE 'Backfilled % Instagram connection(s) into SocialAccount.', n;
END $$;

-- ------------------------------------------------------------
-- Step 4: Column drops — DEFERRED to next migration
-- ------------------------------------------------------------
--
-- The instagram* columns on Creator and the InstagramAccountType
-- enum are dropped in a separate migration that is applied
-- together with the app-code refactor (creator-link.ts,
-- connection.ts, route handlers → Steps 3-6). This keeps the
-- cut-over atomic: the database never exposes a half-migrated
-- schema while the app still reads the old columns.
--
-- That next migration will contain:
--
--   DROP INDEX "Creator_instagramUserId_idx";
--   ALTER TABLE "Creator"
--       DROP COLUMN "instagramUserId",
--       DROP COLUMN "instagramUsername",
--       DROP COLUMN "instagramAccountType",
--       DROP COLUMN "instagramConnectedAt",
--       DROP COLUMN "instagramTokenCiphertext",
--       DROP COLUMN "instagramTokenExpiresAt";
--   DROP TYPE "InstagramAccountType";
--
-- The schema.prisma change that produces it: remove the six
-- instagram* fields from the Creator model block, remove the
-- InstagramAccountType enum block, and remove @@index([instagramUserId]).

