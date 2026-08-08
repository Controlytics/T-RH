import { z } from 'zod';

/**
 * An instrument profile is a named container for instruments — GROUPING ONLY.
 * It carries no settings and instruments inherit nothing from it, deliberately
 * (2026-08-08 design spec): inheritance would raise "what happens to existing
 * members when the default changes?", which is a separate design question.
 *
 * `name` is trimmed before validation because the database's unique index is an
 * exact match. Without trimming, "Cleanroom-A" and "Cleanroom-A " are two
 * distinct profiles that look identical everywhere they are rendered — an
 * operator would have no way to tell which one their instruments went into.
 */
export const createInstrumentProfileSchema = z.object({
  name: z.string().trim()
    .min(1, 'Profile name is required')
    .max(120, 'Profile name must be 120 characters or fewer'),
  description: z.string().trim().max(500, 'Description must be 500 characters or fewer').optional(),
  isActive: z.boolean().default(true),
});

export const updateInstrumentProfileSchema = z.object({
  name: z.string().trim()
    .min(1, 'Profile name is required')
    .max(120, 'Profile name must be 120 characters or fewer')
    .optional(),
  // `.nullish()` rather than `.optional()`: null is meaningful here — it is how
  // an operator clears a description they no longer want.
  description: z.string().trim().max(500, 'Description must be 500 characters or fewer').nullish(),
  isActive: z.boolean().optional(),
});

export type CreateInstrumentProfileInput = z.infer<typeof createInstrumentProfileSchema>;
export type UpdateInstrumentProfileInput = z.infer<typeof updateInstrumentProfileSchema>;
