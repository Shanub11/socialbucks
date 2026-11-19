// apps/web/src/lib/slots/dispute-schemas.ts
//
// Request-body schema for POST /api/campaigns/slots/[slotId]/dispute.
//
// A dispute reason is 1 to 1000 characters, NFC-normalized and trimmed, and may
// contain newlines and tabs but no other control characters and no bidi
// overrides. This mirrors RejectionReasonSchema in reject-schemas.ts exactly:
// keep the two in sync so a reason rejected by one path is rejected by the
// other (both guard the same TEXT column through different routes).

import { z } from 'zod';

// Dispute reasons may contain newlines and tabs but no other control characters
// and no bidi overrides. Mirrors the identical regex in reject-schemas.ts.
const DISPUTE_REASON_PATTERN =
  /^(?:[^\p{Cc}\u202A-\u202E\u2066-\u2069]|[\n\r\t])*$/u;

/**
 * Maximum length of a dispute reason, in characters.
 *
 * Must equal the slot_dispute_reason_len CHECK in migration
 * 20261114100100_slot_closure_and_dispute. Postgres counts characters with
 * char_length (UTF-8 code points); zod's .max() counts UTF-16 code units, so a
 * 1000-character string is never accepted by zod when the database would reject
 * it — zod is never looser than the database.
 */
export const MAX_DISPUTE_REASON_LENGTH = 1000;

export const DisputeReasonSchema = z
  .string()
  .transform((value) => value.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .min(1, 'A dispute reason is required')
      .max(
        MAX_DISPUTE_REASON_LENGTH,
        `Reason must be at most ${MAX_DISPUTE_REASON_LENGTH} characters`,
      )
      .regex(DISPUTE_REASON_PATTERN, 'Reason contains invalid characters'),
  );

export const DisputeSlotBodySchema = z.strictObject({
  reason: DisputeReasonSchema,
});
