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
import { validatePolygon, doorEdge, boundingBox, type Polygon } from '@digilog/shared';

/**
 * Coordinates are normalized against the plan image, never pixels. The 0..1
 * bound is also what catches the likely mistake — posting screen pixels, which
 * fail this check long before any of the edge rules below.
 */
const normalized = z.number().min(0).max(1);
const temperature = z.number().min(-100).max(200);
const humidity = z.number().min(0).max(100);

/**
 * A door is normalized against its WALL, not against the plan: `offset` is where
 * the opening starts along that wall as a fraction of the wall's length, and
 * `width` is how much of the wall it takes. Normalizing against the wall (rather
 * than storing plan coordinates) is what keeps a door attached to its room when
 * the room is moved or resized in the editor.
 *
 * Doors are static geometry. NOTHING in this install senses a door, so a door
 * must never be drawn as though it carries a reading.
 */
const doorSchema = z.object({
  // A rectangle room names the wall; a polygon room (Layout Designer,
  // 2026-09-22) names the EDGE index. One of the two is required; both are read
  // through the shared `doorEdge`, the ONE converter, so a door drawn before
  // polygons existed still lands on edge 0..3 of its four-corner room.
  wall: z.enum(['top', 'right', 'bottom', 'left']).optional(),
  edge: z.number().int().min(0).max(63).optional(),
  offset: normalized,
  width: normalized.refine((v) => v > 0, { message: 'must be greater than 0' }),
  kind: z.enum(['ENTRY', 'EXIT', 'PASSAGE']),
}).refine((d) => d.wall !== undefined || d.edge !== undefined, { message: 'a door names its wall or its edge' });

export const DOOR_KINDS = ['ENTRY', 'EXIT', 'PASSAGE'] as const;

export type RoomDoor = z.infer<typeof doorSchema>;

/** The four walls, in the order the editor lists them. */
export const DOOR_WALLS = ['top', 'right', 'bottom', 'left'] as const;

/**
 * Cleanroom-grade classification. TEXT in the database, not a Postgres enum,
 * so this list can grow without a migration — but it is still validated here
 * so a bad payload names the offending field rather than silently persisting
 * an unrecognized grade the renderer can't colour.
 */
export const ROOM_GRADES = ['A', 'B', 'C', 'D', 'CIRCULATION', 'UTILITY'] as const;

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
  // Six is a ceiling on a runaway client, not a judgement about architecture.
  doors: z.array(doorSchema).max(6).nullable().optional(),
  // NULL = nobody has classified this room; it renders white exactly as
  // before this field existed.
  grade: z.enum(ROOM_GRADES).nullable().optional(),
  // The polygon outline (Layout Designer, 2026-09-22). Validated below through
  // the shared `validatePolygon`, not here, so the message names what is wrong
  // with the outline rather than "invalid input". Omitted on PUT = unchanged;
  // explicit null = back to a rectangle.
  points: z.array(z.object({ x: z.number(), y: z.number() })).nullable().optional(),
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

  // The outline, when given, must be a room: simple, inside the plan, not a
  // sliver. The shared validator is the same one the designer refuses with
  // before sending, so a 400 here means a client that bypassed the designer.
  if (d.points) {
    const poly = validatePolygon(d.points);
    if (!poly.ok) return { ok: false, error: `points: ${poly.error}` };
  }

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

  // A door must FINISH on its wall, for the same reason a room must finish
  // inside the plan: normalized coordinates make "starts in bounds" too weak.
  // And it must name an edge the room HAS — a polygon with five corners has
  // five edges, a rectangle four — or the dashboard would have nothing to cut.
  const poly: Polygon | null = d.points ?? null;
  const doors = d.doors ?? [];
  const wallName = (door: { wall?: string; edge?: number }) => door.wall ?? `edge ${door.edge}`;
  for (let i = 0; i < doors.length; i++) {
    const door = doors[i];
    if (doorEdge(door, poly) < 0) {
      return { ok: false, error: `doors.${i}: names an edge the room does not have.` };
    }
    if (door.offset + door.width > 1) {
      return {
        ok: false,
        error: `doors.${i}: the door runs past the end of the ${wallName(door)} wall (offset + width must be at most 1).`,
      };
    }
  }

  // Two openings drawn on top of each other are not representable — one wall
  // cannot have two doors in the same place — so this is a drag that went wrong.
  const byEdge = new Map<number, typeof doors>();
  for (const door of doors) {
    const e = doorEdge(door, poly);
    byEdge.set(e, [...(byEdge.get(e) ?? []), door]);
  }
  for (const [, onEdge] of byEdge) {
    const sorted = [...onEdge].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      if (sorted[i].offset < prev.offset + prev.width) {
        return { ok: false, error: `doors: two doors overlap on the ${wallName(prev)} wall.` };
      }
    }
  }

  return { ok: true, data: d };
}

/**
 * The box a room is STORED with. A polygon room's `x/y/w/h` are its bounding
 * box, derived here on every write and never trusted from the client; a
 * rectangle room's box is the geometry the client sent.
 */
export function roomGeometry(room: Pick<RoomInput, 'x' | 'y' | 'w' | 'h' | 'points'>): { x: number; y: number; w: number; h: number } {
  return room.points ? boundingBox(room.points) : { x: room.x, y: room.y, w: room.w, h: room.h };
}

export const floorplanSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // NULL = a plan drawn from a blank canvas (Layout Designer, 2026-09-22); the
  // width/height are then the chosen canvas size.
  imagePath: z.string().trim().min(1).max(500).nullable().optional(),
  imageWidth: z.number().int().min(1).max(20000),
  imageHeight: z.number().int().min(1).max(20000),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export const floorplanUpdateSchema = floorplanSchema.partial();

/**
 * A LINK between two rooms of one plan (Layout Designer, 2026-09-22).
 * `kind` is a validated string, not a Postgres enum, the `grade` precedent.
 * An OPENING sits on `fromRoom`'s edge `fromEdge` at `offset`/`width`
 * (fractions of that edge) with an optional door leaf; whether that edge is
 * really shared with `toRoom` is a GEOMETRY question the route answers with
 * the rooms in hand. A CONNECTOR needs no adjacency and may carry a label.
 */
export const LINK_KINDS = ['OPENING', 'CONNECTOR'] as const;

export const linkSchema = z.object({
  fromRoomId: z.string().uuid(),
  toRoomId: z.string().uuid(),
  kind: z.enum(LINK_KINDS),
  fromEdge: z.number().int().min(0).max(63).nullable().optional(),
  offset: normalized.nullable().optional(),
  width: normalized.nullable().optional(),
  door: z.enum(DOOR_KINDS).nullable().optional(),
  label: z.string().trim().max(60).nullable().optional(),
}).superRefine((l, ctx) => {
  if (l.fromRoomId === l.toRoomId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['toRoomId'], message: 'a room cannot link to itself' });
  }
  if (l.kind === 'OPENING') {
    if (l.fromEdge == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fromEdge'], message: 'an opening names the edge it sits on' });
    if (l.offset == null || l.width == null || l.width <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['width'], message: 'an opening has a position and a width' });
    } else if (l.offset + l.width > 1 + 1e-9) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['width'], message: 'an opening must finish on its edge' });
    }
  }
});

export type LinkInput = z.infer<typeof linkSchema>;

export function validateLinkPayload(input: unknown): { ok: true; data: LinkInput } | { ok: false; error: string } {
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: `${first.path.join('.') || 'payload'}: ${first.message}` };
  }
  return { ok: true, data: parsed.data };
}
