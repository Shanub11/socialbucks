import { z } from 'zod';

// Reasons may contain newlines and tabs but no other control characters and no bidi overrides.
const REASON_PATTERN = /^(?:[^\p{Cc}\u202A-\u202E\u2066-\u2069]|[\n\r\t])*$/u;
export const MAX_REJECTION_REASON_LENGTH = 1000;

export const RejectionReasonSchema = z
  .string()
  .transform((value) => value.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .min(1, 'A rejection reason is required')
      .max(
        MAX_REJECTION_REASON_LENGTH,
        `Reason must be at most ${MAX_REJECTION_REASON_LENGTH} characters`,
      )
      .regex(REASON_PATTERN, 'Reason contains invalid characters'),
  );

export const RejectSlotBodySchema = z.strictObject({
  reason: RejectionReasonSchema,
});
