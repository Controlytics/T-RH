/**
 * The extra keys the instrument TREND page shows, per instrument PROFILE —
 * widget data keys, phase 3 (spec §7, 2026-10-29).
 *
 * Stored in `instrument_profiles.display_keys` (JSONB, nullable), written by
 * `PUT /api/instrument-profiles/:id/display-keys` (SUPER_ADMIN), read by every
 * instrument of the profile. Each entry is a Phase 2 widget key — the same
 * display settings (label, unit, decimals, colour) — restricted to TELEMETRY:
 * the trend page is about readings, and an attribute has no history to chart or
 * list (ruling P3-1).
 *
 * ONE strict schema for the write, ONE forgiving reader for every read: a
 * corrupted row must never break the trend page — it reads as no extra keys.
 */
import { z } from 'zod';
import { widgetKeySchema, type WidgetKey } from './dashboard-widgets.js';

export const PROFILE_DISPLAY_KEYS_MAX = 12;

export const profileDisplayKeySchema = widgetKeySchema.refine(
  (k) => k.source === 'telemetry',
  { message: 'The trend page shows readings — an attribute has no history', path: ['source'] },
);

export const profileDisplayKeysSchema = z.array(profileDisplayKeySchema)
  .max(PROFILE_DISPLAY_KEYS_MAX, `At most ${PROFILE_DISPLAY_KEYS_MAX} extra keys on the trend page`)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    list.forEach((k, n) => {
      if (seen.has(k.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [n, 'key'], message: `"${k.key}" is chosen twice` });
      seen.add(k.key);
    });
  });

/** The ONE reader: anything but a list is none; bad entries are dropped. */
export function coerceProfileDisplayKeys(v: unknown): WidgetKey[] {
  if (!Array.isArray(v)) return [];
  const out: WidgetKey[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (out.length >= PROFILE_DISPLAY_KEYS_MAX) break;
    const r = profileDisplayKeySchema.safeParse(raw);
    if (!r.success || seen.has(r.data.key)) continue;
    seen.add(r.data.key);
    out.push(r.data);
  }
  return out;
}

/** Whether two stored lists are the same keys with the same settings. */
export function displayKeysEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(coerceProfileDisplayKeys(a)) === JSON.stringify(coerceProfileDisplayKeys(b));
}
