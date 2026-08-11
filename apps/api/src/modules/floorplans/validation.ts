/**
 * Geometry and limit rules for a room, as a pure function.
 *
 * Checked here rather than as Postgres CHECK constraints so a bad payload
 * returns a 400 that NAMES the offending field. A raw constraint violation
 * surfaces in the placement editor as an opaque 500 the operator cannot act on,
 * and "the server said no" is not a usable error for someone dragging a box.
 *
 * Design: docs/superpowers/specs/2026-08-11-instrument-dashboard-floorplan-design.md
 */
import { z } from 'zod';

/**
 * Coordinates are normalized against the plan image, never pixels. The 0..1
 * bound is also what catches the likely mistake — posting screen pixels, which
 * fail this check long before any of the edge rules below.
 */
const normalized = z.number().min(0).max(1);
const temperature = z.number().min(-100).max(200);
const humidity = z.number().min(0).max(100);

export const roomSchema = z.object({
  code: z.string().trim().min(1).max(60),
  label: z.string().trim().max(120).nullable().optional(),
  x: normalized,
  y: normalized,
  // A zero-extent box is an unclickable hotspot — a slip while dragging, never
  // an intent.
  w: normalized.refine((v) => v > 0, { message: 'must be greater than 0' }),
  h: normalized.refine((v) => v > 0, { message: 'must be greater than 0' }),
  tempMin: temperature.nullable().optional(),
  tempMax: temperature.nullable().optional(),
  rhMin: humidity.nullable().optional(),
  rhMax: humidity.nullable().optional(),
});

export type RoomInput = z.infer<typeof roomSchema>;

export type ValidationResult =
  | { ok: true; data: RoomInput }
  | { ok: false; error: string };

export function validateRoomPayload(input: unknown): ValidationResult {
  const parsed = roomSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `${first.path.join('.') || 'payload'}: ${first.message}` };
  }
  const d = parsed.data;

  // Normalized coordinates mean a box must FINISH inside the plan, not merely
  // start inside it.
  if (d.x + d.w > 1) {
    return { ok: false, error: 'The room runs past the right edge of the plan (x + w must be at most 1).' };
  }
  if (d.y + d.h > 1) {
    return { ok: false, error: 'The room runs past the bottom edge of the plan (y + h must be at most 1).' };
  }

  // An inverted or empty range can never be satisfied, so it is a typo rather
  // than an intent. Reject loudly instead of colouring the room red forever
  // with no way for the operator to work out why.
  if (d.tempMin != null && d.tempMax != null && d.tempMin >= d.tempMax) {
    return { ok: false, error: 'Minimum temperature must be below maximum temperature.' };
  }
  if (d.rhMin != null && d.rhMax != null && d.rhMin >= d.rhMax) {
    return { ok: false, error: 'Minimum humidity must be below maximum humidity.' };
  }

  return { ok: true, data: d };
}

export const floorplanSchema = z.object({
  name: z.string().trim().min(1).max(120),
  imagePath: z.string().trim().min(1).max(500),
  imageWidth: z.number().int().min(1).max(20000),
  imageHeight: z.number().int().min(1).max(20000),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export const floorplanUpdateSchema = floorplanSchema.partial();
