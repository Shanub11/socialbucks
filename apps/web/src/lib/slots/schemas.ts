import { z } from 'zod';
import { MAX_PAGE_SIZE } from '@/lib/orgs/constants';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const SlotIdParamSchema = z.string().regex(ID_PATTERN);
export const ListMyInvitesQuerySchema = z.strictObject({
  limit: z
    .string()
    .regex(/^\d{1,2}$/, 'limit must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_PAGE_SIZE))
    .optional(),
  cursor: z.string().regex(ID_PATTERN, 'Invalid cursor').optional(),
});