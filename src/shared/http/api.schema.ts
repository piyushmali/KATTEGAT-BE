import { z } from 'zod';
import { ERROR_CODES } from '../errors.js';

/**
 * Wire shapes shared by every module.
 *
 * Only genuinely cross-cutting envelopes belong here — the error body and the
 * pagination block. Domain payloads stay in their own module's schema file, so
 * this file never becomes a dumping ground that couples unrelated modules.
 */

/** `{ error: { code, message, details?, request_id } }` — see shared/errors.ts. */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
    request_id: z.string(),
  }),
});

export const paginationSchema = z.object({
  page: z.number().int(),
  per_page: z.number().int(),
  total: z.number().int(),
  total_pages: z.number().int(),
});

/** Query parameters every paginated collection accepts. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Capped server-side: an uncapped page size is a denial-of-service knob.
  per_page: z.coerce.number().int().min(1).max(100).default(24),
});

export type Pagination = z.infer<typeof paginationSchema>;

/** Builds the pagination block from a total and the requested window. */
export function toPagination(total: number, page: number, perPage: number): Pagination {
  return {
    page,
    per_page: perPage,
    total,
    total_pages: Math.max(1, Math.ceil(total / perPage)),
  };
}
